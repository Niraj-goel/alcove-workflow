// Alcove Accounts Workflow - browser app (no build step).
const S = { me: null, meta: null, cache: {} };
const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STATE_LABEL = { done_ontime: 'Done on time', done_late: 'Done late', awaiting: 'Awaiting approval', overdue: 'Overdue', upcoming: 'Upcoming', rejected: 'Sent back' };
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const FIELD_DEFS = [
  ['docType', 'Document type'], ['referenceLabel', 'Reference type'], ['referenceNo', 'Reference No (ARN / Ack / Challan)'],
  ['amount', 'Amount (Rs.)'], ['date', 'Date in document'], ['period', 'Period / Month'], ['financialYear', 'FY'],
  ['assessmentYear', 'AY'], ['gstin', 'GSTIN'], ['pan', 'PAN'], ['tan', 'TAN'], ['companyInDoc', 'Company in document'],
];

async function api(method, url, body, isForm) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    if (isForm) opts.body = body;
    else { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  }
  const res = await fetch(url, opts);
  if (res.status === 401 && url !== 'api/login') { showLogin(); throw new Error('Please log in'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

function toast(msg, isError) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' error' : '');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.add('hidden'), 3500);
}
const fail = err => toast(err.message, true);

function openModal(html) { $('#modalBox').innerHTML = html; $('#modal').classList.remove('hidden'); }
function closeModal() { $('#modal').classList.add('hidden'); $('#modalBox').innerHTML = ''; }
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });

