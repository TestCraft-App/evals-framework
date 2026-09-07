import { randomUUID } from 'node:crypto';
import { AppError, PASS_THRESHOLD, unsupportedGraderModel } from './validation.mjs';
import { generateOutput } from './providers.mjs';
import { grade } from './graders.mjs';

export class Engine {
  constructor(store, env, fetchImpl = fetch) { this.store = store; this.env = env; this.fetchImpl = fetchImpl; this.queue = []; this.active = 0; this.inFlight = new Set(); }
  start(ids) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 50 || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new AppError('Select between 1 and 50 distinct evaluations.');
    if (this.queue.length + this.active + ids.length > 100) throw new AppError('Run queue is full. Wait for the active runs to finish.', 429);
    if (ids.some(id => this.inFlight.has(id))) throw new AppError('One of these evaluations is already running.', 409);
    const evaluations = ids.map(id => { const value = this.store.evaluation(id); if (!value) throw new AppError('Evaluation not found.', 404); return { ...value, threshold: PASS_THRESHOLD }; });
    const run = { id: randomUUID(), status: 'queued', createdAt: new Date().toISOString(), items: evaluations.map(evaluation => ({ id: randomUUID(), evaluationId: evaluation.id, evaluation, status: 'queued', score: null, output: null, checks: [], events: [] })) };
    this.store.saveRun(run);
    for (const item of run.items) { this.inFlight.add(item.evaluationId); this.queue.push({ run, item }); }
    setImmediate(() => this.pump());
    return run;
  }
  pump() {
    while (this.active < 2 && this.queue.length) {
      const job = this.queue.shift(); this.active++;
      this.execute(job).catch(error => console.error('Evaluation persistence failure:', error.message)).finally(() => { this.inFlight.delete(job.item.evaluationId); this.active--; this.pump(); });
    }
  }
  async execute({ run, item }) {
    const started = Date.now();
    const event = message => { item.events.push({ at: new Date().toISOString(), message }); this.store.saveRun(run); };
    run.status = 'running'; item.status = 'generating'; item.startedAt = new Date().toISOString();
    event(item.evaluation.source === 'pasted' ? 'Loading supplied TestCraft output' : `Generating ${item.evaluation.type} from input and HTML`);
    try {
      // Do not pay for a generation when the selected judge cannot be called.
      if (item.evaluation.method === 'model_grade' && !this.env.OPENAI_API_KEY) throw new AppError('Set OPENAI_API_KEY in the backend .env and restart before running Model grade.', 503);
      if (item.evaluation.method === 'model_grade' && unsupportedGraderModel(item.evaluation.judgeModel)) throw new AppError('This model does not support structured grading. Duplicate the evaluation and choose another model grader.');
      const generated = await generateOutput(item.evaluation, this.env, this.fetchImpl);
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
    this.store.saveRun(run);
  }
}
