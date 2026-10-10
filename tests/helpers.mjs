import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp as createRawApp } from '../server.mjs';

export const testScope = { ownerId: 'fixture-owner', workshopId: 'workshop' };
export const runConfig = { environment: 'prod', generationModel: 'gpt-4o-mini', graderModel: 'gpt-4o-mini' };
export const catalogResponse = () => Response.json({ models: ['gpt-4o-mini', 'gpt-4o', 'o3-mini'].map(id => ({ id, label: id })) });
export const syntheticStream = (output = 'valid user; invalid password') => new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: output }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
let nextGithubId = 1;
export const createOAuthApp = options => createRawApp({ ...options, env: { OAUTH_GITHUB_CLIENT_ID: 'synthetic-client', GITHUB_CLIENT_SECRET: 'synthetic-secret', ADMIN_GITHUB_IDS: Array.from({ length: 1000 }, (_, i) => String(i + 1)).join(','), ...options?.env }, fetchImpl: async (url, init) => {
  if (url === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: new URLSearchParams(init.body).get('code') });
  if (url === 'https://api.github.com/user') {
    const id = Number(init.headers.authorization.slice(7));
    return Response.json({ id, login: 'user-' + id, name: 'Synthetic User ' + id });
  }
  if (options?.fetchImpl) return options.fetchImpl(url, init);
  throw new Error('Tests must mock every provider request.');
} });
export const createApp = options => createOAuthApp({ ...options, env: { ...options?.env }, fetchImpl: async (url, init) => {
  if (url.endsWith('/api/models')) return catalogResponse();
  if (options?.fetchImpl) return options.fetchImpl(url, init);
  if (url.startsWith('https://api.testcraft.app/api/')) return syntheticStream();
  throw new Error('Tests must mock every provider request.');
} });
export async function listen(app) {
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  return app;
}
export const close = app => new Promise(resolve => app.server.close(resolve));
export async function client(app, { cookie, origin, githubId = nextGithubId++ } = {}) {
  const url = `http://127.0.0.1:${app.server.address().port}`;
  origin ||= url;
  let info, rawCookie;
  if (cookie) info = await (await fetch(url + '/api/session', { headers: { cookie } })).json();
  else {
    const res = await fetch(url + '/api/auth/github/start', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 200, await res.clone().text());
    const authorization = new URL((await res.json()).authorizeUrl);
    const callback = await fetch(url + '/api/auth/github/callback?' + new URLSearchParams({ state: authorization.searchParams.get('state'), code: String(githubId) }), { headers: { cookie: res.headers.get('set-cookie').split(';')[0] }, redirect: 'manual' });
    assert.equal(callback.status, 303);
    assert.equal(callback.headers.get('location'), '/');
    rawCookie = callback.headers.getSetCookie().find(value => value.startsWith('testcraft_session=') || value.startsWith('__Host-testcraft_session=')); cookie = rawCookie.split(';')[0];
    info = await (await fetch(url + '/api/session', { headers: { cookie } })).json();
  }
  const headers = { cookie, origin, 'x-csrf-token': info.csrfToken, 'content-type': 'application/json' };
  const request = (path, options = {}) => fetch(url + path, { ...options, headers: { ...headers, ...options.headers } });
  const get = async path => (await request(path)).json();
  const post = (path, body) => request(path, { method: 'POST', body: JSON.stringify(path === '/api/runs' ? { ...runConfig, ...body } : body) });
  return { url, request, get, post, headers, cookie, rawCookie, info, scope: { ownerId: info.workspaceId, workshopId: app.engine.env.WORKSHOP_ID || 'workshop' } };
}
export async function waitForRun(client, id) {
  for (let count = 0; count < 200; count++) {
    const run = await client.get('/api/runs/' + id);
    if (run.id && !['running', 'queued'].includes(run.status)) return run;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Evaluation did not finish');
}