const today = () => S.meta?.today || new Date().toISOString().slice(0, 10);
function localISO(dt) { return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`; }
function shiftDays(d, n) { const x = new Date(d + 'T00:00:00'); x.setDate(x.getDate() + n); return localISO(x); }
const pct = v => (v === null || v === undefined ? '-' : v + '%');
const fmtAmt = v => (v === undefined || v === '' || v === null ? '' : Number(v).toLocaleString('en-IN'));
const pill = state => `<span class="pill s-${state}">${STATE_LABEL[state] || state}</span>`;
const entity = r => esc([r.company, r.cost_centre].filter(Boolean).join(' / ') || '-');
const taskName = r => esc(r.alias && r.alias.length < r.description.length ? r.alias : r.description);

function pctBar(v) {
  if (v === null || v === undefined) return '<span class="muted">-</span>';
  const color = v >= 90 ? 'var(--green)' : v >= 70 ? 'var(--amber)' : 'var(--red)';
  return `<div class="pctcell"><div class="bar"><span style="width:${v}%;background:${color}"></span></div>${v}%</div>`;
}

function options(list, selected, blank = 'All') {
  return `<option value="">${blank}</option>` + list.map(v => `<option ${v === selected ? 'selected' : ''}>${esc(v)}</option>`).join('');
}

function scheduleText(tk) {
  if (tk.frequency === 'Daily') return `Daily ${tk.daily_time || '8:00 PM'}`;
  if (tk.frequency === 'Weekly') return 'Weekly: ' + String(tk.weekdays || '').split(',').filter(Boolean).map(d => WD[d]).join(', ');
  if (tk.frequency === 'Monthly') return `Monthly: day ${tk.month_days}`;
  if (tk.frequency === 'Once') return `Once: ${tk.once_date}`;
  try {
    const ys = JSON.parse(tk.year_sched || '{}');
    return 'Yearly: ' + Object.entries(ys).map(([m, d]) => `${MON[m]} ${d.join('/')}`).join(', ');
  } catch { return tk.frequency; }
}

// ---------------- login / shell ----------------
async function showLogin() {
  $('#shell').classList.add('hidden');
  $('#login').classList.remove('hidden');
  let users = await fetch('api/login-users').then(r => r.json()).catch(() => []);
  if (!Array.isArray(users)) users = [];
  const sel = $('#loginName');
  sel.innerHTML = '<option value="">Select your name</option>' +
    users.map(u => `<option value="${esc(u.username)}" data-pwd="${u.needsPassword ? 1 : 0}">${esc(u.name)}</option>`).join('');
  const syncPwd = () => {
    const needs = sel.selectedOptions[0]?.dataset.pwd === '1';
    $('#loginPwdRow').classList.toggle('hidden', !needs);
    $('#loginPwdRow input').required = needs;
  };
  sel.onchange = syncPwd;
  syncPwd();
}

$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    await api('POST', 'api/login', { username: f.get('username'), password: f.get('password') });
    $('#loginErr').textContent = '';
    start();
  } catch (err) { $('#loginErr').textContent = err.message; }
});

$('#logoutBtn').addEventListener('click', async () => { await api('POST', 'api/logout').catch(() => {}); location.hash = ''; showLogin(); });
$('#pwdBtn').addEventListener('click', () => passwordDialog(false));

function passwordDialog(forced) {
  openModal(`<h2>${forced ? 'Please set your own password' : 'Change password'}</h2>
    <div class="fields"><label>Current password<input type="password" id="pwCur"></label>
    <label>New password (min 6)<input type="password" id="pwNew"></label></div>
    <div class="row"><button class="btn primary" id="pwSave">Save</button>${forced ? '' : '<button class="btn" onclick="closeModal()">Cancel</button>'}</div>`);
  $('#pwSave').onclick = async () => {
    try {
      await api('POST', 'api/change-password', { current: $('#pwCur').value, next: $('#pwNew').value });
      closeModal(); toast('Password changed');
    } catch (err) { fail(err); }
  };
}

async function start() {
  try {
    S.me = await api('GET', 'api/me');
    S.meta = await api('GET', 'api/meta');
  } catch { return showLogin(); }
  $('#login').classList.add('hidden');
  $('#shell').classList.remove('hidden');
  $('#userName').textContent = `${S.me.name}${S.me.role === 'admin' ? ' (Admin)' : ''}`;
  buildNav();
  $('#pwdBtn').classList.toggle('hidden', S.me.role !== 'admin');
  if (!location.hash) location.hash = S.me.role === 'admin' ? '#dashboard' : '#tasks';
  route();
}

const isAdmin = () => S.me?.role === 'admin';

function buildNav() {
  const items = isAdmin()
    ? [['dashboard', 'Dashboard'], ['approvals', 'Approvals'], ['matrix', 'Compliance Matrix'], ['tasks', 'Tasks'],
      ['register', 'Attachment Register'], ['master', 'Task Master'], ['users', 'Users']]
    : [['tasks', 'My Tasks'], ['dashboard', S.me.team.length ? 'Team Dashboard' : 'My Dashboard'], ['register', 'My Attachments']];
  $('#nav').innerHTML = items.map(([k, l]) => `<a href="#${k}" data-k="${k}">${l}${k === 'approvals' ? '<span class="badge hidden" id="apprBadge"></span>' : ''}</a>`).join('');
  if (isAdmin()) refreshBadge();
}

async function refreshBadge() {
  const list = await api('GET', 'api/approvals').catch(() => []);
  const b = $('#apprBadge');
  if (!b) return;
  b.textContent = list.length;
  b.classList.toggle('hidden', !list.length);
}

window.addEventListener('hashchange', route);
function route() {
  if (!S.me) return;
  const key = (location.hash || '#tasks').slice(1).split('?')[0];
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('active', a.dataset.k === key));
  const views = { dashboard: viewDashboard, tasks: viewTasks, approvals: viewApprovals, matrix: viewMatrix, register: viewRegister, master: viewMaster, users: viewUsers };
  (views[key] || viewTasks)();
}

// ---------------- dashboard ----------------
S.dash = { from: '', to: '', doer: '', head: '', company: '', category: '', frequency: '' };

async function viewDashboard() {
  const f = S.dash;
  if (!f.from) { f.from = shiftDays(today(), -30); f.to = today(); }
  const m = S.meta;
  $('#view').innerHTML = `
    <div class="card"><div class="filters">
      <label>From<input type="date" id="dFrom" value="${f.from}"></label>
      <label>To<input type="date" id="dTo" value="${f.to}"></label>
      <div class="row">
        <button class="btn small" data-q="today">Today</button><button class="btn small" data-q="week">This week</button>
        <button class="btn small" data-q="month">This month</button><button class="btn small" data-q="30">Last 30 days</button>
        <button class="btn small" data-q="fy">This FY</button>
      </div>
      ${isAdmin() ? `<label>Reporting head<select id="dHead">${options(m.heads, f.head)}</select></label>` : ''}
      <label>Person<select id="dDoer">${options(isAdmin() ? m.people : [S.me.name, ...S.me.team], f.doer)}</select></label>
      <label>Company<select id="dCompany">${options(m.companies, f.company)}</select></label>
      <label>Category<select id="dCategory">${options(m.categories, f.category)}</select></label>
      <label>Frequency<select id="dFreq">${options(['Daily', 'Weekly', 'Monthly', 'Yearly', 'Once'], f.frequency)}</select></label>
      <button class="btn" id="dReset">Reset</button>
    </div></div>
    <div id="dashBody"><div class="card muted">Loading...</div></div>`;

  const set = (k, v) => { f[k] = v; viewDashboard(); };
  $('#dFrom').onchange = e => set('from', e.target.value);
  $('#dTo').onchange = e => set('to', e.target.value);
  if ($('#dHead')) $('#dHead').onchange = e => set('head', e.target.value);
  $('#dDoer').onchange = e => set('doer', e.target.value);
  $('#dCompany').onchange = e => set('company', e.target.value);
  $('#dCategory').onchange = e => set('category', e.target.value);
  $('#dFreq').onchange = e => set('frequency', e.target.value);
  $('#dReset').onclick = () => { S.dash = { from: '', to: '', doer: '', head: '', company: '', category: '', frequency: '' }; viewDashboard(); };
  document.querySelectorAll('[data-q]').forEach(b => b.onclick = () => {
    const td = today();
    const d = new Date(td + 'T00:00:00');
    const q = b.dataset.q;
    if (q === 'today') { f.from = td; f.to = td; }
    if (q === 'week') { const x = new Date(d); x.setDate(d.getDate() - ((d.getDay() + 6) % 7)); f.from = localISO(x); f.to = td; }
    if (q === 'month') { f.from = td.slice(0, 8) + '01'; f.to = td; }
    if (q === '30') { f.from = shiftDays(td, -30); f.to = td; }
    if (q === 'fy') { const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; f.from = `${y}-04-01`; f.to = td; }
    viewDashboard();
  });

  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  let d;
  try { d = await api('GET', 'api/dashboard?' + qs); } catch (err) { return fail(err); }
  const k = d.kpi;
  const table = (title, rows, keyCol, keyLabel, onClickKey) => `
    <div class="card"><h3>${title}</h3><div class="table-wrap"><table>
      <tr><th>${keyLabel}</th>${keyCol === 'doer' ? '<th>Reporting to</th>' : ''}<th class="num">Due</th><th class="num">On time</th>
      <th class="num">Late</th><th class="num">Overdue</th><th class="num">Awaiting</th><th>Timeliness</th><th>First-time-right</th></tr>
      ${rows.map(r => `<tr class="click" data-${onClickKey}="${esc(r[keyCol])}"><td>${esc(r[keyCol])}</td>${keyCol === 'doer' ? `<td class="muted">${esc(r.head)}</td>` : ''}
        <td class="num">${r.due}</td><td class="num">${r.onTime}</td><td class="num">${r.late || ''}</td>
        <td class="num" style="color:var(--red);font-weight:600">${r.overdue || ''}</td><td class="num">${r.awaiting || ''}</td>
        <td>${pctBar(r.onTimePct)}</td><td>${pctBar(r.firstPassPct)}</td></tr>`).join('') || '<tr><td colspan="9" class="muted">No tasks in this period</td></tr>'}
    </table></div></div>`;

  $('#dashBody').innerHTML = `
    <div class="kpis">
      <div class="kpi"><div class="v">${k.due}</div><div class="l">Tasks due in period</div></div>
      <div class="kpi green"><div class="v">${pct(k.onTimePct)}</div><div class="l">Done on time (${k.onTime})</div></div>
      <div class="kpi amber"><div class="v">${k.late}</div><div class="l">Done late</div></div>
      <div class="kpi red"><div class="v">${k.overdue}</div><div class="l">Overdue - not done</div></div>
      <div class="kpi blue"><div class="v">${k.awaiting}</div><div class="l">Awaiting approval</div></div>
      <div class="kpi green"><div class="v">${pct(k.firstPassPct)}</div><div class="l">First-time-right (${k.rejections} sent back)</div></div>
      <div class="kpi"><div class="v">${k.upcoming}</div><div class="l">Upcoming in period</div></div>
    </div>
    <div class="card"><h3>Daily on-time % </h3>
      <div class="trend">${d.trend.map(b => `<div class="${b.onTimePct < 70 ? 'bad' : b.onTimePct < 90 ? 'low' : ''}" style="height:${Math.max(3, b.onTimePct || 0)}%" title="${b.date}: ${pct(b.onTimePct)} on time, ${b.overdue} overdue"></div>`).join('')}</div>
      <div class="row muted"><span>${d.trend[0]?.date || ''}</span><span class="right">${d.trend[d.trend.length - 1]?.date || ''}</span></div>
    </div>
    ${table('Person-wise', d.byPerson, 'doer', 'Person', 'doer')}
    <div class="grid2">
      ${isAdmin() ? table('Reporting head-wise', d.byHead, 'head', 'Reporting head', 'head') : ''}
      ${table('Category-wise', d.byCategory, 'category', 'Category', 'category')}
    </div>
    ${table('Company-wise', d.byCompany, 'company', 'Company / Individual', 'company')}
    <div class="card"><h3>Overdue tasks (${d.overdue.length})</h3><div class="table-wrap"><table>
      <tr><th>Due</th><th class="num">Days late</th><th>Person</th><th>Task</th><th>Company</th><th>Category</th></tr>
      ${d.overdue.map(r => `<tr class="click" data-inst="${r.id}"><td>${esc(r.due_at)}</td><td class="num" style="color:var(--red)">${r.daysLate}</td>
        <td>${esc(r.doer)}</td><td>${taskName(r)}</td><td>${entity(r)}</td><td>${esc(r.category)}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Nothing overdue</td></tr>'}
    </table></div></div>`;

  document.querySelectorAll('#dashBody [data-doer]').forEach(tr => tr.onclick = () => set('doer', tr.dataset.doer));
  document.querySelectorAll('#dashBody [data-head]').forEach(tr => tr.onclick = () => set('head', tr.dataset.head === '-' ? '' : tr.dataset.head));
  document.querySelectorAll('#dashBody [data-company]').forEach(tr => tr.onclick = () => set('company', tr.dataset.company === '(General)' ? '' : tr.dataset.company));
  document.querySelectorAll('#dashBody [data-category]').forEach(tr => tr.onclick = () => set('category', tr.dataset.category));
  document.querySelectorAll('#dashBody [data-inst]').forEach(tr => tr.onclick = () => openTask(tr.dataset.inst));
}

// ---------------- tasks ----------------
S.tasks = { tab: 'today', scope: 'mine', doer: '', company: '', search: '' };

async function viewTasks() {
  const st = S.tasks;
  if (isAdmin() && st.scope === 'mine' && !st._init) { st.scope = 'all'; st._init = true; }
  const scopes = isAdmin() ? [['all', 'Whole team'], ['mine', 'My own']] : S.me.team.length ? [['mine', 'My tasks'], ['team', 'My team']] : [];
  const people = isAdmin() ? S.meta.people : S.me.team;
  $('#view').innerHTML = `<div class="card">
    <div class="filters">
      ${scopes.length ? `<label>Show<select id="tScope">${scopes.map(([v, l]) => `<option value="${v}" ${v === st.scope ? 'selected' : ''}>${l}</option>`).join('')}</select></label>` : ''}
      ${st.scope !== 'mine' ? `<label>Person<select id="tDoer">${options(people, st.doer)}</select></label>` : ''}
      <label>Company<select id="tCompany">${options(S.meta.companies, st.company)}</select></label>
      <label>Search<input id="tSearch" value="${esc(st.search)}" placeholder="task / company"></label>
      <button class="btn green right" id="bulkDone" disabled>Mark selected Done</button>
    </div>
    <div class="tabs" id="tTabs"></div>
    <div class="table-wrap" id="tList"><p class="muted">Loading...</p></div></div>`;

  if ($('#tScope')) $('#tScope').onchange = e => { st.scope = e.target.value; st.doer = ''; viewTasks(); };
  if ($('#tDoer')) $('#tDoer').onchange = e => { st.doer = e.target.value; viewTasks(); };
  $('#tCompany').onchange = e => { st.company = e.target.value; viewTasks(); };
  $('#tSearch').oninput = e => { st.search = e.target.value; renderTaskList(); };

  const qs = new URLSearchParams({ scope: st.scope, ...(st.doer && { doer: st.doer }), ...(st.company && { company: st.company }) });
  try { S.cache.tasks = await api('GET', 'api/my-tasks?' + qs); } catch (err) { return fail(err); }
  renderTaskList();
}

function renderTaskList() {
  const st = S.tasks;
  const td = today();
  const q = st.search.toLowerCase();
  const all = (S.cache.tasks || []).filter(r => !q || `${r.description} ${r.alias} ${r.company} ${r.cost_centre} ${r.doer}`.toLowerCase().includes(q));
  const groups = {
    overdue: all.filter(r => r.state === 'overdue'),
    today: all.filter(r => r.due_date === td && r.state === 'upcoming'),
    upcoming: all.filter(r => r.state === 'upcoming' && r.due_date > td),
    rejected: all.filter(r => r.status === 'rejected'),
    awaiting: all.filter(r => r.state === 'awaiting'),
    done: all.filter(r => r.state.startsWith('done')),
  };
  const labels = { overdue: 'Overdue', today: 'Due today', upcoming: 'Upcoming', rejected: 'Sent back', awaiting: 'Awaiting approval', done: 'Done (7 days)' };
  $('#tTabs').innerHTML = Object.keys(labels).map(k => `<button data-tab="${k}" class="${k === st.tab ? 'active' : ''}">${labels[k]} (${groups[k].length})</button>`).join('');
  document.querySelectorAll('#tTabs button').forEach(b => b.onclick = () => { st.tab = b.dataset.tab; renderTaskList(); });

  const rows = groups[st.tab];
  const canBulk = r => ['pending', 'rejected'].includes(r.status) && !r.approval_required && !r.proofRequired && (isAdmin() || r.doer === S.me.name);
  $('#tList').innerHTML = `<table>
    <tr><th><input type="checkbox" id="chkAll"></th><th>Due</th><th>Status</th>${st.scope !== 'mine' ? '<th>Person</th>' : ''}<th>Task</th><th>Company / Cost centre</th><th>Freq.</th><th>Proof</th></tr>
    ${rows.map(r => `<tr class="click" data-id="${r.id}">
      <td onclick="event.stopPropagation()">${canBulk(r) ? `<input type="checkbox" class="chk" value="${r.id}">` : ''}</td>
      <td>${esc(r.due_at)}</td><td>${pill(r.status === 'rejected' ? 'rejected' : r.state)}</td>
      ${st.scope !== 'mine' ? `<td>${esc(r.doer)}</td>` : ''}<td>${taskName(r)}${r.approval_required ? ' <span class="muted">• approval</span>' : ''}</td>
      <td>${entity(r)}</td><td>${r.frequency}</td><td>${r.attachment_count ? '📎 ' + r.attachment_count : r.proofRequired ? '<span class="muted">needed</span>' : ''}</td></tr>`).join('')
      || `<tr><td colspan="8" class="muted">Nothing here</td></tr>`}
  </table>`;
  document.querySelectorAll('#tList tr[data-id]').forEach(tr => tr.onclick = () => openTask(tr.dataset.id));
  const bulk = $('#bulkDone');
  const sync = () => { bulk.disabled = !document.querySelectorAll('.chk:checked').length; };
  document.querySelectorAll('.chk').forEach(c => c.onchange = sync);
  $('#chkAll').onchange = e => { document.querySelectorAll('.chk').forEach(c => { c.checked = e.target.checked; }); sync(); };
  bulk.onclick = async () => {
    const ids = [...document.querySelectorAll('.chk:checked')].map(c => Number(c.value));
    try {
      const r = await api('POST', 'api/instances/bulk-done', { ids });
      toast(`${r.done} task(s) marked done`); viewTasks();
    } catch (err) { fail(err); }
  };
}

// ---------------- single task (upload / submit / approve) ----------------
async function openTask(id) {
  let d;
  try { d = await api('GET', 'api/instances/' + id); } catch (err) { return fail(err); }
  const editable = d.canWork && ['pending', 'rejected'].includes(d.status);
  const state = d.status === 'rejected' ? 'rejected' : d.state;
  openModal(`
    <div class="row"><h2>${esc(d.alias || d.description)}</h2><button class="btn small right" onclick="closeModal()">✕</button></div>
    <div class="kv">
      <div>Status</div><div>${pill(state)} ${d.submitted_at ? `<span class="muted">submitted ${esc(d.submitted_at)}${d.submitted_at > d.due_at ? ' (late)' : ''}</span>` : ''}</div>
      <div>Full task</div><div>${esc(d.description)}</div>
      <div>Company / Cost centre</div><div>${entity(d)}</div>
      <div>Due</div><div>${esc(d.due_at)} <span class="muted">(${d.frequency})</span></div>
      <div>Doer</div><div>${esc(d.doer)} <span class="muted">reports to ${esc(d.reporting_to)}</span></div>
      <div>Category</div><div>${esc(d.category)} ${d.approval_required ? '• needs approval' : '• auto-done on submit'} ${d.proofRequired ? '• proof required' : ''}</div>
      ${d.review_note ? `<div>Reviewer note</div><div><b>${esc(d.review_note)}</b> <span class="muted">- ${esc(d.reviewed_by)} ${esc(d.reviewed_at)}</span></div>` : ''}
      ${d.remarks ? `<div>Doer remarks</div><div>${esc(d.remarks)}</div>` : ''}
    </div>
    <h3>Attachments & details</h3>
    <div id="atts">${d.attachments.map(a => attBlock(a, editable)).join('') || '<p class="muted">No attachment yet.</p>'}</div>
    ${editable ? `<div class="row"><input type="file" id="fileIn" multiple accept=".pdf,.jpg,.jpeg,.png,.xlsx,.xls,.csv,.doc,.docx">
      <span class="muted">PDF challan / acknowledgement - details are read automatically</span></div>
      <label class="muted" style="display:block;margin-top:10px">Remarks<textarea id="remarks">${esc(d.remarks)}</textarea></label>
      <div class="row" style="margin-top:8px"><button class="btn primary" id="submitBtn">${d.approval_required ? 'Submit for approval' : 'Mark Done'}</button></div>` : ''}
    ${d.canReview && d.status === 'submitted' ? `<div class="card" style="margin-top:12px"><h3>Review</h3>
      <textarea id="revNote" placeholder="Note (required when sending back)"></textarea>
      <div class="row"><button class="btn green" id="apprBtn">Approve</button><button class="btn red" id="rejBtn">Send back</button></div></div>` : ''}
    ${d.canReview && d.status === 'done' ? `<div class="row" style="margin-top:10px"><input id="revNote" placeholder="Reason" style="flex:1"><button class="btn red" id="rejBtn">Send back for correction</button></div>` : ''}
    <h3 style="margin-top:14px">Comments</h3>
    <div>${d.comments.map(c => `<p><b>${esc(c.user)}</b> <span class="muted">${esc(c.created_at)}</span><br>${esc(c.text)}</p>`).join('') || '<p class="muted">No comments</p>'}</div>
    <div class="row"><input id="cmt" placeholder="Write a comment" style="flex:1"><button class="btn" id="cmtBtn">Add</button></div>`);

  if (editable) {
    $('#fileIn').onchange = async e => {
      for (const file of e.target.files) {
        const fd = new FormData();
        fd.append('file', file);
        try {
          toast('Uploading ' + file.name + '...');
          await api('POST', `api/instances/${id}/upload`, fd, true);
        } catch (err) { fail(err); }
      }
      openTask(id);
    };
    $('#submitBtn').onclick = async () => {
      const fields = {};
      document.querySelectorAll('.att[data-att]').forEach(box => {
        const f = {};
        box.querySelectorAll('[data-f]').forEach(inp => { if (inp.value.trim()) f[inp.dataset.f] = inp.value.trim(); });
        fields[box.dataset.att] = { ...JSON.parse(box.dataset.extra || '{}'), ...f };
      });
      try {
        const r = await api('POST', `api/instances/${id}/submit`, { remarks: $('#remarks').value, fields });
        toast(r.status === 'done' ? 'Marked done' : 'Sent for approval');
        closeModal(); route();
      } catch (err) { fail(err); }
    };
    document.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      if (!confirm('Remove this attachment?')) return;
      try { await api('DELETE', 'api/attachments/' + b.dataset.del); openTask(id); } catch (err) { fail(err); }
    });
  }
  if ($('#apprBtn')) $('#apprBtn').onclick = () => reviewAct(id, true);
  if ($('#rejBtn')) $('#rejBtn').onclick = () => reviewAct(id, false);
  $('#cmtBtn').onclick = async () => {
    try { await api('POST', `api/instances/${id}/comments`, { text: $('#cmt').value }); openTask(id); } catch (err) { fail(err); }
  };
}

