export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export const frameworks = { playwright: ['typescript', 'javascript', 'python', 'java', 'csharp'], cypress: ['typescript', 'javascript'], selenium: ['javascript', 'python', 'java', 'csharp'] };
import { criterionMethods, evaluationMethods, methods, needsModelGrader, isModelMethod, TEST_COUNT_CRITERION } from './methods.mjs';
export { methods } from './methods.mjs';
export const sources = ['pasted', 'testcraft_api', 'llm'];
export const PASS_THRESHOLD = 80;

function string(value, field, max, required = true) {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new AppError(`${field} must be ${required ? 'non-empty text' : 'text'} (up to ${max} characters).`);
  return value.trim();
}
function choice(value, options, field) {
  if (!options.includes(value)) throw new AppError(`Invalid ${field}.`);
  return value;
}

// Return new objects without modifying saved definitions or historical run snapshots.
// Scalar definitions predate criteria lists: rules used expectedOutput, while
// model graders used newline-separated rubric text and an optional reference.
export function normalizeCriteria(evaluation, { allowLegacy = true } = {}) {
  if (!evaluation || typeof evaluation !== 'object' || Array.isArray(evaluation)) throw new AppError('Expected an evaluation object.');
  const method = choice(evaluation.method, methods, 'evaluation method');
  let values = evaluation.criteria;
  if (!Array.isArray(values) && allowLegacy && method !== 'hybrid') {
    const reference = method === 'model_grade' ? values : evaluation.expectedOutput ?? values;
    if (typeof reference === 'string') {
      values = method === 'exact_match' ? [reference] : [...new Set(reference.split(/\r?\n/).map(value => value.trim()).filter(Boolean))];
    }
  }
  if (!Array.isArray(values) || !values.length || values.length > 20) throw new AppError('Add between 1 and 20 criteria as a list.');
  const criteria = Array.from(values, value => {
    const legacyString = typeof value === 'string';
    if (!legacyString && (!value || typeof value !== 'object' || Array.isArray(value))) throw new AppError('Each criterion must be text or an object with text, method, and an optional weight.');
    const criterionMethod = choice(legacyString ? method : value.method, criterionMethods, 'criterion method');
    if (method !== 'hybrid' && criterionMethod !== method) throw new AppError('Each criterion method must match the evaluation method unless it is hybrid.');
    const text = criterionMethod === 'test_count' ? TEST_COUNT_CRITERION : string(legacyString ? value : value.text, 'Each criterion', 8000);
    const weight = legacyString || value.weight === undefined ? 1 : value.weight;
    if (!Number.isFinite(weight) || weight < 0.01 || weight > 100) throw new AppError('Each criterion weight must be a finite number from 0.01 to 100.');
    const description = !legacyString && !isModelMethod(criterionMethod) ? string(value.description, 'Criterion description', 2000, false) : '';
    return { text, method: criterionMethod, weight, ...(description ? { description } : {}) };
  });
  if (criteria.filter(criterion => criterion.method === 'test_count').length > 1) throw new AppError('Use at most one Test count criterion.');
  if (criteria.reduce((sum, criterion) => sum + criterion.text.length, 0) > 8000) throw new AppError('Keep all criteria within 8000 characters.');
  if (new Set(criteria.map(criterion => JSON.stringify([criterion.method, criterion.text]))).size !== criteria.length) throw new AppError('Each criterion must have a distinct method and text.');
  if (method === 'exact_match' && criteria.length !== 1) throw new AppError('Exact match requires exactly one criterion containing the complete text to match.');
  return criteria;
}

export function validateEvaluation(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError('Expected an evaluation object.');
  const type = choice(body.type, ['ideas', 'code'], 'TestCraft endpoint');
  const framework = type === 'code' ? choice(body.framework, Object.keys(frameworks), 'framework') : '';
  const language = type === 'code' ? choice(body.language, frameworks[framework], 'framework/language combination') : '';
  const method = choice(body.method, methods, 'evaluation method');
  const source = choice(body.source ?? 'testcraft_api', sources, 'output source');
  const criteria = normalizeCriteria(body, { allowLegacy: false });
  const model = source === 'pasted' ? '' : string(body.model, 'Generation model', 120, source === 'llm');
  const judgeModel = needsModelGrader({ method, criteria }) ? string(body.judgeModel, 'Model grader', 120, false) : '';
  const suiteId = string(body.suiteId, 'Suite ID', 36, false);
  if (suiteId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(suiteId)) throw new AppError('Suite ID must be a UUID or empty for an evaluation without a suite.');
  const pageUrl = string(body.pageUrl, 'Page URL', 2000, false);
  if (source === 'testcraft_api' && type === 'code' && !pageUrl) throw new AppError('Page URL is required for TestCraft code generation.');
  if (body.pom !== undefined && typeof body.pom !== 'boolean') throw new AppError('POM must be a boolean.');
  if (body.fromIdeas !== undefined && typeof body.fromIdeas !== 'boolean') throw new AppError('From ideas must be a boolean.');
  if (pageUrl) {
    try { if (!['https:', 'http:'].includes(new URL(pageUrl).protocol)) throw new Error(); }
    catch { throw new AppError('Page URL must be a valid HTTP or HTTPS URL.'); }
  }
  const fromIdeas = type === 'code' && source === 'testcraft_api' && (body.fromIdeas ?? false);
  return {
    schemaVersion: 3, name: string(body.name, 'Name', 140), suiteId, type, framework, language, method, evaluationFamily: evaluationMethods[method].family, source, threshold: PASS_THRESHOLD,
    input: string(body.input, 'Test description', 16000, false), html: string(body.html, 'HTML', 100000),
    actualOutput: source === 'pasted' ? string(body.actualOutput, 'TestCraft output', 60000) : '',
    ideas: fromIdeas ? string(body.ideas, 'Selected test ideas', 16000) : '',
    criteria, model, judgeModel, pageUrl, pom: type === 'code' && source === 'testcraft_api' && (body.pom ?? false), fromIdeas,
  };
}
