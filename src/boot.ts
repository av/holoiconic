import { createDatabase, initSchema } from "./db.ts";
import { createCtx } from "./ctx.ts";
import { seedTemplate } from "./template.ts";

// CLI arg parser + applicator for trivial launch with custom provider at entrypoint.
// Supports long/short flags, = or space, --port alias; sets process.env + Bun.env (for main/ports)
// and ctx._*Provider so prior resolution paths (env in nodes, _providerConfig in REPL) pick it up.
function parseCliArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { out.help = '1'; continue; }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      let key: string, val: string | undefined;
      if (eq > 0) { key = arg.slice(2, eq); val = arg.slice(eq + 1); }
      else { key = arg.slice(2); if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) val = argv[++i]; else val = '1'; }
      out[key] = val!;
      if (key === 'baseUrl' || key === 'base-url') out['openai-base-url'] = val!;
    } else if (arg[0] === '-' && arg[1] && !arg.startsWith('--')) {
      const shorts = arg.slice(1);
      for (let j = 0; j < shorts.length; j++) {
        const c = shorts[j];
        if ((c === 'b' || c === 'k' || c === 'm') && j === shorts.length - 1 && i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
          const map: Record<string, string> = { b: 'openai-base-url', k: 'openai-api-key', m: 'model' };
          out[map[c]] = argv[++i];
        } else if (c === 'h') { out.help = '1'; }
      }
    }
  }
  if (!out['api-port'] && out.port) out['api-port'] = out.port;
  if (!out['openai-base-url'] && out.baseUrl) out['openai-base-url'] = out.baseUrl;
  return out;
}

async function boot() {
  const cli = parseCliArgs(process.argv);
  if (cli.help) {
    console.log('holoiconic — CLI flags for trivial custom OpenAI launch: bun src/boot.ts --openai-base-url=URL|-b --openai-api-key=KEY|-k --model=MODEL|-m --provider=p --api-port=N|--port=N --web-port=N --help ; precedence CLI>env ; also via bun start -- --flags');
    process.exit(0);
  }

  // Apply CLI > env (covers main.ts hasOpenAIBase/port logic + all node env reads)
  if (cli['openai-base-url']) {
    const v = cli['openai-base-url'];
    process.env.OPENAI_BASE_URL = v;
    process.env.OPENAI_API_BASE = v;
    if ((globalThis as any).Bun?.env) (globalThis as any).Bun.env.OPENAI_BASE_URL = v;
  }
  if (cli['openai-api-key']) {
    const v = cli['openai-api-key'];
    process.env.OPENAI_API_KEY = v;
    if ((globalThis as any).Bun?.env) (globalThis as any).Bun.env.OPENAI_API_KEY = v;
  }
  if (cli.model) {
    const v = cli.model;
    process.env.HOLOICONIC_MODEL = v;
    process.env.OPENAI_MODEL = v;
    if ((globalThis as any).Bun?.env) { (globalThis as any).Bun.env.HOLOICONIC_MODEL = v; (globalThis as any).Bun.env.OPENAI_MODEL = v; }
  }
  if (cli['api-port']) {
    const v = cli['api-port'];
    process.env.HOLO_API_PORT = v;
    if ((globalThis as any).Bun?.env) (globalThis as any).Bun.env.HOLO_API_PORT = v;
  }
  if (cli['web-port']) {
    const v = cli['web-port'];
    process.env.HOLO_WEB_PORT = v;
    if ((globalThis as any).Bun?.env) (globalThis as any).Bun.env.HOLO_WEB_PORT = v;
  }

  // 1. Connect to libSQL — Turso Cloud if TURSO_URL is set, else local file
  const db = createDatabase("holoiconic.db");

  // 2. Init schema (idempotent)
  await initSchema(db);

  // 3. Create the context with 6 naive primitives
  const ctx = createCtx(db);

  // Attach CLI-derived provider config to ctx so REPL's _providerConfig (and any
  // existing resolution from prior per-session/per-req work) picks up the global
  // launch-time custom provider without further changes.
  const prov: any = {};
  if (cli['openai-base-url']) prov.baseUrl = cli['openai-base-url'];
  if (cli['openai-api-key']) prov.apiKey = cli['openai-api-key'];
  if (cli.model) prov.model = cli.model;
  if (cli.provider) prov.provider = cli.provider;
  if (Object.keys(prov).length) {
    ctx._providerConfig = prov;
    ctx._globalProvider = prov;
  }

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