function attBlock(a, editable) {
  const f = a.fields || {};
  const ex = a.extracted || {};
  const extra = { textFound: ex.textFound, note: ex.note, warning: ex.warning };
  return `<div class="att" data-att="${a.id}" data-extra='${esc(JSON.stringify(extra))}'>
    <div class="row"><a href="files/${a.id}" target="_blank">📎 ${esc(a.original_name)}</a>
      <span class="muted">${esc(a.uploaded_at || '')}</span>
      ${editable ? `<button class="btn small right" data-del="${a.id}">Remove</button>` : ''}</div>
    ${ex.warning ? `<div class="warn">⚠ ${esc(ex.warning)}</div>` : ''}
    ${ex.note ? `<div class="muted">${esc(ex.note)}</div>` : ''}
    <div class="fields">${FIELD_DEFS.map(([k, l]) => `<label>${l}<input data-f="${k}" value="${esc(f[k] ?? '')}" ${editable ? '' : 'readonly'}></label>`).join('')}</div>
  </div>`;
}

async function reviewAct(id, approve) {
  const note = $('#revNote') ? $('#revNote').value : '';
  try {
    await api('POST', `api/instances/${id}/${approve ? 'approve' : 'reject'}`, { note });
    toast(approve ? 'Approved' : 'Sent back');
    closeModal(); route(); refreshBadge();
  } catch (err) { fail(err); }
}

