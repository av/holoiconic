import { createClient, type Client } from "@libsql/client";

export function createDatabase(path?: string): Client {
  return createClient({
    url: path ? `file:${path}` : "file:holoiconic.db",
  });
}

export async function initSchema(db: Client): Promise<void> {
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS quads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      s TEXT NOT NULL,
      p TEXT NOT NULL,
      o TEXT NOT NULL,
      g TEXT NOT NULL DEFAULT '_',
      attrs TEXT,
      UNIQUE(s, p, o, g)
    );
    CREATE INDEX IF NOT EXISTS idx_spo ON quads(s, p, o);
    CREATE INDEX IF NOT EXISTS idx_pos ON quads(p, o, s);
    CREATE INDEX IF NOT EXISTS idx_graph ON quads(g);
  `);
}
