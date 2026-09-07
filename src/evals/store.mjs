import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS evaluations (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, data TEXT NOT NULL);`);
  }
  recoverInterruptedRuns() {
    // Preserve unfinished evidence without replaying paid calls after a restart.
    for (const run of this.runs()) {
      if (['queued', 'running'].includes(run.status)) {
        run.status = 'interrupted'; run.finishedAt = new Date().toISOString();
        for (const item of run.items) if (['queued', 'generating', 'grading'].includes(item.status)) {
          item.status = 'error'; item.error = 'Server restarted before this evaluation finished. Run it again.';
          item.events.push({ at: new Date().toISOString(), message: item.error });
        }
        this.saveRun(run);
      }
    }
  }
  evaluations() {
    return this.db.prepare('SELECT data FROM evaluations').all().map(row => JSON.parse(row.data)).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
  }
  evaluation(id) { const row = this.db.prepare('SELECT data FROM evaluations WHERE id=?').get(id); return row && JSON.parse(row.data); }
  create(data) {
    const record = { ...data, id: randomUUID(), createdAt: new Date().toISOString() };
    this.db.prepare('INSERT INTO evaluations VALUES (?,?)').run(record.id, JSON.stringify(record));
    return record;
  }
  runs() { return this.db.prepare('SELECT data FROM runs').all().map(row => JSON.parse(row.data)).sort((a,b) => b.createdAt.localeCompare(a.createdAt)); }
  run(id) { const row = this.db.prepare('SELECT data FROM runs WHERE id=?').get(id); return row && JSON.parse(row.data); }
  saveRun(run) { this.db.prepare('INSERT INTO runs VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(run.id, JSON.stringify(run)); }
  close() { this.db.close(); }
}
