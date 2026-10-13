// Signal before importing persistence, so the parent holds the lock during startup.
process.stdout.write('opening\n');
const { db } = await import('../../src/core/store.js');
process.stdout.write(JSON.stringify({ journal: db.prepare('PRAGMA journal_mode').get(), timeout: db.prepare('PRAGMA busy_timeout').get() }) + '\n');
db.close();
