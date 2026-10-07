import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePersonalApiKey } from '../src/evals/credentials.mjs';
import { createApp, listen, client } from './helpers.mjs';

test('key validation uses only the supplied key at the configured model-list endpoint without generation or persistence', async () => {
  const calls = [];
  const env = { OPENAI_BASE_URL: 'https://grader.example/v1/', OPENAI_API_KEY: 'admin-judge', TESTCRAFT_OPENAI_API_KEY: 'admin-generator' };
  const app = await listen(createApp({ dbPath: ':memory:', env, fetchImpl: async (url, options) => {
    calls.push({ url, options }); return Response.json({ object: 'list', data: [] });
  } }));
  try {
    const collaborator = await client(app, { githubId: 1001 });
    const response = await collaborator.post('/api/api-key/validate', { openAiApiKey: '  synthetic-personal-key  ' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { valid: true });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://grader.example/v1/models');
    assert.equal(calls[0].options.method, 'GET');
    assert.deepEqual(calls[0].options.headers, { authorization: 'Bearer synthetic-personal-key' });
    assert.equal(calls[0].options.body, undefined);
    assert.equal(calls[0].options.redirect, 'error');
    assert.ok(calls[0].options.signal instanceof AbortSignal);
    assert.equal(app.engine.active, 0);
    assert.deepEqual(await collaborator.get('/api/runs'), { runs: [] });
    assert.equal(env.OPENAI_API_KEY, 'admin-judge');
    assert.equal(env.TESTCRAFT_OPENAI_API_KEY, 'admin-generator');
    for (const { name } of app.store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()) {
      assert.equal(JSON.stringify(app.store.db.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '"').all()).includes('synthetic-personal-key'), false);
    }
  } finally { await app.shutdown(); }
});

test('key validation requires authentication, exact origin and session CSRF; admin credentials are never checked', async () => {
  let calls = 0;
  const app = await listen(createApp({ dbPath: ':memory:', fetchImpl: async () => { calls++; return Response.json({ object: 'list', data: [] }); } }));
  try {
    const collaborator = await client(app, { githubId: 1001 }), admin = await client(app, { githubId: 1 });
    const path = '/api/api-key/validate', body = JSON.stringify({ openAiApiKey: 'synthetic-key' });
    assert.equal((await fetch(collaborator.url + path, { method: 'POST', headers: { origin: collaborator.url, 'content-type': 'application/json' }, body })).status, 401);
    assert.equal((await collaborator.request(path, { method: 'POST', headers: { origin: 'https://other.example' }, body })).status, 403);
    assert.equal((await collaborator.request(path, { method: 'POST', headers: { 'x-csrf-token': 'wrong' }, body })).status, 403);
    assert.equal((await admin.post(path, { openAiApiKey: 'synthetic-key' })).status, 403);
    for (const value of [undefined, null, 42, '', '  ', 'bad key', 'bad\nkey', 'bad\0key', 'bad\x7fkey', 'x'.repeat(4097)]) {
      assert.equal((await collaborator.post(path, { openAiApiKey: value })).status, 400);
    }
    assert.equal(calls, 0);
  } finally { await app.shutdown(); }
});

test('provider failures give safe key-check errors without expiring the app session or retrying', async () => {
  let status = 401, calls = 0;
  const app = await listen(createApp({ dbPath: ':memory:', fetchImpl: async () => {
    calls++; return Response.json({ error: { message: 'synthetic-secret raw provider details' } }, { status });
  } }));
  try {
    const collaborator = await client(app, { githubId: 1001 });
    for (const [upstream, expected, message] of [[401, 422, /rejected/], [403, 422, /permissions/], [429, 503, /rate limiting/], [500, 502, /right now/]]) {
      status = upstream;
      const response = await collaborator.post('/api/api-key/validate', { openAiApiKey: 'synthetic-secret' });
      assert.equal(response.status, expected);
      const text = await response.text(); assert.match(text, message); assert.doesNotMatch(text, /synthetic-secret|raw provider/);
      assert.equal((await collaborator.get('/api/session')).authenticated, true);
    }
    assert.equal(calls, 4);
  } finally { await app.shutdown(); }
});

test('network, timeout, redirects and malformed success responses never validate a key or leak provider errors', async () => {
  for (const [fetchImpl, message] of [
    [async () => { throw new Error('private-key'); }, /could not be reached/],
    [async () => { throw Object.assign(new Error('private-key'), { name: 'TimeoutError' }); }, /timed out/],
    [async () => new Response('', { status: 302 }), /right now/],
    [async () => new Response('<html>private-key</html>'), /unexpected/],
    [async () => Response.json({ object: 'list', data: 'private-key' }), /unexpected/],
    [async () => new Response('x'.repeat(500001)), /unexpected/],
  ]) {
    let calls = 0;
    await assert.rejects(validatePersonalApiKey('synthetic-key', {}, (...args) => { calls++; return fetchImpl(...args); }), error => {
      assert.match(error.message, message); assert.doesNotMatch(error.message, /private-key/); assert.equal(error.status, 502); return true;
    });
    assert.equal(calls, 1);
  }
});
