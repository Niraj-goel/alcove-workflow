// Dashboard / matrix calculations: timeliness (on-time vs late) and correctness (approved first time).
const { db } = require('./db');
const { COMPLIANCE_CATEGORIES } = require('./classify');
const t = require('./time');

const BASE_SQL = `
  SELECT i.*, tk.frequency, tk.doer, tk.reporting_to, tk.description, tk.alias, tk.company, tk.cost_centre,
         tk.category, tk.approval_required, tk.department,
         (SELECT COUNT(*) FROM attachments a WHERE a.instance_id = i.id) AS attachment_count
  FROM instances i JOIN tasks tk ON tk.id = i.task_id`;

function queryInstances(f = {}) {
  const where = [];
  const args = [];
  if (f.from) { where.push('i.due_date >= ?'); args.push(f.from); }
  if (f.to) { where.push('i.due_date <= ?'); args.push(f.to); }
  for (const [key, col] of [['doer', 'tk.doer'], ['head', 'tk.reporting_to'], ['company', 'tk.company'],
    ['category', 'tk.category'], ['frequency', 'tk.frequency'], ['status', 'i.status']]) {
    if (f[key]) { where.push(`${col} = ?`); args.push(f[key]); }
  }
  if (f.doers) { where.push(`tk.doer IN (${f.doers.map(() => '?').join(',')})`); args.push(...f.doers); }
  const sql = BASE_SQL + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY i.due_at, tk.doer';
  return db.prepare(sql).all(...args);
}

// One of: done_ontime, done_late, awaiting (submitted, waiting for approval), overdue, upcoming
function stateOf(row, nowStr = t.now()) {
  if (row.status === 'done') return row.submitted_at <= row.due_at ? 'done_ontime' : 'done_late';
  if (row.status === 'submitted') return 'awaiting';
  return row.due_at < nowStr ? 'overdue' : 'upcoming';
}

function emptyBucket(extra = {}) {
  return { ...extra, total: 0, due: 0, onTime: 0, late: 0, awaiting: 0, overdue: 0, upcoming: 0, approvedCount: 0, firstPass: 0, rejections: 0 };
}

function addTo(b, row, state) {
  b.total++;
  if (state === 'upcoming') { b.upcoming++; return; }
  b.due++;
  if (state === 'overdue') b.overdue++;
  else {
    if (state === 'awaiting') b.awaiting++;
    if (row.submitted_at && row.submitted_at <= row.due_at) b.onTime++; else b.late++;
  }
  b.rejections += row.reject_count;
  if (row.status === 'done' && row.approval_required) {
    b.approvedCount++;
    if (!row.reject_count) b.firstPass++;
  }
}

function finish(b) {
  const pct = (a, z) => (z ? Math.round((a / z) * 1000) / 10 : null);
  b.onTimePct = pct(b.onTime, b.due);
  b.completionPct = pct(b.onTime + b.late, b.due);
  b.firstPassPct = pct(b.firstPass, b.approvedCount);
  return b;
}

function groupBy(rows, states, keyFn, extraFn) {
  const map = new Map();
  rows.forEach((r, i) => {
    const k = keyFn(r);
    if (!map.has(k)) map.set(k, emptyBucket(extraFn(r)));
    addTo(map.get(k), r, states[i]);
  });
  return [...map.values()].map(finish);
}

