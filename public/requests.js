import { createRunDetail, scoreMarkup } from './run-detail.js';

const labels = { pending: 'Pending', changes_requested: 'Changes requested', approved: 'Approved', rejected: 'Rejected', submitted: 'Submitted', resubmitted: 'Resubmitted', approve: 'Approved', reject: 'Rejected', request_changes: 'Changes requested' };
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const date = value => new Date(value).toLocaleString();
const path = id => '/api/evaluation-requests' + (id ? '/' + encodeURIComponent(id) : '');

export function createRequests({ api, getSession, inspect, editLink, openRun, runOptions, lockBody, toast, error, onSubmitted }) {
  const $ = id => document.getElementById(id);
  const root = $('requests-panel');
  let current = null, rows = [], displayedSubmission = 0, routeVersion = 0, timer, dialogTarget, returnFocus, busy = false, draft = null;
  let filters = { query: '', suite: '', endpoint: '', method: '' }, sort = 'createdAt', direction = -1, listStatus = '';
  let runView, reviewRuns = [], historyReturnFocus;
  const isAdmin = () => getSession()?.user.role === 'admin';
  const canSubmit = () => getSession()?.user.role === 'collaborator';
  const status = value => '<span class="badge request-' + escape(value) + '">' + escape(labels[value]) + '</span>';
  const actions = request => isAdmin() && request.status === 'pending' ? '<div class="request-actions">' + [['approve', 'Approve all'], ['reject', 'Reject'], ['request_changes', 'Request changes']].map(([action, label]) => '<button class="button small' + (action === 'reject' ? ' danger' : '') + '" data-review="' + action + '" data-request="' + request.id + '">' + label + '</button>').join('') + '</div>' : '';
  const badge = async () => {
    if (!getSession()) return;
    const summary = await api(path('summary'));
    $('request-menu-label').textContent = isAdmin() ? 'Evaluation requests' : 'My requests';
    for (const id of ['request-menu-badge', 'request-user-badge']) { $(id).textContent = summary.count; $(id).hidden = !summary.count; $(id).setAttribute('aria-label', summary.count + (isAdmin() ? ' pending requests' : ' requests with unread feedback')); }
  };
  function reset() {
    historyReturnFocus = null; $('request-history-dialog').close(); $('request-history-events').replaceChildren();
    routeVersion++; clearTimeout(timer); current = null; rows = []; reviewRuns = []; draft = null; busy = false;
    root.replaceChildren(); runView = null; $('request-dialog').close(); $('request-decision-dialog').close();
    $('request-menu-badge').hidden = true; $('request-user-badge').hidden = true;
  }
  function modal(id, focus) {
    returnFocus = document.activeElement; $(id).showModal(); lockBody(); $(focus).focus();
  }
  function openHistory() {
    if (!current) return;
    historyReturnFocus = $('open-request-history');
    $('request-history-events').innerHTML = current.events.map(event => '<li><strong>' + escape(labels[event.action]) + '</strong> · ' + escape(event.actor.login) + ' · ' + escape(date(event.at)) + ' · Submission ' + event.submission + (event.comment ? '<p class="request-description">' + escape(event.comment) + '</p>' : '') + '</li>').join('');
    $('request-history-dialog').showModal(); lockBody(); $('close-request-history').focus();
  }
  function renderList() {
    root.innerHTML = '<div class="section-heading"><h2 tabindex="-1" id="requests-title">' + (isAdmin() ? 'Evaluation requests' : 'My requests') + '</h2><a href="' + escape(editLink()) + '">Back to evaluations</a></div>'
      + '<label class="request-status-filter">Status<select id="request-status"><option value="">All statuses</option>' + Object.entries(labels).filter(([key]) => ['pending', 'changes_requested', 'approved', 'rejected'].includes(key)).map(([key, label]) => '<option value="' + key + '">' + label + '</option>').join('') + '</select></label>'
      + '<div class="table-card table-scroll"><table aria-label="Evaluation requests"><thead><tr><th>Submitted</th><th>Requester</th><th>Evaluations</th><th>Description</th><th>Status</th><th>Actions</th></tr></thead><tbody>'
      + rows.filter(request => !listStatus || request.status === listStatus).map(request => '<tr><td><a href="#requests/' + request.id + '">' + escape(date(request.submittedAt)) + '</a></td><td>' + escape(request.requester.login) + '</td><td>' + request.evaluationCount + '</td><td><a class="request-description-preview" href="#requests/' + request.id + '" title="' + escape(request.description) + '">' + escape(request.description) + '</a></td><td>' + status(request.status) + '</td><td>' + actions(request) + '</td></tr>').join('') + '</tbody></table></div>'
      + (rows.some(request => !listStatus || request.status === listStatus) ? '' : '<p class="empty-state">No requests to show.</p>');
    $('request-status').value = listStatus;
  }
  const entries = () => current?.submissions.find(submission => submission.number === displayedSubmission)?.evaluations || [];
  function renderEvaluations() {
    const value = (entry, key) => key === 'suite' ? entry.suite?.name || 'None' : key === 'endpoint' ? runOptions.endpoint(entry.evaluation) : key === 'method' ? runOptions.method(entry.evaluation) : key === 'reference' ? Number(entry.evaluation.reference?.slice(5) || 0) : entry.evaluation[key];
    const visible = entries().filter(entry => {
      const e = entry.evaluation;
      return (!filters.query || [e.reference, e.name, e.input].join(' ').toLowerCase().includes(filters.query.toLowerCase())) && (!filters.suite || (entry.suite?.id || '__none') === filters.suite) && (!filters.endpoint || runOptions.endpoint(e) === filters.endpoint) && (!filters.method || runOptions.method(e) === filters.method);
    }).sort((a, b) => (sort === 'reference' ? value(a, sort) - value(b, sort) : String(value(a, sort)).localeCompare(String(value(b, sort)))) * direction);
    $('request-evaluation-rows').innerHTML = visible.map(({ evaluation: e, suite }) => '<tr><td>' + escape(e.reference) + '</td><td><button class="eval-name" data-request-inspect="' + e.id + '" title="' + escape(e.name) + '">' + escape(e.name) + '</button></td><td title="' + escape(suite?.name || 'None') + '">' + escape(suite?.name || 'None') + '</td><td>' + escape(runOptions.endpointLabel(e)) + '</td><td>' + escape(runOptions.method(e)) + '</td><td>' + escape(date(e.createdAt)) + '</td><td>' + (!isAdmin() && current.status === 'changes_requested' && displayedSubmission === current.submission ? '<a href="#personal/evaluations/' + e.id + '">Edit in My workspace</a>' : '') + '</td></tr>').join('');
    $('request-evaluation-count').textContent = visible.length + ' of ' + entries().length + ' evaluations';
    root.querySelectorAll('[data-request-sort]').forEach(button => button.parentElement.setAttribute('aria-sort', button.dataset.requestSort === sort ? direction === 1 ? 'ascending' : 'descending' : 'none'));
  }
  function renderDetail() {
    const submission = current.submissions.find(item => item.number === displayedSubmission);
    root.innerHTML = '<a href="#requests">← Back to requests</a><div class="section-heading request-detail-heading"><div class="request-title-line"><h2 id="request-title" tabindex="-1">Request from ' + escape(current.requester.login) + '</h2><span class="request-title-separator" aria-hidden="true">·</span><p id="submission-description" class="request-heading-description request-description">' + escape(submission.description) + '</p></div>' + status(current.status) + '</div>'
      + (displayedSubmission === current.submission ? actions(current) : '<p class="notice">Viewing an earlier submission. Select the current submission to review or resubmit.</p>') + (!isAdmin() && current.status === 'changes_requested' && displayedSubmission === current.submission ? '<button id="resubmit-request" class="button primary">Revise and resubmit</button><p>Edit your evaluations in My workspace, then select the revised set to submit.</p>' : '')
      + (current.approvedEvaluations ? '<p>Added to TestCraft: ' + current.approvedEvaluations.map(item => '<a href="#main/evaluations/' + item.id + '">' + escape(item.reference) + '</a>').join(', ') + '</p>' : '')
      + '<section class="table-card"><div class="section-heading"><h3>Submitted evaluations</h3><div class="request-submission-controls"><select id="request-submission" aria-label="Submission">' + current.submissions.map(item => '<option value="' + item.number + '">Submission ' + item.number + ' · ' + escape(date(item.at)) + '</option>').join('') + '</select><button id="open-request-history" type="button" class="button" aria-haspopup="dialog" aria-controls="request-history-dialog">Review history</button></div></div>'
      + '<div class="filters"><label class="search-field">Search evaluations<input id="request-search" type="search" placeholder="Search by name, ID, or input…"></label><label>Suite<select id="request-suite"><option value="">All suites</option><option value="__none">None</option>' + [...new Map(entries().filter(entry => entry.suite).map(entry => [entry.suite.id, entry.suite])).values()].map(suite => '<option value="' + suite.id + '">' + escape(suite.name) + '</option>').join('') + '</select></label><label>Endpoint<select id="request-endpoint"><option value="">All endpoints</option><option value="ideas">Generate ideas</option><option value="code">Automate tests</option><option value="code_ideas">Automate test ideas</option></select></label><label>Method<select id="request-method"><option value="">All methods</option><option>rule-based</option><option>model-graded</option><option>hybrid</option></select></label></div>'
      + '<div class="table-scroll"><table class="request-evaluations" aria-label="Requested evaluations"><thead><tr>' + [['reference', 'Eval ID'], ['name', 'Eval name'], ['suite', 'Suite'], ['endpoint', 'Endpoint'], ['method', 'Method'], ['createdAt', 'Created']].map(([key, label]) => '<th><button data-request-sort="' + key + '">' + label + '</button></th>').join('') + '<th>Actions</th></tr></thead><tbody id="request-evaluation-rows"></tbody></table></div><p id="request-evaluation-count" class="table-footer"></p></section>'
      + (isAdmin() ? '<section class="request-runs"><div class="section-heading"><h3>Admin review runs</h3><button id="create-review-run" class="button"' + (current.status !== 'pending' || displayedSubmission !== current.submission ? ' disabled' : '') + '>Create review run</button></div><p class="muted">Visible only to admins. Runs are optional and do not block approval.</p><div id="review-run-list"></div></section>' : '');
    $('request-submission').value = displayedSubmission;
    for (const [id, key] of [['request-search', 'query'], ['request-suite', 'suite'], ['request-endpoint', 'endpoint'], ['request-method', 'method']]) $(id).value = filters[key];
    renderEvaluations();
  }
  function renderRuns() {
    if (!$('review-run-list')) return;
    const focused = document.activeElement, focusAction = focused?.dataset.reviewRerun ? 'reviewRerun' : 'reviewDelete', focusId = focused?.dataset[focusAction];
    const markup = reviewRuns.length ? '<div class="table-scroll"><table aria-label="Review runs"><thead><tr><th>Run</th><th>Submission</th><th>Status</th><th>Score</th><th>Actions</th></tr></thead><tbody>' + reviewRuns.map(run => '<tr><td><a href="#requests/' + current.id + '/runs/' + run.id + '">' + escape(runOptions.runName(run)) + '</a></td><td>' + run.request.submission + '</td><td>' + escape(run.status) + '</td><td>' + scoreMarkup(run.score) + '</td><td><button class="button small" data-review-rerun="' + run.id + '"' + (current.status !== 'pending' || run.request.submission !== current.submission ? ' disabled' : '') + '>Rerun</button> <button class="button small danger" data-review-delete="' + run.id + '"' + (run.canDelete ? '' : ' disabled') + '>Delete</button></td></tr>').join('') + '</tbody></table></div>' : '<p>No review runs yet.</p>';
    if ($('review-run-list').innerHTML !== markup) { $('review-run-list').innerHTML = markup; if (focusId) [...$('review-run-list').querySelectorAll('button')].find(button => button.dataset[focusAction] === focusId)?.focus(); }
  }
  async function route(hash) {
    $('request-history-dialog').close();
    const revision = ++routeVersion; clearTimeout(timer); runView?.reset(); runView = null;
    if (!hash.startsWith('#requests')) return;
    root.innerHTML = '<p role="status">Loading requests…</p>';
    const [, id, kind, runId] = hash.slice(1).split('/');
    try {
      if (!id) { const data = await api(path()); if (revision !== routeVersion) return; rows = data.requests; current = null; renderList(); }
      else {
        const request = await api(path(id)); if (revision !== routeVersion) return;
        if (current?.id !== id || !request.submissions.some(item => item.number === displayedSubmission) || current?.submission !== request.submission) { displayedSubmission = request.submission; filters = { query: '', suite: '', endpoint: '', method: '' }; }
        current = request;
        if (kind === 'runs' && runId) {
          if (!isAdmin()) throw new Error('Administrator access is required.');
          root.innerHTML = '<a href="#requests/' + id + '">← Back to request</a><h2>Admin review run</h2><p id="review-run-provenance"></p><div id="review-run-detail" class="run-detail"></div>';
          runView = createRunDetail({ ...runOptions, root: $('review-run-detail'), getSuites: () => [], canDelete: run => isAdmin() && !['queued', 'running'].includes(run.status) });
          const poll = async () => {
            try {
              const run = await api(path(id) + '/runs/' + runId); if (revision !== routeVersion) return;
              $('review-run-provenance').textContent = 'Request from ' + current.requester.login + ' · Submission ' + run.request.submission + ' · Admins only';
              runView.render(run);
              if (['queued', 'running'].includes(run.status)) timer = setTimeout(poll, 1000);
            } catch (e) { if (revision === routeVersion) error(e.message); }
          };
          await poll();
        } else {
          renderDetail();
          if (isAdmin()) {
            const poll = async () => {
              try { const data = await api(path(id) + '/runs'); if (revision !== routeVersion) return; reviewRuns = data.runs; renderRuns(); if (reviewRuns.some(run => ['queued', 'running'].includes(run.status))) timer = setTimeout(poll, 1000); }
              catch (e) { if (revision === routeVersion) error(e.message); }
            }; await poll();
          } else if (current.feedbackVersion) { await api(path(id) + '/read', { method: 'POST', body: JSON.stringify({ version: current.feedbackVersion }) }); await badge(); }
        }
      }
    } catch (e) { if (revision === routeVersion) { root.innerHTML = '<a href="#requests">Back to requests</a><p role="alert">' + escape(e.message) + '</p>'; } }
  }
  async function openSubmit(selected, request = null) {
    if (!canSubmit()) return;
    const session = getSession(), focus = document.activeElement, revision = routeVersion;
    let options = selected;
    if (request) options = (await api('/api/workspaces/personal/evaluations')).evaluations;
    if (session !== getSession() || revision !== routeVersion) return;
    const ids = new Set(request ? request.submissions.at(-1).evaluations.map(entry => entry.evaluation.id) : selected.map(e => e.id));
    draft = { request, options, session };
    $('request-dialog-title').textContent = request ? 'Revise and resubmit' : 'Request inclusion';
    $('request-submit-description').value = request?.description || '';
    $('request-submit-error').textContent = '';
    $('request-submit-list').innerHTML = options.map(e => '<label class="request-selection">' + (request ? '<input type="checkbox" data-submit-eval="' + e.id + '"' + (ids.has(e.id) ? ' checked' : '') + '>' : '') + '<span>' + escape(e.reference + ' · ' + e.name) + '</span></label>').join('');
    $('request-submit-note').textContent = request ? 'Edit definitions in My workspace first. Select the revised set below. Missing evaluations have been removed from the selection.' : selected.length + ' selected evaluations, including any hidden by filters. Send snapshots to TestCraft admins for review?';
    $('send-request').textContent = request ? 'Resubmit request' : 'Send request';
    $('send-request').disabled = false;
    modal('request-dialog', 'request-submit-description'); returnFocus = focus;
  }
  async function decide(id, action, runId = null) {
    const request = current?.id === id ? current : rows.find(row => row.id === id);
    if (!request) return;
    dialogTarget = { request, action, runId, session: getSession() };
    $('request-decision-title').textContent = { approve: 'Approve all evaluations?', reject: 'Reject request?', request_changes: 'Request changes?', delete_run: 'Delete review run?' }[action];
    $('request-decision-summary').textContent = action === 'delete_run' ? 'Remove this review run and its evidence. Submitted evaluations remain saved.' : request.evaluationCount + ' evaluations from ' + request.requester.login + (action === 'approve' ? '. Add new copies to TestCraft, preserving suite grouping?' : '. Your comment will be visible to the collaborator.');
    const needsComment = ['reject', 'request_changes'].includes(action);
    $('request-comment-label').hidden = !needsComment; $('request-comment').required = needsComment; $('request-comment').value = '';
    $('request-decision-error').textContent = ''; $('confirm-request-decision').disabled = false;
    $('confirm-request-decision').textContent = { approve: 'Approve all', reject: 'Reject', request_changes: 'Request changes', delete_run: 'Delete run' }[action];
    modal('request-decision-dialog', needsComment ? 'request-comment' : 'cancel-request-decision');
  }
  root.addEventListener('input', event => { if (event.target.id === 'request-search') { filters.query = event.target.value; renderEvaluations(); } });
  root.addEventListener('change', event => {
    const id = event.target.id;
    if (id === 'request-status') { listStatus = event.target.value; renderList(); $('request-status').focus(); }
    if (id === 'request-submission') { displayedSubmission = Number(event.target.value); filters = { query: '', suite: '', endpoint: '', method: '' }; renderDetail(); renderRuns(); $('request-submission').focus(); }
    for (const [control, key] of [['request-suite', 'suite'], ['request-endpoint', 'endpoint'], ['request-method', 'method']]) if (id === control) { filters[key] = event.target.value; renderEvaluations(); }
  });
  root.addEventListener('click', async event => {
    const button = event.target.closest('button'); if (!button) return;
    try {
      if (button.dataset.review) await decide(button.dataset.request, button.dataset.review);
      if (button.dataset.requestInspect) { const entry = entries().find(entry => entry.evaluation.id === button.dataset.requestInspect); inspect(entry.evaluation, entry.suite?.name || 'None', current.requester.login + ' · Submission ' + displayedSubmission); }
      if (button.dataset.requestSort) { const key = button.dataset.requestSort; direction = key === sort ? -direction : 1; sort = key; renderEvaluations(); }
      if (button.id === 'resubmit-request') await openSubmit([], current);
      if (button.id === 'open-request-history') openHistory();
      if (button.id === 'create-review-run') await openRun(null, current);
      if (button.dataset.reviewRerun) { const request = current, revision = routeVersion; const run = await api(path(request.id) + '/runs/' + button.dataset.reviewRerun); if (revision === routeVersion) await openRun(run, request); }
      if (button.dataset.reviewDelete || button.dataset.deleteRun) { event.stopPropagation(); await decide(current.id, 'delete_run', button.dataset.reviewDelete || button.dataset.deleteRun); }
    } catch (e) { error(e.message); }
  });
  $('request-submit-form').addEventListener('submit', async event => {
    event.preventDefault(); if (busy || !draft) return;
    const target = draft;
    const ids = target.request ? [...$('request-submit-list').querySelectorAll('input:checked')].map(input => input.dataset.submitEval) : target.options.map(e => e.id);
    if (!ids.length) { $('request-submit-error').textContent = 'Select at least one evaluation.'; return; }
    busy = true; $('send-request').disabled = true;
    try {
      const result = await api(path(target.request?.id) + (target.request ? '/resubmit' : ''), { method: 'POST', body: JSON.stringify({ evaluationIds: ids, description: $('request-submit-description').value, ...(target.request ? { version: target.request.version } : {}) }) });
      if (target.session !== getSession()) return;
      busy = false; $('request-dialog').close(); onSubmitted(); await badge().catch(e => error(e.message));
      if (location.hash === '#requests/' + result.id) await route(location.hash); else location.hash = 'requests/' + result.id;
      toast('Request sent to TestCraft admins.');
    } catch (e) { if (target.session === getSession()) $('request-submit-error').textContent = e.message; }
    finally { if (target.session === getSession()) { busy = false; $('send-request').disabled = false; } }
  });
  $('request-decision-form').addEventListener('submit', async event => {
    event.preventDefault(); if (busy || !dialogTarget) return;
    const target = dialogTarget; busy = true; $('confirm-request-decision').disabled = true;
    try {
      if (target.action === 'delete_run') await api(path(target.request.id) + '/runs/' + target.runId, { method: 'DELETE' });
      else await api(path(target.request.id) + '/review', { method: 'POST', body: JSON.stringify({ version: target.request.version, action: target.action, ...(target.action !== 'approve' ? { comment: $('request-comment').value } : {}) }) });
      if (target.session !== getSession()) return;
      busy = false; $('request-decision-dialog').close(); await badge().catch(e => error(e.message));
      if (target.action === 'delete_run' && location.hash.includes('/runs/')) location.hash = 'requests/' + target.request.id; else await route(location.hash);
      toast(target.action === 'delete_run' ? 'Review run deleted.' : 'Review saved.');
    } catch (e) { if (target.session === getSession()) $('request-decision-error').textContent = e.message; }
    finally { if (target.session === getSession()) { busy = false; $('confirm-request-decision').disabled = false; } }
  });
  for (const [dialog, cancel] of [['request-dialog', 'cancel-request'], ['request-decision-dialog', 'cancel-request-decision']]) {
    $(cancel).addEventListener('click', () => { if (!busy) $(dialog).close(); });
    $(dialog).addEventListener('cancel', event => { if (busy) event.preventDefault(); });
    $(dialog).addEventListener('close', () => { if (dialog === 'request-dialog') draft = null; else dialogTarget = null; lockBody(); if (returnFocus?.isConnected && returnFocus.offsetParent) returnFocus.focus(); else $('user-menu-toggle').focus(); });
  }
  $('close-request-history').addEventListener('click', () => $('request-history-dialog').close());
  $('request-history-dialog').addEventListener('close', () => { lockBody(); if (historyReturnFocus?.isConnected && historyReturnFocus.offsetParent) historyReturnFocus.focus(); historyReturnFocus = null; });
  return { badge, reset, route, openSubmit, hasDraft: () => (!!draft && $('request-dialog').open) || (!!dialogTarget && $('request-decision-dialog').open), busy: () => busy, canSubmit };
}
