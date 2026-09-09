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
  for (const field of ['generationModel', 'graderModel']) {
    if (field === 'graderModel' && (body[field] === undefined || body[field] === '')) continue;
    if (typeof body[field] !== 'string' || !/^[\w.:-]{1,120}$/.test(body[field])) throw new AppError(`Choose a valid ${field === 'generationModel' ? 'generation' : 'grader'} model.`);
  }
  return { description: (body.description || '').trim(), environment: body.environment, testcraftBaseUrl, generationModel: body.generationModel, graderModel: body.graderModel || '' };
}
export function validateRunModels(settings, evaluations, catalog) {
  if (!catalog.models.length) throw new AppError('Models are unavailable for this environment. Retry loading models.', 503);
  if (!catalog.models.some(model => model.id === settings.generationModel)) throw new AppError('Choose a generation model available in this environment.');
  const needsGrader = evaluations.some(evaluation => needsModelGrader({ ...evaluation, criteria: normalizeCriteria(evaluation) }));
  if (needsGrader && !catalog.models.some(model => model.id === settings.graderModel)) throw new AppError('Choose a grader model available in this environment.');
  return { ...settings, graderModel: needsGrader ? settings.graderModel : '' };
}
