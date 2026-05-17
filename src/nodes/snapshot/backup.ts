/** @param {import('../ctx').Ctx} ctx */
/** @param {any} args */

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const dest = (args && args.path) || ('holoiconic-backup-' + timestamp + '.db');

// The database file path — default is holoiconic.db
const srcPath = (args && args.srcPath) || 'holoiconic.db';

const srcFile = Bun.file(srcPath);
const exists = await srcFile.exists();
if (!exists) {
  throw new Error('[snapshot:backup] source database not found: ' + srcPath);
}

await Bun.write(dest, srcFile);
console.log('[snapshot:backup] backed up to ' + dest);
return { path: dest };
