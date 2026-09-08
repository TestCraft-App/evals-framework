import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError } from './validation.mjs';

function requireScope(scope) {
  if (!scope?.ownerId || !scope?.workshopId) throw new Error('A private workspace scope is required.');
  return [scope.ownerId, scope.workshopId];
}

export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS evaluations (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, data TEXT NOT NULL);`);
    // Additive migration: existing rows remain unowned, never claimed by a visitor.
    for (const table of ['evaluations', 'runs']) {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name);
      for (const column of ['owner_id', 'workshop_id']) if (!columns.includes(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS ${table}_workspace ON ${table}(owner_id, workshop_id)`);
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, owner_id TEXT NOT NULL UNIQUE, workshop_id TEXT NOT NULL, access_version TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS access_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS model_usage (workshop_id TEXT PRIMARY KEY, used INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS model_reservations (item_id TEXT PRIMARY KEY, workshop_id TEXT NOT NULL, remaining INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS reservations_workshop ON model_reservations(workshop_id);`);
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  recoverInterruptedRuns() {
    // Preserve unfinished evidence without replaying paid calls after a restart.
    this.transaction(() => {
      for (const row of this.db.prepare('SELECT id, data FROM runs').all()) {
        const run = JSON.parse(row.data);
        if (['queued', 'running'].includes(run.status)) {
          run.status = 'interrupted'; run.finishedAt = new Date().toISOString();
          for (const item of run.items) if (['queued', 'generating', 'grading'].includes(item.status)) {
            item.status = 'error'; item.error = 'Server restarted before this evaluation finished. Run it again.';
            item.events.push({ at: new Date().toISOString(), message: item.error });
          }
          this.db.prepare('UPDATE runs SET data=? WHERE id=?').run(JSON.stringify(run), row.id);
        }
      }
      this.db.exec('DELETE FROM model_reservations');
    });
  }
  evaluations(scope) {
    return this.db.prepare('SELECT data FROM evaluations WHERE owner_id=? AND workshop_id=?').all(...requireScope(scope)).map(row => JSON.parse(row.data)).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
  }
  evaluation(id, scope) { const row = this.db.prepare('SELECT data FROM evaluations WHERE id=? AND owner_id=? AND workshop_id=?').get(id, ...requireScope(scope)); return row && JSON.parse(row.data); }
  create(data, scope) {
    const record = { ...data, id: randomUUID(), createdAt: new Date().toISOString() };
    this.db.prepare('INSERT INTO evaluations (id,data,owner_id,workshop_id) VALUES (?,?,?,?)').run(record.id, JSON.stringify(record), ...requireScope(scope));
    return record;
  }
  runs(scope) { return this.db.prepare('SELECT data FROM runs WHERE owner_id=? AND workshop_id=?').all(...requireScope(scope)).map(row => JSON.parse(row.data)).sort((a,b) => b.createdAt.localeCompare(a.createdAt)); }
  run(id, scope) { const row = this.db.prepare('SELECT data FROM runs WHERE id=? AND owner_id=? AND workshop_id=?').get(id, ...requireScope(scope)); return row && JSON.parse(row.data); }
  saveRun(run, scope) {
    const result = this.db.prepare(`INSERT INTO runs (id,data,owner_id,workshop_id) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data WHERE runs.owner_id=excluded.owner_id AND runs.workshop_id=excluded.workshop_id`).run(run.id, JSON.stringify(run), ...requireScope(scope));
    if (!result.changes) throw new Error('Run workspace mismatch.');
  }
  budget(workshopId, limit) {
    const used = this.db.prepare('SELECT used FROM model_usage WHERE workshop_id=?').get(workshopId)?.used || 0;
    const reserved = this.db.prepare('SELECT COALESCE(SUM(remaining),0) AS total FROM model_reservations WHERE workshop_id=?').get(workshopId).total;
    return { limit, used, reserved, remaining: Math.max(0, limit - used - reserved), unit: 'model_calls' };
  }
  reserveRun(run, scope, limit) {
    return this.transaction(() => {
      const reservations = run.items.map(item => ({ id: item.id, calls: Number(item.evaluation.source !== 'pasted') + Number(item.evaluation.method === 'model_grade') }));
      if (reservations.reduce((sum, item) => sum + item.calls, 0) > this.budget(scope.workshopId, limit).remaining) throw new AppError('The workshop model-call allowance is insufficient for this batch. Try fewer evaluations, or use pasted output with Rule-based grading.', 429);
      this.saveRun(run, scope);
      for (const item of reservations) if (item.calls) this.db.prepare('INSERT INTO model_reservations VALUES (?,?,?)').run(item.id, scope.workshopId, item.calls);
    });
  }
  consumeCall(itemId, workshopId) {
    this.transaction(() => {
      const result = this.db.prepare('UPDATE model_reservations SET remaining=remaining-1 WHERE item_id=? AND workshop_id=? AND remaining>0').run(itemId, workshopId);
      if (!result.changes) throw new AppError('No model-call allowance was reserved for this evaluation.', 429);
      this.db.prepare('INSERT INTO model_usage VALUES (?,1) ON CONFLICT(workshop_id) DO UPDATE SET used=used+1').run(workshopId);
    });
  }
  releaseCalls(itemId) { this.db.prepare('DELETE FROM model_reservations WHERE item_id=?').run(itemId); }
  close() { this.db.close(); }
}
