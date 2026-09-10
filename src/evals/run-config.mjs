import { AppError, normalizeCriteria } from './validation.mjs';
import { needsModelGrader } from './methods.mjs';

export const environments = Object.freeze({ prod: 'https://api.testcraft.app', dev: 'https://openai-api-proxy-dev-rtu664353a-uc.a.run.app', local: 'http://127.0.0.1:8080' });
const loopback = host => ['localhost', '127.0.0.1', '::1', '[::1]', '::ffff:127.0.0.1'].includes(host);
export function localAvailable(env, address) {
  return env.NODE_ENV !== 'production' && loopback(address?.address) && (!env.HOST || loopback(env.HOST))
    && (!env.APP_ORIGIN || loopback(new URL(env.APP_ORIGIN).hostname));
}
export function resolveEnvironment(id, allowLocal) {
  if (!Object.hasOwn(environments, id)) throw new AppError('Choose Prod, Dev, or Local.');
  if (id === 'local' && !allowLocal) throw new AppError('Local is available only when this app runs on a local development server.');
  return environments[id];
}
export function validateRunRequest(body, allowLocal) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError('Expected a run configuration.');
  const testcraftBaseUrl = resolveEnvironment(body.environment, allowLocal);
  if (body.description !== undefined && (typeof body.description !== 'string' || body.description.length > 2000)) throw new AppError('Run description must be text up to 2000 characters.');
  // Accept the historical single-model request; persist new runs with a model list.
  const generationModels = body.generationModels === undefined ? [body.generationModel] : body.generationModels;
  const validModel = model => typeof model === 'string' && /^[\w.:-]{1,120}$/.test(model);
  if (!Array.isArray(generationModels) || !generationModels.length || generationModels.length > 200 || generationModels.some(model => !validModel(model)) || new Set(generationModels).size !== generationModels.length) throw new AppError('Choose at least one distinct valid generation model (maximum 200).');
  if (body.graderModel !== undefined && body.graderModel !== '' && !validModel(body.graderModel)) throw new AppError('Choose a valid grader model.');
  return { description: (body.description || '').trim(), environment: body.environment, testcraftBaseUrl, generationModels: [...generationModels], graderModel: body.graderModel || '' };
}
export function validateRunModels(settings, evaluations, catalog) {
  if (!catalog.models.length) throw new AppError('Models are unavailable for this environment. Retry loading models.', 503);
  if (settings.generationModels.some(id => !catalog.models.some(model => model.id === id))) throw new AppError('Choose generation models available in this environment.');
  const needsGrader = evaluations.some(evaluation => needsModelGrader({ ...evaluation, criteria: normalizeCriteria(evaluation) }));
  if (needsGrader && !catalog.models.some(model => model.id === settings.graderModel)) throw new AppError('Choose a grader model available in this environment.');
  return { ...settings, graderModel: needsGrader ? settings.graderModel : '' };
}
