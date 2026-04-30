import { AsyncLocalStorage } from "node:async_hooks";
import type { Client } from "@libsql/client";

// ── Types ──────────────────────────────────────────────────────────

export type Quad = {
  id: number;
  s: string;
  p: string;
  o: string;
  g: string;
  attrs?: Record<string, any>;
};

export type Change = {
  type: "assert" | "retract";
  quad: Quad;
};

export type Pattern = {
  s?: string;
  p?: string;
  o?: string;
  g?: string;
};

export type Subscriber = (change: Change) => void;

export type Ctx = {
  assert(s: string, p: string, o: string, g?: string): Promise<Quad>;
  retract(s: string, p: string, o: string, g?: string): Promise<void>;
  query(pattern: Pattern): Promise<Quad[]>;
  call(name: string, args?: any): Promise<any>;
  on(pattern: Pattern, callback: Subscriber): () => void;
  readonly self: string;
};

// ── Internals ──────────────────────────────────────────────────────

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const nodeStorage = new AsyncLocalStorage<string>();

type Sub = { pattern: Pattern; callback: Subscriber };

function matchesPattern(pattern: Pattern, quad: Quad): boolean {
  if (pattern.s !== undefined && pattern.s !== quad.s) return false;
  if (pattern.p !== undefined && pattern.p !== quad.p) return false;
  if (pattern.o !== undefined && pattern.o !== quad.o) return false;
  if (pattern.g !== undefined && pattern.g !== quad.g) return false;
  return true;
}

function rowToQuad(row: any): Quad {
  return {
    id: row.id as number,
    s: row.s as string,
    p: row.p as string,
    o: row.o as string,
    g: row.g as string,
    attrs: row.attrs ? JSON.parse(row.attrs as string) : undefined,
  };
}

// ── Factory ────────────────────────────────────────────────────────

export function createCtx(db: Client): Ctx {
  const subscribers: Sub[] = [];

  function fire(change: Change) {
    for (const sub of subscribers) {
      if (matchesPattern(sub.pattern, change.quad)) {
        try {
          sub.callback(change);
        } catch (err) {
          console.error("[ctx.on] subscriber error:", err);
        }
      }
    }
  }

  const ctx: Ctx = {
    // ── assert ───────────────────────────────────────────────────
    async assert(s: string, p: string, o: string, g: string = "_"): Promise<Quad> {
      const insertResult = await db.execute({
        sql: "INSERT OR IGNORE INTO quads (s, p, o, g) VALUES (?, ?, ?, ?)",
        args: [s, p, o, g],
      });

      const rs = await db.execute({
        sql: "SELECT id, s, p, o, g, attrs FROM quads WHERE s = ? AND p = ? AND o = ? AND g = ?",
        args: [s, p, o, g],
      });

      const quad = rowToQuad(rs.rows[0]);

      // Only fire change events for actual inserts, not duplicate no-ops
      if (insertResult.rowsAffected > 0) {
        fire({ type: "assert", quad });
      }

      return quad;
    },

    // ── retract ──────────────────────────────────────────────────
    async retract(s: string, p: string, o: string, g: string = "_"): Promise<void> {
      // First fetch the quad so we have it for the change event
      const rs = await db.execute({
        sql: "SELECT id, s, p, o, g, attrs FROM quads WHERE s = ? AND p = ? AND o = ? AND g = ?",
        args: [s, p, o, g],
      });

      if (rs.rows.length === 0) return; // no-op

      const quad = rowToQuad(rs.rows[0]);

      await db.execute({
        sql: "DELETE FROM quads WHERE s = ? AND p = ? AND o = ? AND g = ?",
        args: [s, p, o, g],
      });

      fire({ type: "retract", quad });
    },

    // ── query ────────────────────────────────────────────────────
    async query(pattern: Pattern): Promise<Quad[]> {
      const clauses: string[] = [];
      const args: any[] = [];

      if (pattern.s !== undefined) {
        clauses.push("s = ?");
        args.push(pattern.s);
      }
      if (pattern.p !== undefined) {
        clauses.push("p = ?");
        args.push(pattern.p);
      }
      if (pattern.o !== undefined) {
        clauses.push("o = ?");
        args.push(pattern.o);
      }
      if (pattern.g !== undefined) {
        clauses.push("g = ?");
        args.push(pattern.g);
      }

      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const rs = await db.execute({
        sql: `SELECT id, s, p, o, g, attrs FROM quads ${where}`,
        args,
      });

      return rs.rows.map(rowToQuad);
    },

    // ── call (naive kernel version — no cache) ───────────────────
    async call(name: string, args?: any): Promise<any> {
      const rs = await db.execute({
        sql: "SELECT o FROM quads WHERE s = ? AND p = 'source'",
        args: [name],
      });

      if (rs.rows.length === 0) {
        throw new Error(`[ctx.call] no source found for node: ${name}`);
      }

      const source = rs.rows[0]!.o as string;
      const fn = new AsyncFunction("ctx", "args", source);

      return nodeStorage.run(name, () => fn(ctx, args));
    },

    // ── on ───────────────────────────────────────────────────────
    on(pattern: Pattern, callback: Subscriber): () => void {
      const sub: Sub = { pattern, callback };
      subscribers.push(sub);

      return () => {
        const idx = subscribers.indexOf(sub);
        if (idx !== -1) subscribers.splice(idx, 1);
      };
    },

    // ── self ─────────────────────────────────────────────────────
    get self(): string {
      const name = nodeStorage.getStore();
      if (name === undefined) {
        throw new Error("[ctx.self] not inside a node execution");
      }
      return name;
    },
  };

  return ctx;
}
