// Password hashing (scrypt) and cookie sessions.
const crypto = require('crypto');
const { db } = require('./db');
const t = require('./time');

const COOKIE = 'aw_session';
const SESSION_DAYS = 30;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}

function usernameFor(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '');
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions(token, user_id, created_at) VALUES (?, ?, ?)').run(token, userId, t.now());
  return token;
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return '';
}

function sessionUser(req) {
  const token = readCookie(req, COOKIE);
  if (!token) return null;
  const cutoff = t.fmtDateTime(new Date(Date.now() - SESSION_DAYS * 86400000));
  return db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
                     WHERE s.token = ? AND u.active = 1 AND s.created_at >= ?`).get(token, cutoff) || null;
}

function requireLogin(req, res, next) {
  const user = sessionUser(req);
  if (!user) return res.status(401).json({ error: 'Please log in' });
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only admin can do this' });
  next();
}

module.exports = { COOKIE, SESSION_DAYS, hashPassword, verifyPassword, usernameFor, createSession, readCookie, sessionUser, requireLogin, requireAdmin };
