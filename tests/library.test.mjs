import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, listen, close, client, waitForRun, testScope, syntheticStream } from './helpers.mjs';
import { Store } from '../src/evals/store.mjs';
import { validateEvaluation } from '../src/evals/validation.mjs';
import { workshopSuite, workshopSuites } from '../src/evals/workshop.mjs';

const workshopEvaluations = workshopSuites.flatMap(suite => suite.evaluations);

const base = {
  name: 'Login coverage', type: 'ideas', source: 'pasted', method: 'contains',
  html: '<form><button>Login</button></form>', actualOutput: 'valid user; invalid password',
  criteria: ['valid user', 'invalid password'],
};
const noProvider = async () => assert.fail('Library operations must not contact a provider.');
const put = (person, path, body, headers) => person.request(path, { method: 'PUT', headers, body: JSON.stringify(body) });
async function result(response, status) {
  const res = await response;
  assert.equal(res.status, status, await res.clone().text());
  return res.json();
}
const save = (person, data = base) => result(person.post('/api/evaluations', data), 201);
const suite = (person, name = 'Login suite') => result(person.post('/api/suites', { name }), 201);
const rename = (person, id, body) => person.request('/api/evaluations/' + id, { method: 'PATCH', body: JSON.stringify(body) });
const run = async (person, id) => waitForRun(person, (await result(person.post('/api/runs', { evaluationIds: [id] }), 202)).id);
function snapshot(evaluation, id = 'saved-run', status = 'completed', itemStatus = 'passed') {
  return { id, createdAt: '2026-01-01T00:00:00.000Z', status, items: [{
    id: id + '-item', evaluationId: evaluation.id, evaluation: structuredClone(evaluation),
    status: itemStatus, score: itemStatus === 'passed' ? 100 : null, events: [],
  }] };
}

test('suite deletion rechecks membership added by another store after an empty read', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'testcraft-suite-delete-')), dbPath = join(dir, 'evals.sqlite');
  const first = new Store(dbPath), second = new Store(dbPath);
  try {
    const group = first.createSuite({ name: 'Initially empty' }, testScope);
    assert.deepEqual(first.evaluations(testScope), []);
    const member = second.create({ ...validateEvaluation(base), suiteId: group.id }, testScope);
    assert.throws(() => first.deleteSuite(group.id, testScope), { status: 409, message: 'Only empty suites can be deleted.' });
    assert.deepEqual(first.suite(group.id, testScope), group);
    assert.deepEqual(first.evaluation(member.id, testScope), member);
    second.updateEvaluation(member.id, { ...member, suiteId: '' }, member.revision, testScope);
    assert.deepEqual(first.deleteSuite(group.id, testScope), { deletedId: group.id });
    assert.equal(second.suite(group.id, testScope), undefined);
    assert.equal(second.evaluation(member.id, testScope).suiteId, '');
  } finally { second.close(); first.close(); await rm(dir, { recursive: true, force: true }); }
});

test('name-only updates preserve copied legacy definitions and historical snapshots', async () => {
  const app = await listen(createApp({ dbPath: ':memory:', fetchImpl: noProvider }));
  try {
    const person = await client(app);
    const legacy = app.store.create({ ...base, schemaVersion: 1, criteria: 'Legacy scalar rubric', expectedOutput: 'Original target', customLegacyField: 'Retain me' }, person.scope);
    const originalRun = snapshot(legacy); app.store.saveRun(originalRun, person.scope);
    const copy = await result(person.post('/api/evaluations/' + legacy.id + '/duplicate', { name: 'Legacy (copy)' }), 201);
    const renamed = await result(rename(person, copy.id, { name: '  Renamed copy  ', revision: copy.revision }), 200);
    assert.deepEqual(renamed, { ...copy, name: 'Renamed copy', revision: 2 });
    assert.deepEqual(await person.get('/api/evaluations/' + legacy.id), legacy);
    assert.deepEqual(await person.get('/api/runs/' + originalRun.id), originalRun);
    assert.equal((await rename(person, copy.id, { name: 'Stale name', revision: 1 })).status, 409);
    assert.deepEqual(await person.get('/api/evaluations/' + copy.id), renamed);
  } finally { await close(app); }
});

