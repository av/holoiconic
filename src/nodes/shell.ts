/** @param {import('../ctx').Ctx} ctx */
/** @param {any} args */

const cmd = args && args.cmd;
if (!cmd) throw new Error('[shell] args.cmd is required');

let result;
try {
  result = await ctx.call('runtime:adapter', { op: 'spawn', args: ['sh', '-c', cmd] });
} catch (e) {
  if (e.code === 'E2BIG') {
    throw new Error('[shell] command too long (' + cmd.length + ' chars) — exceeds OS argument limit');
  }
  throw e;
}

const { stdout, stderr, exitCode } = result;

if (exitCode !== 0) {
  throw new Error('[shell] command failed (exit ' + exitCode + '): ' + stderr);
}

return stdout;
