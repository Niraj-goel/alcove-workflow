// All dates are stored as local (IST) strings: 'YYYY-MM-DD' and 'YYYY-MM-DD HH:MM'.
// String comparison then gives correct ordering.

const pad = n => String(n).padStart(2, '0');

function fmtDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fmtDateTime(d) {
  return `${fmtDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function today() {
  return fmtDate(new Date());
}

function now() {
  return fmtDateTime(new Date());
}

function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function addDays(s, n) {
  const d = parseDate(s);
  d.setDate(d.getDate() + n);
  return fmtDate(d);
}

function daysInMonth(y, m) {
  return new Date(y, m, 0).getDate();
}

// "8:00 PM", "11:00 P.M", "3.00 P.M", "18:30" -> "20:00"
function parseClock(text) {
  if (!text) return '';
  const m = String(text).match(/(\d{1,2})\s*[:.]\s*(\d{2})\s*([AP])?\.?\s*M?\.?/i);
  if (!m) return '';
  let h = Number(m[1]);
  const min = Number(m[2]);
  const ap = (m[3] || '').toUpperCase();
  if (ap === 'P' && h < 12) h += 12;
  if (ap === 'A' && h === 12) h = 0;
  if (h > 23 || min > 59) return '';
  return `${pad(h)}:${pad(min)}`;
}

function daysBetween(a, b) {
  return Math.round((parseDate(b) - parseDate(a)) / 86400000);
}

module.exports = { pad, fmtDate, fmtDateTime, today, now, parseDate, addDays, daysInMonth, parseClock, daysBetween };