function dashboard(filters) {
  const rows = queryInstances(filters);
  const nowStr = t.now();
  const states = rows.map(r => stateOf(r, nowStr));
  const kpi = emptyBucket();
  rows.forEach((r, i) => addTo(kpi, r, states[i]));
  finish(kpi);

  const byPerson = groupBy(rows, states, r => r.doer, r => ({ doer: r.doer, head: r.reporting_to }))
    .sort((a, b) => (a.onTimePct ?? 101) - (b.onTimePct ?? 101) || b.overdue - a.overdue);
  const byHead = groupBy(rows, states, r => r.reporting_to || '-', r => ({ head: r.reporting_to || '-' }))
    .sort((a, b) => b.overdue - a.overdue);
  const byCompany = groupBy(rows, states, r => r.company || '(General)', r => ({ company: r.company || '(General)' }))
    .sort((a, b) => b.overdue - a.overdue || (a.onTimePct ?? 101) - (b.onTimePct ?? 101));
  const byCategory = groupBy(rows, states, r => r.category, r => ({ category: r.category }))
    .sort((a, b) => b.due - a.due);
  const byFrequency = groupBy(rows, states, r => r.frequency, r => ({ frequency: r.frequency }));
  const trend = groupBy(rows, states, r => r.due_date, r => ({ date: r.due_date }))
    .filter(b => b.due > 0).sort((a, b) => a.date.localeCompare(b.date));

  const overdue = rows.filter((r, i) => states[i] === 'overdue')
    .map(r => ({ ...pick(r), daysLate: t.daysBetween(r.due_date, t.today()) }))
    .sort((a, b) => b.daysLate - a.daysLate).slice(0, 300);

  return { kpi, byPerson, byHead, byCompany, byCategory, byFrequency, trend, overdue };
}

function pick(r) {
  return {
    id: r.id, task_id: r.task_id, due_date: r.due_date, due_at: r.due_at, status: r.status, doer: r.doer,
    reporting_to: r.reporting_to, description: r.description, alias: r.alias, company: r.company,
    cost_centre: r.cost_centre, category: r.category, frequency: r.frequency, approval_required: r.approval_required,
    submitted_at: r.submitted_at, reviewed_at: r.reviewed_at, review_note: r.review_note, reject_count: r.reject_count,
    remarks: r.remarks, attachment_count: r.attachment_count,
  };
}

// Company x compliance-category grid for one month.
function matrix(month) {
  const [y, m] = month.split('-').map(Number);
  const from = `${month}-01`;
  const to = `${month}-${t.pad(t.daysInMonth(y, m))}`;
  const nowStr = t.now();
  const rows = queryInstances({ from, to }).filter(r => COMPLIANCE_CATEGORIES.includes(r.category));
  const companies = db.prepare(`SELECT DISTINCT company FROM tasks WHERE active = 1 AND company != ''
                                AND company NOT LIKE 'All Co%' ORDER BY company`).all().map(r => r.company);
  const applic = new Map(db.prepare('SELECT * FROM applicability').all().map(a => [`${a.company}|${a.category}`, a.applicable]));
  const hasTask = new Set(db.prepare('SELECT DISTINCT company, category FROM tasks WHERE active = 1').all().map(r => `${r.company}|${r.category}`));

  const cells = {};
  for (const r of rows) {
    const k = `${r.company}|${r.category}`;
    const c = cells[k] || (cells[k] = { total: 0, done: 0, late: 0, awaiting: 0, overdue: 0, upcoming: 0 });
    const s = stateOf(r, nowStr);
    c.total++;
    if (s === 'done_ontime') c.done++;
    else if (s === 'done_late') { c.done++; c.late++; }
    else c[s]++;
  }
  const grid = companies.map(company => ({
    company,
    cells: COMPLIANCE_CATEGORIES.map(category => {
      const k = `${company}|${category}`;
      const applicable = applic.has(k) ? !!applic.get(k) : true; // default: everything applies
      const c = cells[k];
      let status;
      if (!applicable) status = 'na';
      else if (!c) status = hasTask.has(k) ? 'none_this_month' : 'gap';
      else if (c.overdue) status = 'red';
      else if (c.late) status = 'amber';
      else if (c.awaiting) status = 'blue';
      else if (c.done === c.total) status = 'green';
      else status = 'grey';
      return { category, applicable, status, ...(c || {}) };
    }),
  }));
  return { month, categories: COMPLIANCE_CATEGORIES, grid };
}

module.exports = { queryInstances, stateOf, dashboard, matrix, pick };