// ---------------- approvals ----------------
async function viewApprovals() {
  $('#view').innerHTML = '<div class="card muted">Loading...</div>';
  let rows;
  try { rows = await api('GET', 'api/approvals'); } catch (err) { return fail(err); }
  refreshBadge();
  $('#view').innerHTML = `<div class="card">
    <div class="row"><h2>Awaiting your approval (${rows.length})</h2>
      <button class="btn green right" id="bulkAppr" disabled>Approve selected</button></div>
    <div class="table-wrap"><table>
      <tr><th><input type="checkbox" id="aAll"></th><th>Due</th><th>Submitted</th><th>Person</th><th>Task</th><th>Company</th>
      <th>Reference No</th><th class="num">Amount</th><th>Period</th><th></th></tr>
      ${rows.map(r => {
        const f = (r.attachments[0] || {}).fields || {};
        return `<tr><td><input type="checkbox" class="achk" value="${r.id}"></td><td>${esc(r.due_at)}</td>
        <td>${esc(r.submitted_at)} ${r.late ? '<span class="pill s-done_late">late</span>' : '<span class="pill s-done_ontime">on time</span>'}</td>
        <td>${esc(r.doer)}</td><td>${taskName(r)}</td><td>${entity(r)}</td>
        <td>${esc(f.referenceNo || '')} <span class="muted">${esc(f.referenceLabel || '')}</span></td><td class="num">${fmtAmt(f.amount)}</td>
        <td>${esc(f.period || '')}</td>
        <td><div class="row"><button class="btn small" data-open="${r.id}">Open</button>
          ${r.attachments.map(a => `<a href="files/${a.id}" target="_blank" title="${esc(a.original_name)}">📎</a>`).join(' ')}</div></td></tr>`;
      }).join('') || '<tr><td colspan="10" class="muted">Nothing waiting. 👍</td></tr>'}
    </table></div></div>`;
  const sync = () => { $('#bulkAppr').disabled = !document.querySelectorAll('.achk:checked').length; };
  document.querySelectorAll('.achk').forEach(c => c.onchange = sync);
  $('#aAll').onchange = e => { document.querySelectorAll('.achk').forEach(c => { c.checked = e.target.checked; }); sync(); };
  document.querySelectorAll('[data-open]').forEach(b => b.onclick = () => openTask(b.dataset.open));
  $('#bulkAppr').onclick = async () => {
    const ids = [...document.querySelectorAll('.achk:checked')].map(c => Number(c.value));
    try { const r = await api('POST', 'api/approvals/bulk-approve', { ids }); toast(`${r.count} approved`); viewApprovals(); } catch (err) { fail(err); }
  };
}

