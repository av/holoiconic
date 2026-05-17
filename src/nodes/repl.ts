/** @param {import('../ctx').Ctx} ctx */
/** @param {any} args */

const signal = args && args.signal;
const readline = await import('node:readline');

// TUI rendering via @mariozechner/pi-tui (from the pi-mono monorepo)
// Provides markdown rendering, syntax highlighting, and formatted display
const piTui = await import('@mariozechner/pi-tui');
const { Markdown } = piTui;

// pi-mono TUI theme for markdown rendering in the repl
const piMonoTheme = {
  heading: (t) => '\x1b[1;36m\x1b[1m\x1b[4m' + t + '\x1b[0m',
  link: (t) => '\x1b[4;34m' + t + '\x1b[0m',
  linkUrl: (t) => '\x1b[2;34m' + t + '\x1b[0m',
  code: (t) => '\x1b[43;30m ' + t + ' \x1b[0m',
  codeBlock: (t) => '\x1b[2m' + t + '\x1b[0m',
  codeBlockBorder: (t) => '\x1b[2m' + t + '\x1b[0m',
  quote: (t) => '\x1b[3;37m' + t + '\x1b[0m',
  quoteBorder: (t) => '\x1b[2;37m' + t + '\x1b[0m',
  hr: (t) => '\x1b[2m' + t + '\x1b[0m',
  listBullet: (t) => '\x1b[33m' + t + '\x1b[0m',
  bold: (t) => '\x1b[1m' + t + '\x1b[0m',
  italic: (t) => '\x1b[3m' + t + '\x1b[0m',
  strikethrough: (t) => '\x1b[9m' + t + '\x1b[0m',
  underline: (t) => '\x1b[4m' + t + '\x1b[0m',
};

// Render markdown text to the terminal using pi-mono's Markdown component
function renderMarkdown(text) {
  const cols = process.stdout.columns || 80;
  const md = new Markdown(text, 0, 0, piMonoTheme);
  const lines = md.render(cols);
  return lines.join('\n');
}

// Format tool-call display using pi-mono markdown rendering
function renderToolCall(toolName, toolInput) {
  const inputStr = typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput, null, 2);
  const md = '**\u{1f527} ' + toolName + '**\n\n\`\`\`json\n' + inputStr + '\n\`\`\`';
  return renderMarkdown(md);
}

// Patch for .provider: wrapper around ctx.call that injects per-session custom provider
// (baseUrl, apiKey, model, provider) from ctx._providerConfig into agent:loop/llm/embed calls.
// This makes chat + explicit .call use the REPL override (caller-provided args win over config).
// Stored in ctx._ (in-memory runtime state, like _mockFaux) — not graph-persisted.
function makeCallInjectingProvider(ctx) {
  const targets = ['agent:loop', 'llm', 'embed'];
  return async (name, callArgs = {}) => {
    if (targets.includes(name) && ctx._providerConfig) {
      callArgs = { ...ctx._providerConfig, ...callArgs };
    }
    return callInjectingProvider(name, callArgs);
  };
}

// Create a persistent session ID for this REPL instance
let sessionId = 'repl:' + Date.now();
console.log('[repl] session: ' + sessionId);

