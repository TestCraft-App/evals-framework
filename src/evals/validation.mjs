export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export const frameworks = { playwright: ['typescript', 'javascript', 'python', 'java', 'csharp'], cypress: ['typescript', 'javascript'], selenium: ['javascript', 'python', 'java', 'csharp'] };
export const methods = ['model_grade', 'exact_match', 'contains'];
export const sources = ['pasted', 'testcraft_api', 'llm'];

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
  const type = choice(body.type, ['ideas', 'code'], 'evaluation type');
  const framework = choice(body.framework, Object.keys(frameworks), 'framework');
  const language = choice(body.language, frameworks[framework], 'framework/language combination');
  const method = choice(body.method, methods, 'evaluation method');
  const source = choice(body.source, sources, 'output source');
  const criteria = string(body.criteria, 'Evaluation criteria', 8000, method === 'model_grade');
  if (criteria.split('\n').filter(x => x.trim()).length > 20) throw new AppError('Use at most 20 criteria, one per line.');
  const threshold = body.threshold;
  if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 1 || threshold > 100) throw new AppError('Pass threshold must be between 1 and 100.');
  const model = string(body.model, 'Generation model', 120, source === 'llm');
  const judgeModel = string(body.judgeModel, 'Judge model', 120, method === 'model_grade');
  const pageUrl = string(body.pageUrl, 'Page URL', 2000, false);
  if (source === 'testcraft_api' && type === 'code' && !pageUrl) throw new AppError('Page URL is required for TestCraft code generation.');
  if (body.pom !== undefined && typeof body.pom !== 'boolean') throw new AppError('POM must be a boolean.');
  if (body.fromIdeas !== undefined && typeof body.fromIdeas !== 'boolean') throw new AppError('From ideas must be a boolean.');
  if (pageUrl) {
    try { if (!['https:', 'http:'].includes(new URL(pageUrl).protocol)) throw new Error(); }
    catch { throw new AppError('Page URL must be a valid HTTP or HTTPS URL.'); }
  }
  return {
    name: string(body.name, 'Name', 140), type, framework, language, method, source, threshold,
    input: string(body.input, 'Input', 16000), html: string(body.html, 'HTML', 100000),
    expectedOutput: string(body.expectedOutput, 'Expected output', 50000),
    actualOutput: string(body.actualOutput, 'TestCraft output', 60000, source === 'pasted'),
    criteria, model, judgeModel, pageUrl, pom: body.pom ?? false, fromIdeas: body.fromIdeas ?? false,
  };
}