test('name-only updates validate names, exact fields, revisions, ownership and body limits', async () => {
  const app = await listen(createApp({ dbPath: ':memory:', fetchImpl: noProvider }));
  try {
    const person = await client(app), other = await client(app), saved = await save(person);
    for (const body of [null, [], {}, { name: 'Name' }, { name: '', revision: 1 }, { name: '   ', revision: 1 }, { name: 5, revision: 1 }, { name: 'x'.repeat(141), revision: 1 }, { name: 'Name', revision: '1' }, { name: 'Name', revision: 1, criteria: [] }]) {
      assert.equal((await rename(person, saved.id, body)).status, 400);
    }
    assert.equal((await rename(person, saved.id, { name: 'x'.repeat(3000), revision: 1 })).status, 413);
    assert.equal((await rename(other, saved.id, { name: 'Foreign name', revision: 1 })).status, 404);
    assert.equal((await rename(person, 'missing', { name: 'Missing', revision: 1 })).status, 404);
    assert.deepEqual(await person.get('/api/evaluations/' + saved.id), saved);
  } finally { await close(app); }
});

test('private suites and evaluation revisions persist across restart and two store connections', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'testcraft-library-')), dbPath = join(dir, 'evals.sqlite');
  let app = await listen(createApp({ dbPath, fetchImpl: noProvider }));
  try {
    const person = await client(app), group = await suite(person, '  Login suite  ');
    assert.equal(group.name, 'Login suite'); assert.equal(group.revision, 1);
    assert.equal(group.createdAt, group.updatedAt);
    assert.deepEqual(Object.keys(group).sort(), ['createdAt', 'id', 'name', 'revision', 'updatedAt']);
    const evaluation = await save(person, { ...base, suiteId: '  ' + group.id + '  ' });
    assert.equal(evaluation.suiteId, group.id); assert.equal(evaluation.revision, 1);
    const edited = await result(put(person, '/api/evaluations/' + evaluation.id, {
      ...base, name: 'Edited login', actualOutput: 'Changed output', suiteId: group.id, revision: 1,
      id: 'caller-id', createdAt: 'caller-date', ownerId: 'caller-owner',
    }), 200);
    assert.equal(edited.id, evaluation.id); assert.equal(edited.createdAt, evaluation.createdAt);
    assert.equal(edited.revision, 2); assert.equal(edited.actualOutput, 'Changed output');
    assert.equal('ownerId' in edited, false);
    const renamed = await result(put(person, '/api/suites/' + group.id, { name: '  Renamed  ', revision: 1 }), 200);
    assert.equal(renamed.name, 'Renamed'); assert.equal(renamed.revision, 2);
    assert.equal(renamed.createdAt, group.createdAt); assert.ok(renamed.updatedAt >= group.updatedAt);
    await close(app); app = await listen(createApp({ dbPath, fetchImpl: noProvider }));
    const restored = await client(app, { cookie: person.cookie });
    assert.deepEqual(await restored.get('/api/suites'), { suites: [renamed] });
    assert.deepEqual(await restored.get('/api/evaluations/' + edited.id), edited);
    assert.equal((await put(restored, '/api/evaluations/' + edited.id, { ...base, revision: 1 })).status, 409);
    const other = new Store(dbPath);
    try {
      const saved = other.updateEvaluation(edited.id, validateEvaluation({ ...base, suiteId: group.id }), 2, restored.scope);
      assert.equal(saved.revision, 3);
      assert.equal((await put(restored, '/api/evaluations/' + edited.id, { ...base, revision: 2 })).status, 409);
      assert.deepEqual(await restored.get('/api/evaluations/' + edited.id), saved);
    } finally { other.close(); }
    assert.equal((await save(restored)).suiteId, '');
  } finally { await close(app); await rm(dir, { recursive: true, force: true }); }
});

