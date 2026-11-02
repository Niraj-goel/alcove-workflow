// Reads challan / acknowledgement PDFs and pulls out the key details (ARN, Ack No, amount, date, period ...).
// Works on text-based PDFs downloaded from GST / Income Tax / TRACES / EPFO / ESIC / MCA portals.
// Scanned images have no text layer: the doer fills those fields by hand on the submit screen.
const fs = require('fs');

let pdfParse = null;
try { pdfParse = require('pdf-parse/lib/pdf-parse.js'); } catch { /* optional until npm install */ }

const DOC_TYPES = [
  ['GSTR-3B', /GSTR[\s-]*3B/i],
  ['GSTR-1', /GSTR[\s-]*1\b|GSTR[\s-]*1\s/i],
  ['GSTR-9/9C', /GSTR[\s-]*9C?\b/i],
  ['GST Challan (PMT-06)', /PMT[\s-]*06|CPIN/i],
  ['TDS/TCS Return', /\b(24Q|26Q|27Q|27EQ)\b|Provisional Receipt|Token Number/i],
  ['Income Tax Challan', /ITNS\s*28[0-2]|Challan\s*No\.?\s*\/?\s*ITNS|Challan Identification|Income Tax Department.*Challan|Tax Applicable/i],
  ['ITR Acknowledgement', /INDIAN INCOME TAX RETURN ACKNOWLEDGEMENT|ITR[\s-]*V|ITR[\s-]*[1-7]\b/i],
  ['Tax Audit (3CA/3CB/3CD)', /\b3C[ABD]\b/i],
  ['PF ECR / Challan', /\bTRRN\b|EPFO|Employees.? Provident Fund|ECR/i],
  ['ESIC Challan', /ESIC|Employees.? State Insurance/i],
  ['MCA / ROC Filing', /\bSRN\b|Ministry of Corporate Affairs|MCA|AOC[\s-]*4|MGT[\s-]*7|DPT[\s-]*3|DIR[\s-]*3|ADT[\s-]*1|MSME[\s-]*1/i],
];

// Most specific labels first.
const REFERENCE_PATTERNS = [
  ['ARN', /\b(AA\d{12}[A-Z0-9])\b/],
  ['CPIN', /CPIN\s*[:\-]?\s*(\d{14})/i],
  ['TRRN', /TRRN\s*(?:No\.?)?\s*[:\-]?\s*(\d{10,16})/i],
  ['SRN', /\bSRN\s*(?:No\.?)?\s*[:\-]?\s*([A-Z]{1,2}\d{7,8})\b/i],
  ['Acknowledgement No', /Acknowledge?ment\s*(?:No\.?|Number)\s*[:\-]?\s*([A-Z0-9]{8,20})/i],
  ['Token / Receipt No', /(?:Token|Provisional Receipt)\s*(?:No\.?|Number)\s*[:\-]?\s*([A-Z0-9]{8,20})/i],
  ['CIN', /\bCIN\s*[:\-]?\s*([0-9]{14,24})/i],
  ['Challan No', /Challan\s*(?:Serial\s*)?(?:No\.?|Number)\s*[:\-]?\s*([A-Z0-9\/-]{4,25})/i],
  ['BRN / UTR', /\b(?:BRN|UTR|Bank Reference No\.?)\s*[:\-]?\s*([A-Z0-9]{6,25})/i],
];

const DATE_RX = String.raw`(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}|\d{1,2}[\s\-]+[A-Za-z]{3,9}[\s\-,]+\d{4}|\d{4}-\d{2}-\d{2})`;
const LABELLED_DATE = new RegExp(String.raw`(?:Date\s*of\s*(?:filing|deposit|payment|presentation|ARN|submission)|Filing\s*Date|Payment\s*Date|Deposit\s*Date|Tender\s*Date|Paid\s*on|Filed\s*on|Date)\s*[:\-]?\s*` + DATE_RX, 'i');
const ANY_DATE = new RegExp(DATE_RX);

