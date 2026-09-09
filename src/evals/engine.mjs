import { randomUUID } from 'node:crypto';
import { AppError, normalizeCriteria, validateEvaluation, PASS_THRESHOLD } from './validation.mjs';
import { generateOutput } from './providers.mjs';
import { grade } from './graders.mjs';
import { GRADING_VERSION, needsModelGrader } from './methods.mjs';

export class Engine {
  constructor(store, env, fetchImpl = fetch) { this.store = store; this.env = env; this.fetchImpl = fetchImpl; this.queue = []; this.active = 0; this.inFlight = new Set(); this.accepting = true; this.idleWaiters = new Set(); }
  get idle() { return this.active === 0 && this.queue.length === 0; }
  drain() {
    this.accepting = false;
    if (this.idle) return Promise.resolve();
    return new Promise(resolve => this.idleWaiters.add(resolve));
  }
  resume() { this.accepting = true; }
  evaluationsForRun(ids, scope) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 50 || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new AppError('Select between 1 and 50 distinct evaluations.');
    return ids.map(id => { const value = this.store.evaluation(id, scope); if (!value) throw new AppError('Evaluation not found.', 404); return { ...value, threshold: PASS_THRESHOLD }; });
  }
  start(ids, scope, settings) {
    if (!this.accepting) throw new AppError('The server is preparing an update. Existing runs will finish; try starting a new run shortly.', 503);
    if (!Array.isArray(ids) || !ids.length || ids.length > 50 || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new AppError('Select between 1 and 50 distinct evaluations.');
    if (this.queue.length + this.active + ids.length > 100) throw new AppError('Run queue is full. Wait for the active runs to finish.', 429);
    let evaluations = this.evaluationsForRun(ids, scope);
    if (settings) evaluations = evaluations.map(evaluation => {
      const effective = { ...evaluation, source: 'testcraft_api', model: settings.generationModel, judgeModel: settings.graderModel, actualOutput: '' };
      try { validateEvaluation({ ...effective, criteria: normalizeCriteria(effective) }); }
      catch (error) { if (error instanceof AppError) throw new AppError(`Edit "${evaluation.name}": ${error.message}`); throw error; }
      return effective;
    });
    if (ids.some(id => this.inFlight.has(id))) throw new AppError('One of these evaluations is already running.', 409);
    evaluations = evaluations.map(evaluation => ({ ...evaluation, suiteName: evaluation.suiteId ? this.store.suite(evaluation.suiteId, scope)?.name || 'Unavailable suite' : 'Unfiled' }));
    const run = { id: randomUUID(), gradingVersion: GRADING_VERSION, status: 'queued', createdAt: new Date().toISOString(), items: evaluations.map(evaluation => ({ id: randomUUID(), gradingVersion: GRADING_VERSION, evaluationId: evaluation.id, evaluation, status: 'queued', score: null, output: null, checks: [], events: [] })) };
    if (settings) { const { description, ...configuration } = settings; run.description = description; run.settings = configuration; }
    this.store.saveRun(run, scope);
    for (const item of run.items) { this.inFlight.add(item.evaluationId); this.queue.push({ run, item, scope }); }
    setImmediate(() => this.pump());
    return run;
  }
  pump() {
    while (this.active < 2 && this.queue.length) {
      const job = this.queue.shift(); this.active++;
      this.execute(job).catch(error => console.error('Evaluation persistence failure:', error.message)).finally(() => { this.inFlight.delete(job.item.evaluationId); this.active--; this.pump(); });
    }
    if (this.idle) {
      for (const resolve of this.idleWaiters) resolve();
      this.idleWaiters.clear();
    }
  }
  async execute({ run, item, scope }) {
    const started = Date.now();
    const event = message => { item.events.push({ at: new Date().toISOString(), message }); this.store.saveRun(run, scope); };
    run.status = 'running'; item.status = 'generating'; item.startedAt = new Date().toISOString();
    event(item.evaluation.source === 'pasted' ? 'Loading supplied TestCraft output' : `Generating ${item.evaluation.type} from input and HTML`);
    try {
      // Do not pay for a generation when the selected judge cannot be called.
      const criteria = normalizeCriteria(item.evaluation);
      if (needsModelGrader({ ...item.evaluation, criteria })) {
        if (!this.env.OPENAI_API_KEY) throw new AppError('Set OPENAI_API_KEY in the backend .env and restart before running LLM as a judge.', 503);
        if (typeof item.evaluation.judgeModel !== 'string' || !item.evaluation.judgeModel.trim()) throw new AppError('Choose a model grader before running model criteria.');
      }
      const generated = await generateOutput(item.evaluation, run.settings ? { ...this.env, TESTCRAFT_BASE_URL: run.settings.testcraftBaseUrl } : this.env, this.fetchImpl);
      item.output = generated.output; item.outputSource = generated.source; item.generationModel = generated.model; item.generationUsage = generated.usage;
      item.status = 'grading'; event(`Output received. Applying ${item.evaluation.method.replaceAll('_', ' ')}`);
      const result = await grade(item.evaluation, item.output, this.env, this.fetchImpl);
      Object.assign(item, result);
      item.status = item.score >= item.evaluation.threshold ? 'passed' : 'failed';
      event(`Evaluation ${item.status}: ${item.score}/100`);
    } catch (error) {
      item.status = 'error'; item.error = error instanceof AppError ? error.message : 'Unexpected evaluation failure. Check the server logs.';
      event(item.error);
    }
    item.durationMs = Date.now() - started;
    if (run.items.every(x => ['passed', 'failed', 'error'].includes(x.status))) { run.status = 'completed'; run.finishedAt = new Date().toISOString(); }
    this.store.saveRun(run, scope);
  }
}
