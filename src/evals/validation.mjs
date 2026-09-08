export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export const frameworks = { playwright: ['typescript', 'javascript', 'python', 'java', 'csharp'], cypress: ['typescript', 'javascript'], selenium: ['javascript', 'python', 'java', 'csharp'] };
import { evaluationMethods, methods } from './methods.mjs';
export { methods } from './methods.mjs';
export const sources = ['pasted', 'testcraft_api', 'llm'];
export const PASS_THRESHOLD = 80;
export const verifiedGraderModels = ['gpt-4o-mini', 'gpt-4o', 'o3-mini'];
export const unsupportedGraderModel = model => /^(gpt-4-turbo|o1-mini)(-|$)/.test(model);

function string(value, field, max, required = true) {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new AppError(`${field} must be ${required ? 'non-empty text' : 'text'} (up to ${max} characters).`);
  return value.trim();
}
function choice(value, options, field) {
  if (!options.includes(value)) throw new AppError(`Invalid ${field}.`);
  return value;
}

export function validateEvaluation(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError('Expected an evaluation object.');
  const type = choice(body.type, ['ideas', 'code'], 'TestCraft endpoint');
  const framework = type === 'code' ? choice(body.framework, Object.keys(frameworks), 'framework') : '';
  const language = type === 'code' ? choice(body.language, frameworks[framework], 'framework/language combination') : '';
  const method = choice(body.method, methods, 'evaluation method');
  const source = choice(body.source, sources, 'output source');
  if (!Array.isArray(body.criteria) || !body.criteria.length || body.criteria.length > 20) throw new AppError('Add between 1 and 20 criteria as a list of strings.');
  const criteria = body.criteria.map(value => string(value, 'Each criterion', 8000));
  if (criteria.join('').length > 8000) throw new AppError('Keep all criteria within 8000 characters.');
  if (new Set(criteria).size !== criteria.length) throw new AppError('Each criterion must be distinct.');
  if (method === 'exact_match' && criteria.length !== 1) throw new AppError('Exact match requires exactly one criterion containing the complete text to match.');
  const model = source === 'pasted' ? '' : string(body.model, 'Generation model', 120, source === 'llm');
  const judgeModel = method === 'model_grade' ? string(body.judgeModel, 'Model grader', 120) : '';
  if (unsupportedGraderModel(judgeModel)) throw new AppError('This model does not support structured grading. Choose another model grader.');
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
    schemaVersion: 2, name: string(body.name, 'Name', 140), type, framework, language, method, evaluationFamily: evaluationMethods[method].family, source, threshold: PASS_THRESHOLD,
    input: string(body.input, 'Test description', 16000, false), html: string(body.html, 'HTML', 100000),
    actualOutput: source === 'pasted' ? string(body.actualOutput, 'TestCraft output', 60000) : '',
    ideas: fromIdeas ? string(body.ideas, 'Selected test ideas', 16000) : '',
    criteria, model, judgeModel, pageUrl, pom: type === 'code' && source === 'testcraft_api' && (body.pom ?? false), fromIdeas,
  };
}
