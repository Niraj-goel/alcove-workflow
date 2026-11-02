// Imports the "Job Checklist - Bulk Add / Delete Import" CSV into the task master.
const config = require('./config');
const { db, transaction } = require('./db');
const { parseCsv, toCsv } = require('./csv');
const { classify, defaultApproval } = require('./classify');
const { hashPassword, usernameFor } = require('./auth');
const { generateInstances, removeFutureInstances } = require('./scheduler');
const t = require('./time');

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar'];
const MONTH_NO = { Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12, Jan: 1, Feb: 2, Mar: 3 };

// Spelling variants seen in the checklist, mapped to one name (keys are lower-case).
const COST_CENTRE_ALIASES = {
  'alcove estates': 'Alcove Estate',
  'all -lot': 'All - LOT',
  'all - lot': 'All - LOT',
  'all lot': 'All - LOT',
  'duets': 'Alcove Duets',
  'mall road': 'Mall Road',
};

function clean(s) {
  return String(s || '').replace(/�/g, ' ').replace(/\s+/g, ' ').trim();
}

// Capitalise words typed fully in lower case ("Yashaswi shroff" -> "Yashaswi Shroff").
function titleFix(s) {
  return s.replace(/\b([a-z])([a-z]*)\b/g, (w, a, b) => (w.length > 2 ? a.toUpperCase() + b : w));
}

function normCompany(s) {
  let v = clean(s);
  if (!v) return '';
  v = v.replace(/\.{2,}/g, '.').replace(/Pvt\.?\s*Ltd\.?/i, 'Pvt. Ltd.').replace(/\s+\./g, '.');
  return titleFix(v);
}

function normCostCentre(s) {
  const v = clean(s);
  if (!v) return '';
  return COST_CENTRE_ALIASES[v.toLowerCase()] || titleFix(v);
}

function normPerson(s) {
  return titleFix(clean(s));
}