// In-memory per-REPL-session provider override (set via .provider set/show/clear)
if (!ctx._providerConfig) ctx._providerConfig = null;
const callInjectingProvider = makeCallInjectingProvider(ctx);

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

    } else if (trimmed.startsWith('.insert ')) {
      const parts = trimmed.slice(8).split(' ');
      if (parts.length < 3) { console.log('usage: .insert subject predicate object [--g graph]'); }
      else {
        const ggIdx = parts.indexOf('--g');
        let s = parts[0], p = parts[1], o, g;
        if (ggIdx !== -1 && ggIdx + 1 < parts.length) {
          g = parts[ggIdx + 1];
          o = parts.slice(2, ggIdx).join(' ');
        } else {
          o = parts.slice(2).join(' ');
        }
        const q = await ctx.insert(s, p, o, g || '_');
        console.log('inserted:', JSON.stringify(q));
      }

    } else if (trimmed.startsWith('.remove ')) {
      const parts = trimmed.slice(8).split(' ');
      if (parts.length < 3) { console.log('usage: .remove subject predicate object [--g graph]'); }
      else {
        const ggIdx = parts.indexOf('--g');
        let s = parts[0], p = parts[1], o, g;
        if (ggIdx !== -1 && ggIdx + 1 < parts.length) {
          g = parts[ggIdx + 1];
          o = parts.slice(2, ggIdx).join(' ');
        } else {
          o = parts.slice(2).join(' ');
        }
        await ctx.remove(s, p, o, g || '_');
        console.log('removed');
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
      const result = await callInjectingProvider(name, callArgs);
      console.log('result:', JSON.stringify(result, null, 2));

    } else if (trimmed === '.nodes') {
      const results = await ctx.query({ predicate: 'type', object: 'Function' });
      for (const q of results) console.log(' ', q.subject);

    } else if (trimmed === '.session') {
      console.log('session: ' + sessionId);

    } else if (trimmed.startsWith('.source ')) {
      const name = trimmed.slice(8).trim();
      const rs = await ctx.query({ subject: name, predicate: 'source' });
      if (rs.length === 0) { console.log('no source found for: ' + name); }
      else { console.log(renderMarkdown('```js\n' + rs[0].object + '\n```')); }

    } else if (trimmed.startsWith('.edit ')) {
      const name = trimmed.slice(5).trim();
      const rs = await ctx.query({ subject: name, predicate: 'source' });
      if (rs.length === 0) {
        console.log('no source found for: ' + name);
      } else {
        const oldSource = rs[0].object;
        console.log('--- current source for ' + name + ' ---');
        console.log(oldSource);
        console.log('--- enter new source (type .done on its own line to finish) ---');
        const lines = [];
        for await (const editLine of rl) {
          if (editLine.trim() === '.done') break;
          lines.push(editLine);
        }
        if (lines.length === 0) {
          console.log('(empty input, no changes)');
        } else {
          const newSource = lines.join('\n');
          await ctx.remove(name, 'source');
          await ctx.insert(name, 'source', newSource);
          console.log('source updated for: ' + name);
        }
      }

    } else if (trimmed.startsWith('.create ')) {
      const name = trimmed.slice(8).trim();
      const existing = await ctx.query({ subject: name, predicate: 'type', object: 'Function' });
      if (existing.length > 0) {
        console.log('node already exists: ' + name);
      } else {
        console.log('enter source for ' + name + ' (type .done on its own line to finish):');
        const lines = [];
        for await (const editLine of rl) {
          if (editLine.trim() === '.done') break;
          lines.push(editLine);
        }
        if (lines.length === 0) {
          console.log('(empty input, node not created)');
        } else {
          const source = lines.join('\n');
          await ctx.insert(name, 'type', 'Function');
          await ctx.insert(name, 'source', source);
          console.log('created node: ' + name);
        }
      }

    } else if (trimmed.startsWith('.spawn ')) {
      const name = trimmed.slice(7).trim();
      await callInjectingProvider('spawn', { node: name });
      console.log('spawned: ' + name);

    } else if (trimmed === '.sessions') {
      const msgQuads = await ctx.query({ predicate: 'message' });
      const sessions = new Set();
      for (const q of msgQuads) sessions.add(q.graph);
      if (sessions.size === 0) { console.log('(no sessions)'); }
      else {
        for (const s of sessions) console.log(' ', s);
      }

    } else if (trimmed.startsWith('.resume ')) {
      const target = trimmed.slice(8).trim();
      if (!target) { console.log('usage: .resume <sessionId>'); }
      else {
        const msgQuads = await ctx.query({ predicate: 'message', graph: target });
        if (msgQuads.length === 0) {
          console.log('no messages found in session: ' + target);
        } else {
          sessionId = target;
          console.log('resumed session: ' + sessionId + ' (' + msgQuads.length + ' messages)');
        }
      }

    } else if (trimmed.startsWith('.export')) {
      const path = trimmed.slice(7).trim() || undefined;
      const result = await callInjectingProvider('snapshot:export', path ? { path } : {});
      if (path) {
        console.log('exported ' + result.count + ' quads to ' + result.path);
      } else {
        console.log(result);
      }

    } else if (trimmed.startsWith('.import ')) {
      const path = trimmed.slice(8).trim();
      if (!path) { console.log('usage: .import <path>'); }
      else {
        const result = await callInjectingProvider('snapshot:import', { path });
        console.log('imported ' + result.count + ' quads from ' + path);
      }

    } else if (trimmed.startsWith('.deps ')) {
      const name = trimmed.slice(6).trim();
      if (!name) { console.log('usage: .deps <name>'); }
      else {
        const result = await callInjectingProvider('graph:deps', { node: name });
        console.log('node: ' + result.node);
        console.log('calls: ' + (result.calls.length > 0 ? result.calls.join(', ') : '(none)'));
        console.log('calledBy: ' + (result.calledBy.length > 0 ? result.calledBy.join(', ') : '(none)'));
      }

    } else if (trimmed.startsWith('.inspect ')) {
      const name = trimmed.slice(9).trim();
      if (!name) { console.log('usage: .inspect <name>'); }
      else {
        const result = await callInjectingProvider('inspect', { node: name });
        console.log(JSON.stringify(result, null, 2));
      }

    } else if (trimmed.startsWith('.versions ')) {
      const name = trimmed.slice(10).trim();
      if (!name) { console.log('usage: .versions <name>'); }
      else {
        const result = await callInjectingProvider('version:list', { name });
        if (result.count === 0) {
          console.log('no versions found for: ' + name);
        } else {
          console.log('versions for ' + name + ' (' + result.count + '):');
          for (const v of result.versions) {
            console.log('  seq ' + v.seq + '  ' + v.timestamp + '  (' + v.sourceLength + ' chars)');
          }
        }
      }

    } else if (trimmed.startsWith('.restore ')) {
      const parts = trimmed.slice(9).trim().split(/\s+/);
      if (parts.length < 2) { console.log('usage: .restore <name> <seq>'); }
      else {
        const name = parts[0];
        const seq = parseInt(parts[1]);
        if (isNaN(seq)) { console.log('seq must be a number'); }
        else {
          const result = await callInjectingProvider('version:restore', { name, seq });
          console.log('restored ' + name + ' to version ' + result.seq + ' (from ' + result.timestamp + ')');
        }
      }

    } else if (trimmed.startsWith('.cron ')) {
      const parts = trimmed.slice(6).trim().split(/\s+/);
      if (parts.length < 2) { console.log('usage: .cron <name> <interval_ms>'); }
      else {
        const node = parts[0];
        const interval = parseInt(parts[1]);
        if (isNaN(interval) || interval < 100) { console.log('interval must be a number >= 100'); }
        else {
          const result = await callInjectingProvider('cron', { node, interval });
          console.log('cron started: ' + result.cronId);
        }
      }

    } else if (trimmed.startsWith('.cron-stop ')) {
      const cronId = trimmed.slice(11).trim();
      if (!cronId) { console.log('usage: .cron-stop <cronId>'); }
      else {
        const result = await callInjectingProvider('cron:stop', { cronId });
        console.log('stopped: ' + result.cronId);
      }

    } else if (trimmed === '.crons') {
      const result = await callInjectingProvider('cron:list');
      if (result.count === 0) {
        console.log('(no cron jobs)');
      } else {
        for (const j of result.jobs) {
          console.log('  ' + j.cronId + '  node=' + j.node + '  interval=' + j.interval + 'ms  status=' + j.status);
        }
      }

    } else if (trimmed === '.metrics') {
      const report = await callInjectingProvider('metrics:report');
      console.log(report);

    } else if (trimmed.startsWith('.provider')) {
      const rest = trimmed.slice(9).trim();
      if (!rest || rest === 'show') {
        if (ctx._providerConfig) {
          console.log('current provider override:');
          console.log('  baseUrl:   ' + (ctx._providerConfig.baseUrl || '(none)'));
          console.log('  apiKey:    ' + (ctx._providerConfig.apiKey ? '***' + ctx._providerConfig.apiKey.slice(-4) : '(none)'));
          console.log('  model:     ' + (ctx._providerConfig.model || '(none)'));
          console.log('  provider:  ' + (ctx._providerConfig.provider || '(default openai)'));
        } else {
          console.log('no provider override set (falls back to env vars or mock:llm)');
        }
      } else if (rest === 'clear') {
        ctx._providerConfig = null;
        console.log('provider override cleared for this REPL session');
      } else if (rest.startsWith('set ')) {
        const argsStr = rest.slice(4).trim();
        const parts = argsStr.split(/\s+/);
        const config = ctx._providerConfig ? { ...ctx._providerConfig } : {};
        for (let i = 0; i < parts.length; i++) {
          let k = parts[i];
          if (k.startsWith('--')) {
            const val = parts[i + 1];
            if (val && !val.startsWith('--')) {
              if (k === '--base' || k === '--baseUrl' || k === '--url') config.baseUrl = val;
              else if (k === '--key' || k === '--apiKey' || k === '--apikey') config.apiKey = val;
              else if (k === '--model') config.model = val;
              else if (k === '--provider' || k === '--prov') config.provider = val;
              i++;
            }
          }
        }
        if (!config.baseUrl && !config.apiKey && !config.model && !config.provider) {
          console.log('usage: .provider set --base <url> [--key <key>] [--model <model>] [--provider <name>]');
        } else {
          ctx._providerConfig = config;
          console.log('provider override set for this REPL session:');
          console.log('  baseUrl:  ' + (config.baseUrl || '(env)'));
          console.log('  model:    ' + (config.model || '(env)'));
          console.log('  provider: ' + (config.provider || '(openai)'));
          console.log('(subsequent chat and .call agent:loop/llm/embed will use it; .provider clear to reset)');
        }
      } else {
        console.log('usage: .provider [show|clear|set --base <url> --key <k> --model <m> [--provider <p>]]');
        console.log('  e.g. .provider set --base https://api.groq.com/openai --key $GROQ_KEY --model llama-3.1-70b');
      }

    } else if (trimmed.startsWith('.eval ')) {
      const code = trimmed.slice(6);
      const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;
      const fn = new AsyncFn('ctx', code);
      const result = await fn(ctx);
      if (result !== undefined) console.log(result);

    } else if (trimmed === '.help') {
      console.log('commands:');
      console.log('  .query {"subject":"...","predicate":"..."}  — query quads by pattern');
      console.log('  .insert subject predicate object [--g graph]     — insert a quad');
      console.log('  .remove subject predicate object [--g graph]    — remove a quad');
      console.log('  .call name [argsJSON]          — call a node');
      console.log('  .nodes                        — list all Function nodes');
      console.log('  .source <name>                — view a node source');
      console.log('  .edit <name>                  — edit a node source inline');
      console.log('  .create <name>                — create a new node interactively');
      console.log('  .spawn <name>                 — spawn a node');
      console.log('  .sessions                     — list sessions');
      console.log('  .resume <sessionId>           — resume a previous session');
      console.log('  .export [path]                — export snapshot');
      console.log('  .import <path>                — import snapshot');
      console.log('  .deps <name>                  — show node dependencies');
      console.log('  .inspect <name>               — comprehensive node info');
      console.log('  .versions <name>              — list saved versions of a node');
      console.log('  .restore <name> <seq>         — restore a node to a specific version');
      console.log('  .cron <name> <interval_ms>    — run a node on a timer');
      console.log('  .cron-stop <cronId>           — stop a cron job');
      console.log('  .crons                        — list cron jobs');
      console.log('  .metrics                      — show metrics report');
      console.log('  .provider set --base <url> [--key <k>] [--model <m>] [--provider <p>]  — set per-REPL custom OpenAI-compatible provider');
      console.log('  .provider show                — show current override (for chat / .call llm/agent:loop/embed)');
      console.log('  .provider clear               — clear the override for this session');
      console.log('  .eval <code>                  — eval code with ctx');
      console.log('  .session                      — show current session ID');
      console.log('  .help                         — this help');

    } else if (trimmed.startsWith('.')) {
      console.log('unknown command. type .help');

    } else {
      // Route through agent:loop with persistent session, streaming text deltas to stdout
      let streamed = false;
      const result = await callInjectingProvider('agent:loop', {
        prompt: trimmed,
        session: sessionId,
        stream: true,
        onDelta: (delta) => { streamed = true; process.stdout.write(delta); },
      });
      // After streaming, print newline
      if (streamed) console.log('');
      // If no streaming occurred, render response with pi-mono markdown
      else if (result.response) console.log(renderMarkdown(result.response));
      // Display tool calls via pi-mono TUI rendering
      if (result.tool_calls && result.tool_calls.length > 0) {
        for (const tc of result.tool_calls) {
          console.log(renderToolCall(tc.name, tc.input));
        }
      }
    }
  } catch (err) {
    console.error('error:', err.message || err);
  }

  rl.prompt();
}

console.log('[repl] exited');
