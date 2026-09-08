import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp as createRawApp } from '../server.mjs';

export const testScope = { ownerId: 'fixture-owner', workshopId: 'workshop' };
export const createApp = options => createRawApp({ ...options, env: { ...options?.env } });
export async function listen(app) {
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  return app;
}
export const close = app => new Promise(resolve => app.server.close(resolve));
export async function client(app, { cookie, origin } = {}) {
  const url = `http://127.0.0.1:${app.server.address().port}`;
  origin ||= url;
  let info, rawCookie;
  if (cookie) info = await (await fetch(url + '/api/session', { headers: { cookie } })).json();
  else {
    const res = await fetch(url + '/api/session', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 200, await res.clone().text());
    info = await res.json(); rawCookie = res.headers.get('set-cookie'); cookie = rawCookie.split(';')[0];
  }
  const headers = { cookie, origin, 'x-csrf-token': info.csrfToken, 'content-type': 'application/json' };
  const request = (path, options = {}) => fetch(url + path, { ...options, headers: { ...headers, ...options.headers } });
  const get = async path => (await request(path)).json();
  const post = (path, body) => request(path, { method: 'POST', body: JSON.stringify(body) });
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