// ---------------- compliance matrix ----------------
S.matrixMonth = '';
const CELL_TEXT = { green: c => `✓ ${c.done}/${c.total}`, amber: c => `${c.late} late`, red: c => `${c.overdue} overdue`,
  blue: c => `${c.awaiting} to approve`, grey: c => `${c.done}/${c.total} done`, na: () => 'N/A', gap: () => '⚠ no task', none_this_month: () => '—' };

async function viewMatrix() {
  if (!S.matrixMonth) S.matrixMonth = today().slice(0, 7);
  $('#view').innerHTML = '<div class="card muted">Loading...</div>';
  let d;
  try { d = await api('GET', 'api/matrix?month=' + S.matrixMonth); } catch (err) { return fail(err); }
  $('#view').innerHTML = `<div class="card">
    <div class="row"><h2>Compliance Matrix</h2><label class="right">Month <input type="month" id="mMonth" value="${S.matrixMonth}"></label></div>
    <div class="legend">
      <span class="c-green">✓ all done on time</span><span class="c-amber">done, some late</span><span class="c-red">overdue</span>
      <span class="c-blue">awaiting approval</span><span class="c-grey">due later this month</span><span class="c-none_this_month">— nothing due this month</span>
      <span class="c-gap">⚠ applicable but no task assigned</span><span class="c-na">N/A</span>
    </div>
    <p class="muted">Click a cell to see its tasks, or to mark the compliance Not Applicable / Applicable for that company.</p>
    <div class="table-wrap"><table class="matrix">
      <tr><th>Company / Individual</th>${d.categories.map(c => `<th style="text-align:center">${c}</th>`).join('')}</tr>
      ${d.grid.map(r => `<tr><td>${esc(r.company)}</td>${r.cells.map(c => `<td class="cell c-${c.status}" data-co="${esc(r.company)}" data-cat="${esc(c.category)}" data-app="${c.applicable ? 1 : 0}">${CELL_TEXT[c.status](c)}</td>`).join('')}</tr>`).join('')}
    </table></div></div>`;
  $('#mMonth').onchange = e => { S.matrixMonth = e.target.value; viewMatrix(); };
  document.querySelectorAll('td.cell').forEach(td => td.onclick = () => {
    const { co, cat, app } = td.dataset;
    openModal(`<h2>${esc(co)} - ${esc(cat)}</h2><div class="row">
      <button class="btn primary" id="mView">View tasks on dashboard</button>
      <button class="btn" id="mToggle">${app === '1' ? 'Mark NOT applicable' : 'Mark applicable'}</button>
      <button class="btn right" onclick="closeModal()">Close</button></div>`);
    $('#mView').onclick = () => {
      const [y, m] = S.matrixMonth.split('-').map(Number);
      S.dash = { from: `${S.matrixMonth}-01`, to: localISO(new Date(y, m, 0)), doer: '', head: '', company: co, category: cat, frequency: '' };
      closeModal(); location.hash = '#dashboard';
    };
    $('#mToggle').onclick = async () => {
      try { await api('POST', 'api/matrix/applicability', { company: co, category: cat, applicable: app !== '1' }); closeModal(); viewMatrix(); } catch (err) { fail(err); }
    };
  });
}

