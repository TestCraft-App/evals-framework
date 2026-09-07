const $ = id => document.getElementById(id);
const names = { ideas: 'Generate ideas', code: 'Generate code', model_grade: 'Model grade', exact_match: 'Exact match', contains: 'Contains', pasted: 'Pasted output', testcraft_api: 'TestCraft v1', llm: 'LLM adapter', playwright: 'Playwright', cypress: 'Cypress', selenium: 'Selenium', typescript: 'TypeScript', javascript: 'JavaScript', python: 'Python', java: 'Java', csharp: 'C#', not_run: 'Not run', passed: 'Passed', failed: 'Failed', error: 'Error', queued: 'Queued', generating: 'Generating', grading: 'Grading', running: 'Running', completed: 'Completed', interrupted: 'Interrupted' };
const languages = { playwright: ['typescript','javascript','python','java','csharp'], cypress: ['typescript','javascript'], selenium: ['javascript','python','java','csharp'] };
const activeStatuses = ['queued','running','generating','grading'];
let config, evaluations = [], runs = [], selected = new Set(), currentRun, currentItemId, polling, lastRunJson, pollFailures = 0, toastTimer;
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const badge = status => '<span class="badge ' + escape(status) + '">' + escape(names[status] || status) + '</span>';
const date = value => new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
function error(message) { $('app-error').textContent = message; $('app-error').hidden = !message; }
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3000); }
async function api(path, options) {
  const res = await fetch(path, options && { ...options, headers: { 'content-type': 'application/json' } });
  let body;
  try { body = await res.json(); } catch { throw new Error('The server returned an unexpected response. Restart the updated backend.'); }
  if (!res.ok) throw new Error(body.error || 'Request failed.');
  return body;
}
async function loadLibrary() {
  const data = await api('/api/evaluations'); evaluations = data.evaluations;
  selected = new Set([...selected].filter(id => evaluations.some(e => e.id === id)));
  renderLibrary();
}
async function loadRuns() { runs = (await api('/api/runs')).runs; $('runs-count').textContent = runs.length; renderRunList(); }
function visibleEvaluations() {
  const query = $('search').value.trim().toLowerCase();
  return evaluations.filter(e => {
    const status = e.latest?.status || 'not_run';
    return (!query || (e.name + ' ' + e.input).toLowerCase().includes(query))
      && (!$('filter-type').value || e.type === $('filter-type').value)
      && (!$('filter-method').value || e.method === $('filter-method').value)
      && (!$('filter-status').value || ($('filter-status').value === 'active' ? activeStatuses.includes(status) : status === $('filter-status').value));
  }).sort((a,b) => $('sort').value === 'name' ? a.name.localeCompare(b.name) : $('sort').value === 'score' ? (b.latest?.score ?? -1) - (a.latest?.score ?? -1) : b.createdAt.localeCompare(a.createdAt));
}
function renderLibrary() {
  $('eval-count').textContent = evaluations.length; $('stat-total').textContent = evaluations.length;
  $('stat-passed').textContent = evaluations.filter(e => e.latest?.status === 'passed').length;
  $('stat-failed').textContent = evaluations.filter(e => ['failed','error'].includes(e.latest?.status)).length;
  const scored = evaluations.filter(e => Number.isFinite(e.latest?.score));
  $('stat-score').textContent = scored.length ? Math.round(scored.reduce((sum,e) => sum + e.latest.score, 0) / scored.length) + '%' : '—';
  const visible = visibleEvaluations();
  $('evaluation-rows').innerHTML = visible.map(e => '<tr><td class="checkbox-cell"><input type="checkbox" aria-label="Select ' + escape(e.name) + '" data-select="' + e.id + '"' + (selected.has(e.id) ? ' checked' : '') + '></td>'
    + '<td><button class="eval-name" data-inspect="' + e.id + '" title="Inspect or duplicate">' + escape(e.name) + '</button><div class="eval-id">EV-' + e.id.slice(0,8).toUpperCase() + '</div></td>'
    + '<td>' + badge(e.type) + '</td><td>' + escape(names[e.framework]) + '<span class="row-meta">' + escape(names[e.language]) + '</span></td>'
    + '<td>' + escape(names[e.method]) + '</td><td>' + escape(names[e.source]) + '</td><td>' + badge(e.latest?.status || 'not_run') + '</td>'
    + '<td class="score">' + (Number.isFinite(e.latest?.score) ? e.latest.score + '%' : '—') + '</td><td>' + escape(date(e.createdAt)) + '</td>'
    + '<td>' + (e.latest ? '<button class="text-button" data-run-link="' + e.latest.runId + '">View run ↗</button>' : '<button class="text-button" data-run-one="' + e.id + '">Run →</button>') + '</td></tr>').join('');
  $('empty-library').hidden = visible.length > 0;
  $('empty-library').querySelector('h3').textContent = evaluations.length ? 'No evaluations match these filters.' : 'Your first evaluation starts here.';
  $('filtered-count').textContent = visible.length + ' of ' + evaluations.length + ' evaluations';
  updateSelection();
}
function updateSelection() {
  const visible = visibleEvaluations();
  $('select-all').checked = visible.length > 0 && visible.every(e => selected.has(e.id));
  $('select-all').indeterminate = visible.some(e => selected.has(e.id)) && !$('select-all').checked;
  $('select-all').disabled = !visible.length;
  $('selection-count').textContent = selected.size + ' selected';
  $('clear-selection').disabled = !selected.size;
  $('run-selected').disabled = !selected.size;
}
function setLanguages(preferred = $('language').value) {
  $('language').innerHTML = languages[$('framework').value].map(value => '<option value="' + value + '">' + names[value] + '</option>').join('');
  if (languages[$('framework').value].includes(preferred)) $('language').value = preferred;
}
function syncForm() {
  const source = $('source').value, method = $('method').value, code = $('type').value === 'code';
  if (source === 'llm' && !$('model').value) $('model').value = config?.model || 'gpt-4o-mini';
  $('actual-field').hidden = source !== 'pasted'; $('actual-output').required = source === 'pasted';
  $('model-field').hidden = source === 'pasted'; $('model').required = source === 'llm';
  $('judge-field').hidden = method !== 'model_grade'; $('judge-model').required = method === 'model_grade';
  $('criteria-field').hidden = method !== 'model_grade'; $('criteria').required = method === 'model_grade';
  $('code-options').hidden = !code; $('page-url').required = source === 'testcraft_api' && code;
  $('source-hint').textContent = source === 'pasted' ? 'Grade an actual output copied from the extension. No generation call.'
    : source === 'llm' ? 'Calls a separate backend prompt adapter. This is not the TestCraft v1 generation pipeline.'
    : code ? 'Calls the same automation endpoint as the v1 extension. Enable selected ideas to send your input as test cases.'
    : 'Calls /api/generate-ideas with the HTML. v1 does not accept extra instructions; Input is used by the evaluator.';
  $('method-hint').textContent = method === 'model_grade' ? (config?.llmReady ? 'An LLM scores each criterion with evidence.' : 'Needs OPENAI_API_KEY in the backend. You can save this case before configuring the judge.')
    : method === 'contains' ? 'Checks each expected-output line as a case-sensitive substring. Score = matched lines / total.'
    : 'Compares text after trimming and normalizing line endings. Case and internal whitespace matter.';
  $('expected-hint').textContent = method === 'contains' ? 'One required fragment per line. Each fragment has equal weight.' : 'The reference is sent only to the evaluator, never to the generator.';
}
function openForm(example = false, existing) {
  $('evaluation-form').reset(); $('form-error').textContent = '';
  $('dialog-title').textContent = existing ? 'Inspect / duplicate evaluation' : 'New evaluation';
  $('save-evaluation').textContent = existing ? 'Save as new evaluation' : 'Create evaluation';
  $('model').value = ''; $('judge-model').value = config?.judgeModel || 'gpt-4o-mini';
  $('criteria').value = 'The output covers the requested behavior.\nAssertions or expected outcomes are specific and meaningful.\nThe output uses only elements supported by the HTML context.';
  setLanguages('typescript');
  const sample = {
    name: 'Login form · negative test coverage', type: 'ideas', source: 'pasted', framework: 'playwright', language: 'typescript', method: 'contains', threshold: 100,
    input: 'Generate positive and negative test ideas for the login form.', pageUrl: 'https://example.com/login',
    html: '<form aria-label="Sign in">\n  <label for="email">Email</label>\n  <input id="email" type="email" required>\n  <label for="password">Password</label>\n  <input id="password" type="password" required>\n  <button type="submit">Sign in</button>\n</form>',
    expectedOutput: 'valid credentials\ninvalid email\nempty password',
    actualOutput: 'Positive Tests:\n- Sign in with valid credentials and verify the account page is shown.\n\nNegative Tests:\n- Submit an invalid email and verify email validation is displayed.\n- Submit an empty password and verify the required-field message.',
  };
  const data = existing || (example ? sample : null);
  if (data) {
    for (const key of ['name','type','source','framework','method','threshold','input','html','model','criteria']) if (data[key] !== undefined) $(key).value = data[key];
    setLanguages(data.language);
    for (const [key,id] of [['pageUrl','page-url'],['expectedOutput','expected-output'],['actualOutput','actual-output'],['judgeModel','judge-model']]) if (data[key] !== undefined) $(id).value = data[key];
    $('pom').checked = !!data.pom; $('from-ideas').checked = !!data.fromIdeas;
  }
  syncForm(); $('evaluation-dialog').showModal(); $('name').focus();
}
async function saveEvaluation(event) {
  event.preventDefault(); $('save-evaluation').disabled = true; $('form-error').textContent = '';
  const payload = Object.fromEntries(new FormData($('evaluation-form')));
  payload.threshold = Number(payload.threshold); payload.pom = $('pom').checked; payload.fromIdeas = $('from-ideas').checked;
  try {
    await api('/api/evaluations', { method: 'POST', body: JSON.stringify(payload) });
    $('evaluation-dialog').close(); await loadLibrary(); toast('Evaluation saved. Select it to run.');
  } catch (e) { $('form-error').textContent = e.message; }
  finally { $('save-evaluation').disabled = false; }
}
async function startRun(ids) {
  error(''); $('run-selected').disabled = true;
  try {
    const run = await api('/api/runs', { method: 'POST', body: JSON.stringify({ evaluationIds: ids }) });
    selected.clear(); currentItemId = null; await loadRuns(); location.hash = 'runs/' + run.id;
    toast('Run created. Generation and grading continue in the backend.');
  } catch (e) { error(e.message); }
  finally { updateSelection(); }
}
function renderRunList() {
  $('run-list').innerHTML = runs.length ? runs.map((run,index) => '<button class="' + (currentRun?.id === run.id ? 'active' : '') + '" data-run-link="' + run.id + '"><strong>Run ' + String(runs.length - index).padStart(2,'0') + ' · ' + run.total + ' evaluation' + (run.total === 1 ? '' : 's') + '</strong>' + badge(run.status) + '<small>' + escape(date(run.createdAt)) + ' · ' + run.passed + ' passed</small></button>').join('') : '<div class="empty-state"><p>Your runs will appear here.</p></div>';
}
function renderRunDetail() {
  const run = currentRun;
  if (!run) return;
  if (!run.items.some(item => item.id === currentItemId)) currentItemId = run.items[0]?.id;
  const item = run.items.find(item => item.id === currentItemId), e = item?.evaluation;
  if (!item) return;
  const active = activeStatuses.includes(item.status);
  $('run-detail').innerHTML = '<div class="run-top"><div><h3>Run ' + run.id.slice(0,8) + ' ' + badge(run.status) + '</h3><p>' + escape(date(run.createdAt)) + ' · ' + run.items.length + ' saved evaluation snapshots</p></div><a href="#runs/' + run.id + '" target="_blank" rel="noopener">Open in new tab ↗</a></div>'
    + '<div class="run-items">' + run.items.map(x => '<button class="run-item ' + (x.id === item.id ? 'active' : '') + '" data-item="' + x.id + '">' + escape(x.evaluation.name) + ' · ' + escape(names[x.status] || x.status) + '</button>').join('') + '</div>'
    + '<div class="result-body"><div class="result-title"><div><h3>' + escape(e.name) + '</h3><p>' + escape(names[e.type]) + ' · ' + escape(names[e.method]) + ' · Threshold ' + e.threshold + '%</p></div><div class="result-score">' + (Number.isFinite(item.score) ? item.score + '<small> / 100</small>' : '—') + '</div></div>'
    + (active ? '<p class="muted"><span class="spinner" aria-hidden="true"></span>' + escape(names[item.status]) + '… Results update automatically.</p>' : '<p>' + badge(item.status) + ' <span class="muted">' + (item.durationMs ?? 0) + ' ms</span></p>')
    + (item.error ? '<div class="error-banner" role="alert">' + escape(item.error) + '</div>' : '')
    + '<div class="comparison"><section class="output-card"><h4>EXPECTED OUTPUT</h4><pre>' + escape(e.expectedOutput) + '</pre></section><section class="output-card"><h4>ACTUAL OUTPUT</h4><pre>' + escape(item.output ?? 'Waiting for output…') + '</pre></section></div>'
    + '<p class="muted">Source: ' + escape(item.outputSource || names[e.source]) + (item.generationModel ? ' · Generation model: ' + escape(item.generationModel) : '') + (item.judgeModel ? ' · Judge: ' + escape(item.judgeModel) : '') + '</p>'
    + '<div class="checks"><h4>Criteria and evidence</h4>' + (item.checks.length ? item.checks.map(check => '<article class="check"><div class="check-title"><b>' + escape(check.criterion) + '</b><span>' + check.score + '/100</span></div><p>' + escape(check.reason) + '</p><blockquote>' + escape(check.evidence) + '</blockquote></article>').join('') : '<p class="muted">' + (item.error ? 'Grading did not complete. No score has been fabricated.' : 'Checks will appear when grading finishes.') + '</p>') + '</div>'
    + '<div class="event-log"><h4>Run activity</h4>' + item.events.map(event => '<p><time>' + escape(new Date(event.at).toLocaleTimeString()) + '</time>' + escape(event.message) + '</p>').join('') + '</div>'
    + '<details><summary>Inspect saved input, HTML, and criteria</summary><pre class="context-pre">' + escape(JSON.stringify({ input: e.input, html: e.html, framework: e.framework, language: e.language, pageUrl: e.pageUrl, criteria: e.criteria, pom: e.pom, fromIdeas: e.fromIdeas }, null, 2)) + '</pre></details></div>';
}
async function pollRun(id) {
  if (location.hash !== '#runs/' + id) return;
  try {
    const run = await api('/api/runs/' + id);
    if (location.hash !== '#runs/' + id) return;
    pollFailures = 0; currentRun = run;
    const serialized = JSON.stringify(run);
    if (serialized !== lastRunJson) { lastRunJson = serialized; renderRunDetail(); await loadRuns(); }
    if (activeStatuses.includes(run.status)) polling = setTimeout(() => pollRun(id), 900);
    else { await loadLibrary(); }
  } catch (e) {
    error(e.message);
    if (++pollFailures < 3 && location.hash === '#runs/' + id) polling = setTimeout(() => pollRun(id), 1500);
  }
}
async function route() {
  clearTimeout(polling); lastRunJson = null; pollFailures = 0;
  const isRuns = location.hash.startsWith('#runs');
  $('evaluations-panel').hidden = isRuns; $('runs-panel').hidden = !isRuns;
  $('evaluations-tab').setAttribute('aria-selected', String(!isRuns)); $('runs-tab').setAttribute('aria-selected', String(isRuns));
  $('evaluations-tab').tabIndex = isRuns ? -1 : 0; $('runs-tab').tabIndex = isRuns ? 0 : -1;
  if (isRuns) {
    await loadRuns();
    const id = location.hash.split('/')[1];
    if (id) { currentItemId = null; await pollRun(id); }
    else if (runs.length) location.hash = 'runs/' + runs[0].id;
  } else await loadLibrary();
}
$('evaluation-form').addEventListener('submit', saveEvaluation);
['new-button','empty-create'].forEach(id => $(id).addEventListener('click', () => openForm()));
$('example-button').addEventListener('click', () => openForm(true));
['close-dialog','cancel-dialog'].forEach(id => $(id).addEventListener('click', () => $('evaluation-dialog').close()));
['type','source','method'].forEach(id => $(id).addEventListener('change', syncForm));
$('framework').addEventListener('change', () => setLanguages());
['search','filter-type','filter-method','filter-status','sort'].forEach(id => $(id).addEventListener(id === 'search' ? 'input' : 'change', renderLibrary));
$('select-all').addEventListener('change', () => { visibleEvaluations().forEach(e => $('select-all').checked ? selected.add(e.id) : selected.delete(e.id)); renderLibrary(); });
$('clear-selection').addEventListener('click', () => { selected.clear(); renderLibrary(); });
$('run-selected').addEventListener('click', () => startRun([...selected]));
$('evaluation-rows').addEventListener('change', event => { const id = event.target.dataset.select; if (id) { event.target.checked ? selected.add(id) : selected.delete(id); updateSelection(); } });
document.addEventListener('click', event => {
  const el = event.target.closest('button');
  if (!el) return;
  if (el.dataset.inspect) openForm(false, evaluations.find(e => e.id === el.dataset.inspect));
  if (el.dataset.runLink) location.hash = 'runs/' + el.dataset.runLink;
  if (el.dataset.runOne) startRun([el.dataset.runOne]);
  if (el.dataset.item) { currentItemId = el.dataset.item; renderRunDetail(); }
});
$('evaluations-tab').addEventListener('click', () => { location.hash = 'evaluations'; });
$('runs-tab').addEventListener('click', () => { location.hash = currentRun ? 'runs/' + currentRun.id : 'runs'; });
document.querySelector('.tabs').addEventListener('keydown', event => {
  if (['ArrowRight','ArrowLeft','Home','End'].includes(event.key)) {
    event.preventDefault(); const target = event.key === 'Home' ? $('evaluations-tab') : event.key === 'End' ? $('runs-tab') : event.target === $('runs-tab') ? $('evaluations-tab') : $('runs-tab'); target.click(); target.focus();
  }
});
$('refresh-runs').addEventListener('click', () => { error(''); route().catch(e => error(e.message)); });
window.addEventListener('hashchange', () => route().catch(e => error(e.message)));
async function init() {
  config = await api('/api/config');
  if (config.version !== 2) throw new Error('An older server is running. Restart npm start to load TestCraft Evals.');
  $('connection').textContent = '● Backend connected';
  if (!config.llmReady) { $('setup-notice').hidden = false; $('setup-notice').textContent = 'Model grade needs OPENAI_API_KEY in the backend. You can already save evaluations and grade pasted TestCraft outputs with Exact match or Contains. Load example to try it.'; }
  await Promise.all([loadLibrary(), loadRuns()]); await route();
}
init().catch(e => { error(e.message); $('connection').textContent = 'Backend unavailable'; });
