// Daily backup: consistent copy of the database into data/backups, keeps the last 30.
// Run from cron:  0 23 * * * cd /opt/alcove-workflow && node scripts/backup.js
process.env.TZ = process.env.TZ || 'Asia/Kolkata';
const fs = require('fs');
const path = require('path');
const config = require('../lib/config');
const { db } = require('../lib/db');
const t = require('../lib/time');

const dir = path.join(config.DATA_DIR, 'backups');
fs.mkdirSync(dir, { recursive: true });
const target = path.join(dir, `workflow-${t.today()}.db`);
if (fs.existsSync(target)) fs.unlinkSync(target);
db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);

const old = fs.readdirSync(dir).filter(f => /^workflow-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().slice(0, -30);
old.forEach(f => fs.unlinkSync(path.join(dir, f)));
console.log(`Backup written: ${target} (removed ${old.length} old)`);
