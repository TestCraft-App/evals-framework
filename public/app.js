import { createRunDetail, scoreMarkup, evaluationFamily } from './run-detail.js';
const $ = id => document.getElementById(id);
const names = { ideas: 'Generate ideas', code: 'Automate tests', code_ideas: 'Automate test ideas', model_grade: 'Model-graded', exact_match: 'Exact match', contains: 'Contains', not_contains: 'Not Contains', pasted: 'Pasted output', testcraft_api: 'TestCraft v1', llm: 'LLM adapter', playwright: 'Playwright', cypress: 'Cypress', selenium: 'Selenium', typescript: 'TypeScript', javascript: 'JavaScript', python: 'Python', java: 'Java', csharp: 'C#', not_run: 'Not run', passed: 'Passed', failed: 'Failed', error: 'Error', queued: 'Queued', generating: 'Generating', grading: 'Grading', running: 'Running', completed: 'Completed', interrupted: 'Interrupted' };
names.hybrid = 'Hybrid';
names.rule_based = 'Rule-based';
names.test_count = 'Test count';
names.counted = 'Counted';
const isModelMethod = method => ['model_grade', 'test_count'].includes(method);
const testCountText = 'Count test ideas or automated tests in the output.';
const languages = { playwright: ['typescript','javascript','python','java','csharp'], cypress: ['typescript','javascript'], selenium: ['javascript','python','java','csharp'] };
const activeStatuses = ['queued','running','generating','grading'];
let config, evaluations = [], runs = [], currentRun, polling, lastRunJson, pollFailures = 0, toastTimer;
let formStep = 1, editing = null, savingEvaluation = false, criteria = [];
let suites = [], libraryDeleteTarget = null, deletingLibrary = false;
let workspaceReview = null, clearingWorkspace = false;
let session = null, sessionTimer, sessionSetup;
let activeWorkspace = 'main', personalKey = '', acceptedHash = '', runSourceWorkspace = null;
let runEvaluations = [], runSuites = [];
const accountChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('testcraft-account') : null;
const routeHash = () => location.hash.replace(/^#(?:main|personal)\//, '#');
const navigate = value => { location.hash = activeWorkspace + '/' + value.replace(/^#/, ''); };
const canWriteWorkspace = () => activeWorkspace === 'personal' || session?.user.role === 'admin';
const resourcePath = (path, workspace = activeWorkspace) => '/api/workspaces/' + workspace + path.slice(4);
function updateKey(value) {
  personalKey = value; $('personal-api-key').value = value; $('run-api-key').value = value;
}
function applyWorkspaceControls() {
  $('workspace-switcher').value = activeWorkspace;
  document.body.classList.toggle('readonly-workspace', !canWriteWorkspace());
  $('workspace-access').textContent = canWriteWorkspace() ? 'You can manage this workspace.' : 'Read-only library · your runs are saved in My workspace.';
  $('private-badge').textContent = session.user.login + ' · ' + session.user.role;
  $('user-menu-name').textContent = session.user.login;
  $('user-menu-toggle').title = 'User menu: ' + session.user.login;
  $('github-login').hidden = true;
  $('open-api-key').hidden = session.user.role === 'admin';
  for (const [id, label] of [['example-button', 'Load example'], ['basic-workshop-button', 'Load Basic Suite'], ['workshop-button', 'Load Full Suite']]) $(id).textContent = label + (canWriteWorkspace() ? '' : ' into My workspace');
  document.querySelector('.brand').href = '#' + activeWorkspace + '/evaluations';
  document.querySelector('.back-to-runs').href = '#' + activeWorkspace + '/runs';
}
function hasDraft() { return !!inlineName || !!suiteDraft || $('evaluation-dialog').open || $('create-run-dialog').open || ($('api-key-dialog').open && $('personal-api-key').value.trim() !== personalKey); }
async function changeWorkspace(alias) {
  const account = session;
  showConnecting(); activeWorkspace = alias; session = { ...account };
  applyWorkspaceControls(); await openWorkspace();
}
async function personalLoader(action) {
  if (!canWriteWorkspace()) {
    history.replaceState(null, '', '#personal/evaluations');
    await changeWorkspace('personal');
  }
  action();
}

let suiteDraft = null, savingSuite = false;
let inlineName = null, duplicatingEvaluation = false, renderingLibrary = false;
let deleteTarget = null, deletingRun = false, runViewRevision = 0, runsRequest = 0, libraryRequest = 0;
let evalSort = 'createdAt', evalSortDirection = -1;
let runSort = 'createdAt', runSortDirection = -1, lastRunRows = null;
let runSelection = new Set(), runCatalogs = new Map(), catalogLoads = new Map(), runCatalog = null, runModelsLoading = false, creatingRun = false, runDraftRevision = 0, catalogRequest = 0;
let runModelDefaults = null, rerunRequest = 0;
const canDeleteRun = run => canWriteWorkspace() && (typeof run.canDelete === 'boolean' ? run.canDelete : ['completed', 'interrupted'].includes(run.status) && run.items.every(item => ['passed', 'failed', 'counted', 'error'].includes(item.status)));
const criterionObjects = evaluation => {
  const values = Array.isArray(evaluation.criteria) ? evaluation.criteria : evaluation.method === 'exact_match' ? [evaluation.expectedOutput || ''] : (['contains', 'not_contains'].includes(evaluation.method) ? evaluation.expectedOutput || '' : evaluation.criteria || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  return values.map(value => typeof value === 'string' ? { text: value, method: evaluation.method, weight: 1 } : { ...value, method: value.method || evaluation.method, weight: value.weight ?? 1 });
};
const draftMethod = () => $('method').value === 'test_count' ? 'test_count' : $('method').value === 'model_based' ? 'model_grade' : $('criterion-rule').value;
const endpoint = e => e.type === 'code' && e.fromIdeas ? 'code_ideas' : e.type;
const runDetail = createRunDetail({ root: $('run-detail'), getSuites: () => suites, getCatalog: environment => runCatalogs.get(environment), getMethods: () => config?.evaluationMethods || {}, getCriteria: criterionObjects, runName, canDelete: canDeleteRun });
function lockBody() { document.body.classList.toggle('modal-open', !!document.querySelector('dialog[open]')); }
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const badge = status => '<span class="badge ' + escape(status) + '">' + escape(names[status] || status) + '</span>';
const date = value => new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
function error(message) { $('app-error').textContent = message; $('app-error').hidden = !message; }
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3000); }
async function api(path, options) {
  const requestSession = session;
  if (/^\/api\/(?:evaluations|suites|runs|workspace|workshop-suite|basic-workshop-suite)(?:[/?]|$)/.test(path)) path = resourcePath(path);
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
  workspaceReview = null; clearingWorkspace = false; $('clear-workspace-dialog').close();
  closeLibraryActions();
  closeUserMenu(); $('api-key-dialog').close(); $('personal-api-key').value = '';
  runDetail.reset();
  session = null; config = null; clearTimeout(polling); clearTimeout(sessionTimer); clearTimeout(toastTimer);
  evaluations = []; runs = []; suites = []; editing = null; currentRun = null; criteria = [];
  inlineName = null; duplicatingEvaluation = false;
  suiteDraft = null; savingSuite = false; closeSuiteEditor(false);
  runViewRevision++; runsRequest++; libraryRequest++; deleteTarget = null; deletingRun = false; $('delete-run-dialog').close();
  closeRunDraft(); $('evaluation-dialog').close(); $('evaluation-form').reset(); $('criteria-list').replaceChildren();
  $('delete-library-dialog').close(); $('inspect-evaluation').close();
  libraryDeleteTarget = null; savingEvaluation = false; deletingLibrary = false;
  $('filter-suite').value = ''; evalSort = 'createdAt'; evalSortDirection = -1; renderSuites();
  $('run-search').value = ''; $('run-status').value = ''; $('run-model').value = ''; runSort = 'createdAt'; runSortDirection = -1; lastRunRows = null;
  $('evaluation-rows').replaceChildren(); $('run-list').replaceChildren(); $('run-detail').replaceChildren(); $('toast').hidden = true;
  $('workspace').hidden = true; $('user-menu').hidden = true; $('session-status').hidden = false;
  $('private-badge').textContent = ''; $('user-menu-name').textContent = ''; $('user-menu-toggle').removeAttribute('title');
  $('session-message').textContent = 'Opening your workspace…';
  $('session-error').textContent = ''; $('retry-session').hidden = true;
}
function scheduleSessionCheck() {
  clearTimeout(sessionTimer);
  if (session) sessionTimer = setTimeout(() => refreshSession().catch(e => { error(e.message); scheduleSessionCheck(); }), 30000);
}
async function refreshSession() {
  clearTimeout(sessionTimer);
  if (!session) return;
  const current = await api('/api/session');
  if (!current.authenticated || current.workspaceId !== session?.workspaceId || current.user.role !== session.user.role) return connectWorkspace();
  // Preserve object identity so parallel responses from this workspace remain valid.
  Object.assign(session, current);
  scheduleSessionCheck();
}
async function loadLibrary() {
  const request = ++libraryRequest, [data, groups] = await Promise.all([api('/api/evaluations'), api('/api/suites')]);
  if (request !== libraryRequest) return;
  evaluations = data.evaluations; suites = groups.suites; renderSuites();
  renderLibrary();
}
async function loadRuns() {
  const request = ++runsRequest, data = await api('/api/runs');
  if (request !== runsRequest) return;
  runs = data.runs; $('runs-count').textContent = runs.length; renderRunList();
}
const evaluationSuite = e => suites.find(s => s.id === e.suiteId)?.name || 'None';
const evaluationMethod = e => ({ rule_based: 'rule-based', model_based: 'model-graded', hybrid: 'hybrid' }[evaluationFamily(e)]);
function visibleEvaluations() {
  const query = $('search').value.trim().toLowerCase();
  const value = e => evalSort === 'reference' ? Number(e.reference?.slice(5) || 0) : evalSort === 'suite' ? evaluationSuite(e) : evalSort === 'method' ? evaluationMethod(e) : evalSort === 'type' ? names[endpoint(e)] : e[evalSort];
  return evaluations.filter(e => {
    return (!query || ((e.reference || '') + ' ' + e.id + ' ' + e.name + ' ' + (e.input || '')).toLowerCase().includes(query))
      && (!$('filter-type').value || endpoint(e) === $('filter-type').value)
      && (!$('filter-suite').value || ($('filter-suite').value === '__unfiled' ? !e.suiteId : e.suiteId === $('filter-suite').value))
      && (!$('filter-method').value || evaluationFamily(e) === $('filter-method').value);
  }).sort((a, b) => (evalSort === 'reference' ? value(a) - value(b) : String(value(a)).localeCompare(String(value(b)))) * evalSortDirection || a.id.localeCompare(b.id));
}
function renderLibrary() {
  $('eval-count').textContent = evaluations.length;
  const visible = visibleEvaluations().filter(e => e.id !== inlineName?.record.id);
  if (inlineName) visible.unshift(inlineName.record);
  const focused = document.activeElement?.id === 'duplicate-name', selection = focused ? [$('duplicate-name').selectionStart, $('duplicate-name').selectionEnd] : null;
  renderingLibrary = true;
  $('evaluation-rows').innerHTML = visible.map(e => '<tr><td class="evaluation-id">' + escape(e.reference || '—') + '</td>'
    + '<td>' + (e.id === inlineName?.record.id ? inlineNameMarkup() : '<button class="eval-name" data-inspect="' + escape(e.id) + '" title="' + escape(e.name) + '">' + escape(e.name) + '</button>') + '</td>'
    + '<td><span class="eval-suite" title="' + escape(evaluationSuite(e)) + '">' + escape(evaluationSuite(e)) + '</span></td><td>' + badge(endpoint(e)) + '</td>'
    + '<td>' + evaluationMethod(e) + '</td><td><time datetime="' + escape(e.createdAt) + '">' + escape(date(e.createdAt)) + '</time></td>'
    + '<td><div class="row-actions">' + '<button class="text-button eval-action" data-inspect="' + escape(e.id) + '" title="Edit evaluation" aria-label="Edit ' + escape(e.name) + '"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M16 3l5 5-12 12H4v-5L16 3zM13 6l5 5"/></svg></button>' + '<button class="text-button eval-action" data-duplicate-evaluation="' + escape(e.id) + '" title="Duplicate evaluation" aria-label="Duplicate ' + escape(e.name) + '"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M9 9h12v12H9zM15 9V3H3v12h6"/></svg></button>' + '<button class="text-button eval-action danger" data-delete-evaluation="' + escape(e.id) + '" title="Delete evaluation" aria-label="Delete ' + escape(e.name) + '"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></svg></button>' + '</div></td></tr>').join('');
  $('evaluation-rows').querySelectorAll('td:not(:nth-child(2)):not(:last-child)').forEach(cell => { cell.title = cell.textContent.trim(); });
  renderingLibrary = false;
  document.querySelectorAll('[data-duplicate-evaluation]').forEach(button => { button.disabled = duplicatingEvaluation; });
  if (focused && $('duplicate-name')) { $('duplicate-name').focus(); $('duplicate-name').setSelectionRange(...selection); }
  document.querySelectorAll('[data-eval-sort]').forEach(button => button.parentElement.setAttribute('aria-sort', button.dataset.evalSort === evalSort ? (evalSortDirection === 1 ? 'ascending' : 'descending') : 'none'));
  $('empty-library').hidden = visible.length > 0;
  $('empty-library').querySelector('h3').textContent = evaluations.length ? 'No evaluations match these filters.' : 'Your first evaluation starts here.';
  $('filtered-count').textContent = visible.length + ' of ' + evaluations.length + ' evaluations';
}
function setLanguages(preferred = $('language').value) {
  $('language').innerHTML = languages[$('framework').value].map(value => '<option value="' + value + '">' + names[value] + '</option>').join('');
  if (languages[$('framework').value].includes(preferred)) $('language').value = preferred;
}
function syncForm() {
  const code = $('type').value !== 'ideas', fromIdeas = $('type').value === 'code_ideas';
  $('code-parameters').hidden = !code;
  for (const id of ['framework', 'language', 'pom', 'page-url']) $(id).disabled = !code;
  $('page-url').required = code;
  $('ideas-field').hidden = !fromIdeas; $('ideas').required = fromIdeas; $('ideas').disabled = !fromIdeas;
  $('criterion-rule-field').hidden = $('method').value !== 'rule_based';
  $('criterion-rule').disabled = $('method').value !== 'rule_based';
  $('criterion-description-field').hidden = $('method').value !== 'rule_based';
  $('criterion-description').disabled = $('method').value !== 'rule_based';
  $('criterion-draft').placeholder = config?.evaluationMethods?.[draftMethod()]?.placeholder || '';
  $('criterion-draft').hidden = draftMethod() === 'test_count';
  $('criterion-draft').disabled = draftMethod() === 'test_count';
  $('criterion-composer-label').hidden = draftMethod() === 'test_count';
  $('test-count-hint').hidden = draftMethod() !== 'test_count';
  $('test-count-hint').textContent = 'The selected model grader counts ' + (code ? 'implemented automated tests in the output, excluding skipped and empty tests.' : 'separately proposed test ideas in the output.') + ' Add once per evaluation; the count does not affect the quality score.';
  updateCriteriaState(); resizeTextareas();
}
function resizeTextareas() {
  document.querySelectorAll('#step-1 textarea').forEach(el => {
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
  $('save-evaluation').textContent = step === 1 ? 'Next →' : editing ? 'Save' : 'Create evaluation';
  $('form-error').textContent = ''; $('wizard-body').scrollTop = 0;
  resizeTextareas();
  if (focus) $(step === 1 ? 'name' : 'method').focus();
}
function updateCriteriaState() {
  $('criteria-count').textContent = criteria.length + (criteria.length === 1 ? ' criterion' : ' criteria');
  $('criteria-empty').hidden = criteria.length > 0;
  $('add-criterion').disabled = criteria.length >= 20 || (['exact_match', 'test_count'].includes(draftMethod()) && criteria.some(c => c.method === draftMethod()));
}
function updateCriterionTooltip(preview) {
  const field = preview.parentElement.querySelector('textarea');
  if (preview.clientWidth && preview.scrollWidth > preview.clientWidth) field.title = field.value;
  else field.removeAttribute('title');
}
const criterionPreviewObserver = new ResizeObserver(entries => entries.forEach(entry => updateCriterionTooltip(entry.target)));
function syncCriterionPreview(field) {
  const preview = field.parentElement.querySelector('.criterion-text-preview');
  preview.textContent = field.value.replace(/\r?\n/g, ' ↵ ');
  updateCriterionTooltip(preview);
}
function renderCriteria() {
  criterionPreviewObserver.disconnect();
  $('criteria-list').innerHTML = criteria.map((value, index) => '<li><div class="criterion-card-header"><span class="criterion-number" aria-hidden="true">' + (index + 1) + '.</span>' + badge(isModelMethod(value.method) ? value.method : 'rule_based')
    + (!isModelMethod(value.method) ? '<label class="criterion-description-editor"><span class="sr-only">Description for criterion ' + (index + 1) + '</span><input data-criterion-description="' + index + '" maxlength="2000" placeholder="Description (optional)" value="' + escape(value.description || '') + '"></label>' : '')
    + '<button type="button" class="icon-button" data-remove-criterion="' + index + '" aria-label="Remove criterion ' + (index + 1) + '">×</button></div><div class="criterion-card-body">'
    + (!isModelMethod(value.method) ? '<select class="criterion-rule-pill" data-criterion-method="' + index + '" aria-label="Rule for criterion ' + (index + 1) + '">' + ['contains', 'not_contains', 'exact_match'].map(method => '<option value="' + method + '"' + (method === value.method ? ' selected' : '') + '>' + names[method] + '</option>').join('') + '</select>' : '')
    + '<div class="criterion-text-editor"><label class="sr-only" for="criterion-' + index + '">Criterion ' + (index + 1) + '</label><textarea id="criterion-' + index + '" data-criterion="' + index + '" rows="1" maxlength="8000" required' + (value.method === 'test_count' ? ' readonly' : '') + '>' + escape(value.text) + '</textarea><span class="criterion-text-preview" aria-hidden="true"></span></div></div></li>').join('');
  $('criteria-list').querySelectorAll('[data-criterion]').forEach(field => {
    syncCriterionPreview(field);
    criterionPreviewObserver.observe(field.parentElement.querySelector('.criterion-text-preview'));
  });
  updateCriteriaState();
}
function addCriterion() {
  const method = draftMethod(), value = method === 'test_count' ? testCountText : $('criterion-draft').value.trim();
  if (!value) { $('form-error').textContent = 'Write a criterion before adding it.'; $('criterion-draft').focus(); return false; }
  if (criteria.length >= 20) { $('form-error').textContent = 'Use at most 20 criteria.'; return false; }
  if (method === 'exact_match' && criteria.some(c => c.method === method)) { $('form-error').textContent = 'Use at most one Exact match criterion.'; return false; }
  if (method === 'test_count' && criteria.some(c => c.method === method)) { $('form-error').textContent = 'Use at most one Test count criterion.'; return false; }
  if (criteria.map(c => c.text).join('').length + value.length > 8000) { $('form-error').textContent = 'Keep all criteria within 8000 characters.'; return false; }
  if (criteria.some(c => c.method === method && c.text.trim() === value)) { $('form-error').textContent = 'This criterion is already in the list.'; return false; }
  const description = !isModelMethod(method) ? $('criterion-description').value.trim() : '';
  criteria.push({ text: value, method, weight: 1, ...(description ? { description } : {}) });
  if (!isModelMethod(method)) $('criterion-description').value = '';
  $('criterion-draft').value = ''; $('form-error').textContent = ''; renderCriteria(); syncForm();
  (method === 'test_count' ? $('method') : $('criterion-draft')).focus(); return true;
}
function validateStep(step) {
  const invalid = [...$('step-' + step).querySelectorAll('input,select,textarea')].find(el => !el.disabled && !el.checkValidity());
  if (!invalid) return true;
  setStep(step, false); invalid.focus(); invalid.reportValidity(); return false;
}
function openForm(example = false, existing) {
  if (!session || !config) return;
  if (!canWriteWorkspace()) { if (existing) inspectEvaluation(existing); return; }
  $('evaluation-form').reset(); $('form-error').textContent = '';
  closeSuiteEditor(false);
  editing = existing ? structuredClone(existing) : null;
  $('dialog-title').textContent = existing ? 'Edit evaluation' : 'New evaluation';
  $('edit-version').hidden = !editing;
  $('edit-version').textContent = editing ? 'Version ' + (editing.revision || 1) + ' · Previous runs keep their original inputs and results.' : '';
  $('delete-evaluation').hidden = !editing;
  setSavingEvaluation(false); renderSuites();
  $('evaluation-suite').value = existing?.suiteId || (suites.some(s => s.id === $('filter-suite').value) ? $('filter-suite').value : '');
  criteria = [];
  setLanguages('typescript');
  const sample = {
    name: 'Login form · negative test coverage', type: 'ideas', source: 'testcraft_api', framework: 'playwright', language: 'typescript', method: 'contains',
    input: 'Generate positive and negative test ideas for the login form.', pageUrl: 'https://example.com/login',
    html: '<form aria-label="Sign in">\n  <label for="email">Email</label>\n  <input id="email" type="email" required>\n  <label for="password">Password</label>\n  <input id="password" type="password" required>\n  <button type="submit">Sign in</button>\n</form>',
    criteria: ['valid credentials', 'invalid email', 'empty password'],
  };
  const data = existing || (example ? sample : null);
  if (data) {
    for (const key of ['name','html']) if (data[key] !== undefined) $(key).value = data[key];
    if (languages[data.framework]) $('framework').value = data.framework;
    setLanguages(data.language);
    if (data.pageUrl !== undefined) $('page-url').value = data.pageUrl;
    $('type').value = endpoint(data); $('pom').checked = !!data.pom;
    $('ideas').value = data.ideas ?? (data.fromIdeas ? data.input : '') ?? '';
    criteria = criterionObjects(data);

  }
  const initialMethod = criteria[0]?.method || 'model_grade';
  $('method').value = initialMethod === 'test_count' ? 'test_count' : initialMethod === 'model_grade' ? 'model_based' : 'rule_based';
  $('criterion-rule').value = isModelMethod(initialMethod) ? 'contains' : initialMethod;
  renderCriteria(); syncForm(); syncSuiteActions(); setStep(1, false);
  $('evaluation-dialog').showModal(); document.body.classList.add('modal-open'); resizeTextareas(); $('name').focus();
}
async function saveEvaluation(event) {
  event.preventDefault(); $('form-error').textContent = '';
  if (savingEvaluation || savingSuite) return;
  if (suiteDraft) { $('form-error').textContent = 'Save or cancel the suite change first.'; $('save-suite').focus(); return; }
  if (!validateStep(1)) return;
  if (formStep === 1) { setStep(2); return; }
  if (!$('criterion-draft').disabled && $('criterion-draft').value.trim() && !addCriterion()) return;
  if (!validateStep(2)) return;
  if (!criteria.length) {
    $('form-error').textContent = 'Add at least one evaluation criterion.'; (draftMethod() === 'test_count' ? $('add-criterion') : $('criterion-draft')).focus(); return;
  }
  if (criteria.filter(c => c.method === 'exact_match').length > 1) {
    $('form-error').textContent = 'Use at most one Exact match criterion.'; return;
  }
  const target = editing, requestSession = session;
  const payload = { ...Object.fromEntries(new FormData($('evaluation-form'))), source: 'testcraft_api' };
  payload.criteria = criteria.map(value => ({ text: value.text.trim(), method: value.method, weight: 1, ...(!isModelMethod(value.method) && value.description?.trim() ? { description: value.description.trim() } : {}) }));
  payload.method = new Set(criteria.map(c => c.method)).size === 1 ? criteria[0].method : 'hybrid';
  payload.type = $('type').value === 'ideas' ? 'ideas' : 'code';
  payload.fromIdeas = $('type').value === 'code_ideas';
  if (payload.type === 'code') payload.pom = $('pom').checked;
  if (target) payload.revision = target.revision || 1;
  setSavingEvaluation(true);
  let saved = false;
  try {
    await api('/api/evaluations' + (target ? '/' + target.id : ''), { method: target ? 'PUT' : 'POST', body: JSON.stringify(payload) });
    saved = true; $('evaluation-dialog').close(); await loadLibrary(); toast(target ? 'Changes saved. Run this version to evaluate it.' : 'Evaluation saved. Open Runs to create a run.');
  } catch (e) { if (requestSession === session) { if (saved) error('Saved, but the library could not refresh. Reload the page.'); else $('form-error').textContent = e.status === 409 ? e.message + ' Your draft is preserved. Copy any changes you want to keep, then reopen the evaluation to load its latest version.' : e.message; } }
  finally { if (requestSession === session) setSavingEvaluation(false); }
}
function setSavingEvaluation(busy) {
  savingEvaluation = busy;
  ['save-evaluation','delete-evaluation','close-dialog','cancel-dialog','back-step'].forEach(id => { $(id).disabled = busy || savingSuite; });
  syncSuiteActions();
}
function renderSuites() {
  for (const [id, empty] of [['filter-suite', '<option value="">All evaluations</option><option value="__unfiled">None</option>'], ['create-eval-suite', '<option value="">All suites</option><option value="__unfiled">None</option>'], ['evaluation-suite', '<option value="">None</option>']]) {
    const current = $(id).value;
    $(id).innerHTML = empty + suites.map(s => '<option value="' + escape(s.id) + '">' + escape(s.name) + '</option>').join('');
    if ([...$(id).options].some(o => o.value === current)) $(id).value = current;
  }
  syncSuiteActions();
}
function closeSuiteMenu() {
  $('suite-menu').hidden = true; $('suite-actions').setAttribute('aria-expanded', 'false');
}
function syncSuiteActions() {
  const selected = suites.find(s => s.id === $('evaluation-suite').value), busy = savingSuite || savingEvaluation;
  const nonempty = !!selected && evaluations.some(e => e.suiteId === selected.id);
  $('suite-actions').disabled = busy; $('evaluation-suite').disabled = busy || !!suiteDraft;
  $('create-suite').disabled = busy;
  $('rename-suite').disabled = busy || !selected; $('delete-suite').disabled = busy || !selected || nonempty;
  $('suite-delete-hint').hidden = !nonempty;
  $('save-suite').disabled = busy; $('cancel-suite').disabled = busy;
  $('suite-name').disabled = busy || !suiteDraft || suiteDraft.kind === 'delete';
}
function closeSuiteEditor(focus = true) {
  suiteDraft = null; $('suite-editor').hidden = true; $('suite-error').textContent = '';
  closeSuiteMenu(); syncSuiteActions();
  if (focus) $('suite-actions').focus();
}
function openSuiteEditor(kind) {
  if (savingSuite || savingEvaluation) return;
  const record = suites.find(s => s.id === $('evaluation-suite').value);
  if (kind !== 'create' && !record) return;
  if (kind === 'delete' && evaluations.some(e => e.suiteId === record.id)) return;
  suiteDraft = { kind, record: record ? { ...record } : null, session };
  closeSuiteMenu(); $('suite-editor').hidden = false; $('suite-error').textContent = '';
  $('suite-name-field').hidden = kind === 'delete'; $('suite-delete-confirmation').hidden = kind !== 'delete';
  $('suite-editor-title').textContent = kind === 'create' ? 'Create suite' : 'Rename suite';
  $('suite-name').value = kind === 'create' ? '' : record.name;
  $('suite-delete-confirmation').textContent = kind === 'delete' ? 'Delete suite “' + record.name + '”?' : '';
  $('save-suite').textContent = kind === 'delete' ? 'Delete suite' : 'Save suite';
  syncSuiteActions(); $(kind === 'delete' ? 'cancel-suite' : 'suite-name').focus();
}
async function saveSuite() {
  const draft = suiteDraft;
  if (!draft || savingSuite || savingEvaluation || draft.session !== session) return;
  const name = $('suite-name').value.trim();
  if (draft.kind !== 'delete' && (!name || name.length > 140)) {
    $('suite-error').textContent = 'Enter a suite name from 1 to 140 characters.'; $('suite-name').focus(); return;
  }
  savingSuite = true; setSavingEvaluation(false); $('suite-error').textContent = '';
  let saved = false;
  try {
    const record = await api('/api/suites' + (draft.kind === 'create' ? '' : '/' + draft.record.id), {
      method: draft.kind === 'create' ? 'POST' : draft.kind === 'rename' ? 'PUT' : 'DELETE',
      ...(draft.kind === 'delete' ? {} : { body: JSON.stringify({ name, ...(draft.kind === 'rename' ? { revision: draft.record.revision } : {}) }) }),
    });
    saved = true;
    if (draft.session !== session) return;
    if (draft.kind === 'delete') suites = suites.filter(s => s.id !== draft.record.id);
    else suites = [record, ...suites.filter(s => s.id !== record.id)];
    renderSuites(); $('evaluation-suite').value = draft.kind === 'delete' ? '' : record.id;
    closeSuiteEditor(false); await loadLibrary();
    toast(draft.kind === 'delete' ? 'Suite deleted.' : 'Suite saved.');
  } catch (e) {
    if (draft.session === session) {
      if (saved) $('form-error').textContent = 'Suite saved, but the library could not refresh. Reload the page.';
      else $('suite-error').textContent = e.message + (e.status === 409 && draft.kind === 'rename' ? ' Cancel and retry to load the latest suite.' : '');
      if (!saved && e.status === 409) { try { await loadLibrary(); } catch {} }
    }
  } finally {
    if (draft.session === session) {
      savingSuite = false; setSavingEvaluation(false);
      if (saved) $('suite-actions').focus();
    }
  }
}
function inlineNameMarkup() {
  const draft = inlineName;
  return '<div class="inline-eval-name"><input id="duplicate-name" aria-label="Duplicated evaluation name" aria-describedby="duplicate-name-error" maxlength="140" required value="' + escape(draft.text) + '"' + (draft.pending ? ' disabled' : '') + (draft.error ? ' aria-invalid="true"' : '') + '><button type="button" class="icon-button" data-save-duplicate-name aria-label="Save evaluation name" title="Save name"' + (draft.pending ? ' disabled' : '') + '><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg></button></div><p id="duplicate-name-error" class="inline-name-error" role="alert">' + escape(draft.error || '') + '</p>';
}
function finishInlineName(draft, focus = false) {
  if (inlineName !== draft) return;
  inlineName = null; renderLibrary();
  if (focus) [...document.querySelectorAll('#evaluation-rows .eval-name')].find(button => button.dataset.inspect === draft.record.id)?.focus();
}
async function saveDuplicateName(focus = false) {
  const draft = inlineName;
  if (!draft) return true;
  if (draft.pending) return draft.pending;
  const name = draft.text.trim();
  if (!name || name.length > 140) {
    draft.error = 'Enter a name from 1 to 140 characters.'; renderLibrary();
    if (focus) $('duplicate-name')?.focus(); return false;
  }
  if (name === draft.record.name) { finishInlineName(draft, focus); return true; }
  const requestSession = session;
  draft.pending = (async () => {
    try {
      const saved = await api('/api/evaluations/' + draft.record.id, { method: 'PATCH', body: JSON.stringify({ name, revision: draft.record.revision || 1 }) });
      if (requestSession !== session || inlineName !== draft) return false;
      libraryRequest++; evaluations = evaluations.map(e => e.id === saved.id ? { ...saved, latest: null } : e);
      finishInlineName(draft, focus); return true;
    } catch (e) {
      if (requestSession === session && inlineName === draft) {
        draft.error = e.message + (e.status === 409 ? ' Press Escape to keep the saved name, then reopen the evaluation for the latest version.' : ' Your name is preserved; retry saving.');
      }
      return false;
    } finally {
      draft.pending = null;
      if (requestSession === session && inlineName === draft) { renderLibrary(); if (focus) $('duplicate-name')?.focus(); }
    }
  })();
  const input = $('duplicate-name');
  if (input) { input.disabled = true; input.parentElement.querySelector('button').disabled = true; }
  return draft.pending;
}
async function duplicateEvaluation(id) {
  if (savingEvaluation || duplicatingEvaluation) return;
  duplicatingEvaluation = true;
  const requestSession = session; error('');
  document.querySelectorAll('[data-duplicate-evaluation]').forEach(button => { button.disabled = true; });
  try {
    if (!await saveDuplicateName()) return;
    const original = evaluations.find(e => e.id === id);
    const copy = await api('/api/evaluations/' + id + '/duplicate', { method: 'POST', body: JSON.stringify(original ? { name: original.name.slice(0, 133) + ' (copy)' } : {}) });
    libraryRequest++; evaluations = [{ ...copy, latest: null }, ...evaluations];
    inlineName = { record: copy, text: copy.name, error: '', pending: null };
    renderLibrary(); $('duplicate-name').focus(); $('duplicate-name').select();
    toast('Duplicate created. Rename it here, then open it to edit.');
  } catch (e) { if (requestSession === session) error(e.message); }
  finally {
    if (requestSession === session) {
      duplicatingEvaluation = false;
      document.querySelectorAll('[data-duplicate-evaluation]').forEach(button => { button.disabled = false; });
    }
  }
}
function askDeleteLibrary(kind, record) {
  if (!record || deletingLibrary || savingEvaluation) return;
  libraryDeleteTarget = { kind, record, session };
  $('delete-library-title').textContent = kind === 'suite' ? 'Delete suite?' : 'Delete evaluation?';
  $('delete-library-name').textContent = record.name;
  $('delete-library-description').textContent = kind === 'suite' ? 'Only this empty suite is removed; all runs remain saved.' : 'This definition will be permanently removed. Previous runs keep their inputs, outputs, and results. Used model calls are not restored.';
  $('delete-library-error').textContent = ''; $('confirm-delete-library').textContent = kind === 'suite' ? 'Delete suite' : 'Delete evaluation';
  $('delete-library-dialog').showModal(); lockBody(); $('cancel-delete-library').focus();
}
async function deleteLibrary(event) {
  event.preventDefault(); const target = libraryDeleteTarget;
  if (!target || target.session !== session || deletingLibrary) return;
  deletingLibrary = true; $('confirm-delete-library').disabled = true; $('cancel-delete-library').disabled = true; $('delete-library-error').textContent = '';
  let deleted = false;
  try {
    await api('/api/' + (target.kind === 'suite' ? 'suites' : 'evaluations') + '/' + target.record.id, { method: 'DELETE' });
    deleted = true; $('delete-library-dialog').close();
    if (target.kind === 'evaluation' && editing?.id === target.record.id) $('evaluation-dialog').close();
    await loadLibrary(); toast(target.kind === 'suite' ? 'Suite deleted.' : 'Evaluation deleted. Previous runs are unchanged.');
  } catch (e) { if (target.session === session) { if (deleted) error('Deleted. Reload to refresh the library.'); else $('delete-library-error').textContent = e.message; } }
  finally { if (target.session === session) { deletingLibrary = false; $('confirm-delete-library').disabled = false; $('cancel-delete-library').disabled = false; } }
}
async function reviewWorkspace() {
  closeLibraryActions(true);
  const requestSession = session;
  $('clear-workspace-button').disabled = true;
  try {
    const summary = await api('/api/workspace');
    workspaceReview = { ...summary, session };
    $('clear-workspace-summary').textContent = `${summary.suites.length} suites, ${summary.evaluationCount} evaluations (${summary.unfiledCount} unfiled), and ${summary.runCount} runs will be removed, including items hidden by filters.`;
    $('clear-workspace-suites').replaceChildren(...summary.suites.map(suite => {
      const item = document.createElement('li'); item.textContent = `${suite.name} — ${suite.evaluationCount} evaluations`; return item;
    }));
    $('clear-workspace-error').textContent = summary.activeRunCount ? 'Wait for active runs to finish, then reopen this dialog.' : '';
    $('confirm-clear-workspace').disabled = !!summary.activeRunCount || !(summary.suites.length || summary.evaluationCount || summary.runCount);
    $('cancel-clear-workspace').disabled = false;
    $('clear-workspace-dialog').showModal(); lockBody(); $('cancel-clear-workspace').focus();
  } catch (e) { if (requestSession === session) error(e.message); }
  finally { $('clear-workspace-button').disabled = false; }
}
async function clearWorkspace(event) {
  event.preventDefault(); const review = workspaceReview;
  if (!review || review.session !== session || clearingWorkspace || $('confirm-clear-workspace').disabled) return;
  clearingWorkspace = true; $('confirm-clear-workspace').disabled = true; $('cancel-clear-workspace').disabled = true;
  $('clear-workspace-error').textContent = '';
  try {
    await api('/api/workspace', { method: 'DELETE', body: JSON.stringify({ revision: review.revision }) });
    clearTimeout(polling); runViewRevision++; libraryRequest++; runsRequest++;
    currentRun = null; lastRunJson = null; evaluations = []; suites = []; runs = []; lastRunRows = null; inlineName = null; editing = null;
    closeRunDraft(); runDetail.reset(); $('run-detail').replaceChildren();
    for (const id of ['search', 'filter-suite', 'filter-type', 'filter-method', 'run-search', 'run-status', 'run-model']) $(id).value = '';
    renderSuites(); renderLibrary(); renderRunList(); $('runs-count').textContent = '0';
    $('clear-workspace-dialog').close(); toast('Workspace cleared. You can load the workshop templates again.');
  } catch (e) { if (review.session === session) $('clear-workspace-error').textContent = e.message; }
  finally { if (review.session === session) { clearingWorkspace = false; $('cancel-clear-workspace').disabled = false; $('confirm-clear-workspace').disabled = false; } }
}
async function loadWorkshop(basic = false) {
  if ($('workshop-button').disabled) return;
  const requestSession = session; $('workshop-button').disabled = true; $('basic-workshop-button').disabled = true; error('');
  try {
    const imported = await api(basic ? '/api/basic-workshop-suite' : '/api/workshop-suite', { method: 'POST', body: '{}' });
    await loadLibrary(); $('filter-suite').value = imported.suites?.length > 1 ? '' : imported.suite.id; renderSuites(); renderLibrary();
    toast('Workshop templates ready. Open Runs and choose Create Run to generate and evaluate with TestCraft.');
  } catch (e) { if (requestSession === session) error(e.message); }
  finally { $('workshop-button').disabled = false; $('basic-workshop-button').disabled = false; }
}
function closeRunDraft() {
  runDraftRevision++; catalogRequest++; runSelection.clear(); runCatalog = null; runCatalogs.clear(); catalogLoads.clear(); creatingRun = false;
  $('create-run-dialog').close();
}
function selectedNeedsGrader() {
  return runEvaluations.some(e => runSelection.has(e.id) && criterionObjects(e).some(c => isModelMethod(c.method)));
}
function visibleRunEvaluations() {
  const query = $('create-eval-search').value.trim().toLowerCase(), suite = $('create-eval-suite').value, type = $('create-eval-type').value, method = $('create-eval-method').value;
  return runEvaluations.filter(e => (!query || ((e.reference || '') + ' ' + e.id + ' ' + e.name).toLowerCase().includes(query))
    && (!suite || (suite === '__unfiled' ? !e.suiteId : e.suiteId === suite))
    && (!type || endpoint(e) === type)
    && (!method || evaluationFamily(e) === method)).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}
const selectedGenerationModels = () => [...$('generation-model-options').querySelectorAll('input:checked')].map(input => input.value);
function positionGenerationModels() {
  const bounds = $('generation-model-toggle').getBoundingClientRect(), options = $('generation-model-options');
  const below = innerHeight - bounds.bottom - 12, above = bounds.top - 12, openAbove = below < 180 && above > below;
  const width = Math.min(bounds.width, document.documentElement.clientWidth - 32);
  options.style.width = width + 'px';
  options.style.left = Math.max(16, Math.min(bounds.left, document.documentElement.clientWidth - width - 16)) + 'px';
  options.style.top = openAbove ? 'auto' : bounds.bottom + 4 + 'px';
  options.style.bottom = openAbove ? innerHeight - bounds.top + 4 + 'px' : 'auto';
  options.style.maxHeight = Math.max(80, Math.min(240, openAbove ? above : below)) + 'px';
}
function updateRunSubmit() {
  const needsGrader = selectedNeedsGrader();
  const modelCount = selectedGenerationModels().length, combinations = runSelection.size * modelCount;
  $('create-grader-model').disabled = creatingRun || runModelsLoading;
  $('create-grader-model').required = needsGrader;
  $('create-generation-models').disabled = creatingRun || runModelsLoading;
  if (creatingRun || runModelsLoading) $('generation-model-options').hidePopover();
  const modelLabels = [...$('generation-model-options').querySelectorAll('input:checked')].map(input => input.parentElement.textContent.trim());
  $('generation-model-selection').textContent = modelCount > 1 ? modelCount + ' models selected' : modelLabels[0] || 'Select models';
  $('generation-model-toggle').title = modelLabels.join(', ');
  $('submit-create-run').disabled = creatingRun || runModelsLoading || !runCatalog?.models.length || !runSelection.size || runSelection.size > 50 || !modelCount || combinations > 100 || (needsGrader && !$('create-grader-model').value);
  $('submit-create-run').textContent = creatingRun ? 'Creating…' : 'Create Run';
  $('create-selected-count').textContent = runSelection.size + ' selected · maximum 50';
  $('create-combination-count').textContent = runSelection.size + ' evals × ' + modelCount + ' models = ' + combinations + ' results · maximum 100';
}
function renderRunEvaluations() {
  const visible = visibleRunEvaluations(), focusedId = document.activeElement?.dataset.runSelect;
  $('create-eval-rows').innerHTML = visible.map(e => '<tr><td><input type="checkbox" data-run-select="' + escape(e.id) + '" aria-label="Select ' + escape(e.name) + '"' + (runSelection.has(e.id) ? ' checked' : '') + (creatingRun || (!runSelection.has(e.id) && runSelection.size >= 50) ? ' disabled' : '') + '></td><td class="evaluation-id">' + escape(e.reference || '—') + '</td><td>' + escape(e.name) + '</td><td>' + escape(runSuites.find(s => s.id === e.suiteId)?.name || 'None') + '</td><td>' + escape(names[endpoint(e)]) + '</td><td>' + escape(evaluationMethod(e)) + '</td></tr>').join('');
  $('create-eval-rows').querySelectorAll('td:not(:first-child)').forEach(cell => { cell.title = cell.textContent; });
  $('create-select-all').checked = !!visible.length && visible.every(e => runSelection.has(e.id));
  $('create-select-all').indeterminate = visible.some(e => runSelection.has(e.id)) && !$('create-select-all').checked;
  $('create-select-all').disabled = creatingRun || !visible.length;
  $('create-eval-empty').hidden = !!visible.length;
  $('create-eval-empty').textContent = runEvaluations.length ? 'No evaluations match these filters.' : 'No evaluations yet. Add an evaluation in Evaluations first.';
  if (focusedId) [...$('create-eval-rows').querySelectorAll('[data-run-select]')].find(input => input.dataset.runSelect === focusedId)?.focus({ preventScroll: true });
  updateRunSubmit();
}
function requestRunCatalog(environment, force = false) {
  if (!force && runCatalogs.has(environment)) return Promise.resolve(runCatalogs.get(environment));
  if (catalogLoads.has(environment)) return catalogLoads.get(environment);
  const workspace = session;
  const pending = (async () => {
    let catalog;
    try { catalog = await api('/api/models?environment=' + encodeURIComponent(environment)); }
    catch {
      const cached = runCatalogs.get(environment);
      catalog = { ...(cached || { models: [] }), warning: 'Could not load models. ' + (cached?.models.length ? 'Showing the last catalog for this environment.' : 'Retry loading models before creating a run.') };
    }
    if (workspace === session) runCatalogs.set(environment, catalog);
    return catalog;
  })().finally(() => { if (workspace === session) catalogLoads.delete(environment); });
  catalogLoads.set(environment, pending);
  return pending;
}
async function loadRunModels(useDefaults = false, force = false) {
  $('generation-model-options').hidePopover();
  const request = ++catalogRequest, draft = runDraftRevision, workspace = session, environment = $('create-environment').value;
  const generation = selectedGenerationModels(), grader = $('create-grader-model').value;
  runModelsLoading = force || !runCatalogs.has(environment); runCatalog = null; updateRunSubmit();
  $('run-models-status').hidden = true; $('retry-run-models').hidden = true;
  const catalog = !force && runCatalogs.has(environment) ? runCatalogs.get(environment) : await requestRunCatalog(environment, force);
  if (request !== catalogRequest || draft !== runDraftRevision || workspace !== session) return;
  runCatalog = catalog; runModelsLoading = false;
  $('create-grader-model').innerHTML = '<option value="">Select a model</option>' + catalog.models.map(m => '<option value="' + escape(m.id) + '">' + escape(m.label) + '</option>').join('');
  const luna = ['gpt-6-luna', 'gpt-5.6-luna'].find(id => catalog.models.some(m => m.id === id));
  const desiredGeneration = generation.length ? generation : useDefaults ? runModelDefaults.generationModels || (luna ? [luna] : []) : [];
  $('generation-model-options').innerHTML = catalog.models.length ? catalog.models.map(m => '<label class="model-option"><input type="checkbox" value="' + escape(m.id) + '"' + (desiredGeneration.includes(m.id) ? ' checked' : '') + '><span>' + escape(m.label) + '</span></label>').join('') : '<span class="muted">No models available</span>';
  const desired = grader || (useDefaults ? runModelDefaults.graderModel || luna || config.judgeModel : '');
  $('create-grader-model').value = catalog.models.some(m => m.id === desired) ? desired : '';
  $('run-models-status').hidden = !catalog.warning;
  $('run-models-status').textContent = catalog.warning || '';
  $('retry-run-models').hidden = !catalog.warning; updateRunSubmit();
}
async function openCreateRun(sourceRun = null) {
  if (!session || !config || creatingRun) return;
  const draft = ++runDraftRevision;
  runEvaluations = []; runSuites = [];
  runSourceWorkspace = sourceRun?.sourceWorkspace?.alias || activeWorkspace;
  $('run-key-field').hidden = session.user.role === 'admin';
  $('run-api-key').value = personalKey;
  $('run-destination').textContent = 'Evaluations from ' + (runSourceWorkspace === 'main' ? 'TestCraft' : 'My workspace') + '. Results saved in ' + (session.user.role !== 'admin' || runSourceWorkspace === 'personal' ? 'My workspace (private)' : 'TestCraft (visible to everyone)') + '. ' + (session.user.role === 'admin' ? 'Uses server credentials.' : 'Uses your OpenAI key.');
  runSelection.clear(); runCatalog = null; $('create-run-form').reset(); $('run-api-key').value = personalKey; $('create-run-error').textContent = '';
  $('generation-model-options').hidePopover();
  $('generation-model-options').replaceChildren();
  runModelDefaults = { generationModels: sourceRun?.settings?.generationModels || (sourceRun?.settings?.generationModel ? [sourceRun.settings.generationModel] : undefined), graderModel: sourceRun?.settings?.graderModel };
  $('create-environment').innerHTML = config.environments.map(e => '<option value="' + e.id + '"' + (e.enabled ? '' : ' disabled') + '>' + escape(e.label) + '</option>').join('');
  const environment = sourceRun?.settings?.environment || 'dev';
  $('create-environment').value = config.environments.some(e => e.id === environment && e.enabled) ? environment : '';
  $('run-description').value = sourceRun?.description || '';
  $('create-eval-method').innerHTML = '<option value="">All methods</option>' + Object.entries({ rule_based: 'Rule-based', model_based: 'Model-graded', hybrid: 'Hybrid' }).map(([id, label]) => '<option value="' + id + '">' + label + '</option>').join('');
  setCreatingRun(false); $('create-run-dialog').showModal(); lockBody(); renderRunEvaluations(); $('create-environment').focus();
  if ($('create-environment').value) void loadRunModels(true);
  try {
    const sourceAlias = runSourceWorkspace;
    const [sourceEvaluations, sourceSuites] = await Promise.all([api(resourcePath('/api/evaluations', sourceAlias)), api(resourcePath('/api/suites', sourceAlias))]);
    if (draft !== runDraftRevision) return;
    runEvaluations = sourceEvaluations.evaluations; runSuites = sourceSuites.suites;
    $('create-eval-suite').innerHTML = '<option value="">All suites</option><option value="__unfiled">None</option>' + runSuites.map(s => '<option value="' + escape(s.id) + '">' + escape(s.name) + '</option>').join('');
    if (draft !== runDraftRevision) return;
    if (sourceRun) {
      const ids = new Set(sourceRun.items.map(item => item.evaluationId || item.evaluation?.id).filter(Boolean));
      runSelection = new Set([...ids].filter(id => runEvaluations.some(e => e.id === id)).slice(0, 50));
      $('create-run-error').textContent = runSelection.size < ids.size ? 'Some evaluations are no longer available or exceed the 50-evaluation limit. Review the selection before creating the run.' : '';
    }
    renderRunEvaluations();
  }
  catch (e) { if (draft === runDraftRevision) $('create-run-error').textContent = e.message; }
}
async function rerun(id) {
  const workspace = session, draft = runDraftRevision, request = ++rerunRequest, route = routeHash();
  error('');
  try {
    const run = await api('/api/runs/' + encodeURIComponent(id));
    if (workspace !== session || draft !== runDraftRevision || request !== rerunRequest || route !== routeHash()) return;
    await openCreateRun(run);
  } catch (e) { if (workspace === session && draft === runDraftRevision && request === rerunRequest && route === routeHash()) error(e.message); }
}
function setCreatingRun(busy) {
  creatingRun = busy;
  ['run-description', 'create-environment', 'create-eval-search', 'create-eval-suite', 'create-eval-type', 'create-eval-method', 'cancel-create-run', 'close-create-run', 'retry-run-models'].forEach(id => { $(id).disabled = busy; });
  renderRunEvaluations();
}
async function submitRun(event) {
  event.preventDefault();
  if ($('submit-create-run').disabled || !$('create-run-form').reportValidity()) return;
  const workspace = session, draft = runDraftRevision;
  const body = { evaluationIds: [...runSelection], description: $('run-description').value, environment: $('create-environment').value, generationModels: selectedGenerationModels(), graderModel: selectedNeedsGrader() ? $('create-grader-model').value : '' };
  setCreatingRun(true); $('create-run-error').textContent = '';
  try {
    if (session.user.role !== 'admin') { updateKey($('run-api-key').value.trim()); body.openAiApiKey = personalKey; }
    const run = await api(resourcePath('/api/runs', runSourceWorkspace), { method: 'POST', body: JSON.stringify(body) });
    if (workspace !== session || draft !== runDraftRevision) return;
    setCreatingRun(false); $('create-run-dialog').close(); location.hash = (run.resultWorkspace?.alias || activeWorkspace) + '/runs/' + run.id;
    toast('Run created. Generation and grading continue in the backend.');
  } catch (e) {
    if (workspace === session && draft === runDraftRevision) $('create-run-error').textContent = e.message;
  } finally { if (workspace === session && draft === runDraftRevision) setCreatingRun(false); }
}
function runName(run) {
  const d = new Date(run.createdAt), pad = n => String(n).padStart(2, '0');
  return 'Run · ' + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}
const runStatus = run => activeStatuses.includes(run.status) ? 'In progress' : run.status === 'completed' ? 'Complete' : names[run.status] || run.status;
function visibleRuns() {
  const query = $('run-search').value.trim().toLowerCase(), status = $('run-status').value, model = $('run-model').value;
  const value = run => runSort === 'name' ? runName(run) : runSort === 'models' ? run.models.join(', ') : runSort === 'status' ? runStatus(run) : run[runSort];
  return runs.filter(run => (!query || (runName(run) + ' ' + run.id).toLowerCase().includes(query))
    && (!status || (status === 'active' ? activeStatuses.includes(run.status) : run.status === status))
    && (!model || run.models.includes(model))).sort((a, b) => {
    if (runSort === 'score' && (a.score === null || b.score === null)) return a.score === b.score ? a.id.localeCompare(b.id) : a.score === null ? 1 : -1;
    const av = value(a), bv = value(b);
    return (typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv))) * runSortDirection || a.id.localeCompare(b.id);
  });
}
function renderRunList() {
  const model = $('run-model').value, models = [...new Set(runs.flatMap(run => run.models))].sort();
  if (model && !models.includes(model)) models.push(model);
  const options = '<option value="">All models</option>' + models.map(m => '<option value="' + escape(m) + '">' + escape(m) + '</option>').join('');
  if ($('run-model').innerHTML !== options) { $('run-model').innerHTML = options; $('run-model').value = model; }
  const visible = visibleRuns(), focused = document.activeElement;
  const focusId = $('run-list').contains(focused) ? focused.closest('[data-run-row]')?.dataset.runRow : null;
  const focusAction = focused?.hasAttribute('data-delete-run') ? '[data-delete-run]' : focused?.hasAttribute('data-rerun') ? '[data-rerun]' : 'a';
  const rows = visible.map(run => '<tr data-run-row="' + escape(run.id) + '"><td><a class="eval-name" data-run-link="' + escape(run.id) + '" href="#' + activeWorkspace + '/runs/' + escape(run.id) + '">' + escape(runName(run)) + '</a></td>'
    + '<td><time datetime="' + escape(run.createdAt) + '">' + escape(new Date(run.createdAt).toLocaleString()) + '</time></td>'
    + '<td>' + (run.models.length ? run.models.map(escape).join('<br>') : '—') + '</td><td>' + run.total + '</td>'
    + '<td><span class="badge ' + escape(run.status) + '">' + escape(runStatus(run)) + '</span>' + (run.errors ? '<span class="row-meta">' + run.errors + ' error' + (run.errors === 1 ? '' : 's') + '</span>' : '') + '</td>'
    + '<td class="score">' + scoreMarkup(run.score) + (run.scoredCount < run.total ? '<span class="row-meta">' + run.scoredCount + ' of ' + run.total + ' scored</span>' : '') + '</td>'
    + '<td><div class="row-actions"><button class="text-button run-action" data-rerun="' + escape(run.id) + '" title="Rerun" aria-label="Rerun ' + escape(runName(run)) + '"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3 10a9 9 0 1 1 2 8M3 4v6h6"/></svg></button><button class="text-button danger run-delete" data-delete-run="' + escape(run.id) + '" aria-label="Delete ' + escape(runName(run)) + '"' + (run.canDelete ? '' : ' disabled title="Wait for this run to finish before deleting it."') + '><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></svg></button></div></td></tr>').join('');
  const changed = rows !== lastRunRows;
  if (changed) { $('run-list').innerHTML = rows; lastRunRows = rows; }
  if (changed && focusId) {
    const row = [...$('run-list').rows].find(row => row.dataset.runRow === focusId);
    (row?.querySelector(focusAction) || $('runs-title')).focus();
  }
  document.querySelectorAll('[data-run-sort]').forEach(button => button.parentElement.setAttribute('aria-sort', button.dataset.runSort === runSort ? (runSortDirection === 1 ? 'ascending' : 'descending') : 'none'));
  $('empty-runs').hidden = visible.length > 0;
  $('empty-runs').querySelector('h3').textContent = runs.length ? 'No runs match these filters.' : 'Your runs will appear here.';
  $('empty-runs').querySelector('p').textContent = runs.length ? 'Try another search or change the filters.' : 'Create a run to generate outputs and evaluate your saved evaluations.';
  $('filtered-runs-count').textContent = visible.length + ' of ' + runs.length + ' runs';
}
function renderRunDetail() {
  runDetail.render(currentRun);
}
function askDeleteRun(id) {
  const run = currentRun?.id === id ? currentRun : runs.find(run => run.id === id);
  if (!session || !run || !canDeleteRun(run) || deletingRun) return;
  deleteTarget = { id, session };
  $('delete-run-summary').textContent = runName(run) + ' · ' + (run.total ?? run.items.length) + ' evaluation snapshots';
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
  deletingRun = false; target.deleted = true; $('delete-run-dialog').close(); error('');
  const viewingDeleted = routeHash() === '#runs/' + target.id;
  if (viewingDeleted) {
    history.replaceState(null, '', '#' + activeWorkspace + '/runs'); runViewRevision++; clearTimeout(polling);
    $('runs-list-page').hidden = false; $('run-detail-page').hidden = true;
  }
  runDetail.forget(target.id);
  if (currentRun?.id === target.id) { currentRun = null; lastRunJson = null; renderRunDetail(); }
  // Invalidate older reads before refreshing so a stale response cannot restore the row.
  runsRequest++; libraryRequest++;
  runs = runs.filter(run => run.id !== target.id); $('runs-count').textContent = runs.length; renderRunList();
  evaluations = evaluations.map(evaluation => evaluation.latest?.runId === target.id ? { ...evaluation, latest: null } : evaluation); renderLibrary();
  toast(alreadyDeleted ? 'This run was already removed.' : 'Run deleted. Your evaluations are still saved.');
  try {
    await Promise.all([loadRuns(), loadLibrary()]);
    if (target.session === session && viewingDeleted && routeHash() === '#runs') { await route(); $('runs-title').focus(); }
    else if (target.session === session && routeHash() === '#runs') $('runs-title').focus();
  } catch {
    if (target.session === session) error('The run was removed, but the history could not refresh. Reload the page.');
  }
}
async function pollRun(id, revision = runViewRevision) {
  if (!session || revision !== runViewRevision || routeHash() !== '#runs/' + id) return;
  try {
    const run = await api('/api/runs/' + id);
    if (revision !== runViewRevision || routeHash() !== '#runs/' + id) return;
    pollFailures = 0; currentRun = run;
    const serialized = JSON.stringify(run);
    if (serialized !== lastRunJson) { lastRunJson = serialized; renderRunDetail(); await loadRuns(); }
    if (revision !== runViewRevision || routeHash() !== '#runs/' + id) return;
    if (activeStatuses.includes(run.status)) polling = setTimeout(() => pollRun(id, revision), 900);
    else { await loadLibrary(); }
  } catch (e) {
    if (!session || revision !== runViewRevision || routeHash() !== '#runs/' + id) return;
    if (e.status === 404) {
      currentRun = null; renderRunDetail();
      history.replaceState(null, '', '#' + activeWorkspace + '/runs'); toast('This run is no longer available.');
      $('runs-list-page').hidden = false; $('run-detail-page').hidden = true;
      try { await loadLibrary(); if (revision === runViewRevision) await route(); }
      catch (refreshError) { if (session && revision === runViewRevision) error(refreshError.message); }
      return;
    }
    error(e.message);
    if (++pollFailures < 3) polling = setTimeout(() => pollRun(id, revision), 1500);
  }
}
async function pollRunList(revision = runViewRevision) {
  if (!session || revision !== runViewRevision || routeHash() !== '#runs') return;
  try {
    await loadRuns();
    if (revision !== runViewRevision || routeHash() !== '#runs') return;
    pollFailures = 0;
    if (runs.some(run => activeStatuses.includes(run.status))) polling = setTimeout(() => pollRunList(revision), 900);
    else { await loadLibrary(); }
  } catch (e) {
    if (!session || revision !== runViewRevision || routeHash() !== '#runs') return;
    error(e.message);
    if (++pollFailures < 3) polling = setTimeout(() => pollRunList(revision), 1500);
  }
}
async function route() {
  const requested = location.hash.match(/^#(main|personal)\//)?.[1] || activeWorkspace;
  if (session && requested !== activeWorkspace) {
    if ((creatingRun || savingEvaluation || savingSuite || clearingWorkspace) || (hasDraft() && !confirm('Discard unsaved changes and switch workspaces?'))) {
      history.replaceState(null, '', acceptedHash); $('workspace-switcher').value = activeWorkspace; return;
    }
    acceptedHash = location.hash; await changeWorkspace(requested); return;
  }
  if (session && !/^#(?:main|personal)\//.test(location.hash)) history.replaceState(null, '', '#' + activeWorkspace + '/' + (routeHash().slice(1) || 'evaluations'));
  acceptedHash = location.hash;
  const revision = ++runViewRevision;
  clearTimeout(polling); runsRequest++; lastRunJson = null; pollFailures = 0;
  if (!session) return;
  const isRuns = routeHash().startsWith('#runs');
  $('evaluations-panel').hidden = isRuns; $('runs-panel').hidden = !isRuns;
  $('evaluations-tab').setAttribute('aria-selected', String(!isRuns)); $('runs-tab').setAttribute('aria-selected', String(isRuns));
  $('evaluations-tab').tabIndex = isRuns ? -1 : 0; $('runs-tab').tabIndex = isRuns ? 0 : -1;
  if (isRuns) {
    const id = routeHash().split('/')[1];
    $('runs-list-page').hidden = !!id; $('run-detail-page').hidden = !id;
    if (currentRun?.id !== id || !id) { currentRun = null; renderRunDetail(); }
    await loadRuns();
    if (revision !== runViewRevision) return;
    if (id) { await pollRun(id, revision); }
    else if (runs.some(run => activeStatuses.includes(run.status))) polling = setTimeout(() => pollRunList(revision), 900);
  } else await loadLibrary();
}
$('evaluation-form').addEventListener('submit', saveEvaluation);
['new-button','empty-create'].forEach(id => $(id).addEventListener('click', () => openForm()));
function closeLibraryActions(restoreFocus = false) {
  $('library-actions-menu').hidden = true;
  $('library-actions-toggle').setAttribute('aria-expanded', 'false');
  if (restoreFocus) $('library-actions-toggle').focus();
}
$('library-actions-toggle').addEventListener('click', () => {
  const open = $('library-actions-menu').hidden;
  $('library-actions-menu').hidden = !open;
  $('library-actions-toggle').setAttribute('aria-expanded', String(open));
});
document.addEventListener('click', event => {
  if (!event.target.closest('.library-actions')) closeLibraryActions();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !$('library-actions-menu').hidden) { event.preventDefault(); closeLibraryActions(true); }
});
document.querySelector('.library-actions').addEventListener('focusout', event => {
  if (!event.currentTarget.contains(event.relatedTarget)) closeLibraryActions();
});
$('example-button').addEventListener('click', () => { closeLibraryActions(); void personalLoader(() => openForm(true)).catch(e => error(e.message)); });
$('basic-workshop-button').addEventListener('click', () => { closeLibraryActions(true); void personalLoader(() => void loadWorkshop(true)).catch(e => error(e.message)); });
$('workshop-button').addEventListener('click', () => { closeLibraryActions(true); void personalLoader(() => void loadWorkshop()).catch(e => error(e.message)); });
$('clear-workspace-button').addEventListener('click', reviewWorkspace);
$('clear-workspace-form').addEventListener('submit', clearWorkspace);
$('cancel-clear-workspace').addEventListener('click', () => { if (!clearingWorkspace) $('clear-workspace-dialog').close(); });
$('clear-workspace-dialog').addEventListener('cancel', event => { if (clearingWorkspace) event.preventDefault(); });
$('clear-workspace-dialog').addEventListener('close', () => { workspaceReview = null; lockBody(); $('library-actions-toggle').focus(); });
$('delete-library-form').addEventListener('submit', deleteLibrary);
$('cancel-delete-library').addEventListener('click', () => { if (!deletingLibrary) $('delete-library-dialog').close(); });
$('delete-library-dialog').addEventListener('cancel', event => { if (deletingLibrary) event.preventDefault(); });
$('delete-library-dialog').addEventListener('close', lockBody);
$('delete-evaluation').addEventListener('click', () => askDeleteLibrary('evaluation', editing));
['close-dialog','cancel-dialog'].forEach(id => $(id).addEventListener('click', () => $('evaluation-dialog').close()));
$('evaluation-dialog').addEventListener('close', lockBody);
$('evaluation-dialog').addEventListener('cancel', event => { if (savingEvaluation) event.preventDefault(); });
$('delete-run-form').addEventListener('submit', deleteRun);
$('cancel-delete-run').addEventListener('click', () => { if (!deletingRun) $('delete-run-dialog').close(); });
$('delete-run-dialog').addEventListener('cancel', event => { if (deletingRun) event.preventDefault(); });
$('delete-run-dialog').addEventListener('close', () => {
  const target = deleteTarget; deleteTarget = null; lockBody();
  if (!target || target.deleted || target.session !== session) return;
  const container = routeHash() === '#runs' ? $('run-list') : $('run-detail');
  [...container.querySelectorAll('[data-delete-run]')].find(button => button.dataset.deleteRun === target.id)?.focus();
});
$('back-step').addEventListener('click', () => setStep(1));
$('suite-actions').addEventListener('click', () => {
  const open = $('suite-menu').hidden; $('suite-menu').hidden = !open;
  $('suite-actions').setAttribute('aria-expanded', String(open)); syncSuiteActions();
});
$('evaluation-suite').addEventListener('change', syncSuiteActions);
for (const kind of ['create', 'rename', 'delete']) $(kind + '-suite').addEventListener('click', () => openSuiteEditor(kind));
$('save-suite').addEventListener('click', saveSuite);
$('cancel-suite').addEventListener('click', () => closeSuiteEditor());
$('suite-control').addEventListener('keydown', event => {
  if (event.key === 'Escape' && (suiteDraft || !$('suite-menu').hidden)) {
    event.preventDefault(); event.stopPropagation();
    if (!savingSuite) closeSuiteEditor();
  }
  if (event.key === 'Enter' && event.target === $('suite-name')) { event.preventDefault(); void saveSuite(); }
});
document.addEventListener('click', event => { if (!$('suite-control').contains(event.target)) closeSuiteMenu(); });
$('evaluation-dialog').addEventListener('cancel', event => { if (savingSuite) event.preventDefault(); });
['type','method','criterion-rule'].forEach(id => $(id).addEventListener('change', syncForm));
$('add-criterion').addEventListener('click', addCriterion);
$('criterion-draft').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && draftMethod() !== 'exact_match') { event.preventDefault(); addCriterion(); }
});
$('criteria-list').addEventListener('input', event => {
  if (event.target.dataset.criterion !== undefined) {
    criteria[Number(event.target.dataset.criterion)].text = event.target.value;
    syncCriterionPreview(event.target);
  }
  if (event.target.dataset.criterionDescription !== undefined) criteria[Number(event.target.dataset.criterionDescription)].description = event.target.value;
});
$('criteria-list').addEventListener('focusout', event => {
  const field = event.target;
  if (field.dataset.criterion === undefined) return;
  // Focus can enter and leave between observer deliveries without a net resize.
  requestAnimationFrame(() => {
    if (field.isConnected) updateCriterionTooltip(field.parentElement.querySelector('.criterion-text-preview'));
  });
});
$('criteria-list').addEventListener('change', event => {
  const index = event.target.dataset.criterionMethod;
  if (index === undefined) return;
  const criterion = criteria[Number(index)], method = event.target.value;
  const others = criteria.filter((_, i) => i !== Number(index));
  const message = method === 'exact_match' && others.some(c => c.method === method) ? 'Use at most one Exact match criterion.'
    : others.some(c => c.method === method && c.text.trim() === criterion.text.trim()) ? 'This criterion is already in the list.' : '';
  if (message) { event.target.value = criterion.method; $('form-error').textContent = message; return; }
  criterion.method = method; $('form-error').textContent = ''; updateCriteriaState();
});
$('criteria-list').addEventListener('click', event => {
  const button = event.target.closest('[data-remove-criterion]');
  if (!button) return;
  const index = Number(button.dataset.removeCriterion); criteria.splice(index, 1); renderCriteria(); syncForm();
  ($('criterion-' + Math.min(index, criteria.length - 1)) || $('criterion-draft')).focus();
});
$('evaluation-rows').addEventListener('input', event => {
  if (event.target.id === 'duplicate-name' && inlineName) inlineName.text = event.target.value;
});
$('evaluation-rows').addEventListener('focusout', event => {
  // Table actions save the name in their click handler before using the row.
  // Replacing the row during pointer-down would discard that pending click.
  if (event.relatedTarget?.closest('[data-inspect], [data-delete-evaluation], [data-duplicate-evaluation]')) return;
  if (!renderingLibrary && event.target.id === 'duplicate-name' && !event.target.parentElement.contains(event.relatedTarget)) void saveDuplicateName();
});
$('evaluation-rows').addEventListener('click', event => {
  if (event.target.closest('[data-save-duplicate-name]')) void saveDuplicateName(true);
});
$('evaluation-rows').addEventListener('keydown', event => {
  if (event.target.id !== 'duplicate-name' || !inlineName) return;
  if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); void saveDuplicateName(true); }
  if (event.key === 'Escape' && !inlineName.pending) {
    event.preventDefault(); finishInlineName(inlineName, true);
    void loadLibrary().catch(e => error(e.message));
  }
});
$('evaluation-form').addEventListener('input', resizeTextareas);
new ResizeObserver(resizeTextareas).observe($('wizard-body'));
$('framework').addEventListener('change', () => setLanguages());
['search','filter-type','filter-method'].forEach(id => $(id).addEventListener(id === 'search' ? 'input' : 'change', renderLibrary));
$('filter-suite').addEventListener('change', () => { renderSuites(); renderLibrary(); });
document.addEventListener('click', async event => {
  const el = event.target.closest('button');
  if (!el) return;
  if (inlineName && (el.dataset.inspect || el.dataset.deleteEvaluation) && !await saveDuplicateName()) return;
  if (el.dataset.inspect) openForm(false, evaluations.find(e => e.id === el.dataset.inspect));
  if (el.dataset.duplicateEvaluation) void duplicateEvaluation(el.dataset.duplicateEvaluation);
  if (el.dataset.deleteEvaluation) askDeleteLibrary('evaluation', evaluations.find(e => e.id === el.dataset.deleteEvaluation));
  if (el.dataset.deleteRun) askDeleteRun(el.dataset.deleteRun);
  if (el.dataset.rerun) void rerun(el.dataset.rerun);
});
$('evaluations-tab').addEventListener('click', () => { navigate('evaluations'); });
$('create-run').addEventListener('click', () => openCreateRun());
$('create-run-form').addEventListener('submit', submitRun);
['cancel-create-run', 'close-create-run'].forEach(id => $(id).addEventListener('click', () => { if (!creatingRun) $('create-run-dialog').close(); }));
$('create-run-dialog').addEventListener('cancel', event => { if (creatingRun) event.preventDefault(); });
$('create-run-dialog').addEventListener('close', () => { $('generation-model-options').hidePopover(); runDraftRevision++; catalogRequest++; lockBody(); });
$('generation-model-options').addEventListener('beforetoggle', event => {
  $('generation-model-toggle').setAttribute('aria-expanded', String(event.newState === 'open'));
  if (event.newState === 'open') positionGenerationModels();
});
const repositionGenerationModels = () => { if ($('generation-model-options').matches(':popover-open')) positionGenerationModels(); };
window.addEventListener('resize', repositionGenerationModels);
document.querySelector('.create-run-body').addEventListener('scroll', repositionGenerationModels);
$('create-environment').addEventListener('change', () => loadRunModels());
$('retry-run-models').addEventListener('click', () => loadRunModels(true, true));
['create-generation-models', 'create-grader-model'].forEach(id => $(id).addEventListener('change', updateRunSubmit));
['create-eval-search', 'create-eval-suite', 'create-eval-type', 'create-eval-method'].forEach(id => $(id).addEventListener(id === 'create-eval-search' ? 'input' : 'change', renderRunEvaluations));
$('create-eval-rows').addEventListener('change', event => {
  const id = event.target.dataset.runSelect;
  if (!id || creatingRun) return;
  if (event.target.checked && runSelection.size < 50) runSelection.add(id); else runSelection.delete(id);
  renderRunEvaluations();
});
$('create-select-all').addEventListener('change', () => {
  const visible = visibleRunEvaluations();
  if ($('create-select-all').checked) {
    if (new Set([...runSelection, ...visible.map(e => e.id)]).size > 50) { $('create-run-error').textContent = 'Select at most 50 evaluations. Narrow the filters or select individual rows.'; renderRunEvaluations(); return; }
    visible.forEach(e => runSelection.add(e.id));
  } else visible.forEach(e => runSelection.delete(e.id));
  $('create-run-error').textContent = ''; renderRunEvaluations();
});
$('runs-tab').addEventListener('click', () => { navigate('runs'); });
document.querySelector('.tabs').addEventListener('keydown', event => {
  if (['ArrowRight','ArrowLeft','Home','End'].includes(event.key)) {
    event.preventDefault(); const target = event.key === 'Home' ? $('evaluations-tab') : event.key === 'End' ? $('runs-tab') : event.target === $('runs-tab') ? $('evaluations-tab') : $('runs-tab'); target.click(); target.focus();
  }
});
['run-search', 'run-status', 'run-model'].forEach(id => $(id).addEventListener(id === 'run-search' ? 'input' : 'change', renderRunList));
document.querySelectorAll('[data-eval-sort]').forEach(button => button.addEventListener('click', () => {
  const key = button.dataset.evalSort;
  evalSortDirection = evalSort === key ? -evalSortDirection : key === 'createdAt' ? -1 : 1;
  evalSort = key; renderLibrary();
}));
document.querySelectorAll('[data-run-sort]').forEach(button => button.addEventListener('click', () => {
  const key = button.dataset.runSort;
  runSortDirection = runSort === key ? -runSortDirection : ['createdAt', 'total', 'score'].includes(key) ? -1 : 1;
  runSort = key; renderRunList();
}));
$('run-list').addEventListener('click', event => {
  if (event.target.closest('a, button') || window.getSelection()?.toString()) return;
  const row = event.target.closest('[data-run-row]');
  if (row) navigate('runs/' + row.dataset.runRow);
});
window.addEventListener('hashchange', () => route().catch(e => error(e.message)));
async function openWorkspace() {
  config = await api('/api/config');
  if (config.version !== 10 || !config.evaluationMethods?.hybrid) throw new Error('This page needs the updated backend. Restart the local server or refresh after deployment.');
  $('connection').textContent = '● Backend connected';
  $('setup-notice').hidden = true; error('');
  if (!config.llmReady && session.user.role === 'admin') { $('setup-notice').hidden = false; $('setup-notice').textContent = 'LLM as a judge needs OPENAI_API_KEY in the backend. You can save evaluations and use TestCraft generation with Rule-based grading.'; }
  await Promise.all([loadLibrary(), loadRuns(), ...config.environments.filter(e => e.enabled).map(e => requestRunCatalog(e.id))]); await route();
  if (!session) return;
  $('session-status').hidden = true; $('workspace').hidden = false; $('user-menu').hidden = false;
  scheduleSessionCheck();
}
function inspectEvaluation(evaluation) {
  $('inspect-title').textContent = evaluation.name;
  $('inspect-content').replaceChildren();
  const fields = [['Evaluation', (evaluation.reference || '') + ' · TestCraft'], ['Suite', evaluationSuite(evaluation)], ['Endpoint', names[endpoint(evaluation)]], ['HTML', evaluation.html], ['Input', evaluation.input], ['Page URL', evaluation.pageUrl], ['Framework', evaluation.framework], ['Language', evaluation.language], ['Page object model', evaluation.type === 'code' ? (evaluation.pom ? 'Enabled' : 'Disabled') : ''], ['Ideas', evaluation.ideas], ['Criteria', criterionObjects(evaluation).map(c => c.method + ' (weight ' + (c.weight ?? 1) + '): ' + c.text + (c.description ? '\n' + c.description : '')).join('\n\n')]];
  for (const [label, value] of fields) {
    if (!value) continue;
    const heading = document.createElement('h3'), text = document.createElement('pre'); heading.textContent = label; text.textContent = value;
    $('inspect-content').append(heading, text);
  }
  $('inspect-evaluation').showModal(); lockBody();
}
function connectWorkspace() {
  if (sessionSetup) return sessionSetup;
  updateKey(''); showConnecting();
  sessionSetup = (async () => {
    try {
      const current = await api('/api/session');
      if (!current.authenticated) {
        $('session-message').textContent = 'Sign in to explore TestCraft and create evaluations in your personal workspace.';
        $('github-login').hidden = !current.loginAvailable;
        $('session-error').textContent = new URLSearchParams(location.search).has('login') ? 'GitHub login could not be completed. Please try again.' : current.loginAvailable ? '' : 'GitHub login is not configured. Contact the app administrator.';
        return;
      }
      session = current;
      const pendingRoute = sessionStorage.getItem('testcraft-login-route'); sessionStorage.removeItem('testcraft-login-route');
      if (pendingRoute !== null) accountChannel?.postMessage('changed');
      if (!location.hash && /^#(main|personal)\/(evaluations|runs(?:\/[a-z0-9-]+)?)$/.test(pendingRoute || '')) history.replaceState(null, '', pendingRoute);
      activeWorkspace = location.hash.match(/^#(main|personal)\//)?.[1] || (location.hash ? 'personal' : 'main');
      applyWorkspaceControls(); await openWorkspace();
    } catch (e) {
      showConnecting(); $('session-message').textContent = 'Could not open your workspace.';
      $('session-error').textContent = e.message; $('retry-session').hidden = false;
    } finally { sessionSetup = null; }
  })();
  return sessionSetup;
}
$('github-login').addEventListener('click', async () => {
  $('github-login').disabled = true;
  try {
    const result = await api('/api/auth/github/start', { method: 'POST', body: '{}' });
    sessionStorage.setItem('testcraft-login-route', location.hash);
    location.assign(result.authorizeUrl);
  } catch (e) { $('session-error').textContent = e.message; $('github-login').disabled = false; }
});
$('logout').addEventListener('click', async () => {
  closeUserMenu(true);
  if (hasDraft() && !confirm('Discard unsaved changes and sign out?')) return;
  try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); updateKey(''); accountChannel?.postMessage('changed'); await connectWorkspace(); }
  catch (e) { error(e.message); }
});
$('workspace-switcher').addEventListener('change', () => { location.hash = $('workspace-switcher').value + '/evaluations'; });
$('run-api-key').addEventListener('input', () => updateKey($('run-api-key').value));
function closeUserMenu(restoreFocus = false) {
  $('user-menu-panel').hidden = true; $('user-menu-toggle').setAttribute('aria-expanded', 'false');
  if (restoreFocus) $('user-menu-toggle').focus();
}
function openUserMenu() {
  closeLibraryActions(); $('user-menu-panel').hidden = false; $('user-menu-toggle').setAttribute('aria-expanded', 'true');
}
$('user-menu-toggle').addEventListener('click', () => $('user-menu-panel').hidden ? openUserMenu() : closeUserMenu());
$('user-menu-toggle').addEventListener('keydown', event => {
  if (event.key !== 'ArrowDown') return;
  event.preventDefault(); openUserMenu(); $('user-menu-panel').querySelector('button:not([hidden]), a').focus();
});
document.addEventListener('click', event => { if (!event.target.closest('#user-menu')) closeUserMenu(); });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !$('user-menu-panel').hidden) { event.preventDefault(); closeUserMenu(true); }
});
$('user-menu').addEventListener('focusout', event => { if (!event.currentTarget.contains(event.relatedTarget)) closeUserMenu(); });
$('extension-link').addEventListener('click', () => closeUserMenu(true));
$('open-api-key').addEventListener('click', () => {
  if (!session || session.user.role === 'admin') return;
  closeUserMenu(true); $('personal-api-key').value = personalKey; $('clear-api-key').disabled = !personalKey;
  $('api-key-dialog').showModal(); lockBody(); $('personal-api-key').focus();
});
$('api-key-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!session || session.user.role === 'admin') return;
  updateKey($('personal-api-key').value.trim()); $('api-key-dialog').close(); toast(personalKey ? 'API key saved for this tab.' : 'API key cleared.');
});
$('clear-api-key').addEventListener('click', () => { updateKey(''); $('api-key-dialog').close(); toast('API key cleared.'); });
['close-api-key', 'cancel-api-key'].forEach(id => $(id).addEventListener('click', () => $('api-key-dialog').close()));
$('api-key-dialog').addEventListener('close', () => { $('personal-api-key').value = ''; lockBody(); if (session) $('user-menu-toggle').focus(); });
$('close-inspect').addEventListener('click', () => $('inspect-evaluation').close());
$('inspect-evaluation').addEventListener('close', lockBody);
if (accountChannel) accountChannel.onmessage = () => { updateKey(''); void connectWorkspace(); };
window.addEventListener('focus', () => { if (session) void refreshSession().catch(e => error(e.message)); });
$('retry-session').addEventListener('click', connectWorkspace);
void connectWorkspace();
