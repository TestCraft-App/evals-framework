import { randomUUID } from 'node:crypto';
import { AppError } from './validation.mjs';

const actor = user => ({ id: user.id, login: user.login });
const now = () => new Date().toISOString();
function object(body, fields) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !fields.includes(key))) throw new AppError('Invalid request fields.');
}
function text(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000) throw new AppError(label + ' must be non-empty text up to 2000 characters.');
  return value.trim();
}
function version(request, expected) {
  if (!Number.isSafeInteger(expected) || expected < 1) throw new AppError('A request version is required.');
  if (request.version !== expected) throw new AppError('This request has changed. Reload it before continuing.', 409);
}

export class EvaluationRequests {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS evaluation_requests (id TEXT PRIMARY KEY, workshop_id TEXT NOT NULL, requester_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS evaluation_requests_access ON evaluation_requests(workshop_id, requester_id);
      CREATE TABLE IF NOT EXISTS request_submissions (request_id TEXT NOT NULL, number INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(request_id, number));
      CREATE TABLE IF NOT EXISTS request_events (request_id TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(request_id, version));
      CREATE TABLE IF NOT EXISTS request_reads (request_id TEXT NOT NULL, user_id TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY(request_id, user_id));
      CREATE TABLE IF NOT EXISTS contribution_suites (workshop_id TEXT NOT NULL, source_workspace_id TEXT NOT NULL, source_suite_id TEXT NOT NULL, destination_suite_id TEXT NOT NULL, PRIMARY KEY(workshop_id, source_workspace_id, source_suite_id));
    `);
  }
  requireAdmin(account) {
    if (account.user.role !== 'admin') throw new AppError('Administrator access is required.', 403);
  }
  get(id, account) {
    const row = this.db.prepare('SELECT data FROM evaluation_requests WHERE id=? AND workshop_id=?').get(id, account.workshopId);
    const request = row && JSON.parse(row.data);
    if (!request || (account.user.role !== 'admin' && request.requester.id !== account.user.id)) throw new AppError('Request not found.', 404);
    return request;
  }
  list(account) {
    const rows = account.user.role === 'admin'
      ? this.db.prepare('SELECT data FROM evaluation_requests WHERE workshop_id=?').all(account.workshopId)
      : this.db.prepare('SELECT data FROM evaluation_requests WHERE workshop_id=? AND requester_id=?').all(account.workshopId, account.user.id);
    return rows.map(row => JSON.parse(row.data)).sort((a, b) => b.submittedAt.localeCompare(a.submittedAt) || b.id.localeCompare(a.id));
  }
  detail(id, account) {
    const request = this.get(id, account);
    const submissions = this.db.prepare('SELECT data FROM request_submissions WHERE request_id=? ORDER BY number').all(id).map(row => JSON.parse(row.data));
    const events = this.db.prepare('SELECT data FROM request_events WHERE request_id=? ORDER BY version').all(id).map(row => JSON.parse(row.data));
    return { ...request, submissions, events };
  }
  summary(account) {
    const requests = this.list(account);
    return { count: requests.filter(request => account.user.role === 'admin' ? request.status === 'pending' : request.feedbackVersion > (this.db.prepare('SELECT version FROM request_reads WHERE request_id=? AND user_id=?').get(request.id, account.user.id)?.version || 0)).length };
  }
  save(request, event) {
    this.db.prepare('INSERT INTO evaluation_requests VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(request.id, request.workshopId, request.requester.id, JSON.stringify(request));
    this.db.prepare('INSERT INTO request_events VALUES (?,?,?)').run(request.id, request.version, JSON.stringify({ ...event, version: request.version, submission: request.submission, at: request.updatedAt }));
  }
  snapshot(ids, scope) {
    if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !/^[a-z0-9-]+$/i.test(id)) || new Set(ids).size !== ids.length) throw new AppError('Select one or more distinct evaluations.');
    return ids.map(id => {
      const evaluation = this.store.evaluation(id, scope);
      if (!evaluation) throw new AppError('Evaluation not found.', 404);
      const suite = evaluation.suiteId ? this.store.suite(evaluation.suiteId, scope) : null;
      return { evaluation, suite: suite ? { id: suite.id, name: suite.name, sourceSuiteId: suite.sourceSuiteId || '' } : null };
    });
  }
  submit(body, account, scope, id = null) {
    object(body, id ? ['evaluationIds', 'description', 'version'] : ['evaluationIds', 'description']);
    if (account.user.role !== 'collaborator') throw new AppError('Only collaborators can submit evaluations.', 403);
    const description = text(body.description, 'Description');
    return this.store.transaction(() => {
      const previous = id ? this.get(id, account) : null;
      if (previous) {
        version(previous, body.version);
        if (previous.status !== 'changes_requested') throw new AppError('Only requests with changes requested can be resubmitted.', 409);
      }
      const evaluations = this.snapshot(body.evaluationIds, scope), at = now();
      const request = { ...(previous || { id: randomUUID(), workshopId: account.workshopId, requester: actor(account.user), sourceWorkspaceId: scope.ownerId, createdAt: at, feedbackVersion: 0 }),
        description, status: 'pending', version: (previous?.version || 0) + 1, submission: (previous?.submission || 0) + 1, evaluationCount: evaluations.length, submittedAt: at, updatedAt: at };
      this.db.prepare('INSERT INTO request_submissions VALUES (?,?,?)').run(request.id, request.submission, JSON.stringify({ number: request.submission, at, description, evaluations }));
      this.save(request, { action: previous ? 'resubmitted' : 'submitted', actor: actor(account.user), comment: description });
      return this.detail(request.id, account);
    });
  }
  review(id, body, account, destination) {
    this.requireAdmin(account);
    object(body, ['action', 'comment', 'version']);
    if (!['approve', 'reject', 'request_changes'].includes(body.action)) throw new AppError('Choose a valid review action.');
    const comment = body.action === 'approve' ? (body.comment === undefined || body.comment === '' ? '' : text(body.comment, 'Comment')) : text(body.comment, 'Comment');
    return this.store.transaction(() => {
      const request = this.detail(id, account);
      version(request, body.version);
      if (request.status !== 'pending') throw new AppError('Only pending requests can be reviewed.', 409);
      const { submissions, events, ...record } = request;
      if (body.action === 'approve') {
        record.approvedEvaluations = submissions.at(-1).evaluations.map(({ evaluation, suite }) => {
          let suiteId = '';
          if (suite) {
            const mapped = this.db.prepare('SELECT destination_suite_id FROM contribution_suites WHERE workshop_id=? AND source_workspace_id=? AND source_suite_id=?').get(account.workshopId, record.sourceWorkspaceId, suite.id)?.destination_suite_id;
            suiteId = [suite.sourceSuiteId, mapped].find(candidate => candidate && this.store.suite(candidate, destination)) || '';
            if (!suiteId) suiteId = this.store.createSuite({ name: suite.name }, destination).id;
            this.db.prepare('INSERT INTO contribution_suites VALUES (?,?,?,?) ON CONFLICT(workshop_id, source_workspace_id, source_suite_id) DO UPDATE SET destination_suite_id=excluded.destination_suite_id').run(account.workshopId, record.sourceWorkspaceId, suite.id, suiteId);
          }
          const copied = this.store.insertContribution(evaluation, suiteId, destination);
          return { sourceEvaluationId: evaluation.id, id: copied.id, reference: copied.reference };
        });
      }
      record.status = { approve: 'approved', reject: 'rejected', request_changes: 'changes_requested' }[body.action];
      record.version++; record.feedbackVersion = record.version; record.updatedAt = now();
      this.save(record, { action: body.action, actor: actor(account.user), comment });
      return this.detail(id, account);
    });
  }
  read(id, body, account) {
    object(body, ['version']);
    const request = this.detail(id, account);
    if (request.requester.id !== account.user.id) throw new AppError('Only the requester can acknowledge feedback.', 403);
    if (!Number.isSafeInteger(body.version) || body.version < 0 || (body.version !== 0 && !request.events.some(event => event.version === body.version && ['approve', 'reject', 'request_changes'].includes(event.action)))) throw new AppError('Invalid feedback version.');
    this.db.prepare('INSERT INTO request_reads VALUES (?,?,?) ON CONFLICT(request_id,user_id) DO UPDATE SET version=MAX(version,excluded.version)').run(id, account.user.id, body.version);
    return { read: true };
  }
  runScope(id, account) {
    this.requireAdmin(account);
    this.get(id, account);
    return { ownerId: 'request:' + id, workshopId: account.workshopId, alias: 'request', name: 'Evaluation request' };
  }
  runSnapshots(id, body, account) {
    this.requireAdmin(account);
    object(body, ['version', 'submission', 'evaluationIds', 'environment', 'generationModels', 'generationModel', 'graderModel', 'description']);
    const request = this.detail(id, account);
    version(request, body.version);
    if (request.status !== 'pending' || body.submission !== request.submission) throw new AppError('Run the current pending submission. Reload this request.', 409);
    if (!Array.isArray(body.evaluationIds) || !body.evaluationIds.length || body.evaluationIds.length > 50 || body.evaluationIds.some(id => typeof id !== 'string' || !/^[a-z0-9-]+$/i.test(id)) || new Set(body.evaluationIds).size !== body.evaluationIds.length) throw new AppError('Select between 1 and 50 distinct evaluations.');
    return body.evaluationIds.map(id => {
      const entry = request.submissions.at(-1).evaluations.find(entry => entry.evaluation.id === id);
      if (!entry) throw new AppError('Evaluation not found.', 404);
      return { ...entry.evaluation, suiteName: entry.suite?.name || 'None' };
    });
  }
}
