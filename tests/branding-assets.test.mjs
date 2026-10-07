import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp, listen } from './helpers.mjs';

test('local branding assets load without login with binary MIME types and existing security headers', async () => {
  const app = await listen(createApp({ dbPath: ':memory:', env: {} }));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  try {
    for (const [asset, mime] of [['testcraft-logo.png', 'image/png'], ['Sora-VariableFont_wght.ttf', 'font/ttf']]) {
      const response = await fetch(origin + '/assets/' + asset);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), mime);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(new URL('../public/assets/' + asset, import.meta.url)));
    }
    for (const path of ['/assets/missing.png', '/assets/../server.mjs', '/assets/OFL-Sora.txt']) {
      const response = await fetch(origin + path);
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: 'Not found.' });
    }
  } finally { await app.shutdown(); }
});
