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

  // Try to add optional vector embedding column — may not be supported in all libSQL builds
  try {
    // Check if column already exists
    const cols = await db.execute("PRAGMA table_info(quads)");
    const hasEmbedding = cols.rows.some((r: any) => r.name === "embedding");
    if (!hasEmbedding) {
      await db.execute("ALTER TABLE quads ADD COLUMN embedding F32_BLOB(1536)");
      console.log("[db] vector embedding column added (F32_BLOB(1536))");
    }
    // Try to create vector index
    await db.execute(
      "CREATE INDEX IF NOT EXISTS idx_vector ON quads(libsql_vector_idx(embedding))"
    );
  } catch (err: any) {
    console.warn(
      "[db] vector support unavailable — embedding column/index skipped:",
      err.message || String(err)
    );
  }
}