// ---------------- attachment register ----------------
S.reg = { from: '', to: '', company: '', category: '', doer: '' };

async function viewRegister() {
  const f = S.reg;
  if (!f.from) { f.from = today().slice(0, 8) + '01'; f.to = shiftDays(today(), 31); }
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  $('#view').innerHTML = `<div class="card">
    <div class="filters">
      <label>Due from<input type="date" id="rFrom" value="${f.from}"></label><label>Due to<input type="date" id="rTo" value="${f.to}"></label>
      <label>Company<select id="rCompany">${options(S.meta.companies, f.company)}</select></label>
      <label>Category<select id="rCategory">${options(S.meta.categories, f.category)}</select></label>
      ${isAdmin() || S.me.team.length ? `<label>Person<select id="rDoer">${options(isAdmin() ? S.meta.people : [S.me.name, ...S.me.team], f.doer)}</select></label>` : ''}
      <a class="btn primary right" href="api/register.csv?${qs}">Download Excel (CSV)</a>
    </div><div class="table-wrap" id="rList"><p class="muted">Loading...</p></div></div>`;
  const set = (k, v) => { f[k] = v; viewRegister(); };
  $('#rFrom').onchange = e => set('from', e.target.value);
  $('#rTo').onchange = e => set('to', e.target.value);
  $('#rCompany').onchange = e => set('company', e.target.value);
  $('#rCategory').onchange = e => set('category', e.target.value);
  if ($('#rDoer')) $('#rDoer').onchange = e => set('doer', e.target.value);
  let rows;
  try { rows = await api('GET', 'api/register?' + qs); } catch (err) { return fail(err); }
  $('#rList').innerHTML = `<p class="muted">${rows.length} document(s). Details are read from the uploaded PDF and confirmed by the doer.</p><table>
    <tr><th>Due</th><th>Company</th><th>Category</th><th>Task</th><th>Doer</th><th>Document</th><th>Reference No</th>
    <th class="num">Amount</th><th>Doc date</th><th>Period</th><th>GSTIN / PAN / TAN</th><th>Status</th><th>File</th></tr>
    ${rows.map(r => { const x = r.fields; return `<tr class="click" data-inst="${r.instance_id}"><td>${esc(r.due_date)}</td><td>${entity(r)}</td><td>${esc(r.category)}</td>
      <td>${taskName(r)}</td><td>${esc(r.doer)}</td><td>${esc(x.docType || '')}</td>
      <td>${esc(x.referenceNo || '')} <span class="muted">${esc(x.referenceLabel || '')}</span></td><td class="num">${fmtAmt(x.amount)}</td>
      <td>${esc(x.date || '')}</td><td>${esc(x.period || x.financialYear || x.assessmentYear || '')}</td>
      <td class="muted">${esc([x.gstin, x.pan, x.tan].filter(Boolean).join(' '))}</td><td>${esc(r.status)}</td>
      <td onclick="event.stopPropagation()"><a href="files/${r.id}" target="_blank">📎</a></td></tr>`; }).join('') || '<tr><td colspan="13" class="muted">No attachments in this period</td></tr>'}
  </table>`;
  document.querySelectorAll('#rList [data-inst]').forEach(tr => tr.onclick = () => openTask(tr.dataset.inst));
}

