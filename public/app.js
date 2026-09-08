const $ = id => document.getElementById(id);
const names = { ideas: 'Generate ideas', code: 'Generate code', model_grade: 'LLM as a judge', exact_match: 'Exact match', contains: 'Contains', not_contains: 'Does not contain', pasted: 'Pasted output', testcraft_api: 'TestCraft v1', llm: 'LLM adapter', playwright: 'Playwright', cypress: 'Cypress', selenium: 'Selenium', typescript: 'TypeScript', javascript: 'JavaScript', python: 'Python', java: 'Java', csharp: 'C#', not_run: 'Not run', passed: 'Passed', failed: 'Failed', error: 'Error', queued: 'Queued', generating: 'Generating', grading: 'Grading', running: 'Running', completed: 'Completed', interrupted: 'Interrupted' };
const languages = { playwright: ['typescript','javascript','python','java','csharp'], cypress: ['typescript','javascript'], selenium: ['javascript','python','java','csharp'] };
const activeStatuses = ['queued','running','generating','grading'];
let config, evaluations = [], runs = [], selected = new Set(), currentRun, currentItemId, polling, lastRunJson, pollFailures = 0, toastTimer;
let formStep = 1, duplicate = false, criteria = [], modelCatalog, modelsLoading = false, desiredJudge = '';
let session = null, sessionTimer, sessionSetup;
let currentMethod = null, methodDrafts = new Map(), familyChoices = {};
let deleteTarget = null, deletingRun = false, runViewRevision = 0, runsRequest = 0, libraryRequest = 0;
const canDeleteRun = run => ['completed', 'interrupted'].includes(run.status) && run.items.every(item => ['passed', 'failed', 'error'].includes(item.status));
const familyLabel = method => config?.evaluationMethods?.[method]?.familyLabel || (method === 'model_grade' ? 'Model-based' : 'Rule-based');
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const badge = status => '<span class="badge ' + escape(status) + '">' + escape(names[status] || status) + '</span>';
const date = value => new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
function error(message) { $('app-error').textContent = message; $('app-error').hidden = !message; }
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3000); }
async function api(path, options) {
  const requestSession = session;
  const mutation = options?.method && !['GET', 'HEAD'].includes(options.method);
  const res = await fetch(path, { ...options, credentials: 'same-origin', headers: { ...(options ? { 'content-type': 'application/json' } : {}), ...(session && mutation ? { 'x-csrf-token': session.csrfToken } : {}) } });
  let body;
  try { body = await res.json(); } catch { throw new Error('The server returned an unexpected response. Restart the updated backend.'); }
  if (requestSession !== session) throw new Error('The workspace changed. Please try again.');
  if (res.status === 401 && path !== '/api/session') void connectWorkspace();
  if (!res.ok) throw Object.assign(new Error(body.error || 'Request failed.'), { status: res.status });
  return body;
}
function showConnecting() {
  session = null; config = null; clearTimeout(polling); clearTimeout(sessionTimer); clearTimeout(toastTimer);
  evaluations = []; runs = []; selected.clear(); currentRun = null; currentItemId = null; criteria = []; modelCatalog = null; modelsLoading = false;
  methodDrafts.clear(); currentMethod = null; familyChoices = {};
  runViewRevision++; runsRequest++; libraryRequest++; deleteTarget = null; deletingRun = false; $('delete-run-dialog').close();
  $('evaluation-dialog').close(); $('evaluation-form').reset(); $('criteria-list').replaceChildren();
  $('evaluation-rows').replaceChildren(); $('run-list').replaceChildren(); $('run-detail').replaceChildren(); $('toast').hidden = true;
  $('workspace').hidden = true; $('private-badge').hidden = true; $('session-status').hidden = false;
  $('session-message').textContent = 'Opening your private workspace…';
  $('session-error').textContent = ''; $('retry-session').hidden = true;
}
function renderSession() {
  const b = session.budget;
  $('model-allowance').textContent = `${b.remaining} / ${b.limit} model calls available · shared workshop allowance${b.reserved ? ` · ${b.reserved} reserved` : ''}`;
  $('workspace-id').textContent = session.workspaceId;
  $('session-expiry').textContent = new Date(session.expiresAt).toLocaleString();
}
function scheduleSessionCheck() {
  clearTimeout(sessionTimer);
  if (session) sessionTimer = setTimeout(() => refreshSession().catch(e => { error(e.message); scheduleSessionCheck(); }), 30000);
}
async function refreshSession() {
  clearTimeout(sessionTimer);
  if (!session) return;
  const current = await api('/api/session');
  if (!current.authenticated || current.workspaceId !== session?.workspaceId) return connectWorkspace();
  // Preserve object identity so parallel responses from this workspace remain valid.
  Object.assign(session, current); renderSession();
  scheduleSessionCheck();
}
async function loadLibrary() {
  const request = ++libraryRequest, data = await api('/api/evaluations');
  if (request !== libraryRequest) return;
  evaluations = data.evaluations;
  selected = new Set([...selected].filter(id => evaluations.some(e => e.id === id)));
  renderLibrary();
}
async function loadRuns() {
  const request = ++runsRequest, data = await api('/api/runs');
  if (request !== runsRequest) return;
  runs = data.runs; $('runs-count').textContent = runs.length; renderRunList();
}
function visibleEvaluations() {
  const query = $('search').value.trim().toLowerCase();
  return evaluations.filter(e => {
    const status = e.latest?.status || 'not_run';
    return (!query || (e.name + ' ' + (e.input || '')).toLowerCase().includes(query))
      && (!$('filter-type').value || e.type === $('filter-type').value)
      && (!$('filter-method').value || e.method === $('filter-method').value || config.evaluationMethods[e.method]?.family === $('filter-method').value)
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
    + '<td>' + badge(e.type) + '</td><td>' + (e.type === 'ideas' ? '<span class="muted">Not applicable</span>' : escape(names[e.framework]) + '<span class="row-meta">' + escape(names[e.language]) + '</span>') + '</td>'
    + '<td>' + escape(names[e.method]) + '<span class="row-meta">' + escape(familyLabel(e.method)) + '</span></td><td>' + escape(names[e.source]) + '</td><td>' + badge(e.latest?.status || 'not_run') + '</td>'
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
function selectMethod(method, preserveDraft = true) {
  const definition = config.evaluationMethods[method];
  if (!definition) return;
  if (preserveDraft && currentMethod) methodDrafts.set(currentMethod, { criteria: [...criteria], draft: $('criterion-draft').value });
  $('method-family').value = definition.family;
  $('method').innerHTML = Object.entries(config.evaluationMethods).filter(([, value]) => value.family === definition.family).map(([id, value]) => '<option value="' + escape(id) + '">' + escape(value.label) + '</option>').join('');
  $('method').value = method;
  familyChoices[definition.family] = method; currentMethod = method;
  if (preserveDraft) {
    const savedDraft = methodDrafts.get(method);
    criteria = [...(savedDraft?.criteria || [])]; $('criterion-draft').value = savedDraft?.draft || '';
  }
  renderCriteria(); syncForm();
}
function syncForm() {
  const source = $('source').value, method = $('method').value, code = $('type').value === 'code';
  const definition = config?.evaluationMethods?.[method];
  if (source === 'llm' && !$('model').value) $('model').value = config?.model || 'gpt-4o-mini';
  $('actual-field').hidden = source !== 'pasted'; $('actual-output').disabled = source !== 'pasted'; $('actual-output').required = source === 'pasted';
  $('model').disabled = source === 'pasted'; $('model').required = source === 'llm';
  $('judge-model').disabled = method !== 'model_grade' || modelsLoading; $('judge-model').required = method === 'model_grade';
  $('models-feedback').hidden = method !== 'model_grade';
  $('framework').disabled = !code; $('language').disabled = !code;
  $('pom').disabled = !code || source !== 'testcraft_api'; $('from-ideas').disabled = !code || source !== 'testcraft_api';
  $('page-url').required = source === 'testcraft_api' && code;
  const fromIdeas = !$('from-ideas').disabled && $('from-ideas').checked;
  $('ideas-field').hidden = !fromIdeas; $('ideas').required = fromIdeas; $('ideas').disabled = !fromIdeas;
  $('code-params-hint').hidden = code;
  $('source-hint').textContent = source === 'pasted' ? 'Grade an actual output copied from the extension. No generation call.'
    : source === 'llm' ? 'Calls a separate backend prompt adapter. This is not the TestCraft v1 generation pipeline.'
    : code ? `Calls ${fromIdeas ? '/api/automate-tests-ideas' : '/api/automate-tests'} with the HTML and code parameters. Description is evaluator context.`
    : 'Calls /api/generate-ideas with the HTML. Description is evaluator context, not an extra instruction to TestCraft.';
  $('method-hint').textContent = definition?.description || '';
  $('method-limitation').textContent = definition?.limitation || '';
  $('grading-cost').textContent = method === 'model_grade' ? 'Grading: 1 model call · Non-deterministic' + (!config?.llmReady ? ' · Requires OPENAI_API_KEY in the backend' : '') : 'Grading: 0 model calls · Deterministic for the same output and criteria';
  $('criteria-hint').textContent = definition?.criteriaHint || '';
  $('criterion-draft').placeholder = definition?.placeholder || '';
  $('criteria-empty').textContent = method === 'model_grade' ? 'What makes a good response? Add your first quality criterion.' : method === 'not_contains' ? 'Add the first text fragment that must not appear.' : method === 'exact_match' ? 'Add the complete text that the output must match.' : 'Add the first text fragment that must appear.';
  updateCriteriaState();
  resizeTextareas();
}
function resizeTextareas() {
  document.querySelectorAll('#evaluation-dialog textarea').forEach(el => {
    if (!el.getClientRects().length) return;
    el.style.height = 'auto'; el.style.height = (el.scrollHeight + 2) + 'px';
  });
}
function setStep(step, focus = true) {
  formStep = step;
  for (const n of [1, 2]) {
    $('step-' + n).hidden = n !== step;
    if (n === step) $('step-indicator-' + n).setAttribute('aria-current', 'step');
    else $('step-indicator-' + n).removeAttribute('aria-current');
  }
  $('back-step').hidden = step === 1;
  $('save-evaluation').textContent = step === 1 ? 'Next →' : duplicate ? 'Save as new evaluation' : 'Create evaluation';
  $('form-error').textContent = ''; $('wizard-body').scrollTop = 0;
  resizeTextareas();
  if (focus) $(step === 1 ? 'name' : 'method-family').focus();
}
function updateCriteriaState() {
  $('criteria-count').textContent = criteria.length + (criteria.length === 1 ? ' criterion' : ' criteria');
  $('criteria-empty').hidden = criteria.length > 0;
  const full = criteria.length >= ($('method').value === 'exact_match' ? 1 : 20);
  $('add-criterion').disabled = full;
}
function renderCriteria() {
  $('criteria-list').innerHTML = criteria.map((value, index) => '<li><span class="criterion-number" aria-hidden="true">' + (index + 1) + '</span><label class="sr-only" for="criterion-' + index + '">Criterion ' + (index + 1) + '</label><textarea id="criterion-' + index + '" data-criterion="' + index + '" rows="1" maxlength="8000" required>' + escape(value) + '</textarea><button type="button" class="icon-button" data-remove-criterion="' + index + '" aria-label="Remove criterion ' + (index + 1) + '">×</button></li>').join('');
  updateCriteriaState(); resizeTextareas();
}
function addCriterion() {
  const value = $('criterion-draft').value.trim();
  if (!value) { $('form-error').textContent = 'Write a criterion before adding it.'; $('criterion-draft').focus(); return false; }
  if (criteria.length >= ($('method').value === 'exact_match' ? 1 : 20)) { $('form-error').textContent = $('method').value === 'exact_match' ? 'Exact match uses exactly one criterion.' : 'Use at most 20 criteria.'; return false; }
  if (criteria.join('').length + value.length > 8000) { $('form-error').textContent = 'Keep all criteria within 8000 characters.'; return false; }
  criteria.push(value); $('criterion-draft').value = ''; $('form-error').textContent = ''; renderCriteria();
  if (!$('criterion-draft').disabled) $('criterion-draft').focus();
  else $('criterion-' + (criteria.length - 1)).focus();
  return true;
}
function renderModelOptions() {
  if (!config) return;
  const models = modelCatalog?.models || [{ id: config.judgeModel, label: config.judgeModel + ' · backend configured', graderCompatible: config.judgeModelCompatible }];
  $('judge-model').innerHTML = '<option value="">Select a model</option>' + models.map(model => '<option value="' + escape(model.id) + '"' + (model.graderCompatible ? '' : ' disabled') + '>' + escape(model.label) + (model.graderCompatible ? '' : ' · unavailable for grading') + '</option>').join('');
  if (models.some(model => model.id === desiredJudge && model.graderCompatible)) $('judge-model').value = desiredJudge;
  else if (!desiredJudge && models.some(model => model.id === config.judgeModel && model.graderCompatible)) $('judge-model').value = config.judgeModel;
  else $('judge-model').value = '';
}
async function loadModels() {
  if (modelsLoading || !session || !config) return;
  const requestSession = session;
  modelsLoading = true; $('models-status').textContent = 'Loading TestCraft models…'; $('retry-models').hidden = true; syncForm();
  try {
    modelCatalog = await api('/api/models'); renderModelOptions();
    $('models-status').textContent = modelCatalog.warning || 'TestCraft catalog. Models without verified structured grading support are disabled. Access depends on your backend account.';
    $('retry-models').hidden = !modelCatalog.warning;
  } catch {
    if (requestSession !== session) return;
    $('models-status').textContent = modelCatalog ? 'Could not refresh TestCraft models. Showing the last list; account access is not verified.' : 'Could not load TestCraft models. Only the backend-configured model is listed; its account access is not verified.';
    $('retry-models').hidden = false; renderModelOptions();
  } finally { if (requestSession === session) { modelsLoading = false; syncForm(); } }
}
function validateStep(step) {
  const invalid = [...$('step-' + step).querySelectorAll('input,select,textarea')].find(el => !el.disabled && !el.checkValidity());
  if (!invalid) return true;
  setStep(step, false); invalid.focus(); invalid.reportValidity(); return false;
}
function openForm(example = false, existing) {
  if (!session || !config) return;
  $('evaluation-form').reset(); $('form-error').textContent = '';
  currentMethod = null; methodDrafts.clear(); familyChoices = {};
  duplicate = Boolean(existing);
  $('dialog-title').textContent = existing ? 'Inspect / duplicate evaluation' : 'New evaluation';
  $('model').value = ''; desiredJudge = existing?.judgeModel || config.judgeModel;
  criteria = [];
  setLanguages('typescript');
  const sample = {
    name: 'Login form · negative test coverage', type: 'ideas', source: 'pasted', framework: 'playwright', language: 'typescript', method: 'contains',
    input: 'Generate positive and negative test ideas for the login form.', pageUrl: 'https://example.com/login',
    html: '<form aria-label="Sign in">\n  <label for="email">Email</label>\n  <input id="email" type="email" required>\n  <label for="password">Password</label>\n  <input id="password" type="password" required>\n  <button type="submit">Sign in</button>\n</form>',
    criteria: ['valid credentials', 'invalid email', 'empty password'],
    actualOutput: 'Positive Tests:\n- Sign in with valid credentials and verify the account page is shown.\n\nNegative Tests:\n- Submit an invalid email and verify email validation is displayed.\n- Submit an empty password and verify the required-field message.',
  };
  const data = existing || (example ? sample : null);
  if (data) {
    for (const key of ['name','type','source','input','html','model']) if (data[key] !== undefined) $(key).value = data[key];
    if (languages[data.framework]) $('framework').value = data.framework;
    setLanguages(data.language);
    for (const [key,id] of [['pageUrl','page-url'],['actualOutput','actual-output']]) if (data[key] !== undefined) $(id).value = data[key];
    $('pom').checked = !!data.pom; $('from-ideas').checked = !!data.fromIdeas;
    $('ideas').value = data.ideas ?? (data.fromIdeas ? data.input : '') ?? '';
    criteria = Array.isArray(data.criteria) ? [...data.criteria] : data.method === 'exact_match' ? [data.expectedOutput || ''] : (data.method === 'contains' ? data.expectedOutput || '' : data.criteria || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  }
  selectMethod(data?.method || 'model_grade', false); renderModelOptions(); syncForm(); setStep(1, false);
  $('evaluation-dialog').showModal(); document.body.classList.add('modal-open'); resizeTextareas(); $('name').focus();
  loadModels();
}
async function saveEvaluation(event) {
  event.preventDefault(); $('form-error').textContent = '';
  if (!validateStep(1)) return;
  if (formStep === 1) { setStep(2); return; }
  if ($('criterion-draft').value.trim() && !addCriterion()) return;
  if (!validateStep(2)) return;
  if (!criteria.length || ($('method').value === 'exact_match' && criteria.length !== 1)) {
    $('form-error').textContent = $('method').value === 'exact_match' ? 'Exact match needs exactly one criterion. Edit or remove the extra items.' : 'Add at least one evaluation criterion.';
    $('criterion-draft').focus(); return;
  }
  if ($('method').value === 'model_grade' && (modelsLoading || !$('judge-model').value)) { $('form-error').textContent = 'Wait for the models to load, then select a model grader.'; return; }
  $('save-evaluation').disabled = true;
  const payload = Object.fromEntries(new FormData($('evaluation-form')));
  payload.criteria = criteria.map(value => value.trim());
  payload.pom = !$('pom').disabled && $('pom').checked; payload.fromIdeas = !$('from-ideas').disabled && $('from-ideas').checked;
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
    await refreshSession();
    toast('Run created. Generation and grading continue in the backend.');
  } catch (e) { error(e.message); await refreshSession().catch(() => {}); }
  finally { updateSelection(); }
}
function renderRunList() {
  $('run-list').innerHTML = runs.length ? runs.map(run => '<button class="' + (currentRun?.id === run.id ? 'active' : '') + '" data-run-link="' + run.id + '"><strong>Run ' + run.id.slice(0,8) + ' · ' + run.total + ' evaluation' + (run.total === 1 ? '' : 's') + '</strong>' + badge(run.status) + '<small>' + escape(date(run.createdAt)) + ' · ' + run.passed + ' passed</small></button>').join('') : '<div class="empty-state"><p>Your runs will appear here.</p></div>';
}
function renderRunDetail() {
  const run = currentRun;
  if (!run) {
    $('run-detail').innerHTML = '<div class="empty-state"><div class="empty-icon" aria-hidden="true">▷</div><h3>No run selected</h3><p>Select a run from the history, or run your saved evaluations again.</p></div>';
    return;
  }
  if (!run.items.some(item => item.id === currentItemId)) currentItemId = run.items[0]?.id;
  const item = run.items.find(item => item.id === currentItemId), e = item?.evaluation;
  if (!item) return;
  const active = activeStatuses.includes(item.status);
  $('run-detail').innerHTML = '<div class="run-top"><div><h3>Run ' + run.id.slice(0,8) + ' ' + badge(run.status) + '</h3><p>' + escape(date(run.createdAt)) + ' · ' + run.items.length + ' saved evaluation snapshots</p></div><div class="run-actions"><a href="#runs/' + run.id + '" target="_blank" rel="noopener">Open in new tab ↗</a><button class="button small danger" data-delete-run="' + run.id + '"' + (canDeleteRun(run) ? '' : ' disabled title="Wait for this run to finish before deleting it."') + '>Delete run</button></div></div>'
    + '<div class="run-items">' + run.items.map(x => '<button class="run-item ' + (x.id === item.id ? 'active' : '') + '" data-item="' + x.id + '">' + escape(x.evaluation.name) + ' · ' + escape(names[x.status] || x.status) + '</button>').join('') + '</div>'
    + '<div class="result-body"><div class="result-title"><div><h3>' + escape(e.name) + '</h3><p>' + escape(names[e.type]) + ' · ' + escape(familyLabel(e.method)) + ' / ' + escape(names[e.method]) + '</p></div><div class="result-score">' + (Number.isFinite(item.score) ? item.score + '<small> / 100</small>' : '—') + '</div></div>'
    + (active ? '<p class="muted"><span class="spinner" aria-hidden="true"></span>' + escape(names[item.status]) + '… Results update automatically.</p>' : '<p>' + badge(item.status) + ' <span class="muted">' + (item.durationMs ?? 0) + ' ms</span></p>')
    + (item.error ? '<div class="error-banner" role="alert">' + escape(item.error) + '</div>' : '')
    + '<div class="comparison"><section class="output-card"><h4>' + (Array.isArray(e.criteria) ? 'EVALUATION CRITERIA' : 'LEGACY REFERENCE') + '</h4><pre>' + escape(Array.isArray(e.criteria) ? e.criteria.map((criterion, index) => (index + 1) + '. ' + criterion).join('\n\n') : e.expectedOutput) + '</pre></section><section class="output-card"><h4>ACTUAL OUTPUT</h4><pre>' + escape(item.output ?? 'Waiting for output…') + '</pre></section></div>'
    + '<p class="muted">Source: ' + escape(item.outputSource || names[e.source]) + (item.generationModel ? ' · Generation model: ' + escape(item.generationModel) : '') + (item.judgeModel ? ' · Model grader: ' + escape(item.judgeModel) : '') + '</p>'
    + '<div class="checks"><h4>Criteria and evidence</h4>' + (item.checks.length ? item.checks.map(check => '<article class="check"><div class="check-title"><b>' + escape(check.criterion) + '</b><span>' + check.score + '/100</span></div><p>' + escape(check.reason) + '</p><blockquote>' + escape(check.evidence) + '</blockquote></article>').join('') : '<p class="muted">' + (item.error ? 'Grading did not complete. No score has been fabricated.' : 'Checks will appear when grading finishes.') + '</p>') + '</div>'
    + '<div class="event-log"><h4>Run activity</h4>' + item.events.map(event => '<p><time>' + escape(new Date(event.at).toLocaleTimeString()) + '</time>' + escape(event.message) + '</p>').join('') + '</div>'
    + '<details><summary>Inspect saved input, HTML, and criteria</summary><pre class="context-pre">' + escape(JSON.stringify({ description: e.input, html: e.html, framework: e.framework, language: e.language, pageUrl: e.pageUrl, criteria: e.criteria, pom: e.pom, fromIdeas: e.fromIdeas, ideas: e.ideas }, null, 2)) + '</pre></details></div>';
}
function askDeleteRun(id) {
  if (!session || currentRun?.id !== id || !canDeleteRun(currentRun) || deletingRun) return;
  deleteTarget = { id, session };
  $('delete-run-summary').textContent = 'Run ' + id.slice(0,8) + ' · ' + date(currentRun.createdAt) + ' · ' + currentRun.items.length + ' evaluation snapshots';
  $('delete-run-error').textContent = '';
  $('confirm-delete-run').disabled = false; $('confirm-delete-run').textContent = 'Delete run'; $('cancel-delete-run').disabled = false;
  $('delete-run-dialog').showModal(); document.body.classList.add('modal-open'); $('cancel-delete-run').focus();
}
async function deleteRun(event) {
  event.preventDefault();
  const target = deleteTarget;
  if (!target || target.session !== session || deletingRun) return;
  deletingRun = true; $('confirm-delete-run').disabled = true; $('cancel-delete-run').disabled = true;
  $('confirm-delete-run').textContent = 'Deleting…'; $('delete-run-error').textContent = '';
  let alreadyDeleted = false;
  try {
    await api('/api/runs/' + target.id, { method: 'DELETE' });
  } catch (e) {
    if (target.session !== session) return;
    if (e.status === 404) alreadyDeleted = true;
    else {
      $('delete-run-error').textContent = e.message;
      deletingRun = false; $('confirm-delete-run').disabled = false; $('cancel-delete-run').disabled = false; $('confirm-delete-run').textContent = 'Delete run';
      return;
    }
  }
  if (target.session !== session) return;
  deletingRun = false; $('delete-run-dialog').close(); error('');
  const viewingDeleted = location.hash === '#runs/' + target.id;
  if (viewingDeleted) { history.replaceState(null, '', '#runs'); runViewRevision++; clearTimeout(polling); }
  if (currentRun?.id === target.id) { currentRun = null; currentItemId = null; lastRunJson = null; renderRunDetail(); }
  // Invalidate older reads before refreshing so a stale response cannot restore the row.
  runsRequest++; libraryRequest++;
  runs = runs.filter(run => run.id !== target.id); $('runs-count').textContent = runs.length; renderRunList();
  evaluations = evaluations.map(evaluation => evaluation.latest?.runId === target.id ? { ...evaluation, latest: null } : evaluation); renderLibrary();
  toast(alreadyDeleted ? 'This run was already removed.' : 'Run deleted. Your evaluations are still saved.');
  try {
    await Promise.all([loadRuns(), loadLibrary()]);
    if (target.session === session && viewingDeleted && location.hash === '#runs') { await route(); $('refresh-runs').focus(); }
  } catch {
    if (target.session === session) error('The run was removed, but the history could not refresh. Reload the page.');
  }
}
async function pollRun(id, revision = runViewRevision) {
  if (!session || revision !== runViewRevision || location.hash !== '#runs/' + id) return;
  try {
    const run = await api('/api/runs/' + id);
    if (revision !== runViewRevision || location.hash !== '#runs/' + id) return;
    pollFailures = 0; currentRun = run;
    const serialized = JSON.stringify(run);
    if (serialized !== lastRunJson) { lastRunJson = serialized; renderRunDetail(); await loadRuns(); }
    if (revision !== runViewRevision || location.hash !== '#runs/' + id) return;
    if (activeStatuses.includes(run.status)) polling = setTimeout(() => pollRun(id, revision), 900);
    else { await loadLibrary(); if (!sessionSetup) await refreshSession(); }
  } catch (e) {
    if (!session || revision !== runViewRevision || location.hash !== '#runs/' + id) return;
    if (e.status === 404) {
      currentRun = null; currentItemId = null; renderRunDetail();
      history.replaceState(null, '', '#runs'); toast('This run is no longer available.');
      try { await loadLibrary(); if (revision === runViewRevision) await route(); }
      catch (refreshError) { if (session && revision === runViewRevision) error(refreshError.message); }
      return;
    }
    error(e.message);
    if (++pollFailures < 3) polling = setTimeout(() => pollRun(id, revision), 1500);
  }
}
async function route() {
  const revision = ++runViewRevision;
  clearTimeout(polling); lastRunJson = null; pollFailures = 0;
  if (!session) return;
  const isRuns = location.hash.startsWith('#runs');
  $('evaluations-panel').hidden = isRuns; $('runs-panel').hidden = !isRuns;
  $('evaluations-tab').setAttribute('aria-selected', String(!isRuns)); $('runs-tab').setAttribute('aria-selected', String(isRuns));
  $('evaluations-tab').tabIndex = isRuns ? -1 : 0; $('runs-tab').tabIndex = isRuns ? 0 : -1;
  if (isRuns) {
    const id = location.hash.split('/')[1];
    if (currentRun?.id !== id || !id) { currentRun = null; currentItemId = null; renderRunDetail(); }
    await loadRuns();
    if (revision !== runViewRevision) return;
    if (id) { currentItemId = null; await pollRun(id, revision); }
    else if (runs.length) location.hash = 'runs/' + runs[0].id;
  } else await loadLibrary();
}
$('evaluation-form').addEventListener('submit', saveEvaluation);
['new-button','empty-create'].forEach(id => $(id).addEventListener('click', () => openForm()));
$('example-button').addEventListener('click', () => openForm(true));
['close-dialog','cancel-dialog'].forEach(id => $(id).addEventListener('click', () => $('evaluation-dialog').close()));
$('evaluation-dialog').addEventListener('close', () => document.body.classList.remove('modal-open'));
$('delete-run-form').addEventListener('submit', deleteRun);
$('cancel-delete-run').addEventListener('click', () => { if (!deletingRun) $('delete-run-dialog').close(); });
$('delete-run-dialog').addEventListener('cancel', event => { if (deletingRun) event.preventDefault(); });
$('delete-run-dialog').addEventListener('close', () => { deleteTarget = null; document.body.classList.toggle('modal-open', $('evaluation-dialog').open); });
$('back-step').addEventListener('click', () => setStep(1));
['type','source','from-ideas'].forEach(id => $(id).addEventListener('change', syncForm));
$('method').addEventListener('change', () => selectMethod($('method').value));
$('method-family').addEventListener('change', () => selectMethod(familyChoices[$('method-family').value] || ($('method-family').value === 'model_based' ? 'model_grade' : 'contains')));
$('judge-model').addEventListener('change', () => { desiredJudge = $('judge-model').value; });
$('retry-models').addEventListener('click', loadModels);
$('add-criterion').addEventListener('click', addCriterion);
$('criterion-draft').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && $('method').value !== 'exact_match') { event.preventDefault(); addCriterion(); }
});
$('criteria-list').addEventListener('input', event => {
  if (event.target.dataset.criterion !== undefined) criteria[Number(event.target.dataset.criterion)] = event.target.value;
});
$('criteria-list').addEventListener('click', event => {
  const button = event.target.closest('[data-remove-criterion]');
  if (!button) return;
  const index = Number(button.dataset.removeCriterion); criteria.splice(index, 1); renderCriteria();
  ($('criterion-' + Math.min(index, criteria.length - 1)) || $('criterion-draft')).focus();
});
$('evaluation-form').addEventListener('input', resizeTextareas);
new ResizeObserver(resizeTextareas).observe($('wizard-body'));
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
  if (el.dataset.deleteRun) askDeleteRun(el.dataset.deleteRun);
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
async function openWorkspace() {
  config = await api('/api/config');
  if (config.version !== 7 || !config.evaluationMethods) throw new Error('An older server is running. Restart npm start to enable run deletion.');
  $('connection').textContent = '● Backend connected';
  $('setup-notice').hidden = true; error('');
  if (!config.llmReady) { $('setup-notice').hidden = false; $('setup-notice').textContent = 'LLM as a judge needs OPENAI_API_KEY in the backend. You can already save evaluations and use Rule-based grading with pasted outputs. Load example to try it.'; }
  await Promise.all([loadLibrary(), loadRuns()]); await route();
  if (!session) return;
  $('session-status').hidden = true; $('workspace').hidden = false; $('private-badge').hidden = false;
  renderSession(); scheduleSessionCheck();
}
async function ensureBrowserSession() {
  let current = await api('/api/session');
  if (!current.authenticated) {
    await api('/api/session', { method: 'POST', body: '{}' });
    // Verify that the browser kept the HttpOnly cookie; do not loop when cookies are blocked.
    current = await api('/api/session');
    if (!current.authenticated) throw new Error('Allow cookies for this site, then retry. Your browser needs a cookie to keep its private workspace.');
  }
  return current;
}
function connectWorkspace() {
  if (sessionSetup) return sessionSetup;
  const previousWorkspace = session?.workspaceId;
  showConnecting();
  sessionSetup = (async () => {
    try {
      // Serialize first visits across tabs in browsers supporting Web Locks.
      session = navigator.locks ? await navigator.locks.request('testcraft-session-bootstrap', ensureBrowserSession) : await ensureBrowserSession();
      const renewed = previousWorkspace && previousWorkspace !== session.workspaceId;
      if (renewed) history.replaceState(null, '', '#evaluations');
      await openWorkspace();
      if (renewed) toast('A new browser session was created. Previous evaluations remain in the previous workspace.');
    } catch (e) {
      showConnecting(); $('session-message').textContent = 'Could not open your workspace.';
      $('session-error').textContent = e.message; $('retry-session').hidden = false;
    } finally { sessionSetup = null; }
  })();
  return sessionSetup;
}
$('retry-session').addEventListener('click', connectWorkspace);
void connectWorkspace();
