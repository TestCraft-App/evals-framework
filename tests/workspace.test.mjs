import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, listen, close, client } from './helpers.mjs';

test('workspace reset is scoped, reviewed, atomic, and preserves sessions and reloadable templates', async () => {
  const app = await listen(createApp({ dbPath: ':memory:' }));
  try {
    const person = await client(app), other = await client(app);
    await person.post('/api/workshop-suite', {}); await other.post('/api/workshop-suite', {});
    const otherBefore = await other.get('/api/workspace');
    const initial = await person.get('/api/workspace');
    const clear = (revision, headers) => person.request('/api/workspace', { method: 'DELETE', headers, body: JSON.stringify({ revision }) });
    assert.equal(initial.suites.length, 6);
    assert.equal((await clear(initial.revision, { 'x-csrf-token': 'wrong' })).status, 403);
    assert.equal((await clear(initial.revision, { origin: 'https://foreign.invalid' })).status, 403);
    assert.equal((await clear('invalid')).status, 400);
    app.store.createSuite({ name: 'New suite' }, person.scope);
    assert.equal((await clear(initial.revision)).status, 409);
    const active = { id: 'active', status: 'queued', createdAt: new Date().toISOString(), items: [] };
    app.store.saveRun(active, person.scope);
    assert.equal((await clear((await person.get('/api/workspace')).revision)).status, 409);
    app.store.saveRun({ ...active, status: 'completed' }, person.scope);
    const reviewed = await person.get('/api/workspace');
    app.store.db.exec("CREATE TEMP TRIGGER fail_clear BEFORE DELETE ON evaluations BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;");
    assert.equal((await clear(reviewed.revision)).status, 500);
    assert.deepEqual(await person.get('/api/workspace'), reviewed);
    app.store.db.exec('DROP TRIGGER fail_clear');
    assert.equal((await clear(reviewed.revision)).status, 200);
    const empty = await person.get('/api/workspace');
    assert.equal(empty.evaluationCount + empty.runCount + empty.suites.length, 0);
    assert.deepEqual(await other.get('/api/workspace'), otherBefore);
    assert.equal((await person.get('/api/session')).workspaceId, person.info.workspaceId);
    assert.equal((await clear(empty.revision)).status, 200);
    assert.equal((await person.post('/api/workshop-suite', {})).status, 201);
    assert.equal((await person.get('/api/workspace')).evaluationCount, initial.evaluationCount);
  } finally { await close(app); }
});
