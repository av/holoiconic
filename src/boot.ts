import { createDatabase, initSchema } from "./db.ts";
import { createCtx } from "./ctx.ts";
import { seedTemplate } from "./template.ts";

// CLI arg parser + applicator for trivial launch with custom provider at entrypoint.
// Supports long/short flags, = or space, --port alias; sets process.env + Bun.env (for main/ports)
// and ctx._*Provider so prior resolution paths (env in nodes, _providerConfig in REPL) pick it up.
// Config file (.holoiconic.json etc) is loaded after parse (precedence CLI > config > env) in loadConfigProvider.
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

// loadConfigProvider: tiny JSON config support (no new deps) for persistent default custom provider.
// Checks cwd then home for .holoiconic.json or holoiconic.config.json; supports {provider: {...}} or flat.
// Returns normalized {baseUrl?, apiKey?, model?, provider?} or {}.
async function loadConfigProvider(): Promise<any> {
  const candidates: string[] = [
    "./.holoiconic.json",
    "./holoiconic.config.json",
  ];
  const home = (process.env.HOME || process.env.USERPROFILE || "").trim();
  if (home) {
    candidates.push(`${home}/.holoiconic.json`);
    candidates.push(`${home}/holoiconic.config.json`);
  }
  for (const p of candidates) {
    try {
      const file = Bun.file(p);
      if (await file.exists()) {
        const data = await file.json();
        if (data && typeof data === "object") {
          let raw = (data as any).provider && typeof (data as any).provider === "object" ? (data as any).provider : data;
          if (raw && (raw.baseUrl || raw.apiKey || raw.model || raw.provider || raw['base-url'] || raw['api-key'])) {
            const norm: any = {};
            if (raw.baseUrl || raw['base-url'] || raw.base_url) norm.baseUrl = raw.baseUrl || raw['base-url'] || raw.base_url;
            if (raw.apiKey || raw['api-key'] || raw.api_key) norm.apiKey = raw.apiKey || raw['api-key'] || raw.api_key;
            if (raw.model) norm.model = raw.model;
            if (raw.provider) norm.provider = raw.provider;
            if (Object.keys(norm).length) {
              console.log(`[boot] loaded provider config from ${p}`);
              return norm;
            }
          }
        }
      }
    } catch {
      // silent: bad JSON, permission, etc. — config is optional convenience
    }
  }
  return {};
}

async function boot() {
  const cli = parseCliArgs(process.argv);
  if (cli.help) {
    console.log('holoiconic — CLI flags for trivial custom OpenAI launch: bun src/boot.ts --openai-base-url=URL|-b --openai-api-key=KEY|-k --model=MODEL|-m --provider=p --api-port=N|--port=N --web-port=N --help ; also supports persistent .holoiconic.json (or holoiconic.config.json in cwd or ~/) with {provider:{baseUrl,apiKey,model,provider}}; precedence CLI > config > env ; via bun start -- --flags');
    process.exit(0);
  }

  const configProv = await loadConfigProvider();

  // Apply config (>env) then CLI (>config) so precedence CLI > config file > env (covers main+nodes+REPL env reads)
  if (!cli['openai-base-url'] && configProv.baseUrl) {
    const v = configProv.baseUrl;
    process.env.OPENAI_BASE_URL = v;
    process.env.OPENAI_API_BASE = v;
    if ((globalThis as any).Bun?.env) (globalThis as any).Bun.env.OPENAI_BASE_URL = v;
  }
  if (!cli['openai-api-key'] && configProv.apiKey) {
    const v = configProv.apiKey;
    process.env.OPENAI_API_KEY = v;
    if ((globalThis as any).Bun?.env) (globalThis as any).Bun.env.OPENAI_API_KEY = v;
  }
  if (!cli.model && configProv.model) {
    const v = configProv.model;
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
  // CLI overrides for provider fields (after possible config sets)
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

  // 1. Connect to libSQL — Turso Cloud if TURSO_URL is set, else local file
  const db = createDatabase("holoiconic.db");

  // 2. Init schema (idempotent)
  await initSchema(db);

  // 3. Create the context with 6 naive primitives
  const ctx = createCtx(db);

  // Attach CLI-or-config provider to ctx._providerConfig / _globalProvider (REPL + other paths pick up);
  // configProv already applied to env; here we set ctx for same precedence (CLI > config > env-only).
  const prov: any = {};
  if (cli['openai-base-url'] || configProv.baseUrl) prov.baseUrl = cli['openai-base-url'] || configProv.baseUrl;
  if (cli['openai-api-key'] || configProv.apiKey) prov.apiKey = cli['openai-api-key'] || configProv.apiKey;
  if (cli.model || configProv.model) prov.model = cli.model || configProv.model;
  if (cli.provider || configProv.provider) prov.provider = cli.provider || configProv.provider;
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
