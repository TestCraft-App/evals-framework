import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AppError, validateEvaluation } from './validation.mjs';
import { canDeleteRun } from './runs.mjs';

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
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, github_id TEXT NOT NULL UNIQUE, login TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','collaborator')), created_at TEXT NOT NULL, last_login_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, workshop_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('main','personal')), user_id TEXT, UNIQUE(workshop_id,user_id));
      CREATE UNIQUE INDEX IF NOT EXISTS main_workspace ON workspaces(workshop_id) WHERE kind='main';
      CREATE TABLE IF NOT EXISTS account_sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, workshop_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS access_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS evaluation_references (
      owner_id TEXT NOT NULL, workshop_id TEXT NOT NULL, evaluation_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK(sequence > 0),
      PRIMARY KEY(owner_id, workshop_id, evaluation_id), UNIQUE(owner_id, workshop_id, sequence));`);
    this.#migrateReferences();
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  #reference(id, scope) {
    if (!id) return undefined;
    const row = this.db.prepare('SELECT sequence FROM evaluation_references WHERE owner_id=? AND workshop_id=? AND evaluation_id=?').get(...requireScope(scope), id);
    return row ? 'EVAL-' + row.sequence : undefined;
  }
  #allocateReference(id, scope) {
    // Call only within a write transaction. Retain mappings after deletion so numbers are never reused.
    const existing = this.#reference(id, scope);
    if (existing) return existing;
    const params = requireScope(scope);
    this.db.prepare(`INSERT INTO evaluation_references (owner_id, workshop_id, evaluation_id, sequence)
      SELECT ?, ?, ?, COALESCE(MAX(sequence), 0) + 1 FROM evaluation_references WHERE owner_id=? AND workshop_id=?`).run(...params, id, ...params);
    return this.#reference(id, scope);
  }
  #migrateReferences() {
    this.transaction(() => {
      const candidates = new Map();
      const add = (row, id, createdAt) => {
        if (!id || !row.owner_id || !row.workshop_id) return;
        const key = JSON.stringify([row.owner_id, row.workshop_id, id]);
        const candidate = { id, createdAt: createdAt || '', scope: { ownerId: row.owner_id, workshopId: row.workshop_id } };
        if (!candidates.has(key) || candidate.createdAt < candidates.get(key).createdAt) candidates.set(key, candidate);
      };
      for (const row of this.db.prepare('SELECT id, data, owner_id, workshop_id FROM evaluations').all()) add(row, row.id, JSON.parse(row.data).createdAt);
      for (const row of this.db.prepare('SELECT data, owner_id, workshop_id FROM runs').all()) {
        const run = JSON.parse(row.data);
        if (run.sourceWorkspace) continue;
        for (const item of run.items || []) add(row, item.evaluationId || item.evaluation?.id, item.evaluation?.createdAt || run.createdAt);
      }
      for (const candidate of [...candidates.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))) {
        this.#allocateReference(candidate.id, candidate.scope);
      }
    });
  }
  #readEvaluation(row, scope) {
    const record = readEvaluation(row);
    return record && { ...record, reference: this.#reference(record.id, scope) };
  }
  #readRun(row, scope) {
    if (!row) return undefined;
    const run = JSON.parse(row.data);
    if (run.sourceWorkspace) return run;
    for (const item of run.items || []) {
      const reference = this.#reference(item.evaluationId || item.evaluation?.id, scope);
      if (reference) item.evaluation = { ...item.evaluation, reference };
    }
    return run;
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
    });
  }
  evaluations(scope) {
    return this.db.prepare('SELECT data FROM evaluations WHERE owner_id=? AND workshop_id=?').all(...requireScope(scope)).map(row => this.#readEvaluation(row, scope)).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
  }
  evaluation(id, scope) { return this.#readEvaluation(this.db.prepare('SELECT data FROM evaluations WHERE id=? AND owner_id=? AND workshop_id=?').get(id, ...requireScope(scope)), scope); }
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
    record.reference = this.#allocateReference(record.id, scope);
    this.db.prepare('INSERT INTO evaluations (id,data,owner_id,workshop_id) VALUES (?,?,?,?)').run(record.id, JSON.stringify(record), ...requireScope(scope));
    return record;
  }
  create(data, scope) { return this.transaction(() => this.#insertEvaluation(data, scope)); }
  // Trusted stored snapshot; caller owns the approval transaction.
  insertContribution(snapshot, suiteId, scope) {
    const { id, reference, createdAt, revision, sourceEvaluationId, suiteName, ...definition } = snapshot;
    return this.#insertEvaluation({ ...definition, suiteId }, scope);
  }
  updateEvaluation(id, data, revision, scope) {
    return this.transaction(() => {
      const current = this.evaluation(id, scope);
      if (!current) throw new AppError('Evaluation not found.', 404);
      requireRevision(revision, current.revision);
      const record = { ...data, ...(current.sourceEvaluationId ? { sourceEvaluationId: current.sourceEvaluationId } : {}), suiteId: this.#suiteId(data.suiteId, scope), id: current.id, reference: current.reference, createdAt: current.createdAt, revision: current.revision + 1 };
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
      const { sourceEvaluationId, ...definition } = current;
      return this.#insertEvaluation({ ...definition, name }, scope);
    });
  }
  renameEvaluation(id, body, scope) {
    return this.transaction(() => {
      const current = this.evaluation(id, scope);
      if (!current) throw new AppError('Evaluation not found.', 404);
      requireObject(body, ['name', 'revision']);
      const name = requireName(body.name);
      requireRevision(body.revision, current.revision);
      const record = { ...current, name, revision: current.revision + 1 };
      this.db.prepare('UPDATE evaluations SET data=? WHERE id=? AND owner_id=? AND workshop_id=?').run(JSON.stringify(record), id, ...requireScope(scope));
      return record;
    });
  }
  deleteEvaluation(id, scope) {
    this.deleteEvaluations({ evaluationIds: [id] }, scope);
    return { deletedId: id };
  }
  deleteEvaluations(body, scope) {
    requireObject(body, ['evaluationIds']);
    const ids = body.evaluationIds;
    if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !/^[a-z0-9-]+$/i.test(id)) || new Set(ids).size !== ids.length) throw new AppError('Select one or more distinct evaluation IDs.');
    return this.transaction(() => {
      for (const id of ids) if (!this.evaluation(id, scope)) throw new AppError('Evaluation not found.', 404);
      const selected = new Set(ids);
      const active = this.runs(scope).some(run => run.items.some(item => selected.has(item.evaluationId) &&
        (['queued', 'running'].includes(run.status) || ['queued', 'generating', 'grading'].includes(item.status))));
      if (active) throw new AppError('This evaluation has an active run. Wait for it to finish before deleting it.', 409);
      const statement = this.db.prepare('DELETE FROM evaluations WHERE id=? AND owner_id=? AND workshop_id=?'), params = requireScope(scope);
      for (const id of ids) statement.run(id, ...params);
      // Run snapshots and model usage remain independent of the library definition.
      return { deletedIds: ids };
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
      if (this.evaluations(scope).some(evaluation => evaluation.suiteId === id)) throw new AppError('Only empty suites can be deleted.', 409);
      this.db.prepare('DELETE FROM suites WHERE id=? AND owner_id=? AND workshop_id=?').run(id, ...requireScope(scope));
      return { deletedId: id };
    });
  }
  importTestcraft(sourceScope, scope) {
    return this.transaction(() => {
      const sourceSuites = this.suites(sourceScope), sourceEvaluations = this.evaluations(sourceScope);
      if (!sourceSuites.length && !sourceEvaluations.length) throw new AppError('The TestCraft workspace has no suites or evaluations to load.', 409);
      const existingSuites = this.suites(scope), existingEvaluations = this.evaluations(scope);
      const suites = [], evaluations = [], suiteIds = new Map();
      let created = false;
      for (const source of sourceSuites) {
        let suite = existingSuites.find(item => item.sourceSuiteId === source.id);
        if (!suite) {
          created = true;
          suite = { ...this.createSuite({ name: source.name }, scope), sourceSuiteId: source.id };
          this.db.prepare('UPDATE suites SET data=? WHERE id=? AND owner_id=? AND workshop_id=?').run(JSON.stringify(suite), suite.id, ...requireScope(scope));
        }
        suiteIds.set(source.id, suite.id); suites.push(suite);
      }
      for (const source of sourceEvaluations) {
        let evaluation = existingEvaluations.find(item => item.sourceEvaluationId === source.id);
        if (!evaluation) {
          created = true;
          // Preserve stored legacy definitions while assigning private IDs and references.
          const { id, reference, createdAt, revision, suiteId, sourceEvaluationId, ...definition } = source;
          evaluation = this.#insertEvaluation({ ...definition, suiteId: suiteIds.get(suiteId) || '', sourceEvaluationId: id }, scope);
        }
        evaluations.push(evaluation);
      }
      return { created, suites, evaluations };
    });
  }
  importWorkshop(bundle, scope) {
    return this.transaction(() => {
      // Stable per-suite seeds preserve previous imports, edits and snapshots.
      // Validate the whole collection before writing; a later failure rolls back
      // every new suite. The legacy single-bundle shape remains supported.
      const bundles = Array.isArray(bundle) ? bundle : [bundle];
      if (!bundles.length) throw new AppError('Workshop import requires suites.');
      const keys = new Set();
      for (const entry of bundles) {
        requireObject(entry, ['name', 'evaluations', 'seedKey']);
        requireName(entry.name);
        const key = entry.seedKey ?? 'workshop-v2-live';
        if (typeof key !== 'string' || !/^workshop-[a-z0-9-]{1,80}$/.test(key) || keys.has(key)) throw new AppError('Workshop suites require distinct valid seed keys.');
        keys.add(key);
        if (!Array.isArray(entry.evaluations) || !entry.evaluations.length) throw new AppError('Workshop import requires evaluations.');
        entry.evaluations.forEach(data => validateEvaluation(data));
      }
      let created = false;
      const suites = [], evaluations = [];
      for (const entry of bundles) {
        const seedKey = entry.seedKey ?? 'workshop-v2-live';
        let suite = this.suites(scope).find(item => item.seedKey === seedKey);
        if (suite) evaluations.push(...this.evaluations(scope).filter(item => item.suiteId === suite.id));
        else {
          created = true;
          suite = { ...this.createSuite({ name: entry.name }, scope), seedKey };
          this.db.prepare('UPDATE suites SET data=? WHERE id=? AND owner_id=? AND workshop_id=?').run(JSON.stringify(suite), suite.id, ...requireScope(scope));
          evaluations.push(...entry.evaluations.map(data => this.#insertEvaluation(validateEvaluation({ ...data, suiteId: suite.id }), scope)));
        }
        suites.push(suite);
      }
      return { created, suite: suites[0], ...(Array.isArray(bundle) ? { suites } : {}), evaluations };
    });
  }
  runs(scope) { return this.db.prepare('SELECT data FROM runs WHERE owner_id=? AND workshop_id=?').all(...requireScope(scope)).map(row => this.#readRun(row, scope)).sort((a,b) => b.createdAt.localeCompare(a.createdAt)); }
  run(id, scope) { return this.#readRun(this.db.prepare('SELECT data FROM runs WHERE id=? AND owner_id=? AND workshop_id=?').get(id, ...requireScope(scope)), scope); }
  saveRun(run, scope) {
    const result = this.db.prepare(`INSERT INTO runs (id,data,owner_id,workshop_id) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data WHERE runs.owner_id=excluded.owner_id AND runs.workshop_id=excluded.workshop_id`).run(run.id, JSON.stringify(run), ...requireScope(scope));
    if (!result.changes) throw new Error('Run workspace mismatch.');
  }
  workspaceSummary(scope) {
    const suites = this.suites(scope), evaluations = this.evaluations(scope), runs = this.runs(scope);
    const records = [suites, evaluations, runs].map(records => [...records].sort((a, b) => a.id.localeCompare(b.id)));
    return {
      revision: createHash('sha256').update(JSON.stringify(records)).digest('hex'),
      suites: suites.map(suite => ({ id: suite.id, name: suite.name, evaluationCount: evaluations.filter(e => e.suiteId === suite.id).length })),
      evaluationCount: evaluations.length, unfiledCount: evaluations.filter(e => !e.suiteId).length,
      runCount: runs.length, activeRunCount: runs.filter(run => !canDeleteRun(run)).length,
    };
  }
  clearWorkspace(body, scope) {
    requireObject(body, ['revision']);
    if (typeof body.revision !== 'string' || !/^[a-f0-9]{64}$/.test(body.revision)) throw new AppError('A workspace review revision is required.');
    return this.transaction(() => {
      const summary = this.workspaceSummary(scope);
      if (summary.activeRunCount) throw new AppError('Wait for active runs to finish before clearing this workspace.', 409);
      if (summary.revision !== body.revision) throw new AppError('The workspace changed. Close this dialog and review it again before clearing.', 409);
      const params = requireScope(scope);
      for (const table of ['runs', 'evaluations', 'suites']) this.db.prepare(`DELETE FROM ${table} WHERE owner_id = ? AND workshop_id = ?`).run(...params);
      return { cleared: true };
    });
  }
  deleteRun(id, scope) {
    return this.transaction(() => {
      const run = this.run(id, scope);
      if (!run) throw new AppError('Run not found.', 404);
      // Active jobs still persist their snapshots: deleting one would resurrect it.
      if (!canDeleteRun(run)) throw new AppError('This run is still active. Wait for it to finish before deleting it.', 409);
      this.db.prepare('DELETE FROM runs WHERE id=? AND owner_id=? AND workshop_id=?').run(id, ...requireScope(scope));
      // Evaluation definitions are independent of run history.
      return { deletedId: id };
    });
  }
  close() { this.db.close(); }
}
