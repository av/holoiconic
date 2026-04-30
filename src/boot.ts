import { createDatabase, initSchema } from "./db.ts";
import { createCtx } from "./ctx.ts";
import { seedTemplate } from "./template.ts";

// ── Kernel ────────────────────────────────────────────────────────
// ~30 lines of plumbing, no policy. Everything else lives in the graph.

async function boot() {
  // 1. Connect to local libSQL
  const db = createDatabase("holoiconic.db");

  // 2. Init schema (idempotent)
  await initSchema(db);

  // 3. Create the context with 5 naive primitives
  const ctx = createCtx(db);

  // 4. Seed graph if empty
  const existing = await ctx.query({});
  if (existing.length === 0) {
    await seedTemplate(ctx);
  } else {
    console.log(`[boot] graph has ${existing.length} quads, skipping seed`);
  }

  // 5. Run main — this boots compiler, supervisor, and REPL
  // Wrap in try/catch so kernel catches and logs errors from the boot chain
  try {
    await ctx.call("main");
  } catch (err: any) {
    console.error("[boot] main crashed:", err.message || err);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  }
}

boot().catch((err) => {
  console.error("[boot] fatal:", err);
  process.exit(1);
});
