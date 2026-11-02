// One-time / command-line import:  node scripts/import-csv.js "path\to\Import_File.csv" [--replace]
process.env.TZ = process.env.TZ || 'Asia/Kolkata';
const fs = require('fs');
const { importChecklist } = require('../lib/importer');
const { decodeCsvBuffer } = require('../lib/csv');

const file = process.argv[2];
if (!file) {
  console.log('Usage: node scripts/import-csv.js "<checklist.csv>" [--replace]');
  process.exit(1);
}
const summary = importChecklist(decodeCsvBuffer(fs.readFileSync(file)), { replaceAll: process.argv.includes('--replace') });
console.log(JSON.stringify(summary, null, 2));
