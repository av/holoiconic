/** @param {import('../ctx').Ctx} ctx */
/** @param {any} args */

const op = args && args.op;
if (!op) throw new Error('[runtime:adapter] args.op is required');

// ── serve ─────────────────────────────────────────────────────────
// Start an HTTP server.  Returns { stop(): Promise<void>, port: number }.
// Uses Bun.serve when available, falls back to node:http.
if (op === 'serve') {
  const port = args.port;
  const fetchHandler = args.fetch;
  if (!fetchHandler || typeof fetchHandler !== 'function') {
    throw new Error('[runtime:adapter] args.fetch (function) is required for serve');
  }

  // Bun native path
  if (typeof Bun !== 'undefined' && Bun.serve) {
    const server = Bun.serve({ port, fetch: fetchHandler });
    return {
      stop: async () => { server.stop(true); },
      port: server.port || port,
    };
  }

  // Node fallback (Node 18+ — Request/Response globals required)
  const http = await import('node:http');

  const nodeServer = http.createServer(async (req, res) => {
    try {
      // Build Request
      const protocol = req.headers['x-forwarded-proto'] || 'http';
      const host = req.headers.host || 'localhost';
      const url = `${protocol}://${host}${req.url}`;

      const headers = new Headers();
      for (const [key, values] of Object.entries(req.headers)) {
        if (values == null) continue;
        if (Array.isArray(values)) {
          for (const v of values) headers.append(key, v);
        } else {
          headers.append(key, values);
        }
      }

      let body = undefined;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        body = Buffer.concat(chunks);
      }

      const request = new Request(url, { method: req.method, headers, body });
      const response = await fetchHandler(request);

      res.statusCode = response.status;
      res.statusMessage = response.statusText;
      for (const [key, value] of response.headers.entries()) {
        res.setHeader(key, value);
      }

      // Streaming body (ReadableStream) — pipe via getReader()
      if (response.body && typeof response.body.getReader === 'function') {
        const reader = response.body.getReader();
        const pump = async () => {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) { res.end(); return; }
              res.write(Buffer.from(value));
            }
          } catch (err) {
            res.destroy(err);
          }
        };
        pump();
        return;
      }

      // Non-streaming body — buffer and send
      const buf = await response.arrayBuffer();
      res.end(Buffer.from(buf));
    } catch (err) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end(err.message || String(err));
      }
    }
  });

  await new Promise((resolve) => nodeServer.listen(port, () => resolve(undefined)));

  return {
    stop: () => new Promise((resolve) => nodeServer.close(() => resolve(undefined))),
    port,
  };
}

// ── spawn ─────────────────────────────────────────────────────────
// Spawn a child process.  Returns { stdout, stderr, exitCode }.
if (op === 'spawn') {
  const spawnArgs = args.args;
  if (!Array.isArray(spawnArgs) || spawnArgs.length === 0) {
    throw new Error('[runtime:adapter] args.args (string[]) is required for spawn');
  }

  // Bun native path
  if (typeof Bun !== 'undefined' && Bun.spawn) {
    const proc = Bun.spawn(spawnArgs, { stdout: 'pipe', stderr: 'pipe' });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  }

  // Node fallback — mirror Bun behavior exactly: stdio pipes, always resolve with
  // {stdout, stderr, exitCode} (non-zero exitCode is normal "failure", caller decides),
  // attach any collected stderr to launch errors.
  const { spawn } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    const proc = spawn(spawnArgs[0], spawnArgs.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    if (proc.stdout) proc.stdout.on('data', (d) => { stdout += d.toString(); });
    if (proc.stderr) proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => resolve({ stdout, stderr, exitCode: code ?? 0 }));
    proc.on('error', (err) => {
      err.stderr = stderr;
      reject(err);
    });
  });
}

// ── readFile ────────────────────────────────────────────────────────
// Read a file as UTF-8 text.
if (op === 'readFile') {
  const path = args.path;
  if (!path) throw new Error('[runtime:adapter] args.path is required for readFile');

  if (typeof Bun !== 'undefined' && Bun.file) {
    return await Bun.file(path).text();
  }

  const { readFileSync } = await import('node:fs');
  return readFileSync(path, 'utf-8');
}

// ── writeFile ──────────────────────────────────────────────────────
// Write a string to a file.
if (op === 'writeFile') {
  const path = args.path;
  const content = args.content;
  if (!path) throw new Error('[runtime:adapter] args.path is required for writeFile');
  if (typeof content !== 'string') throw new Error('[runtime:adapter] args.content (string) is required for writeFile');

  if (typeof Bun !== 'undefined' && Bun.write) {
    await Bun.write(path, content);
    return;
  }

  const { writeFileSync } = await import('node:fs');
  writeFileSync(path, content, 'utf-8');
  return;
}

throw new Error('[runtime:adapter] unknown op: ' + op);
