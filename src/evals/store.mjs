import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError, validateEvaluation } from './validation.mjs';
import { needsModelGrader } from './methods.mjs';

function requireScope(scope) {
  if (!scope?.ownerId || !scope?.workshopId) throw new Error('A private workspace scope is required.');
  return [scope.ownerId, scope.workshopId];
}

function readEvaluation(row) {
  if (!row) return undefined;
  const record = JSON.parse(row.data);
  return { ...record, suiteId: record.suiteId ?? '', revision: record.revision ?? 1 };
}

function requireObject(body, fields) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !fields.includes(key))) throw new AppError('Expected an object with only ' + fields.join(', ') + '.');
}

function requireName(name) {
  if (typeof name !== 'string' || !name.trim() || name.length > 140) throw new AppError('Name must be non-empty text (up to 140 characters).');
  return name.trim();
}

function requireRevision(revision, current) {
  if (!Number.isSafeInteger(revision) || revision < 1) throw new AppError('Revision must be a positive integer.');
  if (revision !== current || current === Number.MAX_SAFE_INTEGER) throw new AppError('This record has changed. Reload it before saving again.', 409);
}

export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS evaluations (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS suites (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, data TEXT NOT NULL);`);
    // Additive migration: existing rows remain unowned, never claimed by a visitor.
    for (const table of ['evaluations', 'runs', 'suites']) {
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
    return this.db.prepare('SELECT data FROM evaluations WHERE owner_id=? AND workshop_id=?').all(...requireScope(scope)).map(readEvaluation).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
  }
  evaluation(id, scope) { return readEvaluation(this.db.prepare('SELECT data FROM evaluations WHERE id=? AND owner_id=? AND workshop_id=?').get(id, ...requireScope(scope))); }
  #suiteId(value, scope) {
    requireScope(scope);
    if (value === undefined) return '';
    if (typeof value !== 'string') throw new AppError('Suite ID must be text.');
    const id = value.trim();
    if (id && !this.suite(id, scope)) throw new AppError('Suite not found.', 404);
    return id;
  }
  #insertEvaluation(data, scope) {
    const record = { ...data, suiteId: this.#suiteId(data.suiteId, scope), id: randomUUID(), createdAt: new Date().toISOString(), revision: 1 };
    this.db.prepare('INSERT INTO evaluations (id,data,owner_id,workshop_id) VALUES (?,?,?,?)').run(record.id, JSON.stringify(record), ...requireScope(scope));
    return record;
  }
  create(data, scope) { return this.transaction(() => this.#insertEvaluation(data, scope)); }
  updateEvaluation(id, data, revision, scope) {
    return this.transaction(() => {
      const current = this.evaluation(id, scope);
      if (!current) throw new AppError('Evaluation not found.', 404);
      requireRevision(revision, current.revision);
      const record = { ...data, suiteId: this.#suiteId(data.suiteId, scope), id: current.id, createdAt: current.createdAt, revision: current.revision + 1 };
      this.db.prepare('UPDATE evaluations SET data=? WHERE id=? AND owner_id=? AND workshop_id=?').run(JSON.stringify(record), id, ...requireScope(scope));
      return record;
    });
  }
  duplicateEvaluation(id, body, scope) {
    return this.transaction(() => {
      const current = this.evaluation(id, scope);
      if (!current) throw new AppError('Evaluation not found.', 404);
      requireObject(body, ['name']);
      const name = body.name === undefined ? current.name : requireName(body.name);
      // Copy stored legacy criteria as-is; running a copy uses the engine's normalizer.
      return this.#insertEvaluation({ ...current, name }, scope);
    });
  }
  deleteEvaluation(id, scope) {
    return this.transaction(() => {
      if (!this.evaluation(id, scope)) throw new AppError('Evaluation not found.', 404);
      const active = this.runs(scope).some(run => run.items.some(item => item.evaluationId === id &&
        (['queued', 'running'].includes(run.status) || ['queued', 'generating', 'grading'].includes(item.status))));
      if (active) throw new AppError('This evaluation has an active run. Wait for it to finish before deleting it.', 409);
      this.db.prepare('DELETE FROM evaluations WHERE id=? AND owner_id=? AND workshop_id=?').run(id, ...requireScope(scope));
      // Run snapshots and model usage remain independent of the library definition.
      return { deletedId: id };
    });
  }
  suites(scope) {
    return this.db.prepare('SELECT data FROM suites WHERE owner_id=? AND workshop_id=?').all(...requireScope(scope)).map(row => JSON.parse(row.data)).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
  }
  suite(id, scope) {
    const row = this.db.prepare('SELECT data FROM suites WHERE id=? AND owner_id=? AND workshop_id=?').get(id, ...requireScope(scope));
    return row && JSON.parse(row.data);
  }
  createSuite(body, scope) {
    requireObject(body, ['name']);
    const name = requireName(body.name), now = new Date().toISOString();
    const record = { id: randomUUID(), name, createdAt: now, updatedAt: now, revision: 1 };
    this.db.prepare('INSERT INTO suites (id,data,owner_id,workshop_id) VALUES (?,?,?,?)').run(record.id, JSON.stringify(record), ...requireScope(scope));
    return record;
  }
  updateSuite(id, body, scope) {
    return this.transaction(() => {
      const current = this.suite(id, scope);
      if (!current) throw new AppError('Suite not found.', 404);
      requireObject(body, ['name', 'revision']);
      const name = requireName(body.name);
      requireRevision(body.revision, current.revision ?? 1);
      const record = { ...current, name, updatedAt: new Date().toISOString(), revision: body.revision + 1 };
      this.db.prepare('UPDATE suites SET data=? WHERE id=? AND owner_id=? AND workshop_id=?').run(JSON.stringify(record), id, ...requireScope(scope));
      return record;
    });
  }
  deleteSuite(id, scope) {
    return this.transaction(() => {
      if (!this.suite(id, scope)) throw new AppError('Suite not found.', 404);
      for (const evaluation of this.evaluations(scope)) if (evaluation.suiteId === id) {
        const record = { ...evaluation, suiteId: '', revision: evaluation.revision + 1 };
        this.db.prepare('UPDATE evaluations SET data=? WHERE id=? AND owner_id=? AND workshop_id=?').run(JSON.stringify(record), evaluation.id, ...requireScope(scope));
      }
      this.db.prepare('DELETE FROM suites WHERE id=? AND owner_id=? AND workshop_id=?').run(id, ...requireScope(scope));
      return { deletedId: id };
    });
  }
  importWorkshop(bundle, scope) {
    return this.transaction(() => {
      const existing = this.suites(scope).find(suite => suite.seedKey === 'workshop-v1');
      if (existing) return { created: false, suite: existing, evaluations: this.evaluations(scope).filter(evaluation => evaluation.suiteId === existing.id) };
      requireObject(bundle, ['name', 'evaluations']);
      if (!Array.isArray(bundle.evaluations) || !bundle.evaluations.length) throw new AppError('Workshop import requires evaluations.');
      const suite = { ...this.createSuite({ name: bundle.name }, scope), seedKey: 'workshop-v1' };
      this.db.prepare('UPDATE suites SET data=? WHERE id=? AND owner_id=? AND workshop_id=?').run(JSON.stringify(suite), suite.id, ...requireScope(scope));
      const evaluations = bundle.evaluations.map(data => this.#insertEvaluation(validateEvaluation({ ...data, suiteId: suite.id }), scope));
      return { created: true, suite, evaluations };
    });
  }
  runs(scope) { return this.db.prepare('SELECT data FROM runs WHERE owner_id=? AND workshop_id=?').all(...requireScope(scope)).map(row => JSON.parse(row.data)).sort((a,b) => b.createdAt.localeCompare(a.createdAt)); }
  run(id, scope) { const row = this.db.prepare('SELECT data FROM runs WHERE id=? AND owner_id=? AND workshop_id=?').get(id, ...requireScope(scope)); return row && JSON.parse(row.data); }
  saveRun(run, scope) {
    const result = this.db.prepare(`INSERT INTO runs (id,data,owner_id,workshop_id) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data WHERE runs.owner_id=excluded.owner_id AND runs.workshop_id=excluded.workshop_id`).run(run.id, JSON.stringify(run), ...requireScope(scope));
    if (!result.changes) throw new Error('Run workspace mismatch.');
  }
  deleteRun(id, scope) {
    return this.transaction(() => {
      const run = this.run(id, scope);
      if (!run) throw new AppError('Run not found.', 404);
      // Active jobs still persist their snapshots: deleting one would resurrect it.
      if (!['completed', 'interrupted'].includes(run.status) || run.items.some(item => !['passed', 'failed', 'error'].includes(item.status))) throw new AppError('This run is still active. Wait for it to finish before deleting it.', 409);
      this.db.prepare('DELETE FROM runs WHERE id=? AND owner_id=? AND workshop_id=?').run(id, ...requireScope(scope));
      // Evaluation definitions and workshop usage are independent of run history.
      return { deletedId: id };
    });
  }
  budget(workshopId, limit) {
    const used = this.db.prepare('SELECT used FROM model_usage WHERE workshop_id=?').get(workshopId)?.used || 0;
    const reserved = this.db.prepare('SELECT COALESCE(SUM(remaining),0) AS total FROM model_reservations WHERE workshop_id=?').get(workshopId).total;
    return { limit, used, reserved, remaining: Math.max(0, limit - used - reserved), unit: 'model_calls' };
  }
  reserveRun(run, scope, limit) {
    return this.transaction(() => {
      const reservations = run.items.map(item => ({ id: item.id, calls: Number(item.evaluation.source !== 'pasted') + Number(needsModelGrader(item.evaluation)) }));
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
