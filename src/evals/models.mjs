import { publicConfig } from './providers.mjs';
import { unsupportedGraderModel, verifiedGraderModels } from './validation.mjs';

// TestCraft's /api/models accepts an API key in its query string. Deliberately
// use its public/default catalog: no credentials in URLs, logs, or the browser.
export function createModelCatalog(env, fetchImpl = fetch, now = Date.now) {
  const configured = publicConfig(env).judgeModel;
  let cached, expiresAt = 0, pending;
  const configuredOption = { id: configured, label: `${configured} · backend configured`, source: 'configured', graderCompatible: !unsupportedGraderModel(configured) };
  const withConfigured = models => models.some(model => model.id === configured) ? models : [...models, configuredOption];

  async function fetchCatalog() {
    try {
      const base = (env.TESTCRAFT_BASE_URL || 'https://api.testcraft.app').replace(/\/$/, '');
      const response = await fetchImpl(`${base}/api/models`, { method: 'GET', headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error('Catalog unavailable');
      const reader = response.body.getReader();
      const chunks = []; let length = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > 64000) throw new Error('Catalog too large');
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!Array.isArray(data.models) || !data.models.length || data.models.length > 200) throw new Error('Invalid catalog');
      const models = data.models.map(model => {
        if (!model || typeof model.id !== 'string' || !/^[\w.:-]{1,120}$/.test(model.id) || typeof model.label !== 'string' || !model.label.trim() || model.label.length > 200) throw new Error('Invalid model');
        return { id: model.id, label: model.label, source: 'testcraft', graderCompatible: !unsupportedGraderModel(model.id) && (verifiedGraderModels.includes(model.id) || model.id === configured) };
      });
      if (new Set(models.map(model => model.id)).size !== models.length) throw new Error('Duplicate models');
      cached = { models: withConfigured(models), defaultModel: configured, source: 'testcraft', fetchedAt: new Date(now()).toISOString(), warning: null };
      expiresAt = now() + 5 * 60 * 1000;
      return cached;
    } catch {
      // Do not relay upstream errors (which might contain credentials).
      return cached ? { ...cached, warning: 'TestCraft models could not be refreshed. Showing the last catalog; account access is not verified.' }
        : { models: [configuredOption], defaultModel: configured, source: 'configured', fetchedAt: null, warning: 'TestCraft models are unavailable. Only the backend-configured model is listed; account access is not verified.' };
    }
  }
  return async () => {
    if (cached && now() < expiresAt) return cached;
    if (!pending) pending = fetchCatalog().finally(() => { pending = null; });
    return pending;
  };
}
