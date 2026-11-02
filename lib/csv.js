// Minimal RFC-4180 CSV parser/writer (handles quotes, commas and line breaks inside cells).

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(cell); cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row);
      row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function toCsv(rows) {
  return rows.map(r => r.map(v => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\r\n');
}

// Decode bytes as UTF-8; if that produces replacement chars, fall back to Windows-1252 (Excel "CSV").
function decodeCsvBuffer(buf) {
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.includes('�')) {
    try { text = new TextDecoder('windows-1252').decode(buf); } catch { /* keep utf8 */ }
  }
  return text;
}

module.exports = { parseCsv, toCsv, decodeCsvBuffer };
