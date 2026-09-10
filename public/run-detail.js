// Classify the actual criterion families, including rule-only mixed-method records.
const isModelMethod = method => ['model_grade', 'test_count'].includes(method);
const hasTestCount = evaluation => evaluation?.method === 'test_count' || evaluation?.criteria?.some?.(criterion => criterion?.method === 'test_count');
const countLabel = unit => unit === 'ideas' ? 'ideas' : 'automated tests';
export function evaluationFamily(evaluation) {
  const methods = Array.isArray(evaluation.criteria) ? evaluation.criteria.map(c => typeof c === 'string' ? evaluation.method : c.method || evaluation.method) : [];
  if (!methods.length) return evaluation.method === 'hybrid' ? 'hybrid' : isModelMethod(evaluation.method) ? 'model_based' : 'rule_based';
  const model = methods.some(isModelMethod), rules = methods.some(method => !isModelMethod(method));
  return model && rules ? 'hybrid' : model ? 'model_based' : 'rule_based';
}
export const scoreText = value => Number.isFinite(value) ? (value / 100).toFixed(2) : '—';
export const scoreClass = value => !Number.isFinite(value) ? 'score-missing' : value < 50 ? 'score-low' : value < 80 ? 'score-medium' : 'score-high';
export const scoreBand = value => !Number.isFinite(value) ? '' : value < 50 ? 'low' : value < 80 ? 'medium' : 'high';
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const scoreMarkup = value => '<span class="' + scoreClass(value) + '">' + scoreText(value) + '</span>';
const generationModelId = item => item.evaluation?.source === 'pasted' ? '' : item.generationModel || item.evaluation?.model || (item.evaluation?.source === 'testcraft_api' ? 'API default' : 'Unknown');
export function summarizeModels(run) {
  const groups = new Map();
  const groupFor = model => {
    if (!groups.has(model)) groups.set(model, { model, model_based: 0, rule_based: 0, hybrid: 0, total: 0, scoredCount: 0, score: null });
    return groups.get(model);
  };
  for (const model of run.settings?.generationModels || (run.settings?.generationModel ? [run.settings.generationModel] : [])) groupFor(model);
  for (const item of run.items) {
    const group = groupFor(generationModelId(item));
    group[evaluationFamily(item.evaluation || {})]++; group.total++;
    if (Number.isFinite(item.score)) { group.score = (group.score ?? 0) + item.score; group.scoredCount++; }
    if (hasTestCount(item.evaluation)) {
      const unit = item.evaluation.type === 'ideas' ? 'ideas' : 'automated_tests';
      group.counts ||= {};
      group.counts[unit] ||= { total: 0, measured: 0, enabled: 0 };
      const count = group.counts[unit]; count.enabled++;
      if (Number.isSafeInteger(item.testCount) && item.testCount >= 0) { count.total += item.testCount; count.measured++; }
    }
  }
  return [...groups.values()].map(group => ({ ...group, score: group.scoredCount ? group.score / group.scoredCount : null }));
}
const columns = { reference: 'Eval ID', name: 'Eval name', suite: 'Suite', model: 'Model', method: 'Eval method', status: 'Status', score: 'Score', met: 'Criteria met' };

