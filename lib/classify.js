// Puts each checklist task into a compliance category, used for the Compliance Matrix and approval defaults.

const COMPLIANCE_CATEGORIES = ['GST', 'TDS/TCS', 'PF/ESI', 'ROC', 'Income Tax', 'Audit'];
const ALL_CATEGORIES = [...COMPLIANCE_CATEGORIES, 'Books & MIS', 'Other'];

const RULES = [
  ['ROC', /\b(AOC-?\s?4|MGT-?\s?7|DPT-?\s?3|DIR-?\s?3|DIR-?\s?8|ADT-?\s?1|MSME|PAS-?\s?6|CRA-?\s?[24]|CSR-?\s?2|MBP-?\s?1|Form\s*(8|11)\b|Board Meeting|General Meeting|Statutory Register|ROC\b|MCA\b|NeSL|Charge Status|Directors? Report|Annual Fill?ing Tracker|Shareholder)/i],
  ['GST', /\b(GST|GSTR|ITC|Service Tax)\b|GSTR-|GST-/i],
  ['Income Tax', /\b(26AS|AIS|ITR|Income Tax|Advance Tax|Tax Audit|10BD|10BB|IT file|Scrutiny|Appeal|Petition|b\/f losses)\b/i],
  ['TDS/TCS', /\b(TDS|TCS|24Q|26Q|27EQ|26QB|24QB|12BB)\b/i],
  ['PF/ESI', /\b(E?PF|ESIC?|P\.?\s?Tax|Labour Welfare|Gratuity)\b/i],
  ['Audit', /\bAudit/i],
  ['Books & MIS', /(Trial|Financial Drafting|Entry|Entries|Google Sheet|P\/L|BRS|Bank Statement|Balance Sheet|Budget|Reconcil|Expense Sheet|Depreciation|Salary|Bank Entr|Cash|Voucher|\bPC\b|MIS|Outstanding|Creditors|Report|Income & Expenditure|Interest|Debit Note|Credit Card|Sales|Invoice|GRN|Purchase)/i],
];

function classify(description, alias = '') {
  const text = `${description} ${alias}`;
  for (const [cat, re] of RULES) if (re.test(text)) return cat;
  return 'Other';
}

function defaultApproval(category) {
  return COMPLIANCE_CATEGORIES.includes(category) ? 1 : 0;
}

module.exports = { classify, defaultApproval, COMPLIANCE_CATEGORIES, ALL_CATEGORIES };
