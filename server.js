import express from 'express';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import cookieParser from 'cookie-parser';
import { fileURLToPath } from 'url';
import { initDb, db } from './src/db.js';
import { attachAuth, requireAuth, createSession, destroySession, hashPassword, verifyPassword, getCurrentUser } from './src/auth.js';
import { parseImportFile, runImportJob, resolveImportDecision } from './src/importer.js';
import { getGroupOverview, getMemberTimeline, getExpenseLedger, computeBalances, suggestSettlements } from './src/balances.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const upload = multer({ dest: path.join(__dirname, 'data', 'uploads') });
const PORT = process.env.PORT || 3000;

initDb();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(cookieParser());
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use(attachAuth);

function render(res, view, options = {}) {
  res.render(view, { title: 'Spreatail', ...options });
}

function requireLogin(req, res, next) {
  if (!req.user) {
    return res.redirect('/login');
  }
  return next();
}

function moneyLabel(minor, currency = 'INR') {
  const value = (minor / 100).toFixed(2);
  return `${currency} ${Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function splitList(value) {
  return String(value || '')
    .split(/[|;/,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildManualCanonical(body, kind = 'expense') {
  return {
    rowNumber: 1,
    raw: { ...body },
    date: body.expense_date || body.payment_date || new Date().toISOString().slice(0, 10),
    description: (body.description || '').trim(),
    amount: Number(body.amount),
    currency: String(body.currency || 'INR').trim().toUpperCase(),
    exchangeRate: Number(body.exchange_rate || body.fx_rate || 1) || 1,
    splitType: String(body.split_type || kind).trim().toLowerCase(),
    payer: (body.payer || '').trim(),
    counterparty: (body.payee || body.recipient || '').trim(),
    participants: splitList(body.participants),
    exactShares: splitList(body.exact_shares),
    percentageShares: splitList(body.percentage_shares),
    kind
  };
}

app.get('/', (req, res) => {
  if (req.user) {
    return res.redirect('/dashboard');
  }
  return res.redirect('/login');
});

app.get('/login', (req, res) => {
  render(res, 'login', { error: req.query.error || null });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE lower(username) = lower(?)').get(username || '');
  if (!user || !verifyPassword(password || '', user.password_hash)) {
    return res.redirect('/login?error=Invalid%20credentials');
  }
  const token = createSession(user.id);
  res.cookie('session', token, { httpOnly: true, sameSite: 'lax' });
  res.redirect('/dashboard');
});

app.get('/signup', (req, res) => {
  render(res, 'signup', { error: req.query.error || null });
});

app.post('/signup', (req, res) => {
  const { name, username, password } = req.body;
  if (!name || !username || !password) {
    return res.redirect('/signup?error=Missing%20fields');
  }
  try {
    const stmt = db.prepare('INSERT INTO users (name, username, password_hash) VALUES (?, ?, ?)');
    const info = stmt.run(name.trim(), username.trim(), hashPassword(password));
    const token = createSession(info.lastInsertRowid);
    res.cookie('session', token, { httpOnly: true, sameSite: 'lax' });
    res.redirect('/dashboard');
  } catch (error) {
    return res.redirect('/signup?error=Username%20already%20exists');
  }
});

app.post('/logout', requireLogin, (req, res) => {
  destroySession(req.cookies.session);
  res.clearCookie('session');
  res.redirect('/login');
});

app.get('/dashboard', requireLogin, (req, res) => {
  const groups = db.prepare(`
    SELECT g.*, EXISTS(
      SELECT 1 FROM group_memberships gm WHERE gm.group_id = g.id AND gm.user_id = ? AND (gm.left_at IS NULL OR gm.left_at >= date('now'))
    ) AS is_member
    FROM groups g
    WHERE g.owner_user_id = ?
       OR EXISTS(
         SELECT 1 FROM group_memberships gm WHERE gm.group_id = g.id AND gm.user_id = ? AND (gm.left_at IS NULL OR gm.left_at >= date('now'))
       )
    ORDER BY g.created_at DESC
  `).all(req.user.id, req.user.id, req.user.id);

  const imports = db.prepare(`
    SELECT ij.*, g.name AS group_name
    FROM import_jobs ij
    LEFT JOIN groups g ON g.id = ij.group_id
    WHERE ij.created_by_user_id = ?
    ORDER BY ij.created_at DESC
    LIMIT 12
  `).all(req.user.id);

  render(res, 'dashboard', {
    groups,
    imports,
    user: req.user,
    moneyLabel,
  });
});

app.get('/groups/new', requireLogin, (req, res) => {
  render(res, 'group-new', { user: req.user });
});

app.post('/groups', requireLogin, (req, res) => {
  const name = (req.body.name || '').trim();
  const currency = (req.body.currency || 'INR').trim().toUpperCase();
  if (!name) {
    return res.redirect('/groups/new?error=Name%20required');
  }
  const info = db.prepare('INSERT INTO groups (name, currency, owner_user_id) VALUES (?, ?, ?)').run(name, currency, req.user.id);
  res.redirect(`/groups/${info.lastInsertRowid}`);
});

app.get('/groups/:groupId', requireLogin, (req, res) => {
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.groupId);
  if (!group) return res.status(404).send('Group not found');
  const members = getMemberTimeline(group.id);
  const balances = computeBalances(group.id);
  const settlements = suggestSettlements(group.id);
  const ledger = getExpenseLedger(group.id, 50);
  const overview = getGroupOverview(group.id);
  render(res, 'group', { group, members, balances, settlements, ledger, overview, user: req.user, moneyLabel });
});

app.post('/groups/:groupId/members', requireLogin, (req, res) => {
  const groupId = Number(req.params.groupId);
  const userName = (req.body.user_name || '').trim();
  const joinedAt = (req.body.joined_at || new Date().toISOString().slice(0, 10)).trim();
  const leftAt = (req.body.left_at || '').trim() || null;
  let user = db.prepare('SELECT * FROM users WHERE lower(name) = lower(?) OR lower(username) = lower(?)').get(userName, userName);
  if (!user && userName) {
    const insert = db.prepare('INSERT INTO users (name, username, password_hash) VALUES (?, ?, ?)').run(userName, userName.toLowerCase().replace(/\s+/g, '.'), hashPassword('demo1234'));
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(insert.lastInsertRowid);
  }
  if (!user) return res.redirect(`/groups/${groupId}?error=Member%20required`);
  db.prepare('INSERT INTO group_memberships (group_id, user_id, joined_at, left_at) VALUES (?, ?, ?, ?)').run(groupId, user.id, joinedAt, leftAt);
  res.redirect(`/groups/${groupId}`);
});

app.post('/groups/:groupId/expenses', requireLogin, (req, res) => {
  const groupId = Number(req.params.groupId);
  try {
    const payload = buildManualCanonical(req.body, 'expense');
    const result = runImportJob({
      groupId,
      createdByUserId: req.user.id,
      filename: 'manual-entry',
      rows: [payload],
      mode: 'manual'
    });
    res.redirect(`/imports/${result.importJobId}`);
  } catch (error) {
    res.redirect(`/groups/${groupId}?error=Could%20not%20create%20expense`);
  }
});

app.post('/groups/:groupId/payments', requireLogin, (req, res) => {
  const groupId = Number(req.params.groupId);
  const payer = (req.body.payer || '').trim();
  const payee = (req.body.payee || '').trim();
  const payload = [buildManualCanonical({
    ...req.body,
    description: req.body.description || `Payment from ${payer} to ${payee}`,
    payer,
    payee,
    expense_date: req.body.payment_date
  }, 'payment')];
  const result = runImportJob({
    groupId,
    createdByUserId: req.user.id,
    filename: 'manual-payment',
    rows: payload,
    mode: 'manual'
  });
  res.redirect(`/imports/${result.importJobId}`);
});

app.get('/groups/:groupId/import', requireLogin, (req, res) => {
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.groupId);
  if (!group) return res.status(404).send('Group not found');
  render(res, 'import', { group, user: req.user });
});

app.post('/groups/:groupId/import', requireLogin, upload.single('csv_file'), (req, res) => {
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.groupId);
  if (!group) return res.status(404).send('Group not found');
  if (!req.file) return res.redirect(`/groups/${group.id}/import?error=CSV%20file%20required`);
  const fileText = fs.readFileSync(req.file.path, 'utf8');
  const rows = parseImportFile(fileText);
  const result = runImportJob({
    groupId: group.id,
    createdByUserId: req.user.id,
    filename: req.file.originalname,
    rows,
    mode: 'csv'
  });
  fs.unlink(req.file.path, () => {});
  res.redirect(`/imports/${result.importJobId}`);
});

app.get('/imports/:importId', requireLogin, (req, res) => {
  const job = db.prepare(`
    SELECT ij.*, g.name AS group_name, g.currency AS group_currency
    FROM import_jobs ij
    LEFT JOIN groups g ON g.id = ij.group_id
    WHERE ij.id = ?
  `).get(req.params.importId);
  if (!job) return res.status(404).send('Import not found');
  const anomalies = db.prepare('SELECT * FROM import_anomalies WHERE import_job_id = ? ORDER BY row_number, id').all(job.id);
  const rows = db.prepare('SELECT * FROM import_rows WHERE import_job_id = ? ORDER BY row_number').all(job.id);
  render(res, 'import-report', { job, anomalies, rows, user: req.user, moneyLabel });
});

app.post('/imports/:importId/anomalies/:anomalyId/decision', requireLogin, (req, res) => {
  const job = db.prepare('SELECT * FROM import_jobs WHERE id = ?').get(req.params.importId);
  if (!job) return res.status(404).send('Import not found');
  resolveImportDecision({
    importId: job.id,
    anomalyId: Number(req.params.anomalyId),
    decision: req.body.decision,
    decidedByUserId: req.user.id
  });
  res.redirect(`/imports/${job.id}`);
});

app.use((req, res) => {
  res.status(404).send('Not found');
});

app.listen(PORT, () => {
  console.log(`Spreatail running on http://localhost:${PORT}`);
});