function normFrequency(s) {
  const v = clean(s).toLowerCase();
  return { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly', quarterly: 'Yearly', once: 'Once' }[v] || '';
}

function taskKey(r) {
  return [r.frequency, r.doer, r.description, r.company, r.cost_centre].map(v => clean(v).toLowerCase()).join('|');
}

function findHeader(rows) {
  const idx = rows.findIndex(r => clean(r[0]).toLowerCase() === 'action' && r.some(c => clean(c).toLowerCase() === 'frequency'));
  if (idx < 0) throw new Error('Header row (Action, Frequency, Doer, ...) not found in the file');
  const col = {};
  rows[idx].forEach((name, i) => { const k = clean(name); if (k && col[k] === undefined) col[k] = i; });
  return { idx, col };
}

function rowToTask(row, col) {
  const get = name => (col[name] === undefined ? '' : clean(row[col[name]]));
  const frequency = normFrequency(get('Frequency'));
  const description = get('Task Description');
  const doer = normPerson(get('Doer'));
  if (!frequency || !description || !doer) return null;

  const weekdays = WEEKDAYS.map((d, i) => (get(d) ? i + 1 : 0)).filter(Boolean).join(',');
  const yearSched = {};
  for (const m of MONTHS) {
    const days = get(m).split(/[^0-9]+/).filter(Boolean).map(Number).filter(n => n >= 1 && n <= 31);
    if (days.length) yearSched[MONTH_NO[m]] = days;
  }
  const alias = get('Task Alias');
  const category = classify(description, alias);
  return {
    action: get('Action').toUpperCase(),
    frequency,
    doer,
    department: get('Department'),
    reporting_to: normPerson(get('Reporting To')),
    description,
    alias,
    company: normCompany(get('Company')),
    cost_centre: normCostCentre(get('Cost Centre')),
    daily_time: get('Daily Time'),
    weekdays,
    month_days: get('Monthly Due Day(s)').split(/[^0-9]+/).filter(Boolean).join(','),
    year_sched: Object.keys(yearSched).length ? JSON.stringify(yearSched) : '',
    category,
    approval_required: defaultApproval(category),
    remarks: get('Remarks') || get('Reason'),
  };
}

function ensureUser(name, extra = {}) {
  if (!name) return;
  const existing = db.prepare('SELECT id FROM users WHERE name = ?').get(name);
  if (existing) {
    if (extra.department || extra.reporting_to) {
      db.prepare(`UPDATE users SET department = COALESCE(NULLIF(?, ''), department),
                  reporting_to = COALESCE(NULLIF(?, ''), reporting_to) WHERE id = ?`)
        .run(extra.department || '', extra.reporting_to || '', existing.id);
    }
    return;
  }
  let username = usernameFor(name);
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) username += '.' + Date.now() % 1000;
  const role = config.ADMIN_NAMES.some(a => a.toLowerCase() === name.toLowerCase()) ? 'admin' : 'member';
  db.prepare(`INSERT INTO users(name, username, pass_hash, role, department, reporting_to) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(name, username, hashPassword(config.DEFAULT_PASSWORD), role, extra.department || '', extra.reporting_to || '');
}

/**
 * replaceAll = true: tasks not present in the file are deactivated (file becomes the full master).
 * Returns a summary { added, updated, deleted, deactivated, skipped, errors[] }.
 */
function importChecklist(text, { replaceAll = false } = {}) {
  const rows = parseCsv(text);
  const { idx, col } = findHeader(rows);
  const summary = { added: 0, updated: 0, deleted: 0, deactivated: 0, skipped: 0, errors: [] };
  const seen = new Set();
  const now = t.now();

  transaction(() => {
    for (let i = idx + 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row.some(c => clean(c))) continue;
      const task = rowToTask(row, col);
      if (!task) { summary.skipped++; summary.errors.push(`Row ${i + 1}: Frequency, Doer or Task Description missing`); continue; }
      const key = taskKey(task);
      const existing = db.prepare('SELECT * FROM tasks WHERE task_key = ?').get(key);

      if (task.action === 'DELETE') {
        if (existing && existing.active) {
          db.prepare('UPDATE tasks SET active = 0, deactivated_at = ? WHERE id = ?').run(now, existing.id);
          removeFutureInstances(existing.id);
          summary.deleted++;
        } else summary.skipped++;
        continue;
      }

      seen.add(key);
      ensureUser(task.doer, { department: task.department, reporting_to: task.reporting_to });
      ensureUser(task.reporting_to);

      if (existing) {
        // Keep the admin's approval/category choices; refresh schedule and people.
        db.prepare(`UPDATE tasks SET department=?, reporting_to=?, alias=?, daily_time=?, weekdays=?, month_days=?,
                    year_sched=?, remarks=?, active=1, deactivated_at='' WHERE id=?`)
          .run(task.department, task.reporting_to, task.alias, task.daily_time, task.weekdays, task.month_days,
            task.year_sched, task.remarks, existing.id);
        summary.updated++;
      } else {
        db.prepare(`INSERT INTO tasks(task_key, frequency, doer, department, reporting_to, description, alias, company,
                    cost_centre, daily_time, weekdays, month_days, year_sched, category, approval_required, created_at, remarks)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(key, task.frequency, task.doer, task.department, task.reporting_to, task.description, task.alias,
            task.company, task.cost_centre, task.daily_time, task.weekdays, task.month_days, task.year_sched,
            task.category, task.approval_required, now, task.remarks);
        summary.added++;
      }
    }

    if (replaceAll) {
      for (const task of db.prepare("SELECT id, task_key FROM tasks WHERE active = 1 AND frequency != 'Once'").all()) {
        if (!seen.has(task.task_key)) {
          db.prepare('UPDATE tasks SET active = 0, deactivated_at = ? WHERE id = ?').run(now, task.id);
          removeFutureInstances(task.id);
          summary.deactivated++;
        }
      }
    }
  });

  summary.instancesCreated = generateInstances();
  return summary;
}

// Exports tasks back in the same import format (Action column blank = keep; type DELETE to remove).
function exportChecklist(tasks) {
  const header = ['Action', 'Frequency', 'Doer', 'Department', 'Reporting To', 'Task Description', 'Task Alias', 'Company',
    'Cost Centre', 'Daily Time', ...WEEKDAYS, 'Monthly Due Day(s)', ...MONTHS, 'Reason', 'Requested By (Maker)',
    'Approved By (Checker)', 'Remarks'];
  const rows = [['Job Checklist - Bulk Add / Delete Import'], ['Exported from Alcove Workflow Portal'], header];
  for (const tk of tasks) {
    const wd = String(tk.weekdays || '').split(',').map(Number);
    const ys = tk.year_sched ? JSON.parse(tk.year_sched) : {};
    rows.push(['', tk.frequency, tk.doer, tk.department, tk.reporting_to, tk.description, tk.alias, tk.company,
      tk.cost_centre, tk.daily_time, ...WEEKDAYS.map((_, i) => (wd.includes(i + 1) ? 'Y' : '')),
      (tk.month_days || '').split(',').join(', '), ...MONTHS.map(m => (ys[MONTH_NO[m]] || []).join(', ')), '', '', '', tk.remarks]);
  }
  return toCsv(rows);
}

module.exports = { importChecklist, exportChecklist, ensureUser, normCompany, normCostCentre, normPerson };
