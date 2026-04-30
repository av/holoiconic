import { createClient, type Client } from "@libsql/client";

export type DatabaseConfig = {
  /** Turso Cloud URL (e.g. libsql://db-org.turso.io) — overrides path */
  url?: string;
  /** Turso Cloud auth token */
  authToken?: string;
  /** Local file path (ignored if url is a remote URL) */
  path?: string;
};

/**
 * Creates a libSQL client. Priority:
 * 1. Explicit config.url + config.authToken (Turso Cloud)
 * 2. TURSO_URL + TURSO_AUTH_TOKEN env vars (Turso Cloud)
 * 3. config.path as a local file
 * 4. "file:holoiconic.db" default
 */
export function createDatabase(pathOrConfig?: string | DatabaseConfig): Client {
  // Normalize to config object
  const config: DatabaseConfig =
    typeof pathOrConfig === "string"
      ? { path: pathOrConfig }
      : pathOrConfig ?? {};

  // Check for Turso Cloud: explicit config first, then env vars
  const tursoUrl =
    config.url ||
    (typeof Bun !== "undefined" ? Bun.env.TURSO_URL : undefined) ||
    (typeof process !== "undefined" ? process.env.TURSO_URL : undefined);

  const tursoToken =
    config.authToken ||
    (typeof Bun !== "undefined" ? Bun.env.TURSO_AUTH_TOKEN : undefined) ||
    (typeof process !== "undefined" ? process.env.TURSO_AUTH_TOKEN : undefined);

  if (tursoUrl && isRemoteUrl(tursoUrl)) {
    console.log(`[db] connecting to Turso Cloud: ${tursoUrl}`);
    return createClient({
      url: tursoUrl,
      authToken: tursoToken,
    });
  }

  // Local file mode
  const localPath = config.path || tursoUrl || "holoiconic.db";
  const fileUrl = localPath.startsWith("file:") ? localPath : `file:${localPath}`;
  return createClient({ url: fileUrl });
}

/** Returns true if the URL points to a remote Turso/libSQL server */
export function isRemoteUrl(url: string): boolean {
  return (
    url.startsWith("libsql://") ||
    url.startsWith("https://") ||
    url.startsWith("wss://")
  );
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