function toNumber(s) {
  const n = Number(String(s).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function findAmount(text) {
  const labelled = /(?:Total\s*(?:Amount|Payable|Paid|Tax\s*(?:Paid|Payable)?|Deposit)?|Amount\s*(?:Paid|Deposited|Payable)?(?:\s*\((?:in\s*)?(?:Rs\.?|₹|INR)\))?|Grand\s*Total)\s*[:\-]?\s*(?:₹|Rs\.?|INR)?\s*([0-9][0-9,]*(?:\.\d{1,2})?)/gi;
  const values = [];
  let m;
  while ((m = labelled.exec(text))) { const v = toNumber(m[1]); if (v !== null && v > 0) values.push(v); }
  if (values.length) return Math.max(...values);
  const currency = /(?:₹|Rs\.?|INR)\s*([0-9][0-9,]*(?:\.\d{1,2})?)/gi;
  while ((m = currency.exec(text))) { const v = toNumber(m[1]); if (v !== null && v > 0) values.push(v); }
  return values.length ? Math.max(...values) : null;
}

function findPeriod(text) {
  const m = text.match(/(?:Tax\s*Period|Return\s*Period|Period|Wage\s*Month|Contribution\s*(?:Period|Month)|Month)\s*[:\-]?\s*((?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*[\s\-,']*\d{2,4}|Q[1-4][^\n]{0,12}|Quarter\s*[1-4])/i);
  return m ? m[1].trim() : '';
}

function parseText(text) {
  const flat = text.replace(/ /g, ' ').replace(/[ \t]+/g, ' ');
  const out = { textFound: flat.trim().length > 30 };
  if (!out.textFound) return out;

  out.docType = (DOC_TYPES.find(([, rx]) => rx.test(flat)) || ['Other'])[0];
  for (const [label, rx] of REFERENCE_PATTERNS) {
    const m = flat.match(rx);
    if (m) { out.referenceLabel = label; out.referenceNo = m[1]; break; }
  }
  const amount = findAmount(flat);
  if (amount !== null) out.amount = amount;
  const d = flat.match(LABELLED_DATE) || flat.match(ANY_DATE);
  if (d) out.date = d[1].trim();
  const period = findPeriod(flat);
  if (period) out.period = period;
  const fy = flat.match(/(?:Financial\s*Year|F\.?Y\.?)\s*[:\-]?\s*(20\d{2}\s*-\s*\d{2,4})/i);
  if (fy) out.financialYear = fy[1].replace(/\s/g, '');
  const ay = flat.match(/(?:Assessment\s*Year|A\.?Y\.?)\s*[:\-]?\s*(20\d{2}\s*-\s*\d{2,4})/i);
  if (ay) out.assessmentYear = ay[1].replace(/\s/g, '');
  const gstin = flat.match(/\b(\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z])\b/);
  if (gstin) out.gstin = gstin[1];
  const tan = flat.match(/\b([A-Z]{4}\d{5}[A-Z])\b/);
  if (tan) out.tan = tan[1];
  const pan = flat.replace(/\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/g, '').match(/\b([A-Z]{3}[PCHFATBLJG][A-Z]\d{4}[A-Z])\b/);
  if (pan) out.pan = pan[1];
  else if (out.gstin) out.pan = out.gstin.slice(2, 12); // PAN is embedded in the GSTIN
  out._text = flat.slice(0, 20000); // used once for company matching, not stored
  return out;
}

// Which of our known entities is named in the document? Used to catch "wrong company's challan uploaded".
function matchCompany(text, companies) {
  if (!text) return '';
  const norm = s => s.toLowerCase().replace(/private/g, 'pvt').replace(/limited/g, 'ltd').replace(/[^a-z0-9]+/g, ' ').trim();
  const hay = ' ' + norm(text) + ' ';
  let best = '';
  for (const c of companies) {
    const n = norm(c);
    if (n.length > 5 && hay.includes(' ' + n + ' ') && n.length > best.length) best = c;
  }
  return best;
}

async function extractFromFile(filePath, mime, companies = []) {
  const isPdf = /pdf/i.test(mime) || /\.pdf$/i.test(filePath);
  if (!isPdf) return { textFound: false, note: 'Not a PDF - please type the details' };
  if (!pdfParse) return { textFound: false, note: 'PDF reader not installed (run npm install)' };
  try {
    // Copy into a standalone Uint8Array: newer Node returns pooled Buffers (non-zero byteOffset),
    // which the bundled pdf.js misreads as "bad XRef entry".
    const data = await pdfParse(new Uint8Array(fs.readFileSync(filePath)));
    const out = parseText(data.text || '');
    if (out.textFound) out.companyInDoc = matchCompany(out._text, companies);
    else out.note = 'Scanned PDF (no text) - please type the details';
    delete out._text;
    return out;
  } catch (err) {
    return { textFound: false, note: 'Could not read PDF: ' + err.message };
  }
}

module.exports = { extractFromFile, parseText, matchCompany };
