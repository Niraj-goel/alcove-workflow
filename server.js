// Alcove Accounts Workflow Portal - web server.
process.env.TZ = process.env.TZ || 'Asia/Kolkata';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');

const config = require('./lib/config');
const { db, getSetting, setSetting } = require('./lib/db');
const auth = require('./lib/auth');
const t = require('./lib/time');
const stats = require('./lib/stats');
const { importChecklist, exportChecklist, ensureUser, normCompany, normCostCentre, normPerson } = require('./lib/importer');
const { generateInstances, removeFutureInstances, goLiveDate } = require('./lib/scheduler');
const { extractFromFile } = require('./lib/extract');
const { decodeCsvBuffer, toCsv } = require('./lib/csv');
const { ALL_CATEGORIES, COMPLIANCE_CATEGORIES, classify, defaultApproval } = require('./lib/classify');
const notify = require('./lib/notify');

const app = express();
app.disable('x-powered-by');
// Behind Caddy/nginx on the same machine: trust its X-Forwarded-* headers so req.secure / req.ip are correct.
app.set('trust proxy', 'loopback');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const ALLOWED_UPLOADS = ['.pdf', '.jpg', '.jpeg', '.png', '.xlsx', '.xls', '.csv', '.doc', '.docx', '.zip'];
const upload = multer({
  storage: multer.diskStorage({
    destination: config.UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ALLOWED_UPLOADS.includes(path.extname(file.originalname).toLowerCase());
    cb(ok ? null : Object.assign(new Error('Only PDF, image, Excel, Word or ZIP files are allowed'), { status: 400 }), ok);
  },
});

// Lock an account+IP for 15 minutes after 5 wrong passwords.
const failedLogins = new Map();
const LOCK_AFTER = 5;
const LOCK_MS = 15 * 60 * 1000;
function loginLocked(key) {
  const f = failedLogins.get(key);
  if (!f) return false;
  if (Date.now() - f.first > LOCK_MS) { failedLogins.delete(key); return false; }
  return f.count >= LOCK_AFTER;
}
function noteFailedLogin(key) {
  const f = failedLogins.get(key);
  if (!f || Date.now() - f.first > LOCK_MS) failedLogins.set(key, { count: 1, first: Date.now() });
  else f.count++;
}

function sessionCookie(req, token, maxAge) {
  return `${auth.COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${req.secure ? '; Secure' : ''}`;
}
const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const isAdmin = u => u.role === 'admin';

function teamOf(user) {
  return db.prepare('SELECT DISTINCT doer FROM tasks WHERE reporting_to = ? AND active = 1').all(user.name).map(r => r.doer);
}

function instanceRow(id) {
  return db.prepare(`SELECT i.*, tk.frequency, tk.doer, tk.reporting_to, tk.description, tk.alias, tk.company, tk.cost_centre,
                     tk.category, tk.approval_required, tk.department, tk.daily_time
                     FROM instances i JOIN tasks tk ON tk.id = i.task_id WHERE i.id = ?`).get(id);
}

function canView(user, row) {
  return row && (isAdmin(user) || row.doer === user.name || row.reporting_to === user.name);
}

function canWork(user, row) {
  return row && (isAdmin(user) || row.doer === user.name);
}

function proofRequired(row) {
  return config.PROOF_REQUIRED_FOR === 'all' || !!row.approval_required;
}

function knownCompanies() {
  return db.prepare("SELECT DISTINCT company FROM tasks WHERE company != ''").all().map(r => r.company);
}

// ---------- auth ----------
app.post('/api/login', (req, res) => {
  const { username = '', password = '' } = req.body || {};
  const lockKey = `${req.ip}|${String(username).trim().toLowerCase()}`;
  if (loginLocked(lockKey)) return res.status(429).json({ error: 'Too many wrong attempts. Try again after 15 minutes.' });
  const user = db.prepare('SELECT * FROM users WHERE (username = ? OR lower(name) = lower(?)) AND active = 1')
    .get(username.trim().toLowerCase(), username.trim());
  // Team members log in by name only; admins still need their password.
  const passwordOk = user && (user.role !== 'admin' || auth.verifyPassword(password, user.pass_hash));
  if (!passwordOk) {
    noteFailedLogin(lockKey);
    return res.status(401).json({ error: 'Wrong username or password' });
  }
  failedLogins.delete(lockKey);
  const token = auth.createSession(user.id);
  res.setHeader('Set-Cookie', sessionCookie(req, token, auth.SESSION_DAYS * 86400));
  res.json({ ok: true });
});

// Names shown on the login screen (team members pick their name; admins also type a password).
app.get('/api/login-users', (req, res) => {
  res.json(db.prepare('SELECT name, username, role FROM users WHERE active = 1 ORDER BY name').all()
    .map(u => ({ name: u.name, username: u.username, needsPassword: u.role === 'admin' })));
});

app.post('/api/logout', (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(auth.readCookie(req, auth.COOKIE));
  res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
  res.json({ ok: true });
});

app.use('/api', (req, res, next) => (['/login', '/login-users'].includes(req.path) ? next() : auth.requireLogin(req, res, next)));
app.use('/files', auth.requireLogin);

app.get('/api/me', (req, res) => {
  const u = req.user;
  res.json({ id: u.id, name: u.name, username: u.username, role: u.role, email: u.email, team: teamOf(u) });
});

app.post('/api/change-password', (req, res) => {
  const { current = '', next = '' } = req.body || {};
  if (!auth.verifyPassword(current, req.user.pass_hash)) return res.status(400).json({ error: 'Current password is wrong' });
  if (next.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
  db.prepare('UPDATE users SET pass_hash = ?, must_change = 0 WHERE id = ?').run(auth.hashPassword(next), req.user.id);
  res.json({ ok: true });
});

app.get('/api/meta', (req, res) => {
  res.json({
    people: db.prepare('SELECT name FROM users WHERE active = 1 ORDER BY name').all().map(r => r.name),
    heads: db.prepare("SELECT DISTINCT reporting_to AS n FROM tasks WHERE active = 1 AND reporting_to != '' ORDER BY n").all().map(r => r.n),
    companies: db.prepare("SELECT DISTINCT company AS n FROM tasks WHERE active = 1 AND company != '' ORDER BY n").all().map(r => r.n),
    categories: ALL_CATEGORIES,
    complianceCategories: COMPLIANCE_CATEGORIES,
    goLiveDate: goLiveDate(),
    today: t.today(),
    proofRequiredFor: config.PROOF_REQUIRED_FOR,
  });
});

// ---------- tasks for the logged-in person / team ----------
app.get('/api/my-tasks', (req, res) => {
  const u = req.user;
  const scope = req.query.scope || 'mine';
  const filters = { from: t.addDays(t.today(), -120), to: t.addDays(t.today(), config.LOOKAHEAD_DAYS) };
  if (scope === 'all' && isAdmin(u)) {
    if (req.query.doer) filters.doer = req.query.doer;
  } else if (scope === 'team') {
    const team = teamOf(u);
    if (!team.length) return res.json([]);
    filters.doers = req.query.doer && team.includes(req.query.doer) ? [req.query.doer] : team;
  } else filters.doer = u.name;
  if (req.query.company) filters.company = req.query.company;

  const nowStr = t.now();
  const recent = t.addDays(t.today(), -7);
  const rows = stats.queryInstances(filters)
    .map(r => ({ ...stats.pick(r), state: stats.stateOf(r, nowStr), proofRequired: proofRequired(r) }))
    .filter(r => !r.state.startsWith('done') || r.due_date >= recent);
  res.json(rows);
});

app.get('/api/instances/:id', (req, res) => {
  const row = instanceRow(req.params.id);
  if (!canView(req.user, row)) return res.status(404).json({ error: 'Not found' });
  const attachments = db.prepare('SELECT * FROM attachments WHERE instance_id = ? ORDER BY id').all(row.id)
    .map(a => ({ ...a, extracted: JSON.parse(a.extracted || '{}'), fields: JSON.parse(a.fields || '{}') }));
  const comments = db.prepare('SELECT * FROM comments WHERE instance_id = ? ORDER BY id').all(row.id);
  res.json({ ...row, state: stats.stateOf(row), proofRequired: proofRequired(row), attachments, comments,
    canWork: canWork(req.user, row), canReview: isAdmin(req.user) });
});

app.post('/api/instances/:id/upload', upload.single('file'), wrap(async (req, res) => {
  const row = instanceRow(req.params.id);
  if (!req.file) return res.status(400).json({ error: 'No file received' });
  if (!canWork(req.user, row) || !['pending', 'rejected'].includes(row.status)) {
    fs.unlink(req.file.path, () => {});
    return res.status(403).json({ error: 'You cannot upload to this task now' });
  }
  const extracted = await extractFromFile(req.file.path, req.file.mimetype, knownCompanies());
  if (extracted.companyInDoc && row.company && extracted.companyInDoc !== row.company) {
    extracted.warning = `Document seems to be for "${extracted.companyInDoc}", but task is for "${row.company}"`;
  }
  const info = db.prepare(`INSERT INTO attachments(instance_id, original_name, stored_name, mime, size, uploaded_at, uploaded_by, extracted, fields)
                           VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(row.id, req.file.originalname, req.file.filename, req.file.mimetype, req.file.size, t.now(), req.user.name,
      JSON.stringify(extracted), JSON.stringify(extracted));
  res.json({ id: Number(info.lastInsertRowid), original_name: req.file.originalname, extracted, fields: extracted });
}));

app.delete('/api/attachments/:id', (req, res) => {
  const a = db.prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.id);
  const row = a && instanceRow(a.instance_id);
  if (!row || !canWork(req.user, row) || !['pending', 'rejected'].includes(row.status)) return res.status(403).json({ error: 'Cannot delete' });
  db.prepare('DELETE FROM attachments WHERE id = ?').run(a.id);
  fs.unlink(path.join(config.UPLOAD_DIR, a.stored_name), () => {});
  res.json({ ok: true });
});

app.post('/api/instances/:id/submit', (req, res) => {
  const row = instanceRow(req.params.id);
  if (!canWork(req.user, row)) return res.status(403).json({ error: 'Not your task' });
  if (!['pending', 'rejected'].includes(row.status)) return res.status(400).json({ error: 'Task is already submitted' });
  const { remarks = '', fields = {} } = req.body || {};
  const count = db.prepare('SELECT COUNT(*) AS n FROM attachments WHERE instance_id = ?').get(row.id).n;
  if (proofRequired(row) && !count) return res.status(400).json({ error: 'Please upload proof (challan / acknowledgement) before submitting' });

  const updateFields = db.prepare('UPDATE attachments SET fields = ? WHERE id = ? AND instance_id = ?');
  for (const [attId, f] of Object.entries(fields)) updateFields.run(JSON.stringify(f || {}), Number(attId), row.id);

  // An admin's own work (e.g. Niraj's reviews) doesn't need to wait for self-approval.
  const status = row.approval_required && !isAdmin(req.user) ? 'submitted' : 'done';
  db.prepare('UPDATE instances SET status = ?, submitted_at = ?, submitted_by = ?, remarks = ? WHERE id = ?')
    .run(status, t.now(), req.user.name, String(remarks).slice(0, 2000), row.id);
  res.json({ ok: true, status });
});

// Routine tasks (no approval, no proof needed) can be ticked in bulk.
app.post('/api/instances/bulk-done', (req, res) => {
  const ids = (req.body && req.body.ids) || [];
  let done = 0;
  const skipped = [];
  for (const id of ids) {
    const row = instanceRow(id);
    if (!canWork(req.user, row) || !['pending', 'rejected'].includes(row.status) || row.approval_required || proofRequired(row)) {
      skipped.push(id); continue;
    }
    db.prepare("UPDATE instances SET status = 'done', submitted_at = ?, submitted_by = ? WHERE id = ?").run(t.now(), req.user.name, id);
    done++;
  }
  res.json({ done, skipped: skipped.length });
});

app.post('/api/instances/:id/comments', (req, res) => {
  const row = instanceRow(req.params.id);
  const text = String((req.body && req.body.text) || '').trim();
  if (!canView(req.user, row) || !text) return res.status(400).json({ error: 'Cannot comment' });
  db.prepare('INSERT INTO comments(instance_id, user, text, created_at) VALUES (?,?,?,?)').run(row.id, req.user.name, text.slice(0, 2000), t.now());
  res.json({ ok: true });
});

// ---------- approvals (admin) ----------
app.get('/api/approvals', auth.requireAdmin, (req, res) => {
  const rows = stats.queryInstances({ status: 'submitted' }).map(r => {
    const atts = db.prepare('SELECT id, original_name, fields FROM attachments WHERE instance_id = ?').all(r.id)
      .map(a => ({ id: a.id, original_name: a.original_name, fields: JSON.parse(a.fields || '{}') }));
    return { ...stats.pick(r), late: r.submitted_at > r.due_at, attachments: atts };
  });
  res.json(rows);
});

function review(req, res, approve) {
  const ids = req.params.id ? [req.params.id] : ((req.body && req.body.ids) || []);
  const note = String((req.body && req.body.note) || '').slice(0, 2000);
  if (!approve && !note) return res.status(400).json({ error: 'Please write the reason for sending it back' });
  let n = 0;
  for (const id of ids) {
    const row = instanceRow(id);
    if (!row) continue;
    if (approve && row.status === 'submitted') {
      db.prepare("UPDATE instances SET status = 'done', reviewed_at = ?, reviewed_by = ?, review_note = ? WHERE id = ?")
        .run(t.now(), req.user.name, note, row.id);
      n++;
    } else if (!approve && ['submitted', 'done'].includes(row.status)) {
      db.prepare("UPDATE instances SET status = 'rejected', reviewed_at = ?, reviewed_by = ?, review_note = ?, reject_count = reject_count + 1 WHERE id = ?")
        .run(t.now(), req.user.name, note, row.id);
      db.prepare('INSERT INTO comments(instance_id, user, text, created_at) VALUES (?,?,?,?)').run(row.id, req.user.name, 'Sent back: ' + note, t.now());
      n++;
    }
  }
  res.json({ ok: true, count: n });
}
app.post('/api/instances/:id/approve', auth.requireAdmin, (req, res) => review(req, res, true));
app.post('/api/instances/:id/reject', auth.requireAdmin, (req, res) => review(req, res, false));
app.post('/api/approvals/bulk-approve', auth.requireAdmin, (req, res) => review(req, res, true));

// ---------- dashboard & matrix ----------
app.get('/api/dashboard', (req, res) => {
  const u = req.user;
  const q = req.query;
  const filters = { from: q.from || t.addDays(t.today(), -30), to: q.to || t.today(), doer: q.doer, head: q.head,
    company: q.company, category: q.category, frequency: q.frequency };
  if (!isAdmin(u)) {
    const allowed = [u.name, ...teamOf(u)];
    filters.doers = q.doer && allowed.includes(q.doer) ? [q.doer] : allowed;
    delete filters.doer;
  }
  res.json({ filters, ...stats.dashboard(filters) });
});

app.get('/api/matrix', auth.requireAdmin, (req, res) => {
  res.json(stats.matrix(/^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : t.today().slice(0, 7)));
});

app.post('/api/matrix/applicability', auth.requireAdmin, (req, res) => {
  const { company, category, applicable } = req.body || {};
  if (!company || !COMPLIANCE_CATEGORIES.includes(category)) return res.status(400).json({ error: 'Bad input' });
  db.prepare(`INSERT INTO applicability(company, category, applicable) VALUES (?,?,?)
              ON CONFLICT(company, category) DO UPDATE SET applicable = excluded.applicable`).run(company, category, applicable ? 1 : 0);
  res.json({ ok: true });
});

// ---------- attachment register (report auto-filled from uploads) ----------
function registerRows(q, user) {
  const where = ['1 = 1'];
  const args = [];
  if (q.from) { where.push('i.due_date >= ?'); args.push(q.from); }
  if (q.to) { where.push('i.due_date <= ?'); args.push(q.to); }
  for (const [k, col] of [['company', 'tk.company'], ['category', 'tk.category'], ['doer', 'tk.doer']]) {
    if (q[k]) { where.push(`${col} = ?`); args.push(q[k]); }
  }
  if (!isAdmin(user)) {
    const allowed = [user.name, ...teamOf(user)];
    where.push(`tk.doer IN (${allowed.map(() => '?').join(',')})`); args.push(...allowed);
  }
  return db.prepare(`SELECT a.id, a.original_name, a.uploaded_at, a.fields, i.id AS instance_id, i.due_date, i.due_at, i.status,
                     i.submitted_at, i.reviewed_by, i.reviewed_at, tk.doer, tk.company, tk.cost_centre, tk.category,
                     tk.description, tk.alias, tk.frequency
                     FROM attachments a JOIN instances i ON i.id = a.instance_id JOIN tasks tk ON tk.id = i.task_id
                     WHERE ${where.join(' AND ')} ORDER BY i.due_date DESC, tk.company`).all(...args)
    .map(r => ({ ...r, fields: JSON.parse(r.fields || '{}') }));
}

app.get('/api/register', (req, res) => res.json(registerRows(req.query, req.user)));

app.get('/api/register.csv', (req, res) => {
  const rows = registerRows(req.query, req.user);
  const out = [['Due Date', 'Company', 'Cost Centre', 'Category', 'Task', 'Doer', 'Document Type', 'Reference Type', 'Reference No',
    'Amount', 'Date in Document', 'Period', 'FY', 'AY', 'GSTIN', 'PAN', 'TAN', 'Company in Document', 'Status', 'Submitted At',
    'On Time', 'Approved By', 'File']];
  for (const r of rows) {
    const f = r.fields;
    out.push([r.due_date, r.company, r.cost_centre, r.category, r.alias || r.description, r.doer, f.docType, f.referenceLabel,
      f.referenceNo, f.amount, f.date, f.period, f.financialYear, f.assessmentYear, f.gstin, f.pan, f.tan, f.companyInDoc,
      r.status, r.submitted_at, r.submitted_at ? (r.submitted_at <= r.due_at ? 'Yes' : 'No') : '', r.reviewed_by, r.original_name]);
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="attachment-register-${t.today()}.csv"`);
  res.send('﻿' + toCsv(out));
});

app.get('/files/:id', (req, res) => {
  const a = db.prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.id);
  const row = a && instanceRow(a.instance_id);
  if (!canView(req.user, row)) return res.status(404).send('Not found');
  res.download(path.join(config.UPLOAD_DIR, a.stored_name), a.original_name);
});

// ---------- task master (admin) ----------
function taskFilter(q) {
  const where = ['1 = 1'];
  const args = [];
  for (const [k, col] of [['doer', 'doer'], ['company', 'company'], ['category', 'category'], ['frequency', 'frequency']]) {
    if (q[k]) { where.push(`${col} = ?`); args.push(q[k]); }
  }
  if (q.active !== 'all') where.push(q.active === '0' ? 'active = 0' : 'active = 1');
  if (q.search) {
    where.push('(description LIKE ? OR alias LIKE ? OR company LIKE ? OR doer LIKE ?)');
    args.push(...Array(4).fill(`%${q.search}%`));
  }
  return db.prepare(`SELECT * FROM tasks WHERE ${where.join(' AND ')} ORDER BY frequency, doer, description, company`).all(...args);
}

app.get('/api/tasks', auth.requireAdmin, (req, res) => res.json(taskFilter(req.query)));

app.get('/api/tasks/export.csv', auth.requireAdmin, (req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="tasks-export-${t.today()}.csv"`);
  res.send('﻿' + exportChecklist(taskFilter(req.query)));
});

app.patch('/api/tasks/:id', auth.requireAdmin, (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  if (b.approval_required !== undefined) db.prepare('UPDATE tasks SET approval_required = ? WHERE id = ?').run(b.approval_required ? 1 : 0, task.id);
  if (b.category && ALL_CATEGORIES.includes(b.category)) db.prepare('UPDATE tasks SET category = ? WHERE id = ?').run(b.category, task.id);
  if (b.active !== undefined) {
    db.prepare('UPDATE tasks SET active = ?, deactivated_at = ? WHERE id = ?').run(b.active ? 1 : 0, b.active ? '' : t.now(), task.id);
    if (!b.active) removeFutureInstances(task.id); else generateInstances();
  }
  res.json(db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id));
});

app.post('/api/tasks/bulk', auth.requireAdmin, (req, res) => {
  const { ids = [], approval_required } = req.body || {};
  const st = db.prepare('UPDATE tasks SET approval_required = ? WHERE id = ?');
  ids.forEach(id => st.run(approval_required ? 1 : 0, id));
  res.json({ ok: true, count: ids.length });
});

app.post('/api/import', auth.requireAdmin, csvUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Please choose the CSV file' });
  try {
    const summary = importChecklist(decodeCsvBuffer(req.file.buffer), { replaceAll: req.body.replaceAll === 'true' });
    res.json(summary);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/adhoc', auth.requireAdmin, (req, res) => {
  const b = req.body || {};
  const doer = normPerson(b.doer || '');
  if (!doer || !b.description || !/^\d{4}-\d{2}-\d{2}$/.test(b.due_date || '')) {
    return res.status(400).json({ error: 'Doer, task and due date are required' });
  }
  ensureUser(doer);
  const category = b.category && ALL_CATEGORIES.includes(b.category) ? b.category : classify(b.description);
  const doerRow = db.prepare('SELECT reporting_to, department FROM users WHERE name = ?').get(doer) || {};
  db.prepare(`INSERT INTO tasks(task_key, frequency, doer, department, reporting_to, description, company, cost_centre, once_date,
              category, approval_required, created_at, remarks) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(`once|${Date.now()}|${crypto.randomBytes(4).toString('hex')}`, 'Once', doer, doerRow.department || '',
      doerRow.reporting_to || req.user.name, String(b.description).slice(0, 1000), normCompany(b.company || ''),
      normCostCentre(b.cost_centre || ''), b.due_date, category,
      b.approval_required === undefined ? defaultApproval(category) : (b.approval_required ? 1 : 0),
      // created_at is the due date's start, so the instance is generated even for back-dated tasks
      `${b.due_date < t.today() ? b.due_date : t.today()} 00:00`, `Assigned by ${req.user.name}`);
  generateInstances();
  res.json({ ok: true });
});

// ---------- users & settings (admin) ----------
app.get('/api/users', auth.requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT id, name, username, role, email, department, reporting_to, active, must_change FROM users ORDER BY name').all());
});

app.post('/api/users', auth.requireAdmin, (req, res) => {
  const name = normPerson((req.body && req.body.name) || '');
  if (!name) return res.status(400).json({ error: 'Name required' });
  ensureUser(name, { department: req.body.department, reporting_to: req.body.reporting_to });
  res.json({ ok: true });
});

app.patch('/api/users/:id', auth.requireAdmin, (req, res) => {
  const b = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Not found' });
  if (b.email !== undefined) db.prepare('UPDATE users SET email = ? WHERE id = ?').run(String(b.email).trim(), u.id);
  if (b.role && ['admin', 'member'].includes(b.role) && u.id !== req.user.id) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(b.role, u.id);
  if (b.active !== undefined && u.id !== req.user.id) db.prepare('UPDATE users SET active = ? WHERE id = ?').run(b.active ? 1 : 0, u.id);
  if (b.resetPassword) {
    db.prepare('UPDATE users SET pass_hash = ?, must_change = 1 WHERE id = ?').run(auth.hashPassword(config.DEFAULT_PASSWORD), u.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  }
  res.json({ ok: true });
});

app.post('/api/settings', auth.requireAdmin, (req, res) => {
  const d = req.body && req.body.go_live_date;
  if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) { setSetting('go_live_date', d); generateInstances(); }
  res.json({ ok: true, goLiveDate: goLiveDate() });
});

app.post('/api/digest/send-now', auth.requireAdmin, wrap(async (req, res) => res.json(await notify.sendDigest())));

// ---------- errors & start ----------
app.use((err, req, res, next) => {
  console.error(err);
  if (err instanceof multer.MulterError || err.status === 400) return res.status(400).json({ error: err.message });
  res.status(500).json({ error: 'Server error: ' + err.message });
});

function bootstrap() {
  if (!db.prepare("SELECT 1 FROM users WHERE role = 'admin'").get()) {
    for (const name of config.ADMIN_NAMES) ensureUser(name);
    db.prepare(`UPDATE users SET role = 'admin' WHERE name IN (${config.ADMIN_NAMES.map(() => '?').join(',')})`).run(...config.ADMIN_NAMES);
  }
  // Admins who never set their own password get the current default (e.g. after the default was changed).
  const resetAdmin = db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?');
  for (const a of db.prepare("SELECT id FROM users WHERE role = 'admin' AND must_change = 1").all()) {
    resetAdmin.run(auth.hashPassword(config.DEFAULT_PASSWORD), a.id);
  }
  goLiveDate();
  const n = generateInstances();
  console.log(`Task instances created: ${n}`);
  setInterval(() => { try { generateInstances(); } catch (e) { console.error(e); } }, 60 * 60 * 1000);
  notify.startDigestTimer();
}

bootstrap();
app.listen(config.PORT, config.HOST, () => console.log(`Alcove Workflow Portal running on http://${config.HOST}:${config.PORT}`));