// ---------------- task master ----------------
S.master = { search: '', doer: '', company: '', category: '', frequency: '', active: '' };

async function viewMaster() {
  const f = S.master;
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  $('#view').innerHTML = `
    <div class="grid2">
      <div class="card"><h3>Import checklist (CSV)</h3>
        <p class="muted">Same "Job Checklist - Bulk Add / Delete Import" format. Blank Action = add / update, <b>DELETE</b> = remove.
        In Excel use File → Save As → CSV.</p>
        <div class="row"><input type="file" id="impFile" accept=".csv">
          <label class="muted"><input type="checkbox" id="impReplace"> File is the full master (remove tasks not in file)</label></div>
        <div class="row" style="margin-top:8px"><button class="btn primary" id="impBtn">Import</button><a class="btn" href="api/tasks/export.csv?${qs}">Export filtered tasks for import</a></div>
        <pre id="impOut" class="muted" style="white-space:pre-wrap"></pre>
        <hr><div class="row"><label class="muted">Go-live date (tasks are tracked from this date)
          <input type="date" id="goLive" value="${S.meta.goLiveDate}"></label><button class="btn" id="goLiveBtn">Save</button></div>
      </div>
      <div class="card"><h3>Assign a one-time (ad-hoc) task</h3>
        <div class="fields">
          <label>Person<select id="ahDoer">${options(S.meta.people, '', 'Select')}</select></label>
          <label>Due date<input type="date" id="ahDue" value="${today()}"></label>
          <label>Company<input id="ahCo" list="coList"></label>
          <label>Cost centre<input id="ahCc"></label>
          <label>Category<select id="ahCat">${options(S.meta.categories, '', 'Auto')}</select></label>
          <label>Needs approval<select id="ahAppr"><option value="">Auto</option><option value="1">Yes</option><option value="0">No</option></select></label>
        </div>
        <datalist id="coList">${S.meta.companies.map(c => `<option value="${esc(c)}">`).join('')}</datalist>
        <textarea id="ahDesc" placeholder="Task description, e.g. Reply to GST notice ASMT-10 for FY 2023-24"></textarea>
        <button class="btn primary" id="ahBtn" style="margin-top:8px">Assign task</button>
      </div>
    </div>
    <div class="card">
      <div class="filters">
        <label>Search<input id="mSearch" value="${esc(f.search)}"></label>
        <label>Person<select id="mDoer">${options(S.meta.people, f.doer)}</select></label>
        <label>Company<select id="mCompany">${options(S.meta.companies, f.company)}</select></label>
        <label>Category<select id="mCategory">${options(S.meta.categories, f.category)}</select></label>
        <label>Frequency<select id="mFreq">${options(['Daily', 'Weekly', 'Monthly', 'Yearly', 'Once'], f.frequency)}</select></label>
        <label>Active<select id="mActive"><option value="">Active</option><option value="0" ${f.active === '0' ? 'selected' : ''}>Removed</option><option value="all" ${f.active === 'all' ? 'selected' : ''}>All</option></select></label>
        <button class="btn" id="mApprAll">Set "needs approval" for all shown</button>
        <button class="btn" id="mApprNone">Remove approval for all shown</button>
      </div>
      <div class="table-wrap" id="mList"><p class="muted">Loading...</p></div>
    </div>`;

  const set = (k, v) => { f[k] = v; viewMaster(); };
  $('#mSearch').onchange = e => set('search', e.target.value);
  $('#mDoer').onchange = e => set('doer', e.target.value);
  $('#mCompany').onchange = e => set('company', e.target.value);
  $('#mCategory').onchange = e => set('category', e.target.value);
  $('#mFreq').onchange = e => set('frequency', e.target.value);
  $('#mActive').onchange = e => set('active', e.target.value);

  $('#impBtn').onclick = async () => {
    const file = $('#impFile').files[0];
    if (!file) return toast('Choose a CSV file first', true);
    if ($('#impReplace').checked && !confirm('Tasks NOT present in this file will be removed. Continue?')) return;
    const fd = new FormData();
    fd.append('file', file);
    fd.append('replaceAll', $('#impReplace').checked ? 'true' : 'false');
    $('#impOut').textContent = 'Importing...';
    try {
      const r = await api('POST', 'api/import', fd, true);
      $('#impOut').textContent = `Added: ${r.added}  Updated: ${r.updated}  Deleted: ${r.deleted}  Removed (not in file): ${r.deactivated}  Skipped: ${r.skipped}\nTask dates created: ${r.instancesCreated}` + (r.errors.length ? '\n' + r.errors.slice(0, 20).join('\n') : '');
      S.meta = await api('GET', 'api/meta');
      setTimeout(viewMaster, 1500);
    } catch (err) { $('#impOut').textContent = err.message; }
  };
  $('#goLiveBtn').onclick = async () => {
    try { await api('POST', 'api/settings', { go_live_date: $('#goLive').value }); S.meta = await api('GET', 'api/meta'); toast('Saved'); } catch (err) { fail(err); }
  };
  $('#ahBtn').onclick = async () => {
    const body = { doer: $('#ahDoer').value, due_date: $('#ahDue').value, company: $('#ahCo').value, cost_centre: $('#ahCc').value,
      category: $('#ahCat').value, description: $('#ahDesc').value };
    if ($('#ahAppr').value !== '') body.approval_required = $('#ahAppr').value === '1';
    try { await api('POST', 'api/adhoc', body); toast('Task assigned'); $('#ahDesc').value = ''; } catch (err) { fail(err); }
  };

  let tasks;
  try { tasks = await api('GET', 'api/tasks?' + qs); } catch (err) { return fail(err); }
  const bulkAppr = async on => {
    if (!confirm(`${on ? 'Set' : 'Remove'} approval for ${tasks.length} task(s)?`)) return;
    try { await api('POST', 'api/tasks/bulk', { ids: tasks.map(x => x.id), approval_required: on }); viewMaster(); } catch (err) { fail(err); }
  };
  $('#mApprAll').onclick = () => bulkAppr(true);
  $('#mApprNone').onclick = () => bulkAppr(false);

  const shown = tasks.slice(0, 600);
  $('#mList').innerHTML = `<p class="muted">${tasks.length} task(s)${tasks.length > shown.length ? ` - showing first ${shown.length}, use filters to narrow` : ''}</p><table>
    <tr><th>Freq.</th><th>Person</th><th>Reporting to</th><th>Task</th><th>Company / CC</th><th>Schedule</th><th>Category</th><th>Needs approval</th><th>Active</th></tr>
    ${shown.map(tk => `<tr><td>${tk.frequency}</td><td>${esc(tk.doer)}</td><td class="muted">${esc(tk.reporting_to)}</td>
      <td title="${esc(tk.description)}">${taskName(tk)}</td><td>${entity(tk)}</td><td class="muted">${esc(scheduleText(tk))}</td>
      <td><select data-cat="${tk.id}">${S.meta.categories.map(c => `<option ${c === tk.category ? 'selected' : ''}>${c}</option>`).join('')}</select></td>
      <td><input type="checkbox" data-appr="${tk.id}" ${tk.approval_required ? 'checked' : ''}></td>
      <td><input type="checkbox" data-act="${tk.id}" ${tk.active ? 'checked' : ''}></td></tr>`).join('')}
  </table>`;
  const patch = (id, body) => api('PATCH', 'api/tasks/' + id, body).then(() => toast('Saved')).catch(fail);
  document.querySelectorAll('[data-cat]').forEach(s => s.onchange = () => patch(s.dataset.cat, { category: s.value }));
  document.querySelectorAll('[data-appr]').forEach(c => c.onchange = () => patch(c.dataset.appr, { approval_required: c.checked }));
  document.querySelectorAll('[data-act]').forEach(c => c.onchange = () => {
    if (!c.checked && !confirm('Remove this task? Its future dates will be deleted (history stays).')) { c.checked = true; return; }
    patch(c.dataset.act, { active: c.checked });
  });
}

