// Daily e-mail digest: each person gets their due-today + overdue list; admins get the team summary.
const config = require('./config');
const { db, getSetting, setSetting } = require('./db');
const stats = require('./stats');
const t = require('./time');

let transporter = null;
function mailer() {
  if (!config.SMTP.host) return null;
  if (!transporter) {
    const nodemailer = require('nodemailer');
    transporter = nodemailer.createTransport({
      host: config.SMTP.host, port: config.SMTP.port, secure: config.SMTP.secure,
      auth: config.SMTP.user ? { user: config.SMTP.user, pass: config.SMTP.pass } : undefined,
    });
  }
  return transporter;
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function taskTable(rows) {
  if (!rows.length) return '<p>Nothing pending.</p>';
  return `<table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse;font:13px Arial">
    <tr style="background:#1f2a44;color:#fff"><th>Due</th><th>Task</th><th>Company</th><th>Doer</th></tr>
    ${rows.map(r => `<tr><td>${esc(r.due_at)}</td><td>${esc(r.alias || r.description)}</td><td>${esc([r.company, r.cost_centre].filter(Boolean).join(' / '))}</td><td>${esc(r.doer)}</td></tr>`).join('')}
  </table>`;
}

async function sendDigest() {
  const tx = mailer();
  if (!tx) return { sent: 0, reason: 'SMTP not configured' };
  const today = t.today();
  const nowStr = t.now();
  const open = stats.queryInstances({ to: today }).filter(r => ['pending', 'rejected'].includes(r.status));
  const link = config.PORTAL_URL ? `<p><a href="${esc(config.PORTAL_URL)}">Open the portal</a></p>` : '';
  let sent = 0;

  for (const u of db.prepare("SELECT * FROM users WHERE active = 1 AND email != ''").all()) {
    let html;
    let subject;
    if (u.role === 'admin') {
      const d = stats.dashboard({ from: t.addDays(today, -30), to: today });
      const awaiting = db.prepare("SELECT COUNT(*) AS n FROM instances WHERE status = 'submitted'").get().n;
      subject = `Accounts Workflow - ${d.kpi.overdue} overdue, ${awaiting} awaiting your approval`;
      html = `<h3>Team summary (last 30 days)</h3>
        <p>On-time: <b>${d.kpi.onTimePct ?? '-'}%</b> &nbsp; First-time-right: <b>${d.kpi.firstPassPct ?? '-'}%</b>
        &nbsp; Overdue: <b>${d.kpi.overdue}</b> &nbsp; Awaiting approval: <b>${awaiting}</b></p>
        <h4>Overdue by person</h4>
        <table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse;font:13px Arial">
        <tr><th>Person</th><th>Overdue</th><th>On-time %</th></tr>
        ${d.byPerson.filter(p => p.overdue).sort((a, b) => b.overdue - a.overdue).map(p => `<tr><td>${esc(p.doer)}</td><td>${p.overdue}</td><td>${p.onTimePct ?? '-'}</td></tr>`).join('')}
        </table>${link}`;
    } else {
      const mine = open.filter(r => r.doer === u.name);
      if (!mine.length) continue;
      const overdue = mine.filter(r => r.due_at < nowStr);
      const dueToday = mine.filter(r => r.due_date === today && r.due_at >= nowStr);
      subject = `Your tasks today: ${dueToday.length} due, ${overdue.length} overdue`;
      html = `<p>Dear ${esc(u.name)},</p><h4>Overdue</h4>${taskTable(overdue)}<h4>Due today</h4>${taskTable(dueToday)}${link}`;
    }
    await tx.sendMail({ from: config.SMTP.from, to: u.email, subject, html });
    sent++;
  }
  return { sent };
}

function startDigestTimer() {
  setInterval(async () => {
    const today = t.today();
    if (new Date().getHours() < config.DIGEST_HOUR || getSetting('last_digest') === today) return;
    setSetting('last_digest', today);
    try {
      const r = await sendDigest();
      console.log(`[digest] ${today}:`, r);
    } catch (err) {
      console.error('[digest] failed:', err.message);
    }
  }, 5 * 60 * 1000);
}

module.exports = { sendDigest, startDigestTimer };