test('suite and evaluation operations hide other owners and reject foreign suite assignments', async () => {
  const app = await listen(createApp({ dbPath: ':memory:', fetchImpl: noProvider }));
  try {
    const a = await client(app), b = await client(app), group = await suite(a);
    const saved = await save(a, { ...base, suiteId: group.id }), ownB = await save(b);
    assert.deepEqual(await b.get('/api/suites'), { suites: [] });
    for (const path of ['/api/suites/' + group.id, '/api/evaluations/' + saved.id]) {
      assert.equal((await b.request(path)).status, 404);
      assert.equal((await put(b, path, {})).status, 404);
      assert.equal((await b.request(path, { method: 'DELETE' })).status, 404);
    }
    assert.equal((await b.post('/api/evaluations/' + saved.id + '/duplicate', {})).status, 404);
    for (const suiteId of [group.id, '00000000-0000-4000-8000-000000000000']) {
      assert.equal((await b.post('/api/evaluations', { ...base, suiteId, ownerId: a.info.workspaceId })).status, 404);
      assert.equal((await put(b, '/api/evaluations/' + ownB.id, { ...base, suiteId, revision: 1 })).status, 404);
    }
    assert.deepEqual(await a.get('/api/evaluations/' + saved.id), saved);
    assert.deepEqual(await b.get('/api/evaluations/' + ownB.id), ownB);
    const otherWorkshop = { ...a.scope, workshopId: 'other-workshop' };
    assert.deepEqual(app.store.suites(otherWorkshop), []);
    assert.equal(app.store.suite(group.id, otherWorkshop), undefined);
    assert.throws(() => app.store.deleteSuite(group.id, otherWorkshop), { status: 404 });
    assert.throws(() => app.store.updateEvaluation(saved.id, validateEvaluation(base), 1, otherWorkshop), { status: 404 });
    assert.throws(() => app.store.duplicateEvaluation(saved.id, {}, otherWorkshop), { status: 404 });
    assert.throws(() => app.store.deleteEvaluation(saved.id, otherWorkshop), { status: 404 });
    assert.throws(() => app.store.create({ ...validateEvaluation(base), suiteId: group.id }, otherWorkshop), { status: 404 });
    assert.throws(() => app.store.suites(), /workspace scope/);
  } finally { await close(app); }
});

