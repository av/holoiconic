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
  assert(s: string, p: string, o: string, g?: string, embedding?: number[]): Promise<Quad>;
  retract(s: string, p: string, o?: string, g?: string): Promise<Quad[]>;
  query(pattern: Pattern): Promise<Quad[]>;
  call(name: string, args?: any): Promise<any>;
  set(s: string, p: string, o: string, g?: string, embedding?: number[]): Promise<Quad>;
  on(pattern: Pattern, callback: Subscriber): () => void;
  readonly self: string;
  /** @internal — exposed for sys:compiler to use the same AsyncLocalStorage */
  _nodeStorage: AsyncLocalStorage<string>;
  /** @internal — dynamic properties added by nodes (e.g. _supervisorControllers) */
  [key: `_${string}`]: any;
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
    _nodeStorage: nodeStorage,
    // ── assert ───────────────────────────────────────────────────
    async assert(s: string, p: string, o: string, g: string = "_", embedding?: number[]): Promise<Quad> {
      let rs;
      if (embedding && Array.isArray(embedding) && embedding.length > 0) {
        const vecJson = JSON.stringify(embedding);
        rs = await db.execute({
          sql: "INSERT OR IGNORE INTO quads (s, p, o, g, embedding) VALUES (?, ?, ?, ?, vector32(?)) RETURNING id, s, p, o, g, attrs",
          args: [s, p, o, g, vecJson],
        });
      } else {
        rs = await db.execute({
          sql: "INSERT OR IGNORE INTO quads (s, p, o, g) VALUES (?, ?, ?, ?) RETURNING id, s, p, o, g, attrs",
          args: [s, p, o, g],
        });
      }

      if (rs.rows.length > 0) {
        const quad = rowToQuad(rs.rows[0]);
        fire({ type: "assert", quad });
        return quad;
      }

      // Duplicate — RETURNING yields 0 rows on OR IGNORE
      const existing = await db.execute({
        sql: "SELECT id, s, p, o, g, attrs FROM quads WHERE s = ? AND p = ? AND o = ? AND g = ?",
        args: [s, p, o, g],
      });
      return rowToQuad(existing.rows[0]);
    },

    // ── retract ──────────────────────────────────────────────────
    async retract(s: string, p: string, o?: string, g: string = "_"): Promise<Quad[]> {
      let rs;
      if (o !== undefined) {
        rs = await db.execute({
          sql: "DELETE FROM quads WHERE s = ? AND p = ? AND o = ? AND g = ? RETURNING id, s, p, o, g, attrs",
          args: [s, p, o, g],
        });
      } else {
        rs = await db.execute({
          sql: "DELETE FROM quads WHERE s = ? AND p = ? AND g = ? RETURNING id, s, p, o, g, attrs",
          args: [s, p, g],
        });
      }

      const quads = rs.rows.map(rowToQuad);
      for (const quad of quads) {
        fire({ type: "retract", quad });
      }
      return quads;
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

    // ── set (atomic single-valued predicate) ─────────────────────
    async set(s: string, p: string, o: string, g: string = "_", embedding?: number[]): Promise<Quad> {
      const insertStmt = embedding && Array.isArray(embedding) && embedding.length > 0
        ? { sql: "INSERT INTO quads (s, p, o, g, embedding) VALUES (?, ?, ?, ?, vector32(?)) RETURNING id, s, p, o, g, attrs", args: [s, p, o, g, JSON.stringify(embedding)] }
        : { sql: "INSERT INTO quads (s, p, o, g) VALUES (?, ?, ?, ?) RETURNING id, s, p, o, g, attrs", args: [s, p, o, g] };

      const [deleted, inserted] = await db.batch([
        { sql: "DELETE FROM quads WHERE s = ? AND p = ? AND g = ? RETURNING id, s, p, o, g, attrs", args: [s, p, g] },
        insertStmt,
      ], "write");

      for (const row of deleted.rows) {
        fire({ type: "retract", quad: rowToQuad(row) });
      }
      const quad = rowToQuad(inserted.rows[0]);
      fire({ type: "assert", quad });
      return quad;
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
