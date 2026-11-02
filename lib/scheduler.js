// Turns the task master (Daily/Weekly/Monthly/Yearly/Once) into dated task instances.
const config = require('./config');
const { db, getSetting, setSetting, transaction } = require('./db');
const t = require('./time');

const DEFAULT_DAILY_TIME = '20:00';
const END_OF_DAY = '23:59';

function nums(text) {
  return String(text || '').split(/[^0-9]+/).filter(Boolean).map(Number);
}

function goLiveDate() {
  let d = getSetting('go_live_date') || config.GO_LIVE_DATE;
  if (!d) { d = t.today(); setSetting('go_live_date', d); }
  return d;
}

// Returns [{date:'YYYY-MM-DD', time:'HH:MM'}] for one task between from..to (inclusive).
function occurrences(task, from, to) {
  const out = [];
  const freq = task.frequency;
  if (freq === 'Once') {
    if (task.once_date && task.once_date >= from && task.once_date <= to) out.push({ date: task.once_date, time: END_OF_DAY });
    return out;
  }
  if (freq === 'Daily' || freq === 'Weekly') {
    const days = freq === 'Daily' ? config.WORKING_DAYS : nums(task.weekdays);
    const time = freq === 'Daily' ? (t.parseClock(task.daily_time) || DEFAULT_DAILY_TIME) : END_OF_DAY;
    for (let d = from; d <= to; d = t.addDays(d, 1)) {
      if (days.includes(t.parseDate(d).getDay())) out.push({ date: d, time });
    }
    return out;
  }
  // Monthly / Yearly: walk month by month.
  const start = t.parseDate(from);
  const end = t.parseDate(to);
  const yearSched = freq === 'Yearly' ? safeJson(task.year_sched) : null;
  for (let y = start.getFullYear(), m = start.getMonth() + 1; y < end.getFullYear() || (y === end.getFullYear() && m <= end.getMonth() + 1); m === 12 ? (y++, m = 1) : m++) {
    const dayList = freq === 'Monthly' ? nums(task.month_days) : (yearSched[m] || []);
    const dim = t.daysInMonth(y, m);
    for (const day of new Set(dayList.map(d => Math.min(d, dim)))) {
      const date = `${y}-${t.pad(m)}-${t.pad(day)}`;
      if (date >= from && date <= to) out.push({ date, time: END_OF_DAY });
    }
  }
  return out;
}

function safeJson(s) {
  try { return JSON.parse(s || '{}'); } catch { return {}; }
}

// Creates missing instances up to today (daily) / today+LOOKAHEAD (others). Safe to call repeatedly.
function generateInstances() {
  const live = goLiveDate();
  const today = t.today();
  const tasks = db.prepare('SELECT * FROM tasks WHERE active = 1').all();
  const insert = db.prepare('INSERT OR IGNORE INTO instances(task_id, due_date, due_at) VALUES (?, ?, ?)');
  let created = 0;
  transaction(() => {
    for (const task of tasks) {
      const createdDay = (task.created_at || '').slice(0, 10);
      const from = createdDay > live ? createdDay : live;
      const to = task.frequency === 'Daily' ? today : t.addDays(today, config.LOOKAHEAD_DAYS);
      if (from > to) continue;
      for (const o of occurrences(task, from, to)) {
        created += Number(insert.run(task.id, o.date, `${o.date} ${o.time}`).changes);
      }
    }
  });
  return created;
}

// When a task is removed, drop its open future instances but keep history.
function removeFutureInstances(taskId) {
  db.prepare(`DELETE FROM instances WHERE task_id = ? AND due_date > ? AND status = 'pending'
              AND id NOT IN (SELECT instance_id FROM attachments)`).run(taskId, t.today());
}

module.exports = { occurrences, generateInstances, removeFutureInstances, goLiveDate };