test('library writes validate complete payloads, names, revisions and duplicate options without changing records', async () => {
  const app = await listen(createApp({ dbPath: ':memory:', fetchImpl: noProvider }));
  try {
    const person = await client(app), group = await suite(person), saved = await save(person);
    for (const body of [null, [], 'text', {}, { name: '' }, { name: '   ' }, { name: 2 }, { name: 'x'.repeat(141) }, { name: 'Nested', parentId: group.id }, { name: 'Seed', seedKey: 'workshop-v1' }]) {
      assert.equal((await person.post('/api/suites', body)).status, 400);
    }
    for (const revision of [undefined, null, '1', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal((await put(person, '/api/evaluations/' + saved.id, { ...base, revision })).status, 400);
      assert.equal((await put(person, '/api/suites/' + group.id, { name: group.name, revision })).status, 400);
    }
    for (const body of [null, [], {}, { name: 'Partial update', revision: 1 }, { ...base, revision: 1, criteria: [] }, { ...base, revision: 1, html: '' }, { ...base, revision: 1, method: 'unknown' }, { ...base, revision: 1, suiteId: 42 }]) {
      assert.equal((await put(person, '/api/evaluations/' + saved.id, body)).status, 400);
    }
    for (const body of [null, [], { name: null }, { name: '' }, { name: 'x'.repeat(141) }, { suiteId: group.id }, { revision: 1 }]) {
      assert.equal((await person.post('/api/evaluations/' + saved.id + '/duplicate', body)).status, 400);
    }
    for (const path of ['/api/suites/' + group.id, '/api/evaluations/' + saved.id]) {
      assert.equal((await person.request(path, { method: 'PUT', body: '{' })).status, 400);
    }
    assert.equal((await put(person, '/api/suites/' + group.id, { name: 'x'.repeat(3000), revision: 1 })).status, 413);
    assert.equal((await put(person, '/api/evaluations/' + saved.id, { ...base, html: 'x'.repeat(350001), revision: 1 })).status, 413);
    assert.deepEqual(await person.get('/api/evaluations/' + saved.id), saved);
    assert.deepEqual(await person.get('/api/suites/' + group.id), group);
    assert.equal((await person.get('/api/evaluations')).evaluations.length, 1);
  } finally { await close(app); }
});

test('competing evaluation and suite updates accept one revision and reject the stale writer', async () => {
  const app = await listen(createApp({ dbPath: ':memory:', fetchImpl: noProvider }));
  try {
    const person = await client(app), group = await suite(person), saved = await save(person);
    for (const [path, body] of [['/api/suites/' + group.id, {}], ['/api/evaluations/' + saved.id, base]]) {
      const responses = await Promise.all(['First', 'Second'].map(name => put(person, path, { ...body, name, revision: 1 })));
      assert.deepEqual(responses.map(res => res.status).sort(), [200, 409]);
      const winner = await responses.find(res => res.status === 200).json();
      assert.equal(winner.revision, 2); assert.deepEqual(await person.get(path), winner);
    }
  } finally { await close(app); }
});

test('edits invalidate latest results while duplication preserves the current definition with fresh identity', async () => {
  const app = await listen(createApp({ dbPath: ':memory:', fetchImpl: async () => syntheticStream() }));
  try {
    const person = await client(app), group = await suite(person);
    const saved = await save(person, { ...base, suiteId: group.id });
    const first = await run(person, saved.id);
    assert.equal(first.items[0].evaluation.revision, 1);
    assert.equal((await person.get('/api/evaluations')).evaluations[0].latest.runId, first.id);
    const edited = await result(put(person, '/api/evaluations/' + saved.id, { ...base, actualOutput: 'no matches', criteria: ['missing new requirement'], revision: 1, suiteId: group.id }), 200);
    assert.equal((await person.get('/api/evaluations')).evaluations[0].latest, null);
    assert.deepEqual(await person.get('/api/runs/' + first.id), first);
    const duplicate = await result(person.post('/api/evaluations/' + saved.id + '/duplicate', { name: '  Copy  ' }), 201);
    assert.notEqual(duplicate.id, saved.id); assert.ok(duplicate.createdAt >= saved.createdAt);
    assert.deepEqual(duplicate, { ...edited, id: duplicate.id, name: 'Copy', createdAt: duplicate.createdAt, revision: 1 });
    assert.equal((await person.get('/api/evaluations')).evaluations.find(e => e.id === duplicate.id).latest, null);
    const unnamed = await result(person.post('/api/evaluations/' + saved.id + '/duplicate', {}), 201);
    assert.equal(unnamed.name, saved.name);
    const second = await run(person, saved.id);
    assert.equal(second.items[0].score, 0); assert.equal(second.items[0].evaluation.revision, 2);
    assert.equal((await person.get('/api/evaluations')).evaluations.find(e => e.id === saved.id).latest.runId, second.id);
    await result(person.request('/api/runs/' + second.id, { method: 'DELETE' }), 200);
    assert.equal((await person.get('/api/evaluations')).evaluations.find(e => e.id === saved.id).latest, null);
    assert.deepEqual(await person.get('/api/runs/' + first.id), first);
  } finally { await close(app); }
});

test('legacy evaluations and run snapshots without revision behave as revision one without rewriting history', async () => {
  const app = await listen(createApp({ dbPath: ':memory:', fetchImpl: noProvider }));
  try {
    const person = await client(app);
    const old = { ...base, id: 'legacy-evaluation', createdAt: '2025-01-01T00:00:00.000Z' };
    app.store.db.prepare('INSERT INTO evaluations (id,data,owner_id,workshop_id) VALUES (?,?,?,?)').run(old.id, JSON.stringify(old), person.scope.ownerId, person.scope.workshopId);
    const oldRun = snapshot(old); app.store.saveRun(oldRun, person.scope);
    assert.deepEqual(await person.get('/api/evaluations/' + old.id), { ...old, revision: 1, suiteId: '' });
    assert.equal((await person.get('/api/evaluations')).evaluations[0].latest.runId, oldRun.id);
    const copy = await result(person.post('/api/evaluations/' + old.id + '/duplicate', {}), 201);
    assert.equal(copy.revision, 1); assert.notEqual(copy.createdAt, old.createdAt);
    const edited = await result(put(person, '/api/evaluations/' + old.id, { ...base, name: 'Edited legacy', revision: 1 }), 200);
    assert.equal(edited.revision, 2); assert.equal(edited.createdAt, old.createdAt);
    assert.equal((await person.get('/api/evaluations')).evaluations.find(e => e.id === old.id).latest, null);
    assert.deepEqual(await person.get('/api/runs/' + oldRun.id), oldRun);
    const scalar = { ...old, id: 'legacy-scalar', criteria: 'valid user\ninvalid password', expectedOutput: 'original reference' };
    app.store.db.prepare('INSERT INTO evaluations (id,data,owner_id,workshop_id) VALUES (?,?,?,?)').run(scalar.id, JSON.stringify(scalar), person.scope.ownerId, person.scope.workshopId);
    const scalarCopy = await result(person.post('/api/evaluations/' + scalar.id + '/duplicate', {}), 201);
    assert.equal(scalarCopy.criteria, scalar.criteria); assert.equal(scalarCopy.expectedOutput, scalar.expectedOutput);
    assert.equal(scalarCopy.revision, 1); assert.notEqual(scalarCopy.id, scalar.id);
  } finally { await close(app); }
});

test('create, edit and duplicate retain normalized weighted hybrid criteria and allow moving to another suite', async () => {
  const app = await listen(createApp({ dbPath: ':memory:', fetchImpl: async () => syntheticStream() }));
  try {
    const person = await client(app), first = await suite(person, 'First'), second = await suite(person, 'Second');
    const criteria = [{ text: 'valid user', method: 'contains', weight: 2 }, { text: 'TODO', method: 'not_contains', weight: 1 }];
    const saved = await save(person, { ...base, suiteId: first.id, method: 'hybrid', criteria: [{ text: '  valid user  ', method: 'contains', weight: 2 }, { text: 'TODO', method: 'not_contains' }] });
    assert.deepEqual(saved.criteria, criteria); assert.equal(saved.evaluationFamily, 'hybrid');
    const finished = await run(person, saved.id); assert.equal(finished.items[0].score, 100);
    const updatedCriteria = [...criteria, { text: 'Explains expected behavior', method: 'model_grade', weight: 3 }];
    const edited = await result(put(person, '/api/evaluations/' + saved.id, { ...saved, suiteId: ' ' + second.id + ' ', judgeModel: 'gpt-4o-mini', criteria: updatedCriteria, revision: 1 }), 200);
    assert.equal(edited.suiteId, second.id); assert.deepEqual(edited.criteria, updatedCriteria);
    const copy = await result(person.post('/api/evaluations/' + saved.id + '/duplicate', {}), 201);
    assert.equal(copy.suiteId, second.id); assert.deepEqual(copy.criteria, updatedCriteria); assert.equal(copy.revision, 1);
    assert.deepEqual((await person.get('/api/runs/' + finished.id)).items[0].evaluation.criteria, criteria);

  } finally { await close(app); }
});

test('queued and running evaluations cannot be deleted; edits and suite unlinking keep accepted snapshots intact', async () => {
  let release, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const app = await listen(createApp({ dbPath: ':memory:', fetchImpl: async () => {
    calls++; await gate;
    return new Response('data: {"choices":[{"delta":{"content":"valid user; invalid password"},"finish_reason":"stop"}]}\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } }));
  try {
    const person = await client(app), group = await suite(person), saved = [];
    for (let index = 0; index < 3; index++) saved.push(await save(person, { ...base, source: 'testcraft_api', suiteId: group.id, name: 'Case ' + index }));
    const started = await result(person.post('/api/runs', { evaluationIds: saved.map(e => e.id) }), 202);
    const active = await person.get('/api/runs/' + started.id);
    assert.equal(active.status, 'running'); assert.equal(active.items[2].status, 'queued');
    for (const evaluation of saved) assert.equal((await person.request('/api/evaluations/' + evaluation.id, { method: 'DELETE' })).status, 409);

    await result(put(person, '/api/evaluations/' + saved[0].id, { ...base, suiteId: group.id, revision: 1 }), 200);
    const beforeDelete = await person.get('/api/evaluations');
    assert.deepEqual(await result(person.request('/api/suites/' + group.id, { method: 'DELETE' }), 409), { error: 'Only empty suites can be deleted.' });
    assert.deepEqual(await person.get('/api/evaluations'), beforeDelete);
    for (const current of beforeDelete.evaluations) await result(put(person, '/api/evaluations/' + current.id, { ...current, suiteId: '' }), 200);
    await result(person.request('/api/suites/' + group.id, { method: 'DELETE' }), 200);
    assert.deepEqual(await person.get('/api/runs/' + started.id), active);

    for (const [index, original] of saved.entries()) {
      const current = await person.get('/api/evaluations/' + original.id);
      assert.equal(current.suiteId, ''); assert.equal(current.revision, index === 0 ? 3 : 2);
      assert.equal((await put(person, '/api/evaluations/' + original.id, { ...base, suiteId: group.id, revision: 1 })).status, 409);
    }
    release(); const finished = await waitForRun(person, started.id);
    assert.equal(calls, 3);
    assert.deepEqual(finished.items.map(item => item.evaluation), saved.map(e => ({ ...e, model: 'gpt-4o-mini', suiteName: group.name })));
    assert.ok((await person.get('/api/evaluations')).evaluations.every(e => e.latest === null));
    for (const evaluation of saved) assert.deepEqual(await result(person.request('/api/evaluations/' + evaluation.id, { method: 'DELETE' }), 200), { deletedId: evaluation.id });
    assert.deepEqual(await person.get('/api/evaluations'), { evaluations: [] });
    assert.deepEqual(await person.get('/api/runs/' + started.id), finished);

    assert.equal((await person.post('/api/runs', { evaluationIds: [saved[0].id] })).status, 404);
    assert.equal((await person.request('/api/evaluations/' + saved[0].id, { method: 'DELETE' })).status, 404);
  } finally { release(); await app.engine.drain(); await close(app); }
});

test('stored queued runs block deletion and suite deletion preserves unrelated members', () => {
  const store = new Store(':memory:');
  try {
    const group = store.createSuite({ name: 'Group' }, testScope), other = store.createSuite({ name: 'Other' }, testScope);
    const member = store.create({ ...validateEvaluation(base), suiteId: group.id }, testScope);
    const unrelated = store.create({ ...validateEvaluation(base), suiteId: other.id }, testScope);
    const unfiled = store.create(validateEvaluation(base), testScope);
    const queued = snapshot(member, 'queued-run', 'queued', 'queued'); store.saveRun(queued, testScope);
    assert.throws(() => store.deleteEvaluation(member.id, testScope), { status: 409 });
    assert.throws(() => store.deleteSuite(group.id, testScope), { status: 409, message: 'Only empty suites can be deleted.' });
    assert.deepEqual(store.evaluation(member.id, testScope), member);
    assert.deepEqual(store.evaluation(unrelated.id, testScope), unrelated);
    assert.deepEqual(store.evaluation(unfiled.id, testScope), unfiled);
    assert.deepEqual(store.run(queued.id, testScope), queued);
    store.recoverInterruptedRuns();
    const recovered = store.run(queued.id, testScope);
    store.deleteEvaluation(member.id, testScope);
    store.deleteSuite(group.id, testScope);
    assert.deepEqual(store.run(queued.id, testScope), recovered);
    assert.throws(() => store.deleteSuite(group.id, testScope), { status: 404 });
  } finally { store.close(); }
});

test('PUT, DELETE, duplication and workshop import enforce JSON, Origin and session CSRF', async () => {
  const app = await listen(createApp({ dbPath: ':memory:', fetchImpl: noProvider }));
  try {
    const person = await client(app), other = await client(app), saved = await save(person), group = await suite(person);
    const routes = [
      ['PATCH', '/api/evaluations/' + saved.id, { name: 'Renamed', revision: 1 }],
      ['PUT', '/api/evaluations/' + saved.id, { ...base, revision: 1 }],
      ['PUT', '/api/suites/' + group.id, { name: 'Updated', revision: 1 }],
      ['DELETE', '/api/evaluations/' + saved.id, {}], ['DELETE', '/api/suites/' + group.id, {}],
      ['POST', '/api/evaluations/' + saved.id + '/duplicate', {}], ['POST', '/api/workshop-suite', {}],
    ];
    for (const [method, path, body] of routes) {
      for (const headers of [{ 'x-csrf-token': '' }, { 'x-csrf-token': other.info.csrfToken }, { origin: '' }, { origin: 'null' }, { origin: 'https://attacker.invalid' }, { 'sec-fetch-site': 'cross-site' }]) {
        assert.equal((await person.request(path, { method, body: JSON.stringify(body), headers })).status, 403);
      }
      for (const contentType of ['text/plain', 'application/jsonp', '']) assert.equal((await person.request(path, { method, body: JSON.stringify(body), headers: { 'content-type': contentType } })).status, 415);
      assert.equal((await fetch(person.url + path, { method, headers: { origin: person.url, 'content-type': 'application/json' }, body: JSON.stringify(body) })).status, 401);
    }
    for (const path of ['/api/suites', '/api/suites/' + group.id, '/api/evaluations/' + saved.id]) assert.equal((await fetch(person.url + path)).status, 401);
    assert.deepEqual(await person.get('/api/evaluations/' + saved.id), saved);
    assert.deepEqual(await person.get('/api/suites/' + group.id), group);
    await result(put(person, '/api/evaluations/' + saved.id, { ...base, revision: 1 }, { 'content-type': 'Application/JSON; charset=utf-8' }), 200);
    const headers = { ...person.headers }; delete headers['content-type'];
    assert.equal((await fetch(person.url + '/api/evaluations/' + saved.id, { method: 'DELETE', headers })).status, 200);
    assert.equal((await fetch(person.url + '/api/suites/' + group.id, { method: 'DELETE', headers })).status, 200);
  } finally { await close(app); }
});

test('workshop import is private, idempotent across restart, preserves edits and can be reimported after deletion', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'testcraft-workshop-library-')), dbPath = join(dir, 'evals.sqlite');
  let app = await listen(createApp({ dbPath, fetchImpl: noProvider }));
  try {
    const person = await client(app), existingGroup = await suite(person, workshopSuite.name);
    const existing = await save(person, { ...base, suiteId: existingGroup.id });
    const responses = await Promise.all([person.post('/api/workshop-suite', {}), person.post('/api/workshop-suite', {})]);
    assert.deepEqual(responses.map(res => res.status).sort(), [200, 201]);
    const imported = await responses.find(res => res.status === 201).json(), retry = await responses.find(res => res.status === 200).json();
    assert.deepEqual(Object.keys(imported).sort(), ['evaluations', 'suite', 'suites']);
    assert.equal(imported.suite.seedKey, workshopSuite.seedKey); assert.equal(retry.suite.id, imported.suite.id);
    assert.notEqual(imported.suite.id, existingGroup.id); assert.equal(imported.evaluations.length, workshopEvaluations.length);
    assert.deepEqual(retry.evaluations.map(e => e.id).sort(), imported.evaluations.map(e => e.id).sort());
    for (const evaluation of imported.evaluations) {
      const definition = workshopSuites.find(suite => suite.seedKey === imported.suites.find(saved => saved.id === evaluation.suiteId)?.seedKey);
      assert.ok(definition); assert.equal(evaluation.revision, 1);
      assert.deepEqual(validateEvaluation(evaluation), validateEvaluation({ ...definition.evaluations.find(e => e.name === evaluation.name), suiteId: evaluation.suiteId }));
    }
    const first = imported.evaluations[0];
    const edited = await result(put(person, '/api/evaluations/' + first.id, { ...first, name: 'Participant edit', revision: 1 }), 200);
    const renamed = await result(put(person, '/api/suites/' + imported.suite.id, { name: 'Participant suite', revision: 1 }), 200);
    if (imported.evaluations.length > 1) await result(person.request('/api/evaluations/' + imported.evaluations[1].id, { method: 'DELETE' }), 200);
    const currentMembers = app.store.evaluations(person.scope).filter(e => e.suiteId === imported.suite.id);
    const other = await client(app), otherImport = await result(other.post('/api/workshop-suite', {}), 201);
    assert.notEqual(otherImport.suite.id, imported.suite.id);
    await close(app); app = await listen(createApp({ dbPath, fetchImpl: noProvider }));
    const restored = await client(app, { cookie: person.cookie });
    const restoredImport = await result(restored.post('/api/workshop-suite', {}), 200);
    assert.deepEqual(restoredImport.suite, renamed);
    assert.deepEqual(restoredImport.evaluations.filter(e => e.suiteId === renamed.id), currentMembers);
    assert.equal(restoredImport.evaluations.length, workshopEvaluations.length - 1);
    assert.deepEqual(restoredImport.suites.slice(1), imported.suites.slice(1));
    assert.deepEqual(await restored.get('/api/evaluations/' + first.id), edited);
    assert.deepEqual(await restored.get('/api/evaluations/' + existing.id), existing);

    await result(restored.request('/api/suites/' + imported.suite.id, { method: 'DELETE' }), 409);
    for (const member of currentMembers) await result(put(restored, '/api/evaluations/' + member.id, { ...member, suiteId: '' }), 200);
    await result(restored.request('/api/suites/' + imported.suite.id, { method: 'DELETE' }), 200);
    const unlinked = await restored.get('/api/evaluations/' + first.id);
    assert.equal(unlinked.name, edited.name); assert.equal(unlinked.suiteId, ''); assert.equal(unlinked.revision, 3);
    const reimport = await result(restored.post('/api/workshop-suite', {}), 201);
    assert.notEqual(reimport.suite.id, imported.suite.id);
    assert.equal(reimport.evaluations.length, workshopEvaluations.length);
    assert.deepEqual(await restored.get('/api/evaluations/' + first.id), unlinked);
  } finally { await close(app); await rm(dir, { recursive: true, force: true }); }
});

test('the live workshop import leaves earlier pasted suites, edits and run snapshots untouched', async () => {
  const app = await listen(createApp({ dbPath: ':memory:', fetchImpl: async () => syntheticStream() }));
  try {
    const person = await client(app);
    const originalSuite = await suite(person, 'Participant renamed the old workshop');
    const oldSuite = { ...originalSuite, seedKey: 'workshop-v1' };
    app.store.db.prepare('UPDATE suites SET data=? WHERE id=?').run(JSON.stringify(oldSuite), oldSuite.id);
    const oldEvaluation = await save(person, { ...base, name: 'Participant edited old example', suiteId: oldSuite.id });
    const oldRun = await run(person, oldEvaluation.id);
    const imported = await result(person.post('/api/workshop-suite', {}), 201);
    assert.equal(imported.suite.seedKey, workshopSuite.seedKey);
    assert.notEqual(imported.suite.id, oldSuite.id);
    assert.ok(imported.evaluations.every(e => e.source === 'testcraft_api' && e.actualOutput === ''));
    assert.deepEqual(await person.get('/api/suites/' + oldSuite.id), oldSuite);
    assert.deepEqual(await person.get('/api/evaluations/' + oldEvaluation.id), oldEvaluation);
    assert.deepEqual(await person.get('/api/runs/' + oldRun.id), oldRun);
    const repeated = await result(person.post('/api/workshop-suite', {}), 200);
    assert.equal(repeated.suite.id, imported.suite.id);
    assert.equal(app.store.suites(person.scope).length, 1 + workshopSuites.length);

  } finally { await close(app); }
});

test('workshop import rejects custom bodies and rolls back the suite and all fixtures on failure', async () => {
  const app = await listen(createApp({ dbPath: ':memory:', fetchImpl: noProvider }));
  try {
    const person = await client(app), saved = await save(person);
    for (const body of [null, [], 'text', { name: 'Custom' }, { ownerId: 'another' }, { evaluations: [base] }]) {
      assert.equal((await person.post('/api/workshop-suite', body)).status, 400);
    }
    assert.throws(() => app.store.importWorkshop({ name: 'Invalid bundle', evaluations: [base, { ...base, html: '' }] }, person.scope), { status: 400 });
    assert.deepEqual(app.store.suites(person.scope), []);
    assert.deepEqual(app.store.evaluations(person.scope), [saved]);
    app.store.db.exec(`CREATE TEMP TRIGGER fail_workshop_insert BEFORE INSERT ON evaluations
      WHEN (SELECT COUNT(*) FROM evaluations) > 1 BEGIN SELECT RAISE(ABORT, 'Simulated disk failure'); END;`);
    assert.throws(() => app.store.importWorkshop({ name: 'Atomic bundle', evaluations: [base, { ...base, name: 'Second fixture' }] }, person.scope), /Simulated disk failure/);
    assert.deepEqual(app.store.suites(person.scope), []);
    assert.deepEqual(app.store.evaluations(person.scope), [saved]);
    assert.deepEqual(app.store.runs(person.scope), []);

    app.store.db.exec('DROP TRIGGER fail_workshop_insert');
    await result(person.post('/api/workshop-suite', {}), 201);
  } finally { await close(app); }
});
