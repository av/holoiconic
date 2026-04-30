import type { Ctx } from "./ctx.ts";

// ── Node source code ──────────────────────────────────────────────
// Each value is a valid AsyncFunction body receiving (ctx, args).
// Nodes CANNOT use import statements. They CAN use Bun globals.

const nodes: Record<string, string> = {

  // ── sys:compiler ────────────────────────────────────────────────
  // Replaces ctx.call with a cached, reactively-invalidated version.
  "sys:compiler": `
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const cache = new Map();
const nodeStorage = ctx._nodeStorage;
const originalCall = ctx.call.bind(ctx);

ctx.call = async function cachedCall(name, callArgs) {
  let fn = cache.get(name);
  if (!fn) {
    const rs = await ctx.query({ s: name, p: 'source' });
    if (rs.length === 0) {
      throw new Error('[ctx.call] no source found for node: ' + name);
    }
    fn = new AsyncFunction('ctx', 'args', rs[0].o);
    cache.set(name, fn);
  }
  return nodeStorage.run(name, () => fn(ctx, callArgs));
};

// Watch for source changes and invalidate cache
ctx.on({ p: 'source' }, (change) => {
  cache.delete(change.quad.s);
});

console.log('[sys:compiler] installed — ctx.call now cached and reactive');
`,

  // ── sys:supervisor ──────────────────────────────────────────────
  // Watches for spawned nodes and manages lifecycle.
  "sys:supervisor": `
const controllers = new Map();
const signal = args && args.signal;

// Watch for new spawned nodes
ctx.on({ p: 'type', o: 'Spawned' }, async (change) => {
  if (change.type === 'assert') {
    const name = change.quad.s;
    console.log('[sys:supervisor] registered spawned node:', name);
  }
});

// Watch for source changes on spawned nodes — restart them
ctx.on({ p: 'source' }, async (change) => {
  const name = change.quad.s;
  if (change.type !== 'assert') return;
  const spawned = await ctx.query({ s: name, p: 'type', o: 'Spawned' });
  if (spawned.length === 0) return;

  const ac = controllers.get(name);
  if (ac) {
    console.log('[sys:supervisor] restarting:', name);
    await ctx.assert(name, 'lifecycle', 'cleanup');
    ac.abort();
    await ctx.retract(name, 'lifecycle', 'cleanup');

    const newAc = new AbortController();
    controllers.set(name, newAc);
    ctx.call(name, { signal: newAc.signal }).catch(err => {
      if (err.name !== 'AbortError') console.error('[sys:supervisor] node error:', name, err);
    });
  }
});

// Expose controller registration for spawn node
ctx._supervisorControllers = controllers;

// Keep alive until aborted
if (signal) {
  await new Promise((resolve) => {
    signal.addEventListener('abort', resolve, { once: true });
  });
  // Abort all managed nodes on shutdown
  for (const [name, ac] of controllers) {
    await ctx.assert(name, 'lifecycle', 'cleanup');
    ac.abort();
  }
  console.log('[sys:supervisor] shut down');
}
`,

  // ── spawn ───────────────────────────────────────────────────────
  // Starts a supervised long-lived node.
  "spawn": `
const node = args && args.node;
if (!node) throw new Error('[spawn] args.node is required');

const ac = new AbortController();

// Register with supervisor
await ctx.assert(node, 'type', 'Spawned');

// Store controller in supervisor's map if available
if (ctx._supervisorControllers) {
  ctx._supervisorControllers.set(node, ac);
}

const spawnArgs = { ...(args.args || {}), signal: ac.signal };
// Fire and forget — spawned nodes are long-lived
ctx.call(node, spawnArgs).catch(err => {
  if (err.name !== 'AbortError') console.error('[spawn] node error:', node, err);
});

return ac;
`,

  // ── shell ───────────────────────────────────────────────────────
  // Executes a shell command and returns stdout.
  "shell": `
const cmd = args && args.cmd;
if (!cmd) throw new Error('[shell] args.cmd is required');

const proc = Bun.spawn(['sh', '-c', cmd], {
  stdout: 'pipe',
  stderr: 'pipe',
});

const stdout = await new Response(proc.stdout).text();
const stderr = await new Response(proc.stderr).text();
const exitCode = await proc.exited;

if (exitCode !== 0) {
  throw new Error('[shell] command failed (exit ' + exitCode + '): ' + stderr);
}

return stdout;
`,

  // ── llm ─────────────────────────────────────────────────────────
  // Stub — returns placeholder until LLM is configured.
  "llm": `
const messages = args && args.messages;
const model = (args && args.model) || 'default';
console.log('[llm] stub called with model:', model, 'messages:', messages && messages.length);
return {
  role: 'assistant',
  content: '[llm stub] LLM not yet configured. Model: ' + model,
};
`,

  // ── repl ────────────────────────────────────────────────────────
  // Basic REPL for interactive use.
  "repl": `
const signal = args && args.signal;
const readline = await import('node:readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: 'holo> ',
});

if (signal) {
  signal.addEventListener('abort', () => {
    rl.close();
  }, { once: true });
}

rl.prompt();

for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) { rl.prompt(); continue; }

  try {
    if (trimmed.startsWith('.query ')) {
      const pattern = JSON.parse(trimmed.slice(7));
      const results = await ctx.query(pattern);
      console.log(JSON.stringify(results, null, 2));

    } else if (trimmed.startsWith('.assert ')) {
      const parts = trimmed.slice(8).split(' ');
      if (parts.length < 3) { console.log('usage: .assert s p o [g]'); }
      else {
        const q = await ctx.assert(parts[0], parts[1], parts.slice(2).join(' '));
        console.log('asserted:', JSON.stringify(q));
      }

    } else if (trimmed.startsWith('.retract ')) {
      const parts = trimmed.slice(9).split(' ');
      if (parts.length < 3) { console.log('usage: .retract s p o [g]'); }
      else {
        await ctx.retract(parts[0], parts[1], parts.slice(2).join(' '));
        console.log('retracted');
      }

    } else if (trimmed.startsWith('.call ')) {
      const rest = trimmed.slice(6);
      const spaceIdx = rest.indexOf(' ');
      let name, callArgs;
      if (spaceIdx === -1) {
        name = rest;
        callArgs = undefined;
      } else {
        name = rest.slice(0, spaceIdx);
        callArgs = JSON.parse(rest.slice(spaceIdx + 1));
      }
      const result = await ctx.call(name, callArgs);
      console.log('result:', JSON.stringify(result, null, 2));

    } else if (trimmed === '.nodes') {
      const results = await ctx.query({ p: 'type', o: 'Function' });
      for (const q of results) console.log(' ', q.s);

    } else if (trimmed === '.help') {
      console.log('commands:');
      console.log('  .query {"s":"...","p":"..."}  — query quads by pattern');
      console.log('  .assert s p o                 — assert a quad');
      console.log('  .retract s p o                — retract a quad');
      console.log('  .call name [argsJSON]          — call a node');
      console.log('  .nodes                        — list all Function nodes');
      console.log('  .help                         — this help');

    } else {
      console.log('unknown command. type .help');
    }
  } catch (err) {
    console.error('error:', err.message || err);
  }

  rl.prompt();
}

console.log('[repl] exited');
`,

  // ── main ────────────────────────────────────────────────────────
  // Entry point: boots compiler, supervisor, then REPL.
  "main": `
console.log('[main] booting holoiconic...');

// 1. Install the reactive compiler (replaces ctx.call)
await ctx.call('sys:compiler');

// 2. Spawn the supervisor (long-lived, manages other spawned nodes)
await ctx.call('spawn', { node: 'sys:supervisor' });

// Small delay to let supervisor initialize
await new Promise(r => setTimeout(r, 50));

// 3. Start the REPL
console.log('[main] holoiconic ready');
await ctx.call('spawn', { node: 'repl' });
`,

};

// ── Seeder ────────────────────────────────────────────────────────

export async function seedTemplate(ctx: Ctx): Promise<void> {
  console.log("[template] seeding graph with primitive nodes...");

  for (const [name, source] of Object.entries(nodes)) {
    await ctx.assert(name, "source", source);
    await ctx.assert(name, "type", "Function");
  }

  console.log(`[template] seeded ${Object.keys(nodes).length} nodes`);
}
