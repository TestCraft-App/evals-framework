const $ = id => document.getElementById(id);
const names = { ideas: 'Generate ideas', code: 'Generate code', model_grade: 'LLM as a judge', exact_match: 'Exact match', contains: 'Contains', not_contains: 'Does not contain', pasted: 'Pasted output', testcraft_api: 'TestCraft v1', llm: 'LLM adapter', playwright: 'Playwright', cypress: 'Cypress', selenium: 'Selenium', typescript: 'TypeScript', javascript: 'JavaScript', python: 'Python', java: 'Java', csharp: 'C#', not_run: 'Not run', passed: 'Passed', failed: 'Failed', error: 'Error', queued: 'Queued', generating: 'Generating', grading: 'Grading', running: 'Running', completed: 'Completed', interrupted: 'Interrupted' };
names.hybrid = 'Hybrid';
const languages = { playwright: ['typescript','javascript','python','java','csharp'], cypress: ['typescript','javascript'], selenium: ['javascript','python','java','csharp'] };
const activeStatuses = ['queued','running','generating','grading'];
let config, evaluations = [], runs = [], selected = new Set(), currentRun, currentItemId, polling, lastRunJson, pollFailures = 0, toastTimer;
let formStep = 1, editing = null, savingEvaluation = false, criteria = [], modelCatalog, modelsLoading = false, desiredJudge = '';
let suites = [], suiteEditing = null, savingSuite = false, libraryDeleteTarget = null, deletingLibrary = false;
let session = null, sessionTimer, sessionSetup;
let currentMethod = null, methodDrafts = new Map(), familyChoices = {};
let deleteTarget = null, deletingRun = false, runViewRevision = 0, runsRequest = 0, libraryRequest = 0;
const canDeleteRun = run => ['completed', 'interrupted'].includes(run.status) && run.items.every(item => ['passed', 'failed', 'error'].includes(item.status));
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
  evaluations = []; runs = []; suites = []; editing = null; selected.clear(); currentRun = null; currentItemId = null; criteria = []; modelCatalog = null; modelsLoading = false;
  methodDrafts.clear(); currentMethod = null; familyChoices = {};
  runViewRevision++; runsRequest++; libraryRequest++; deleteTarget = null; deletingRun = false; $('delete-run-dialog').close();
  $('evaluation-dialog').close(); $('evaluation-form').reset(); $('criteria-list').replaceChildren();
  ['suite-dialog', 'delete-library-dialog'].forEach(id => $(id).close());
  suiteEditing = null; libraryDeleteTarget = null; savingEvaluation = false; savingSuite = false; deletingLibrary = false;
  $('filter-suite').value = ''; renderSuites();
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
  $('evaluation-rows').innerHTML = visible.map(e => '<tr><td class="checkbox-cell"><input type="checkbox" aria-label="Select ' + escape(e.name) + '" data-select="' + e.id + '"' + (selected.has(e.id) ? ' checked' : '') + '></td>'
    + '<td><button class="eval-name" data-inspect="' + e.id + '" title="Edit evaluation">' + escape(e.name) + '</button><div class="eval-id">' + escape(suites.find(s => s.id === e.suiteId)?.name || 'Unfiled') + ' · v' + (e.revision || 1) + '</div></td>'
    + '<td>' + badge(e.type) + '</td><td>' + (e.type === 'ideas' ? '<span class="muted">Not applicable</span>' : escape(names[e.framework]) + '<span class="row-meta">' + escape(names[e.language]) + '</span>') + '</td>'
    + '<td>' + escape(names[e.method]) + '<span class="row-meta">' + escape(familyLabel(e.method)) + '</span></td><td>' + escape(names[e.source]) + '</td><td>' + badge(e.latest?.status || 'not_run') + '</td>'
    + '<td class="score">' + (Number.isFinite(e.latest?.score) ? scoreText(e.latest.score) + '%' : '—') + '</td><td>' + escape(date(e.createdAt)) + '</td>'
    + '<td><div class="row-actions">' + (e.latest ? '<button class="text-button" data-run-link="' + e.latest.runId + '">View run ↗</button>' : '<button class="text-button" data-run-one="' + e.id + '">Run →</button>') + '<button class="text-button" data-inspect="' + e.id + '" aria-label="Edit ' + escape(e.name) + '">Edit</button><button class="text-button" data-duplicate-evaluation="' + e.id + '" aria-label="Duplicate ' + escape(e.name) + '">Duplicate</button><button class="text-button danger" data-delete-evaluation="' + e.id + '" aria-label="Delete ' + escape(e.name) + '">Delete</button></div></td></tr>').join('');
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
  const source = $('source').value, method = $('method').value, code = $('type').value === 'code';
  const definition = config?.evaluationMethods?.[method];
  const judge = formNeedsGrader();
  if (source === 'llm' && !$('model').value) $('model').value = config?.model || 'gpt-4o-mini';
  $('model').disabled = false; $('model').required = source === 'llm';
  $('judge-model').disabled = !judge || modelsLoading; $('judge-model').required = judge;
  $('models-feedback').hidden = !judge;
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
  if (editing?.source === 'pasted') $('source-hint').textContent += ' Saving this older evaluation switches to generation (1 additional model call per run). Previous runs stay unchanged.';
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
  editing = existing ? structuredClone(existing) : null;
  $('dialog-title').textContent = existing ? 'Edit evaluation' : 'New evaluation';
  $('edit-version').hidden = !editing;
  $('edit-version').textContent = editing ? 'Version ' + (editing.revision || 1) + ' · Previous runs keep their original inputs and results.' : '';
  $('duplicate-evaluation').hidden = !editing; $('delete-evaluation').hidden = !editing;
  setSavingEvaluation(false); renderSuites();
  $('evaluation-suite').value = existing?.suiteId || (suites.some(s => s.id === $('filter-suite').value) ? $('filter-suite').value : '');
  $('model').value = ''; desiredJudge = existing?.judgeModel || config.judgeModel;
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
    for (const key of ['name','type','input','html','model']) if (data[key] !== undefined) $(key).value = data[key];
    $('source').value = data.source === 'llm' ? 'llm' : 'testcraft_api';
    if (languages[data.framework]) $('framework').value = data.framework;
    setLanguages(data.language);
    if (data.pageUrl !== undefined) $('page-url').value = data.pageUrl;
    $('pom').checked = !!data.pom; $('from-ideas').checked = !!data.fromIdeas;
    $('ideas').value = data.ideas ?? (data.fromIdeas ? data.input : '') ?? '';
    criteria = criterionObjects(data);
    $('use-weights').checked = criteria.some(c => c.weight !== 1);
  }
  selectMethod(data?.method || 'model_grade', false); renderModelOptions(); syncForm(); setStep(1, false);
  $('evaluation-dialog').showModal(); document.body.classList.add('modal-open'); resizeTextareas(); $('name').focus();
  loadModels();
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
  if (formNeedsGrader() && (modelsLoading || !$('judge-model').value)) { $('form-error').textContent = 'Wait for the models to load, then select a model grader.'; return; }
  const target = editing, requestSession = session, asNew = event.submitter?.id === 'save-as-new';
  setSavingEvaluation(true);
  const payload = Object.fromEntries(new FormData($('evaluation-form')));
  payload.criteria = criteria.map(value => ({ text: value.text.trim(), method: value.method, weight: $('use-weights').checked ? value.weight : 1 }));
  payload.pom = !$('pom').disabled && $('pom').checked; payload.fromIdeas = !$('from-ideas').disabled && $('from-ideas').checked;
  if (target && !asNew) payload.revision = target.revision || 1;
  if (asNew && payload.name === target.name) payload.name = payload.name.slice(0, 133) + ' (copy)';
  let saved = false;
  try {
    await api('/api/evaluations' + (target && !asNew ? '/' + target.id : ''), { method: target && !asNew ? 'PUT' : 'POST', body: JSON.stringify(payload) });
    saved = true; $('evaluation-dialog').close(); await loadLibrary(); toast(target && !asNew ? 'Changes saved. Run this version to evaluate it.' : 'Evaluation saved. Select it to run.');
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
    toast('Workshop templates ready. Select Run to generate and evaluate with TestCraft.');
  } catch (e) { if (requestSession === session) error(e.message); }
  finally { $('workshop-button').disabled = false; }
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
$('delete-run-dialog').addEventListener('close', () => { deleteTarget = null; document.body.classList.toggle('modal-open', $('evaluation-dialog').open); });
$('back-step').addEventListener('click', () => setStep(1));
['type','source','from-ideas'].forEach(id => $(id).addEventListener('change', syncForm));
$('method').addEventListener('change', () => selectMethod($('method').value));
$('method-family').addEventListener('change', () => selectMethod(familyChoices[$('method-family').value] || ({ model_based: 'model_grade', rule_based: 'contains', hybrid: 'hybrid' }[$('method-family').value])));
$('criterion-method').addEventListener('change', syncForm);
$('use-weights').addEventListener('change', renderCriteria);
$('judge-model').addEventListener('change', () => { desiredJudge = $('judge-model').value; });
$('retry-models').addEventListener('click', loadModels);
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
$('filter-suite').addEventListener('change', () => { selected.clear(); renderSuites(); renderLibrary(); });
$('select-all').addEventListener('change', () => { visibleEvaluations().forEach(e => $('select-all').checked ? selected.add(e.id) : selected.delete(e.id)); renderLibrary(); });
$('clear-selection').addEventListener('click', () => { selected.clear(); renderLibrary(); });
$('run-selected').addEventListener('click', () => startRun([...selected]));
$('evaluation-rows').addEventListener('change', event => { const id = event.target.dataset.select; if (id) { event.target.checked ? selected.add(id) : selected.delete(id); updateSelection(); } });
document.addEventListener('click', event => {
  const el = event.target.closest('button');
  if (!el) return;
  if (el.dataset.inspect) openForm(false, evaluations.find(e => e.id === el.dataset.inspect));
  if (el.dataset.duplicateEvaluation) void duplicateEvaluation(el.dataset.duplicateEvaluation);
  if (el.dataset.deleteEvaluation) askDeleteLibrary('evaluation', evaluations.find(e => e.id === el.dataset.deleteEvaluation));
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
  if (config.version !== 8 || !config.evaluationMethods?.hybrid) throw new Error('This page needs the updated backend. Restart the local server or refresh after deployment.');
  $('connection').textContent = '● Backend connected';
  $('setup-notice').hidden = true; error('');
  if (!config.llmReady) { $('setup-notice').hidden = false; $('setup-notice').textContent = 'LLM as a judge needs OPENAI_API_KEY in the backend. You can save evaluations and use TestCraft generation with Rule-based grading.'; }
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