// ---------------- users ----------------
async function viewUsers() {
  let users;
  try { users = await api('GET', 'api/users'); } catch (err) { return fail(err); }
  $('#view').innerHTML = `<div class="card">
    <div class="row"><h2>Users (${users.length})</h2>
      <input id="nuName" placeholder="New person's full name" class="right"><button class="btn" id="nuBtn">Add user</button>
      <button class="btn" id="digestBtn">Send e-mail digest now</button></div>
    <p class="muted">Users are created automatically from the checklist. Team members log in by picking their name (no password);
    admins also need their password. Add e-mail IDs to send daily reminders.</p>
    <div class="table-wrap"><table>
      <tr><th>Name</th><th>Username</th><th>Reporting to</th><th>Role</th><th>E-mail</th><th>Active</th><th></th></tr>
      ${users.map(u => `<tr><td>${esc(u.name)}</td><td><code>${esc(u.username)}</code>${u.role === 'admin' && u.must_change ? ' <span class="muted">(default pwd)</span>' : ''}</td>
        <td class="muted">${esc(u.reporting_to)}</td>
        <td><select data-role="${u.id}"><option ${u.role === 'member' ? 'selected' : ''}>member</option><option ${u.role === 'admin' ? 'selected' : ''}>admin</option></select></td>
        <td><input data-email="${u.id}" value="${esc(u.email)}" placeholder="name@alcoverealty.in"></td>
        <td><input type="checkbox" data-uact="${u.id}" ${u.active ? 'checked' : ''}></td>
        <td>${u.role === 'admin' ? `<button class="btn small" data-reset="${u.id}">Reset password</button>` : ''}</td></tr>`).join('')}
    </table></div></div>`;
  const patch = (id, body, msg = 'Saved') => api('PATCH', 'api/users/' + id, body).then(() => toast(msg)).catch(fail);
  document.querySelectorAll('[data-role]').forEach(s => s.onchange = () => patch(s.dataset.role, { role: s.value }));
  document.querySelectorAll('[data-email]').forEach(i => i.onchange = () => patch(i.dataset.email, { email: i.value }));
  document.querySelectorAll('[data-uact]').forEach(c => c.onchange = () => patch(c.dataset.uact, { active: c.checked }));
  document.querySelectorAll('[data-reset]').forEach(b => b.onclick = () => confirm('Reset to the default password?') && patch(b.dataset.reset, { resetPassword: true }, 'Password reset to default'));
  $('#nuBtn').onclick = async () => {
    try { await api('POST', 'api/users', { name: $('#nuName').value }); S.meta = await api('GET', 'api/meta'); viewUsers(); } catch (err) { fail(err); }
  };
  $('#digestBtn').onclick = async () => {
    try { const r = await api('POST', 'api/digest/send-now'); toast(r.reason || `Sent ${r.sent} e-mail(s)`); } catch (err) { fail(err); }
  };
}

start();
