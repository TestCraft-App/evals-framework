export const canDeleteRun = run => ['completed', 'interrupted'].includes(run.status)
  && run.items.every(item => ['passed', 'failed', 'error'].includes(item.status));

export function summarizeRun(run) {
  const scored = run.items.filter(item => Number.isFinite(item.score));
  const models = run.items.filter(item => item.evaluation?.source !== 'pasted').map(item =>
    item.generationModel || item.evaluation?.model || (item.evaluation?.source === 'testcraft_api' ? 'API default' : 'Unknown'));
  return {
    id: run.id, createdAt: run.createdAt, status: run.status, finishedAt: run.finishedAt,
    total: run.items.length, passed: run.items.filter(item => item.status === 'passed').length,
    failed: run.items.filter(item => item.status === 'failed').length, errors: run.items.filter(item => item.status === 'error').length,
    models: [...new Set(models)].sort(), score: scored.length ? scored.reduce((sum, item) => sum + item.score, 0) / scored.length : null,
    scoredCount: scored.length, canDelete: canDeleteRun(run),
  };
}
