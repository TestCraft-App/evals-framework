const $ = id => document.getElementById(id);
const names = { ideas: 'Generate ideas', code: 'Generate code', model_grade: 'LLM as a judge', exact_match: 'Exact match', contains: 'Contains', not_contains: 'Does not contain', pasted: 'Pasted output', testcraft_api: 'TestCraft v1', llm: 'LLM adapter', playwright: 'Playwright', cypress: 'Cypress', selenium: 'Selenium', typescript: 'TypeScript', javascript: 'JavaScript', python: 'Python', java: 'Java', csharp: 'C#', not_run: 'Not run', passed: 'Passed', failed: 'Failed', error: 'Error', queued: 'Queued', generating: 'Generating', grading: 'Grading', running: 'Running', completed: 'Completed', interrupted: 'Interrupted' };
names.hybrid = 'Hybrid';
const languages = { playwright: ['typescript','javascript','python','java','csharp'], cypress: ['typescript','javascript'], selenium: ['javascript','python','java','csharp'] };
const activeStatuses = ['queued','running','generating','grading'];
let config, evaluations = [], runs = [], currentRun, currentItemId, polling, lastRunJson, pollFailures = 0, toastTimer;
let formStep = 1, editing = null, savingEvaluation = false, criteria = [];
let suites = [], suiteEditing = null, savingSuite = false, libraryDeleteTarget = null, deletingLibrary = false;
let session = null, sessionTimer, sessionSetup;
let currentMethod = null, methodDrafts = new Map(), familyChoices = {};
let deleteTarget = null, deletingRun = false, runViewRevision = 0, runsRequest = 0, libraryRequest = 0;
let runSort = 'createdAt', runSortDirection = -1, lastRunRows = null;
let runSelection = new Set(), runCatalogs = new Map(), catalogLoads = new Map(), runCatalog = null, runModelsLoading = false, creatingRun = false, runDraftRevision = 0, catalogRequest = 0;
const canDeleteRun = run => typeof run.canDelete === 'boolean' ? run.canDelete : ['completed', 'interrupted'].includes(run.status) && run.items.every(item => ['passed', 'failed', 'error'].includes(item.status));
const familyLabel = method => config?.evaluationMethods?.[method]?.familyLabel || (method === 'model_grade' ? 'Model-based' : 'Rule-based');
const criterionObjects = evaluation => {
  const values = Array.isArray(evaluation.criteria) ? evaluation.criteria : evaluation.method === 'exact_match' ? [evaluation.expectedOutput || ''] : (['contains', 'not_contains'].includes(evaluation.method) ? evaluation.expectedOutput || '' : evaluation.criteria || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  return values.map(value => typeof value === 'string' ? { text: value, method: evaluation.method, weight: 1 } : { ...value, method: value.method || evaluation.method, weight: value.weight ?? 1 });
};
const formNeedsGrader = () => $('method').value === 'model_grade' || ($('method').value === 'hybrid' && criteria.some(c => c.method === 'model_grade'));
const scoreText = value => Number.isFinite(value) ? String(Math.round(value * 100) / 100) : '—';
function lockBody() { document.body.classList.toggle('modal-open', !!document.querySelector('dialog[open]')); }
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
  evaluations = []; runs = []; suites = []; editing = null; currentRun = null; currentItemId = null; criteria = [];
  methodDrafts.clear(); currentMethod = null; familyChoices = {};
  runViewRevision++; runsRequest++; libraryRequest++; deleteTarget = null; deletingRun = false; $('delete-run-dialog').close();
  closeRunDraft(); $('evaluation-dialog').close(); $('evaluation-form').reset(); $('criteria-list').replaceChildren();
  ['suite-dialog', 'delete-library-dialog'].forEach(id => $(id).close());
  suiteEditing = null; libraryDeleteTarget = null; savingEvaluation = false; savingSuite = false; deletingLibrary = false;
  $('filter-suite').value = ''; renderSuites();
  $('run-search').value = ''; $('run-status').value = ''; $('run-model').value = ''; runSort = 'createdAt'; runSortDirection = -1; lastRunRows = null;
  $('evaluation-rows').replaceChildren(); $('run-list').replaceChildren(); $('run-detail').replaceChildren(); $('toast').hidden = true;
  $('workspace').hidden = true; $('private-badge').hidden = true; $('session-status').hidden = false;
  $('session-message').textContent = 'Opening your private workspace…';
  $('session-error').textContent = ''; $('retry-session').hidden = true;
}
function renderSession() {
  const b = session.budget;
  $('model-allowance').textContent = `${b.remaining} / ${b.limit} calls left${b.reserved ? ` · ${b.reserved} reserved` : ''}`;
  $('model-allowance').title = 'Shared model-call allowance for the workshop, not a dollar limit.';
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
function visibleEvaluations() {
  const query = $('search').value.trim().toLowerCase();
  return evaluations.filter(e => {
    const status = e.latest?.status || 'not_run';
    return (!query || (e.name + ' ' + (e.input || '')).toLowerCase().includes(query))
      && (!$('filter-type').value || e.type === $('filter-type').value)
      && (!$('filter-suite').value || ($('filter-suite').value === '__unfiled' ? !e.suiteId : e.suiteId === $('filter-suite').value))
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
  $('evaluation-rows').innerHTML = visible.map(e => '<tr>'
    + '<td><button class="eval-name" data-inspect="' + e.id + '" title="Edit evaluation">' + escape(e.name) + '</button><div class="eval-id">' + escape(suites.find(s => s.id === e.suiteId)?.name || 'Unfiled') + ' · v' + (e.revision || 1) + '</div></td>'
    + '<td>' + badge(e.type) + '</td><td>' + (e.type === 'ideas' ? '<span class="muted">Not applicable</span>' : escape(names[e.framework]) + '<span class="row-meta">' + escape(names[e.language]) + '</span>') + '</td>'
    + '<td>' + escape(names[e.method]) + '<span class="row-meta">' + escape(familyLabel(e.method)) + '</span></td><td>' + escape(names[e.source]) + '</td><td>' + badge(e.latest?.status || 'not_run') + '</td>'
    + '<td class="score">' + (Number.isFinite(e.latest?.score) ? scoreText(e.latest.score) + '%' : '—') + '</td><td>' + escape(date(e.createdAt)) + '</td>'
    + '<td><div class="row-actions">' + (e.latest ? '<button class="text-button" data-run-link="' + e.latest.runId + '">View run ↗</button>' : '') + '<button class="text-button" data-inspect="' + e.id + '" aria-label="Edit ' + escape(e.name) + '">Edit</button><button class="text-button" data-duplicate-evaluation="' + e.id + '" aria-label="Duplicate ' + escape(e.name) + '">Duplicate</button><button class="text-button danger" data-delete-evaluation="' + e.id + '" aria-label="Delete ' + escape(e.name) + '">Delete</button></div></td></tr>').join('');
  $('empty-library').hidden = visible.length > 0;
  $('empty-library').querySelector('h3').textContent = evaluations.length ? 'No evaluations match these filters.' : 'Your first evaluation starts here.';
  $('filtered-count').textContent = visible.length + ' of ' + evaluations.length + ' evaluations';
}
function setLanguages(preferred = $('language').value) {
  $('language').innerHTML = languages[$('framework').value].map(value => '<option value="' + value + '">' + names[value] + '</option>').join('');
  if (languages[$('framework').value].includes(preferred)) $('language').value = preferred;
}
function selectMethod(method, preserveDraft = true) {
  const definition = config.evaluationMethods[method];
  if (!definition) return;
  const previous = currentMethod;
  if (preserveDraft && currentMethod) methodDrafts.set(currentMethod, { criteria: structuredClone(criteria), draft: $('criterion-draft').value });
  $('method-family').value = definition.family;
  $('method').innerHTML = Object.entries(config.evaluationMethods).filter(([, value]) => value.family === definition.family).map(([id, value]) => '<option value="' + escape(id) + '">' + escape(value.label) + '</option>').join('');
  $('method').value = method;
  familyChoices[definition.family] = method; currentMethod = method;
  if (preserveDraft) {
    const savedDraft = methodDrafts.get(method) || (method === 'hybrid' ? methodDrafts.get(previous) : null);
    criteria = structuredClone(savedDraft?.criteria || []); $('criterion-draft').value = savedDraft?.draft || '';
    if (method === 'hybrid' && previous && previous !== 'hybrid') $('criterion-method').value = previous;
  }
  renderCriteria(); syncForm();
}
function syncForm() {
  const source = 'testcraft_api', method = $('method').value, code = $('type').value === 'code';
  const definition = config?.evaluationMethods?.[method];
  const judge = formNeedsGrader();
  $('criterion-method-field').hidden = method !== 'hybrid';
  $('framework').disabled = !code; $('language').disabled = !code;
  $('pom').disabled = !code || source !== 'testcraft_api'; $('from-ideas').disabled = !code || source !== 'testcraft_api';
  $('page-url').required = source === 'testcraft_api' && code;
  const fromIdeas = !$('from-ideas').disabled && $('from-ideas').checked;
  $('ideas-field').hidden = !fromIdeas; $('ideas').required = fromIdeas; $('ideas').disabled = !fromIdeas;
  $('code-params-hint').hidden = code;
  $('source-hint').textContent = source === 'llm' ? 'Calls a separate backend prompt adapter. This is not the TestCraft v1 generation pipeline.'
    : code ? `Calls ${fromIdeas ? '/api/automate-tests-ideas' : '/api/automate-tests'} with the HTML and code parameters. Description is evaluator context.`
    : 'Calls /api/generate-ideas with the HTML. Description is evaluator context, not an extra instruction to TestCraft.';
  if (editing && editing.source !== 'testcraft_api') $('source-hint').textContent += ' New runs generate fresh output through TestCraft. Previous runs stay unchanged.';
  $('method-hint').textContent = definition?.description || '';
  $('method-limitation').textContent = definition?.limitation || '';
  $('grading-cost').textContent = judge ? 'Grading: 1 model call for all model criteria' + (!config?.llmReady ? ' · Model grader not configured' : '') : 'Grading: 0 model calls · Deterministic for the same output and criteria';
  $('criteria-hint').textContent = definition?.criteriaHint || '';
  $('criterion-draft').placeholder = (method === 'hybrid' ? config?.evaluationMethods?.[$('criterion-method').value] : definition)?.placeholder || '';
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
  $('save-evaluation').textContent = step === 1 ? 'Next →' : editing ? 'Save' : 'Create evaluation';
  $('save-as-new').hidden = step === 1 || !editing;
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
  const hybrid = $('method').value === 'hybrid', weighted = $('use-weights').checked;
  $('criteria-list').classList.toggle('weighted', weighted); $('criteria-list').classList.toggle('hybrid', hybrid);
  $('criteria-list').innerHTML = criteria.map((value, index) => '<li><span class="criterion-number" aria-hidden="true">' + (index + 1) + '</span><label class="sr-only" for="criterion-' + index + '">Criterion ' + (index + 1) + '</label><textarea id="criterion-' + index + '" data-criterion="' + index + '" rows="1" maxlength="8000" required>' + escape(value.text) + '</textarea>'
    + (hybrid ? '<label class="criterion-kind"><span class="sr-only">Method for criterion ' + (index + 1) + '</span><select data-criterion-method="' + index + '">' + ['model_grade', 'contains', 'not_contains', 'exact_match'].map(method => '<option value="' + method + '"' + (value.method === method ? ' selected' : '') + '>' + escape(names[method]) + '</option>').join('') + '</select></label>' : '')
    + (weighted ? '<label class="criterion-weight"><span class="sr-only">Weight for criterion ' + (index + 1) + '</span><input type="number" aria-label="Weight for criterion ' + (index + 1) + '" data-criterion-weight="' + index + '" min="0.01" max="100" step="0.01" required value="' + escape(value.weight) + '"></label>' : '')
    + '<button type="button" class="icon-button" data-remove-criterion="' + index + '" aria-label="Remove criterion ' + (index + 1) + '">×</button></li>').join('');
  $('score-formula').textContent = weighted ? 'Score = passed weight / total weight × 100. A larger weight gives that criterion more influence.' : 'Score = passed criteria / total criteria × 100. Every criterion returns Pass or Fail.';
  updateCriteriaState(); resizeTextareas();
}
function addCriterion() {
  const value = $('criterion-draft').value.trim();
  if (!value) { $('form-error').textContent = 'Write a criterion before adding it.'; $('criterion-draft').focus(); return false; }
  if (criteria.length >= ($('method').value === 'exact_match' ? 1 : 20)) { $('form-error').textContent = $('method').value === 'exact_match' ? 'Exact match uses exactly one criterion.' : 'Use at most 20 criteria.'; return false; }
  if (criteria.map(c => c.text).join('').length + value.length > 8000) { $('form-error').textContent = 'Keep all criteria within 8000 characters.'; return false; }
  const method = $('method').value === 'hybrid' ? $('criterion-method').value : $('method').value;
  if (criteria.some(c => c.method === method && c.text.trim() === value)) { $('form-error').textContent = 'This criterion is already in the list.'; return false; }
  criteria.push({ text: value, method, weight: 1 }); $('criterion-draft').value = ''; $('form-error').textContent = ''; renderCriteria(); syncForm();
  if (!$('criterion-draft').disabled) $('criterion-draft').focus();
  else $('criterion-' + (criteria.length - 1)).focus();
  return true;
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
  editing = existing ? structuredClone(existing) : null;
  $('dialog-title').textContent = existing ? 'Edit evaluation' : 'New evaluation';
  $('edit-version').hidden = !editing;
  $('edit-version').textContent = editing ? 'Version ' + (editing.revision || 1) + ' · Previous runs keep their original inputs and results.' : '';
  $('duplicate-evaluation').hidden = !editing; $('delete-evaluation').hidden = !editing;
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
    for (const key of ['name','type','input','html']) if (data[key] !== undefined) $(key).value = data[key];
    if (languages[data.framework]) $('framework').value = data.framework;
    setLanguages(data.language);
    if (data.pageUrl !== undefined) $('page-url').value = data.pageUrl;
    $('pom').checked = !!data.pom; $('from-ideas').checked = !!data.fromIdeas;
    $('ideas').value = data.ideas ?? (data.fromIdeas ? data.input : '') ?? '';
    criteria = criterionObjects(data);
    $('use-weights').checked = criteria.some(c => c.weight !== 1);
  }
  selectMethod(data?.method || 'model_grade', false); syncForm(); setStep(1, false);
  $('evaluation-dialog').showModal(); document.body.classList.add('modal-open'); resizeTextareas(); $('name').focus();
}
async function saveEvaluation(event) {
  event.preventDefault(); $('form-error').textContent = '';
  if (savingEvaluation) return;
  if (!validateStep(1)) return;
  if (formStep === 1) { setStep(2); return; }
  if ($('criterion-draft').value.trim() && !addCriterion()) return;
  if (!validateStep(2)) return;
  if (!criteria.length || ($('method').value === 'exact_match' && criteria.length !== 1)) {
    $('form-error').textContent = $('method').value === 'exact_match' ? 'Exact match needs exactly one criterion. Edit or remove the extra items.' : 'Add at least one evaluation criterion.';
    $('criterion-draft').focus(); return;
  }
  const target = editing, requestSession = session, asNew = event.submitter?.id === 'save-as-new';
  setSavingEvaluation(true);
  const payload = { ...Object.fromEntries(new FormData($('evaluation-form'))), source: 'testcraft_api' };
  payload.criteria = criteria.map(value => ({ text: value.text.trim(), method: value.method, weight: $('use-weights').checked ? value.weight : 1 }));
  payload.pom = !$('pom').disabled && $('pom').checked; payload.fromIdeas = !$('from-ideas').disabled && $('from-ideas').checked;
  if (target && !asNew) payload.revision = target.revision || 1;
  if (asNew && payload.name === target.name) payload.name = payload.name.slice(0, 133) + ' (copy)';
  let saved = false;
  try {
    await api('/api/evaluations' + (target && !asNew ? '/' + target.id : ''), { method: target && !asNew ? 'PUT' : 'POST', body: JSON.stringify(payload) });
    saved = true; $('evaluation-dialog').close(); await loadLibrary(); toast(target && !asNew ? 'Changes saved. Run this version to evaluate it.' : 'Evaluation saved. Open Runs to create a run.');
  } catch (e) { if (requestSession === session) { if (saved) error('Saved, but the library could not refresh. Reload the page.'); else $('form-error').textContent = e.status === 409 ? e.message + ' Your draft is preserved. Save as new, or reopen the evaluation to load its latest version.' : e.message; } }
  finally { if (requestSession === session) setSavingEvaluation(false); }
}
function setSavingEvaluation(busy) {
  savingEvaluation = busy;
  ['save-evaluation','save-as-new','duplicate-evaluation','delete-evaluation','close-dialog','cancel-dialog','back-step'].forEach(id => { $(id).disabled = busy; });
}
function renderSuites() {
  for (const [id, empty] of [['filter-suite', '<option value="">All evaluations</option><option value="__unfiled">Unfiled</option>'], ['evaluation-suite', '<option value="">Unfiled</option>']]) {
    const current = $(id).value;
    $(id).innerHTML = empty + suites.map(s => '<option value="' + escape(s.id) + '">' + escape(s.name) + '</option>').join('');
    if ([...$(id).options].some(o => o.value === current)) $(id).value = current;
  }
  const hasSuite = suites.some(s => s.id === $('filter-suite').value);
  $('rename-suite').disabled = !hasSuite; $('delete-suite').disabled = !hasSuite;
}
function openSuiteForm(existing = null) {
  suiteEditing = existing; $('suite-form').reset(); $('suite-error').textContent = '';
  $('suite-title').textContent = existing ? 'Rename suite' : 'New suite'; $('suite-name').value = existing?.name || '';
  $('suite-dialog').showModal(); lockBody(); $('suite-name').focus();
}
async function saveSuite(event) {
  event.preventDefault(); if (savingSuite || !$('suite-form').reportValidity()) return;
  const target = suiteEditing, requestSession = session;
  savingSuite = true; $('save-suite').disabled = true; $('cancel-suite').disabled = true; $('suite-error').textContent = '';
  let saved = false;
  try {
    const result = await api('/api/suites' + (target ? '/' + target.id : ''), { method: target ? 'PUT' : 'POST', body: JSON.stringify({ name: $('suite-name').value.trim(), ...(target ? { revision: target.revision || 1 } : {}) }) });
    saved = true; $('suite-dialog').close(); await loadLibrary(); $('filter-suite').value = result.id; renderSuites(); renderLibrary(); toast('Suite saved.');
  } catch (e) { if (requestSession === session) { if (saved) error('Suite saved. Reload to refresh the library.'); else $('suite-error').textContent = e.message; } }
  finally { if (requestSession === session) { savingSuite = false; $('save-suite').disabled = false; $('cancel-suite').disabled = false; } }
}
async function duplicateEvaluation(id) {
  if (savingEvaluation) return;
  const requestSession = session; setSavingEvaluation(true); error('');
  let copy;
  try {
    const original = evaluations.find(e => e.id === id);
    copy = await api('/api/evaluations/' + id + '/duplicate', { method: 'POST', body: JSON.stringify(original ? { name: original.name.slice(0, 133) + ' (copy)' } : {}) });
    await loadLibrary();
    $('evaluation-dialog').close(); openForm(false, copy); toast('Duplicate created. Edit it to make a variant.');
  } catch (e) { if (requestSession === session) error(copy ? 'Duplicate saved, but the library could not refresh. Reload the page.' : e.message); }
  finally { if (requestSession === session) setSavingEvaluation(false); }
}
function askDeleteLibrary(kind, record) {
  if (!record || deletingLibrary || savingEvaluation) return;
  libraryDeleteTarget = { kind, record, session };
  $('delete-library-title').textContent = kind === 'suite' ? 'Delete suite?' : 'Delete evaluation?';
  $('delete-library-name').textContent = record.name;
  $('delete-library-description').textContent = kind === 'suite' ? 'Only this folder is removed. Its evaluations move to Unfiled; all runs remain saved.' : 'This definition will be permanently removed. Previous runs keep their inputs, outputs, and results. Used model calls are not restored.';
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
    await loadLibrary(); toast(target.kind === 'suite' ? 'Suite deleted. Its evaluations are now unfiled.' : 'Evaluation deleted. Previous runs are unchanged.');
  } catch (e) { if (target.session === session) { if (deleted) error('Deleted. Reload to refresh the library.'); else $('delete-library-error').textContent = e.message; } }
  finally { if (target.session === session) { deletingLibrary = false; $('confirm-delete-library').disabled = false; $('cancel-delete-library').disabled = false; } }
}
async function loadWorkshop() {
  if ($('workshop-button').disabled) return;
  const requestSession = session; $('workshop-button').disabled = true; error('');
  try {
    const imported = await api('/api/workshop-suite', { method: 'POST', body: '{}' });
    await loadLibrary(); $('filter-suite').value = imported.suite.id; renderSuites(); renderLibrary();
    toast('Workshop templates ready. Open Runs and choose Create Run to generate and evaluate with TestCraft.');
  } catch (e) { if (requestSession === session) error(e.message); }
  finally { $('workshop-button').disabled = false; }
}
function closeRunDraft() {
  runDraftRevision++; catalogRequest++; runSelection.clear(); runCatalog = null; runCatalogs.clear(); catalogLoads.clear(); creatingRun = false;
  $('create-run-dialog').close();
}
function selectedNeedsGrader() {
  return evaluations.some(e => runSelection.has(e.id) && criterionObjects(e).some(c => c.method === 'model_grade'));
}
function visibleRunEvaluations() {
  const query = $('create-eval-search').value.trim().toLowerCase(), type = $('create-eval-type').value, method = $('create-eval-method').value;
  return evaluations.filter(e => (!query || e.name.toLowerCase().includes(query)) && (!type || e.type === type) && (!method || e.method === method)).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}
function updateRunSubmit() {
  const needsGrader = selectedNeedsGrader();
  $('create-grader-model').disabled = creatingRun || runModelsLoading;
  $('create-grader-model').required = needsGrader;
  $('create-generation-model').disabled = creatingRun || runModelsLoading;
  $('submit-create-run').disabled = creatingRun || runModelsLoading || !runCatalog?.models.length || !runSelection.size || runSelection.size > 50 || !$('create-generation-model').value || (needsGrader && !$('create-grader-model').value);
  $('submit-create-run').textContent = creatingRun ? 'Creating…' : 'Create Run';
  $('create-selected-count').textContent = runSelection.size + ' selected · maximum 50';
}
function renderRunEvaluations() {
  const visible = visibleRunEvaluations(), focusedId = document.activeElement?.dataset.runSelect;
  $('create-eval-rows').innerHTML = visible.map(e => '<tr><td><input type="checkbox" data-run-select="' + escape(e.id) + '" aria-label="Select ' + escape(e.name) + '"' + (runSelection.has(e.id) ? ' checked' : '') + (creatingRun || (!runSelection.has(e.id) && runSelection.size >= 50) ? ' disabled' : '') + '></td><td>' + escape(e.name) + '</td><td>' + escape(names[e.type]) + '</td><td>' + escape(names[e.method]) + '</td></tr>').join('');
  $('create-select-all').checked = !!visible.length && visible.every(e => runSelection.has(e.id));
  $('create-select-all').indeterminate = visible.some(e => runSelection.has(e.id)) && !$('create-select-all').checked;
  $('create-select-all').disabled = creatingRun || !visible.length;
  $('create-eval-empty').hidden = !!visible.length;
  $('create-eval-empty').textContent = evaluations.length ? 'No evaluations match these filters.' : 'No evaluations yet. Add an evaluation in Evaluations first.';
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
async function loadRunModels(defaultJudge = false, force = false) {
  const request = ++catalogRequest, draft = runDraftRevision, workspace = session, environment = $('create-environment').value;
  const generation = $('create-generation-model').value, grader = $('create-grader-model').value;
  runModelsLoading = force || !runCatalogs.has(environment); runCatalog = null; updateRunSubmit();
  $('run-models-status').hidden = true; $('retry-run-models').hidden = true;
  const catalog = !force && runCatalogs.has(environment) ? runCatalogs.get(environment) : await requestRunCatalog(environment, force);
  if (request !== catalogRequest || draft !== runDraftRevision || workspace !== session) return;
  runCatalog = catalog; runModelsLoading = false;
  $('create-generation-model').innerHTML = '<option value="">Select a model</option>' + catalog.models.map(m => '<option value="' + escape(m.id) + '">' + escape(m.label) + '</option>').join('');
  $('create-grader-model').innerHTML = '<option value="">Select a model</option>' + catalog.models.map(m => '<option value="' + escape(m.id) + '">' + escape(m.label) + '</option>').join('');
  $('create-generation-model').value = catalog.models.some(m => m.id === generation) ? generation : '';
  const desired = grader || (defaultJudge ? config.judgeModel : '');
  $('create-grader-model').value = catalog.models.some(m => m.id === desired) ? desired : '';
  $('run-models-status').hidden = !catalog.warning;
  $('run-models-status').textContent = catalog.warning || '';
  $('retry-run-models').hidden = !catalog.warning; updateRunSubmit();
}
async function openCreateRun() {
  if (!session || !config || creatingRun) return;
  const draft = ++runDraftRevision;
  runSelection.clear(); runCatalog = null; $('create-run-form').reset(); $('create-run-error').textContent = '';
  $('create-environment').innerHTML = config.environments.map(e => '<option value="' + e.id + '"' + (e.enabled ? '' : ' disabled') + '>' + escape(e.label) + '</option>').join('');
  $('create-environment').value = 'prod';
  $('create-eval-method').innerHTML = '<option value="">All methods</option>' + Object.entries(config.evaluationMethods).map(([id, method]) => '<option value="' + escape(id) + '">' + escape(method.label) + '</option>').join('');
  setCreatingRun(false); $('create-run-dialog').showModal(); lockBody(); renderRunEvaluations(); $('create-environment').focus();
  void loadRunModels(true);
  try { await loadLibrary(); if (draft === runDraftRevision) renderRunEvaluations(); }
  catch (e) { if (draft === runDraftRevision) $('create-run-error').textContent = e.message; }
}
function setCreatingRun(busy) {
  creatingRun = busy;
  ['run-description', 'create-environment', 'create-eval-search', 'create-eval-type', 'create-eval-method', 'cancel-create-run', 'close-create-run', 'retry-run-models'].forEach(id => { $(id).disabled = busy; });
  renderRunEvaluations();
}
async function submitRun(event) {
  event.preventDefault();
  if ($('submit-create-run').disabled || !$('create-run-form').reportValidity()) return;
  const workspace = session, draft = runDraftRevision;
  const body = { evaluationIds: [...runSelection], description: $('run-description').value, environment: $('create-environment').value, generationModel: $('create-generation-model').value, graderModel: selectedNeedsGrader() ? $('create-grader-model').value : '' };
  setCreatingRun(true); $('create-run-error').textContent = '';
  try {
    const run = await api('/api/runs', { method: 'POST', body: JSON.stringify(body) });
    if (workspace !== session || draft !== runDraftRevision) return;
    setCreatingRun(false); $('create-run-dialog').close(); currentItemId = null; location.hash = 'runs/' + run.id;
    toast('Run created. Generation and grading continue in the backend.');
    await refreshSession().catch(() => {});
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
  const focusDelete = focused?.hasAttribute('data-delete-run');
  const rows = visible.map(run => '<tr data-run-row="' + escape(run.id) + '"><td><a class="eval-name" data-run-link="' + escape(run.id) + '" href="#runs/' + escape(run.id) + '">' + escape(runName(run)) + '</a></td>'
    + '<td><time datetime="' + escape(run.createdAt) + '">' + escape(new Date(run.createdAt).toLocaleString()) + '</time></td>'
    + '<td>' + (run.models.length ? run.models.map(escape).join('<br>') : '—') + '</td><td>' + run.total + '</td>'
    + '<td><span class="badge ' + escape(run.status) + '">' + escape(runStatus(run)) + '</span>' + (run.errors ? '<span class="row-meta">' + run.errors + ' error' + (run.errors === 1 ? '' : 's') + '</span>' : '') + '</td>'
    + '<td class="score">' + (Number.isFinite(run.score) ? scoreText(run.score) + ' / 100' : '—') + (run.scoredCount < run.total ? '<span class="row-meta">' + run.scoredCount + ' of ' + run.total + ' scored</span>' : '') + '</td>'
    + '<td><button class="text-button danger run-delete" data-delete-run="' + escape(run.id) + '" aria-label="Delete ' + escape(runName(run)) + '"' + (run.canDelete ? '' : ' disabled title="Wait for this run to finish before deleting it."') + '><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></svg></button></td></tr>').join('');
  const changed = rows !== lastRunRows;
  if (changed) { $('run-list').innerHTML = rows; lastRunRows = rows; }
  if (changed && focusId) {
    const row = [...$('run-list').rows].find(row => row.dataset.runRow === focusId);
    (row?.querySelector(focusDelete ? 'button' : 'a') || $('runs-title')).focus();
  }
  document.querySelectorAll('[data-run-sort]').forEach(button => button.parentElement.setAttribute('aria-sort', button.dataset.runSort === runSort ? (runSortDirection === 1 ? 'ascending' : 'descending') : 'none'));
  $('empty-runs').hidden = visible.length > 0;
  $('empty-runs').querySelector('h3').textContent = runs.length ? 'No runs match these filters.' : 'Your runs will appear here.';
  $('empty-runs').querySelector('p').textContent = runs.length ? 'Try another search or change the filters.' : 'Create a run to generate outputs and evaluate your saved evaluations.';
  $('filtered-runs-count').textContent = visible.length + ' of ' + runs.length + ' runs';
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
  $('run-detail').innerHTML = '<div class="run-top"><div><h3>' + escape(runName(run)) + ' ' + badge(run.status) + '</h3><p>' + escape(date(run.createdAt)) + ' · ' + run.items.length + ' saved evaluation snapshots</p>' + (run.description ? '<p>' + escape(run.description) + '</p>' : '') + (run.settings ? '<p>' + escape({ prod: 'Prod', dev: 'Dev', local: 'Local' }[run.settings.environment]) + ' · Generation: ' + escape(run.settings.generationModel) + (run.settings.graderModel ? ' · Grader: ' + escape(run.settings.graderModel) : '') + '</p>' : '') + '</div><div class="run-actions"><a href="#runs/' + run.id + '" target="_blank" rel="noopener">Open in new tab ↗</a><button class="button small danger" data-delete-run="' + run.id + '"' + (canDeleteRun(run) ? '' : ' disabled title="Wait for this run to finish before deleting it."') + '>Delete run</button></div></div>'
    + '<div class="run-items">' + run.items.map(x => '<button class="run-item ' + (x.id === item.id ? 'active' : '') + '" data-item="' + x.id + '">' + escape(x.evaluation.name) + ' · ' + escape(names[x.status] || x.status) + '</button>').join('') + '</div>'
    + '<div class="result-body"><div class="result-title"><div><h3>' + escape(e.name) + '</h3><p>' + escape(names[e.type]) + ' · ' + escape(familyLabel(e.method)) + ' / ' + escape(names[e.method]) + ' · v' + (e.revision || 1) + '</p></div><div class="result-score">' + (Number.isFinite(item.score) ? scoreText(item.score) + '<small> / 100</small>' : '—') + '</div></div>'
    + (active ? '<p class="muted"><span class="spinner" aria-hidden="true"></span>' + escape(names[item.status]) + '… Results update automatically.</p>' : '<p>' + badge(item.status) + ' <span class="muted">' + (item.durationMs ?? 0) + ' ms</span></p>')
    + (item.error ? '<div class="error-banner" role="alert">' + escape(item.error) + '</div>' : '')
    + '<div class="comparison"><section class="output-card"><h4>EVALUATION CRITERIA</h4><pre>' + escape(criterionObjects(e).map((c, index) => (index + 1) + '. ' + c.text + '\n   ' + (names[c.method] || c.method) + ' · weight ' + c.weight).join('\n\n')) + '</pre></section><section class="output-card"><h4>ACTUAL OUTPUT</h4><pre>' + escape(item.output ?? 'Waiting for output…') + '</pre></section></div>'
    + '<p class="muted">Source: ' + escape(item.outputSource || names[e.source]) + (item.generationModel ? ' · Generation model: ' + escape(item.generationModel) : '') + (item.judgeModel ? ' · Model grader: ' + escape(item.judgeModel) : '') + '</p>'
    + '<div class="checks"><h4>Criteria and evidence</h4>' + (item.checks.length ? (item.checks.every(c => typeof c.passed === 'boolean') ? '<p class="score-explanation">' + item.checks.filter(c => c.passed).length + ' / ' + item.checks.length + ' passed · Passed weight ' + scoreText(item.checks.reduce((sum, c) => sum + (c.passed ? c.weight : 0), 0)) + ' / ' + scoreText(item.checks.reduce((sum, c) => sum + c.weight, 0)) + ' × 100</p>' : '<p class="score-explanation">Historical numeric grading. Rerun this evaluation to use Pass/Fail criteria.</p>') + item.checks.map(check => '<article class="check"><div class="check-title"><b>' + escape(check.criterion) + '</b>' + (typeof check.passed === 'boolean' ? '<span class="badge ' + (check.passed ? 'passed' : 'failed') + '">' + (check.passed ? 'Pass' : 'Fail') + '</span>' : '<span>' + scoreText(check.score) + '/100</span>') + '</div><p class="check-meta">' + escape(names[check.method || e.method] || check.method || e.method) + (check.weight ? ' · Weight ' + escape(check.weight) : '') + '</p><p>' + escape(check.reason) + '</p><blockquote>' + escape(check.evidence) + '</blockquote></article>').join('') : '<p class="muted">' + (item.error ? 'Grading did not complete. No score has been fabricated.' : 'Checks will appear when grading finishes.') + '</p>') + '</div>'
    + '<div class="event-log"><h4>Run activity</h4>' + item.events.map(event => '<p><time>' + escape(new Date(event.at).toLocaleTimeString()) + '</time>' + escape(event.message) + '</p>').join('') + '</div>'
    + '<details><summary>Inspect saved input, HTML, and criteria</summary><pre class="context-pre">' + escape(JSON.stringify({ description: e.input, html: e.html, framework: e.framework, language: e.language, pageUrl: e.pageUrl, criteria: e.criteria, pom: e.pom, fromIdeas: e.fromIdeas, ideas: e.ideas }, null, 2)) + '</pre></details></div>';
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
  const viewingDeleted = location.hash === '#runs/' + target.id;
  if (viewingDeleted) {
    history.replaceState(null, '', '#runs'); runViewRevision++; clearTimeout(polling);
    $('runs-list-page').hidden = false; $('run-detail-page').hidden = true;
  }
  if (currentRun?.id === target.id) { currentRun = null; currentItemId = null; lastRunJson = null; renderRunDetail(); }
  // Invalidate older reads before refreshing so a stale response cannot restore the row.
  runsRequest++; libraryRequest++;
  runs = runs.filter(run => run.id !== target.id); $('runs-count').textContent = runs.length; renderRunList();
  evaluations = evaluations.map(evaluation => evaluation.latest?.runId === target.id ? { ...evaluation, latest: null } : evaluation); renderLibrary();
  toast(alreadyDeleted ? 'This run was already removed.' : 'Run deleted. Your evaluations are still saved.');
  try {
    await Promise.all([loadRuns(), loadLibrary()]);
    if (target.session === session && viewingDeleted && location.hash === '#runs') { await route(); $('runs-title').focus(); }
    else if (target.session === session && location.hash === '#runs') $('runs-title').focus();
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
  if (!session || revision !== runViewRevision || location.hash !== '#runs') return;
  try {
    await loadRuns();
    if (revision !== runViewRevision || location.hash !== '#runs') return;
    pollFailures = 0;
    if (runs.some(run => activeStatuses.includes(run.status))) polling = setTimeout(() => pollRunList(revision), 900);
    else { await loadLibrary(); if (!sessionSetup) await refreshSession(); }
  } catch (e) {
    if (!session || revision !== runViewRevision || location.hash !== '#runs') return;
    error(e.message);
    if (++pollFailures < 3) polling = setTimeout(() => pollRunList(revision), 1500);
  }
}
async function route() {
  const revision = ++runViewRevision;
  clearTimeout(polling); runsRequest++; lastRunJson = null; pollFailures = 0;
  if (!session) return;
  const isRuns = location.hash.startsWith('#runs');
  $('evaluations-panel').hidden = isRuns; $('runs-panel').hidden = !isRuns;
  $('evaluations-tab').setAttribute('aria-selected', String(!isRuns)); $('runs-tab').setAttribute('aria-selected', String(isRuns));
  $('evaluations-tab').tabIndex = isRuns ? -1 : 0; $('runs-tab').tabIndex = isRuns ? 0 : -1;
  if (isRuns) {
    const id = location.hash.split('/')[1];
    $('runs-list-page').hidden = !!id; $('run-detail-page').hidden = !id;
    if (currentRun?.id !== id || !id) { currentRun = null; currentItemId = null; renderRunDetail(); }
    await loadRuns();
    if (revision !== runViewRevision) return;
    if (id) { currentItemId = null; await pollRun(id, revision); }
    else if (runs.some(run => activeStatuses.includes(run.status))) polling = setTimeout(() => pollRunList(revision), 900);
  } else await loadLibrary();
}
$('evaluation-form').addEventListener('submit', saveEvaluation);
['new-button','empty-create'].forEach(id => $(id).addEventListener('click', () => openForm()));
$('example-button').addEventListener('click', () => openForm(true));
$('workshop-button').addEventListener('click', loadWorkshop);
$('new-suite').addEventListener('click', () => openSuiteForm());
$('rename-suite').addEventListener('click', () => openSuiteForm(suites.find(s => s.id === $('filter-suite').value)));
$('delete-suite').addEventListener('click', () => askDeleteLibrary('suite', suites.find(s => s.id === $('filter-suite').value)));
$('suite-form').addEventListener('submit', saveSuite);
$('cancel-suite').addEventListener('click', () => { if (!savingSuite) $('suite-dialog').close(); });
$('suite-dialog').addEventListener('cancel', event => { if (savingSuite) event.preventDefault(); });
$('suite-dialog').addEventListener('close', lockBody);
$('delete-library-form').addEventListener('submit', deleteLibrary);
$('cancel-delete-library').addEventListener('click', () => { if (!deletingLibrary) $('delete-library-dialog').close(); });
$('delete-library-dialog').addEventListener('cancel', event => { if (deletingLibrary) event.preventDefault(); });
$('delete-library-dialog').addEventListener('close', lockBody);
$('duplicate-evaluation').addEventListener('click', () => { if (editing) void duplicateEvaluation(editing.id); });
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
  const container = location.hash === '#runs' ? $('run-list') : $('run-detail');
  [...container.querySelectorAll('[data-delete-run]')].find(button => button.dataset.deleteRun === target.id)?.focus();
});
$('back-step').addEventListener('click', () => setStep(1));
['type','from-ideas'].forEach(id => $(id).addEventListener('change', syncForm));
$('method').addEventListener('change', () => selectMethod($('method').value));
$('method-family').addEventListener('change', () => selectMethod(familyChoices[$('method-family').value] || ({ model_based: 'model_grade', rule_based: 'contains', hybrid: 'hybrid' }[$('method-family').value])));
$('criterion-method').addEventListener('change', syncForm);
$('use-weights').addEventListener('change', renderCriteria);
$('add-criterion').addEventListener('click', addCriterion);
$('criterion-draft').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && $('method').value !== 'exact_match' && !($('method').value === 'hybrid' && $('criterion-method').value === 'exact_match')) { event.preventDefault(); addCriterion(); }
});
$('criteria-list').addEventListener('input', event => {
  if (event.target.dataset.criterion !== undefined) criteria[Number(event.target.dataset.criterion)].text = event.target.value;
  if (event.target.dataset.criterionWeight !== undefined) criteria[Number(event.target.dataset.criterionWeight)].weight = event.target.value === '' ? '' : Number(event.target.value);
});
$('criteria-list').addEventListener('change', event => {
  if (event.target.dataset.criterionMethod !== undefined) { criteria[Number(event.target.dataset.criterionMethod)].method = event.target.value; syncForm(); }
});
$('criteria-list').addEventListener('click', event => {
  const button = event.target.closest('[data-remove-criterion]');
  if (!button) return;
  const index = Number(button.dataset.removeCriterion); criteria.splice(index, 1); renderCriteria(); syncForm();
  ($('criterion-' + Math.min(index, criteria.length - 1)) || $('criterion-draft')).focus();
});
$('evaluation-form').addEventListener('input', resizeTextareas);
new ResizeObserver(resizeTextareas).observe($('wizard-body'));
$('framework').addEventListener('change', () => setLanguages());
['search','filter-type','filter-method','filter-status','sort'].forEach(id => $(id).addEventListener(id === 'search' ? 'input' : 'change', renderLibrary));
$('filter-suite').addEventListener('change', () => { renderSuites(); renderLibrary(); });
document.addEventListener('click', event => {
  const el = event.target.closest('button');
  if (!el) return;
  if (el.dataset.inspect) openForm(false, evaluations.find(e => e.id === el.dataset.inspect));
  if (el.dataset.duplicateEvaluation) void duplicateEvaluation(el.dataset.duplicateEvaluation);
  if (el.dataset.deleteEvaluation) askDeleteLibrary('evaluation', evaluations.find(e => e.id === el.dataset.deleteEvaluation));
  if (el.dataset.runLink) location.hash = 'runs/' + el.dataset.runLink;
  if (el.dataset.deleteRun) askDeleteRun(el.dataset.deleteRun);
  if (el.dataset.item) { currentItemId = el.dataset.item; renderRunDetail(); }
});
$('evaluations-tab').addEventListener('click', () => { location.hash = 'evaluations'; });
$('create-run').addEventListener('click', openCreateRun);
$('create-run-form').addEventListener('submit', submitRun);
['cancel-create-run', 'close-create-run'].forEach(id => $(id).addEventListener('click', () => { if (!creatingRun) $('create-run-dialog').close(); }));
$('create-run-dialog').addEventListener('cancel', event => { if (creatingRun) event.preventDefault(); });
$('create-run-dialog').addEventListener('close', () => { runDraftRevision++; catalogRequest++; lockBody(); });
$('create-environment').addEventListener('change', () => loadRunModels());
$('retry-run-models').addEventListener('click', () => loadRunModels(false, true));
['create-generation-model', 'create-grader-model'].forEach(id => $(id).addEventListener('change', updateRunSubmit));
['create-eval-search', 'create-eval-type', 'create-eval-method'].forEach(id => $(id).addEventListener(id === 'create-eval-search' ? 'input' : 'change', renderRunEvaluations));
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
$('runs-tab').addEventListener('click', () => { location.hash = 'runs'; });
document.querySelector('.tabs').addEventListener('keydown', event => {
  if (['ArrowRight','ArrowLeft','Home','End'].includes(event.key)) {
    event.preventDefault(); const target = event.key === 'Home' ? $('evaluations-tab') : event.key === 'End' ? $('runs-tab') : event.target === $('runs-tab') ? $('evaluations-tab') : $('runs-tab'); target.click(); target.focus();
  }
});
['run-search', 'run-status', 'run-model'].forEach(id => $(id).addEventListener(id === 'run-search' ? 'input' : 'change', renderRunList));
document.querySelectorAll('[data-run-sort]').forEach(button => button.addEventListener('click', () => {
  const key = button.dataset.runSort;
  runSortDirection = runSort === key ? -runSortDirection : ['createdAt', 'total', 'score'].includes(key) ? -1 : 1;
  runSort = key; renderRunList();
}));
$('run-list').addEventListener('click', event => {
  if (event.target.closest('a, button') || window.getSelection()?.toString()) return;
  const row = event.target.closest('[data-run-row]');
  if (row) location.hash = 'runs/' + row.dataset.runRow;
});
window.addEventListener('hashchange', () => route().catch(e => error(e.message)));
async function openWorkspace() {
  config = await api('/api/config');
  if (config.version !== 9 || !config.evaluationMethods?.hybrid) throw new Error('This page needs the updated backend. Restart the local server or refresh after deployment.');
  $('connection').textContent = '● Backend connected';
  $('setup-notice').hidden = true; error('');
  if (!config.llmReady) { $('setup-notice').hidden = false; $('setup-notice').textContent = 'LLM as a judge needs OPENAI_API_KEY in the backend. You can save evaluations and use TestCraft generation with Rule-based grading.'; }
  await Promise.all([loadLibrary(), loadRuns(), ...config.environments.filter(e => e.enabled).map(e => requestRunCatalog(e.id))]); await route();
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