export function createRunDetail({ root, getSuites, getCatalog, getMethods, getCriteria, runName, canDelete }) {
  const states = new Map();
  let current;
  const stateFor = id => {
    if (!states.has(id)) states.set(id, { filters: { suite: '', model: '', method: '', score: '' }, sort: '', direction: 1, expanded: new Set(), outputs: new Set() });
    return states.get(id);
  };
  const modelLabel = id => getCatalog(current.settings?.environment)?.models.find(model => model.id === id)?.label || id || '—';
  function itemView(item, index) {
    const evaluation = item.evaluation || {}, checks = (item.checks || []).filter(check => check.method !== 'test_count'), criteria = getCriteria(evaluation).filter(criterion => criterion.method !== 'test_count');
    const total = Math.max(criteria.length, checks.length);
    const complete = total > 0 && checks.length === total && checks.every(check => typeof check.passed === 'boolean');
    const passed = complete ? checks.filter(check => check.passed).length : null;
    const interrupted = item.status === 'interrupted' || (current.status === 'interrupted' && item.error === 'Server restarted before this evaluation finished. Run it again.');
    const status = interrupted ? 'Interrupted' : item.status === 'counted' ? 'Counted' : ['passed', 'failed'].includes(item.status) ? 'Graded' : ['queued', 'running', 'generating', 'grading'].includes(item.status) ? 'In progress' : 'Error';
    const modelId = generationModelId(item);
    return { item, index, reference: evaluation.reference || '—', name: evaluation.name || 'Unnamed evaluation',
      suite: (!evaluation.suiteId && evaluation.suiteName === 'Unfiled' ? 'None' : evaluation.suiteName) ?? (evaluation.suiteId ? getSuites().find(suite => suite.id === evaluation.suiteId)?.name || 'Unavailable suite' : 'None'),
      model: evaluation.source === 'pasted' ? '—' : modelLabel(modelId),
      method: { rule_based: 'rule-based', model_based: 'model-graded', hybrid: 'hybrid' }[evaluationFamily(evaluation)] || evaluation.method || '—', status,
      score: Number.isFinite(item.score) ? item.score : null,
      count: Number.isSafeInteger(item.testCount) && item.testCount >= 0 ? item.testCount : null,
      countText: Number.isSafeInteger(item.testCount) && item.testCount >= 0 ? item.testCount + ' ' + countLabel(item.testCountUnit || (evaluation.type === 'ideas' ? 'ideas' : 'automated_tests')) : '—',
      met: complete ? passed / total : null, metText: total ? (passed ?? '—') + '/' + total : '—' };
  }
  function criterionHtml(check, evaluation) {
    const method = check.method || evaluation?.method;
    if (method === 'test_count') return '<li class="criterion-result"><span class="criterion-verdict score-missing" aria-label="Quantity">#</span><div><div class="criterion-description">Test count: ' + escape(Number.isSafeInteger(check.count) ? check.count + ' ' + countLabel(check.unit) : 'Unavailable') + '</div><p class="criterion-reason" title="' + escape(check.reason) + '">' + escape(check.reason || 'Reason unavailable.') + '</p><p class="count-evidence">' + escape(check.evidence) + '</p></div></li>';
    const model = check.source === 'model' || method === 'model_grade';
    const verdict = typeof check.passed === 'boolean' ? check.passed ? 'Pass' : 'Fail' : 'Historical score ' + scoreText(check.score);
    const icon = typeof check.passed === 'boolean' ? check.passed ? '✓' : '✗' : '—';
    const target = String(check.criterion || '').replace(/\s+/g, ' ').trim();
    const ruleResult = typeof check.passed !== 'boolean' ? 'Historical result' : check.passed ? 'Met' : 'Not met';
    const reason = model ? check.reason || 'Reason unavailable.' : (getMethods()[method]?.label || method || 'Rule') + ': “' + target + '” — ' + ruleResult;
    const description = check.description || getCriteria(evaluation || {}).find(criterion => criterion.method === method && criterion.text === check.criterion)?.description || 'Description not added yet';
    return '<li class="criterion-result"><span class="criterion-verdict ' + (check.passed === true ? 'score-high' : check.passed === false ? 'score-low' : 'score-missing') + '" role="img" aria-label="' + escape(verdict) + '">' + icon + '</span><div><div class="criterion-description">' + escape(model ? check.criterion : description) + '</div><p class="criterion-reason" title="' + escape(reason) + '">' + escape(reason) + '</p></div></li>';
  }
  function expandedHtml(view, state) {
    const { item } = view, checks = item.checks || [];
    return '<tr class="detail-expansion"' + (state.expanded.has(item.id) ? '' : ' hidden') + '><td colspan="' + (current.items.some(item => hasTestCount(item.evaluation)) ? 9 : 8) + '"><section id="criteria-' + escape(item.id) + '" class="criterion-panel" aria-label="Results for ' + escape(view.name) + '"><h4>Criteria</h4>'
      + (item.error ? '<p class="error-banner" role="alert">' + escape(item.error) + '</p>' : '')
      + (checks.length ? '<ul class="criterion-results">' + checks.map(check => criterionHtml(check, item.evaluation)).join('') + '</ul>' : '<p class="muted">' + (view.status === 'In progress' ? 'Waiting for grading results…' : view.status === 'Graded' ? 'Criterion results are unavailable for this historical run.' : 'Grading did not complete.') + '</p>')
      + '<details data-output="' + escape(item.id) + '"' + (state.outputs.has(item.id) ? ' open' : '') + '><summary id="output-toggle-' + escape(item.id) + '">Inspect generated output</summary><pre class="saved-output">' + escape(item.output ?? (view.status === 'In progress' ? 'Waiting for output…' : 'No output was saved.')) + '</pre></details></section></td></tr>';
  }
  function filterHtml(key, label, values, state) {
    // Keep a selected filter visible if provider metadata changes during polling.
    if (state.filters[key] && !values.some(([value]) => value === state.filters[key])) values.push([state.filters[key], state.filters[key]]);
    return '<label>' + label + '<select id="detail-filter-' + key + '" data-detail-filter="' + key + '"><option value="">All ' + (key === 'suite' ? 'suites' : key === 'model' ? 'models' : key === 'method' ? 'methods' : 'scores') + '</option>'
      + values.map(([value, text]) => '<option value="' + escape(value) + '"' + (state.filters[key] === value ? ' selected' : '') + '>' + escape(text) + '</option>').join('') + '</select></label>';
  }
  function summaryHtml(run) {
    const summaries = summarizeModels(run);
    if (!summaries.length) return '';
    const counting = run.items.some(item => hasTestCount(item.evaluation));
    const countsHtml = group => Object.entries(group.counts || {}).map(([unit, count]) => '<span class="model-count-total">' + (count.measured ? count.total : '—') + ' ' + countLabel(unit) + '</span><span class="model-scored-count">' + count.measured + '/' + count.enabled + ' counted</span>').join('') || '—';
    return '<section class="model-summary" aria-labelledby="model-summary-title"><h4 id="model-summary-title">Model summary</h4>' + (counting ? '<p id="model-summary-help" class="field-hint">Test counts sum measured outputs across the whole run, separately for ideas and automated tests, including outputs that fail quality criteria. Pending and unavailable counts are excluded. Counts do not affect quality scores or criteria met.</p>' : '') + '<div id="model-summary-scroll" class="model-summary-scroll" tabindex="0" aria-label="Model summary table"><table aria-labelledby="model-summary-title"' + (counting ? ' aria-describedby="model-summary-help"' : '') + '><thead><tr><th scope="col">Model</th><th scope="col">Model-graded evals</th><th scope="col">Rule-based evals</th><th scope="col">Hybrid evals</th><th scope="col">Total evals</th><th scope="col">Total score</th>' + (counting ? '<th scope="col">Test count</th>' : '') + '</tr></thead><tbody>'
      + summaries.map(group => '<tr><th scope="row" title="' + escape(group.model ? modelLabel(group.model) : 'Supplied output') + '">' + escape(group.model ? modelLabel(group.model) : 'Supplied output') + '</th><td>' + group.model_based + '</td><td>' + group.rule_based + '</td><td>' + group.hybrid + '</td><td>' + group.total + '</td><td class="model-total-score">' + scoreMarkup(group.score) + ' <span class="model-scored-count">' + group.scoredCount + '/' + group.total + ' scored</span></td>' + (counting ? '<td class="model-test-count">' + countsHtml(group) + '</td>' : '') + '</tr>').join('') + '</tbody></table></div></section>';
  }
  function render(run) {
    current = run;
    if (!run) { root.replaceChildren(); return; }
    const state = stateFor(run.id), focused = root.contains(document.activeElement) ? document.activeElement.id : null;
    const scrollLeft = root.querySelector('.detail-table-scroll')?.scrollLeft || 0;
    const summaryScrollLeft = root.querySelector('.model-summary-scroll')?.scrollLeft || 0;
    const counting = run.items.some(item => hasTestCount(item.evaluation));
    const visibleColumns = Object.entries(columns).flatMap(entry => entry[0] === 'score' && counting ? [entry, ['count', 'Test count']] : [entry]);
    const rows = run.items.map(itemView), visible = rows.filter(row => Object.entries(state.filters).every(([key, value]) => !value || (key === 'score' ? scoreBand(row.score) === value : row[key] === value)));
    if (state.sort) visible.sort((a, b) => {
      const av = a[state.sort], bv = b[state.sort];
      const aMissing = av === null || av === '—', bMissing = bv === null || bv === '—';
      if (aMissing || bMissing) return aMissing === bMissing ? a.index - b.index : aMissing ? 1 : -1;
      const comparison = state.sort === 'reference' ? Number(av.slice(5)) - Number(bv.slice(5)) : typeof av === 'number' ? av - bv : av.localeCompare(bv, undefined, { sensitivity: 'base' });
      return comparison * state.direction || a.index - b.index;
    });
    const status = { queued: 'In progress', running: 'In progress', completed: 'Complete', interrupted: 'Interrupted' }[run.status] || run.status;
    root.innerHTML = '<div class="run-top"><div class="run-heading"><h3>' + escape(runName(run)) + '</h3><span class="badge ' + escape(run.status) + '">' + escape(status) + '</span><span class="run-context">Env: ' + escape({ prod: 'Prod', dev: 'Dev', local: 'Local' }[run.settings?.environment] || '—') + ' · Grader: ' + escape(modelLabel(run.settings?.graderModel)) + '</span></div><button id="detail-delete-run" class="button small danger" data-delete-run="' + escape(run.id) + '"' + (canDelete(run) ? '' : ' disabled title="Wait for this run to finish before deleting it."') + '>Delete run</button></div>'
      + summaryHtml(run)
      + '<div class="detail-filters">' + ['suite', 'model', 'method'].map(key => filterHtml(key, columns[key], [...new Set(rows.map(row => row[key]))].sort((a, b) => a.localeCompare(b)).map(value => [value, value]), state)).join('')
      + filterHtml('score', 'Score', [['low', 'Below 0.50'], ['medium', '0.50 to below 0.80'], ['high', '0.80 and above']], state) + '</div>'
      + '<p class="detail-count" role="status">' + visible.length + ' of ' + rows.length + ' evaluations</p><div id="detail-table-scroll" class="detail-table-scroll" tabindex="0" aria-label="Evaluation results table"><table class="detail-table"><colgroup><col class="detail-id-column"><col><col class="detail-suite-column"><col class="detail-metadata-column"><col class="detail-metadata-column"><col class="detail-metadata-column"><col class="detail-score-column">' + (counting ? '<col class="detail-count-column">' : '') + '<col class="detail-criteria-column"></colgroup><thead><tr>'
      + visibleColumns.map(([key, label]) => '<th scope="col" aria-sort="' + (state.sort === key ? state.direction === 1 ? 'ascending' : 'descending' : 'none') + '"><button id="detail-sort-' + key + '" data-detail-sort="' + key + '">' + label + '<span aria-hidden="true"> ' + (state.sort === key ? state.direction === 1 ? '↑' : '↓' : '↕') + '</span></button></th>').join('') + '</tr></thead><tbody>'
      + visible.map(view => '<tr class="detail-eval-row" data-detail-item="' + escape(view.item.id) + '"><td class="evaluation-id">' + escape(view.reference) + '</td><td><button class="detail-expand" id="expand-' + escape(view.item.id) + '" data-detail-expand="' + escape(view.item.id) + '" aria-expanded="' + state.expanded.has(view.item.id) + '" aria-controls="criteria-' + escape(view.item.id) + '" title="' + escape(view.name) + '"><span class="detail-chevron" aria-hidden="true">' + (state.expanded.has(view.item.id) ? '▾' : '▸') + '</span><span class="detail-name">' + escape(view.name) + '</span></button></td><td>' + escape(view.suite) + '</td><td>' + escape(view.model) + '</td><td>' + escape(view.method) + '</td><td><span class="badge ' + ({ Graded: 'passed', Counted: 'counted', Error: 'error', Interrupted: 'interrupted', 'In progress': 'running' }[view.status]) + '">' + view.status + '</span></td><td class="result-score">' + scoreMarkup(view.score) + '</td>' + (counting ? '<td class="result-test-count">' + escape(view.countText) + '</td>' : '') + '<td class="criteria-met">' + view.metText + '</td></tr>' + expandedHtml(view, state)).join('')
      + '</tbody></table></div>' + (!visible.length ? '<p class="detail-empty">' + (rows.length ? 'No evaluations match these filters.' : 'No evaluations in this run.') + '</p>' : '');
    root.querySelectorAll('.detail-eval-row > td').forEach(cell => { cell.title = cell.textContent.trim(); });
    root.querySelector('.detail-table-scroll').scrollLeft = scrollLeft;
    if (root.querySelector('.model-summary-scroll')) root.querySelector('.model-summary-scroll').scrollLeft = summaryScrollLeft;
    if (focused) document.getElementById(focused)?.focus({ preventScroll: true });
  }
  root.addEventListener('click', event => {
    if (!current) return;
    const state = stateFor(current.id), sort = event.target.closest('[data-detail-sort]');
    if (sort) { state.direction = state.sort === sort.dataset.detailSort ? -state.direction : 1; state.sort = sort.dataset.detailSort; render(current); return; }
    const button = event.target.closest('[data-detail-expand]'), row = event.target.closest('[data-detail-item]');
    if (!button && (!row || event.target.closest('a, button, input, select, summary') || window.getSelection()?.toString())) return;
    const id = button?.dataset.detailExpand || row.dataset.detailItem;
    state.expanded.has(id) ? state.expanded.delete(id) : state.expanded.add(id);
    render(current);
  });
  root.addEventListener('change', event => {
    if (!current || !event.target.dataset.detailFilter) return;
    stateFor(current.id).filters[event.target.dataset.detailFilter] = event.target.value; render(current);
  });
  root.addEventListener('toggle', event => {
    if (!current || !event.target.isConnected || !event.target.matches('details[data-output]')) return;
    const state = stateFor(current.id), id = event.target.dataset.output;
    event.target.open ? state.outputs.add(id) : state.outputs.delete(id);
  }, true);
  return { render, reset() { states.clear(); current = null; }, forget(id) { states.delete(id); } };
}
