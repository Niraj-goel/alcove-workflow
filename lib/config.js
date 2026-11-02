// Reads settings from environment variables and an optional .env file next to server.js.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function loadDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m || line.trim().startsWith('#')) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadDotEnv();

const env = process.env;

module.exports = {
  ROOT,
  PORT: Number(env.PORT || 3000),
  // On the live server use 127.0.0.1 so only Caddy (HTTPS) can reach the app.
  HOST: env.HOST || '0.0.0.0',
  DATA_DIR: path.resolve(ROOT, env.DATA_DIR || 'data'),
  UPLOAD_DIR: path.resolve(ROOT, env.UPLOAD_DIR || 'data/uploads'),
  // Tasks are generated only from this date onwards, so old history doesn't show up as overdue.
  GO_LIVE_DATE: env.GO_LIVE_DATE || '',
  // 0 = Sunday ... 6 = Saturday. Daily tasks are created only on these days.
  WORKING_DAYS: (env.WORKING_DAYS || '1,2,3,4,5,6').split(',').map(Number),
  // Upcoming (non-daily) tasks are shown this many days in advance.
  LOOKAHEAD_DAYS: Number(env.LOOKAHEAD_DAYS || 35),
  DEFAULT_PASSWORD: env.DEFAULT_PASSWORD || 'Alcove@123',
  ADMIN_NAMES: (env.ADMIN_NAMES || 'Niraj Goel').split(',').map(s => s.trim()).filter(Boolean),
  // 'approval' = proof mandatory only for tasks that need approval; 'all' = for every task.
  PROOF_REQUIRED_FOR: env.PROOF_REQUIRED_FOR || 'approval',
  MAX_UPLOAD_MB: Number(env.MAX_UPLOAD_MB || 20),
  SMTP: {
    host: env.SMTP_HOST || '',
    port: Number(env.SMTP_PORT || 587),
    secure: env.SMTP_SECURE === 'true',
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.SMTP_FROM || env.SMTP_USER || '',
  },
  DIGEST_HOUR: Number(env.DIGEST_HOUR || 9),
  PORTAL_URL: env.PORTAL_URL || '',
};
