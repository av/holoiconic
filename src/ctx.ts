import { AsyncLocalStorage } from "node:async_hooks";
import type { Client } from "@libsql/client";

// ── Types ──────────────────────────────────────────────────────────

export type Quad = {
  id: number;
  subject: string;
  predicate: string;
  object: string;
  graph: string;
  attrs?: Record<string, any>;
};

export type Change = {
  type: "insert" | "remove";
  quad: Quad;
};

export type Pattern = {
  subject?: string;
  predicate?: string;
  object?: string;
  graph?: string;
};

export type Subscriber = (change: Change) => void | Promise<void>;

export type Ctx = {
  insert(subject: string, predicate: string, object: string, graph?: string, embedding?: number[]): Promise<Quad>;
  remove(subject: string, predicate: string, object?: string, graph?: string): Promise<Quad[]>;
  query(pattern: Pattern): Promise<Quad[]>;
  call(name: string, args?: any): Promise<any>;
  set(subject: string, predicate: string, object: string, graph?: string, embedding?: number[]): Promise<Quad>;
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

/** Convert a subscriber pattern into a canonical signature key.
 *  `null` means wildcard (field not specified); any string is a concrete value. */
function patternToKey(pattern: Pattern): string {
  return JSON.stringify([
    pattern.subject === undefined ? null : pattern.subject,
    pattern.predicate === undefined ? null : pattern.predicate,
    pattern.object === undefined ? null : pattern.object,
    pattern.graph === undefined ? null : pattern.graph,
  ]);
}

/** Yield all 16 signature keys that a concrete quad can match.
 *  For each field we either use the concrete value or wildcard (null).
 */
function* quadToKeys(quad: Quad): Generator<string> {
  const vals = [quad.subject, quad.predicate, quad.object, quad.graph];
  for (let mask = 0; mask < 16; mask++) {
    yield JSON.stringify([
      (mask & 1) ? vals[0] : null,
      (mask & 2) ? vals[1] : null,
      (mask & 4) ? vals[2] : null,
      (mask & 8) ? vals[3] : null,
    ]);
  }
}

function rowToQuad(row: any): Quad {
  return {
    id: row.id as number,
    subject: row.subject as string,
    predicate: row.predicate as string,
    object: row.object as string,
    graph: row.graph as string,
    attrs: row.attrs ? JSON.parse(row.attrs as string) : undefined,
  };
}

// ── Factory ────────────────────────────────────────────────────────

export function createCtx(db: Client): Ctx {
  const subscriberIndex = new Map<string, Sub[]>();

  function fire(change: Change) {
    for (const key of quadToKeys(change.quad)) {
      const bucket = subscriberIndex.get(key);
      if (!bucket) continue;
      // Snapshot to protect against mutation (unsubscribe or new on() from within a callback)
      const snapshot = bucket.slice();
      for (const sub of snapshot) {
        try {
          const res = sub.callback(change);
          if (res && typeof (res as any).then === "function") {
            (res as Promise<void>).catch((err: any) => {
              console.error("[ctx.on] subscriber async error:", err);
            });
          }
        } catch (err) {
          console.error("[ctx.on] subscriber error:", err);
        }
      }
    }
  }

  const ctx: Ctx = {
    _nodeStorage: nodeStorage,
    // ── insert ───────────────────────────────────────────────────
    async insert(subject: string, predicate: string, object: string, graph: string = "_", embedding?: number[]): Promise<Quad> {
      let rs;
      if (embedding && Array.isArray(embedding) && embedding.length > 0) {
        const vecJson = JSON.stringify(embedding);
        rs = await db.execute({
          sql: "INSERT OR IGNORE INTO quads (subject, predicate, object, graph, embedding) VALUES (?, ?, ?, ?, vector32(?)) RETURNING id, subject, predicate, object, graph, attrs",
          args: [subject, predicate, object, graph, vecJson],
        });
      } else {
        rs = await db.execute({
          sql: "INSERT OR IGNORE INTO quads (subject, predicate, object, graph) VALUES (?, ?, ?, ?) RETURNING id, subject, predicate, object, graph, attrs",
          args: [subject, predicate, object, graph],
        });
      }

      if (rs.rows.length > 0) {
        const quad = rowToQuad(rs.rows[0]);
        fire({ type: "insert", quad });
        return quad;
      }

      // Duplicate — RETURNING yields 0 rows on OR IGNORE
      const existing = await db.execute({
        sql: "SELECT id, subject, predicate, object, graph, attrs FROM quads WHERE subject = ? AND predicate = ? AND object = ? AND graph = ?",
        args: [subject, predicate, object, graph],
      });
      return rowToQuad(existing.rows[0]);
    },

    // ── remove ──────────────────────────────────────────────────
    async remove(subject: string, predicate: string, object?: string, graph: string = "_"): Promise<Quad[]> {
      let rs;
      if (object !== undefined) {
        rs = await db.execute({
          sql: "DELETE FROM quads WHERE subject = ? AND predicate = ? AND object = ? AND graph = ? RETURNING id, subject, predicate, object, graph, attrs",
          args: [subject, predicate, object, graph],
        });
      } else {
        rs = await db.execute({
          sql: "DELETE FROM quads WHERE subject = ? AND predicate = ? AND graph = ? RETURNING id, subject, predicate, object, graph, attrs",
          args: [subject, predicate, graph],
        });
      }

      const quads = rs.rows.map(rowToQuad);
      for (const quad of quads) {
        fire({ type: "remove", quad });
      }
      return quads;
    },

    // ── query ────────────────────────────────────────────────────
    async query(pattern: Pattern): Promise<Quad[]> {
      const clauses: string[] = [];
      const args: any[] = [];

      if (pattern.subject !== undefined) {
        clauses.push("subject = ?");
        args.push(pattern.subject);
      }
      if (pattern.predicate !== undefined) {
        clauses.push("predicate = ?");
        args.push(pattern.predicate);
      }
      if (pattern.object !== undefined) {
        clauses.push("object = ?");
        args.push(pattern.object);
      }
      if (pattern.graph !== undefined) {
        clauses.push("graph = ?");
        args.push(pattern.graph);
      }

      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const rs = await db.execute({
        sql: `SELECT id, subject, predicate, object, graph, attrs FROM quads ${where}`,
        args,
      });

      return rs.rows.map(rowToQuad);
    },

    // ── set (atomic single-valued predicate) ─────────────────────
    async set(subject: string, predicate: string, object: string, graph: string = "_", embedding?: number[]): Promise<Quad> {
      const insertStmt = embedding && Array.isArray(embedding) && embedding.length > 0
        ? { sql: "INSERT INTO quads (subject, predicate, object, graph, embedding) VALUES (?, ?, ?, ?, vector32(?)) RETURNING id, subject, predicate, object, graph, attrs", args: [subject, predicate, object, graph, JSON.stringify(embedding)] }
        : { sql: "INSERT INTO quads (subject, predicate, object, graph) VALUES (?, ?, ?, ?) RETURNING id, subject, predicate, object, graph, attrs", args: [subject, predicate, object, graph] };

      const [deleted, inserted] = await db.batch([
        { sql: "DELETE FROM quads WHERE subject = ? AND predicate = ? AND graph = ? RETURNING id, subject, predicate, object, graph, attrs", args: [subject, predicate, graph] },
        insertStmt,
      ], "write");

      for (const row of deleted.rows) {
        fire({ type: "remove", quad: rowToQuad(row) });
      }
      const quad = rowToQuad(inserted.rows[0]);
      fire({ type: "insert", quad });
      return quad;
    },

    // ── call (naive kernel version — no cache) ───────────────────
    async call(name: string, args?: any): Promise<any> {
      const rs = await db.execute({
        sql: "SELECT object FROM quads WHERE subject = ? AND predicate = 'source'",
        args: [name],
      });

      if (rs.rows.length === 0) {
        throw new Error(`[ctx.call] no source found for node: ${name}`);
      }

      const source = rs.rows[0]!.object as string;
      const fn = new AsyncFunction("ctx", "args", source);

      return nodeStorage.run(name, () => fn(ctx, args));
    },

    // ── on ───────────────────────────────────────────────────────
    on(pattern: Pattern, callback: Subscriber): () => void {
      const sub: Sub = { pattern, callback };
      const key = patternToKey(pattern);
      let bucket = subscriberIndex.get(key);
      if (!bucket) {
        bucket = [];
        subscriberIndex.set(key, bucket);
      }
      bucket.push(sub);

      return () => {
        const idx = bucket.indexOf(sub);
        if (idx !== -1) {
          bucket.splice(idx, 1);
          if (bucket.length === 0) {
            subscriberIndex.delete(key);
          }
        }
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
