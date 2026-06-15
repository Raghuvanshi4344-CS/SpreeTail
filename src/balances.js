import { db } from './db.js';

function userMap(groupId) {
  const users = db.prepare(`
    SELECT u.id, u.name, u.username
    FROM users u
    JOIN group_memberships gm ON gm.user_id = u.id
    WHERE gm.group_id = ?
    GROUP BY u.id
    ORDER BY u.name
  `).all(groupId);
  const map = new Map();
  for (const user of users) {
    map.set(user.id, { ...user, balanceMinor: 0, ledger: [] });
  }
  return map;
}

function isActiveOnDate(groupId, userId, date) {
  const row = db.prepare(`
    SELECT 1
    FROM group_memberships
    WHERE group_id = ? AND user_id = ? AND joined_at <= ? AND (left_at IS NULL OR left_at >= ?)
    LIMIT 1
  `).get(groupId, userId, date, date);
  return Boolean(row);
}

function lookupUserByName(groupId, name) {
  if (!name) return null;
  const normalized = name.trim().toLowerCase();
  const row = db.prepare(`
    SELECT u.*
    FROM users u
    JOIN group_memberships gm ON gm.user_id = u.id
    WHERE gm.group_id = ? AND lower(u.name) = ?
    LIMIT 1
  `).get(groupId, normalized);
  return row || null;
}

function computeShares(transaction) {
  const splits = db.prepare('SELECT * FROM transaction_splits WHERE transaction_id = ?').all(transaction.id);
  const shares = new Map();
  for (const split of splits) {
    shares.set(split.user_id, (shares.get(split.user_id) || 0) + split.share_minor);
  }
  return shares;
}

export function computeBalances(groupId) {
  const users = userMap(groupId);
  const transactions = db.prepare(`
    SELECT *
    FROM transactions
    WHERE group_id = ? AND is_active = 1
    ORDER BY expense_date ASC, id ASC
  `).all(groupId);

  for (const tx of transactions) {
    if (tx.transaction_type === 'payment') {
      if (users.has(tx.payer_user_id)) {
        const payer = users.get(tx.payer_user_id);
        payer.balanceMinor -= tx.base_amount_minor;
        payer.ledger.push({ id: tx.id, type: 'payment', direction: 'out', amountMinor: tx.base_amount_minor, date: tx.expense_date, description: tx.description, counterpartyUserId: tx.counterparty_user_id });
      }
      if (tx.counterparty_user_id && users.has(tx.counterparty_user_id)) {
        const payee = users.get(tx.counterparty_user_id);
        payee.balanceMinor += tx.base_amount_minor;
        payee.ledger.push({ id: tx.id, type: 'payment', direction: 'in', amountMinor: tx.base_amount_minor, date: tx.expense_date, description: tx.description, counterpartyUserId: tx.payer_user_id });
      }
      continue;
    }

    if (users.has(tx.payer_user_id)) {
      const payer = users.get(tx.payer_user_id);
      payer.balanceMinor += tx.base_amount_minor;
      payer.ledger.push({ id: tx.id, type: 'expense', direction: 'credit', amountMinor: tx.base_amount_minor, date: tx.expense_date, description: tx.description });
    }

    const shares = computeShares(tx);
    for (const [userId, shareMinor] of shares.entries()) {
      if (!users.has(userId)) continue;
      const member = users.get(userId);
      member.balanceMinor -= shareMinor;
      member.ledger.push({ id: tx.id, type: 'expense', direction: 'debit', amountMinor: shareMinor, date: tx.expense_date, description: tx.description });
    }
  }

  return Array.from(users.values()).sort((a, b) => b.balanceMinor - a.balanceMinor);
}

export function suggestSettlements(groupId) {
  const balances = computeBalances(groupId)
    .filter((member) => member.balanceMinor !== 0)
    .map((member) => ({
      userId: member.id,
      name: member.name,
      balanceMinor: member.balanceMinor
    }));

  const creditors = balances.filter((member) => member.balanceMinor > 0).sort((a, b) => b.balanceMinor - a.balanceMinor);
  const debtors = balances.filter((member) => member.balanceMinor < 0).sort((a, b) => a.balanceMinor - b.balanceMinor);
  const settlements = [];
  let creditorIndex = 0;
  let debtorIndex = 0;

  while (creditorIndex < creditors.length && debtorIndex < debtors.length) {
    const creditor = creditors[creditorIndex];
    const debtor = debtors[debtorIndex];
    const amountMinor = Math.min(creditor.balanceMinor, Math.abs(debtor.balanceMinor));
    settlements.push({
      from: debtor.name,
      to: creditor.name,
      amountMinor
    });
    creditor.balanceMinor -= amountMinor;
    debtor.balanceMinor += amountMinor;
    if (creditor.balanceMinor === 0) creditorIndex += 1;
    if (debtor.balanceMinor === 0) debtorIndex += 1;
  }

  return settlements;
}

export function getExpenseLedger(groupId, limit = 25) {
  const transactions = db.prepare(`
    SELECT t.*, u.name AS payer_name, c.name AS counterparty_name, t.import_row_id AS source_import_row_id
    FROM transactions t
    JOIN users u ON u.id = t.payer_user_id
    LEFT JOIN users c ON c.id = t.counterparty_user_id
    WHERE t.group_id = ?
    ORDER BY t.expense_date DESC, t.id DESC
    LIMIT ?
  `).all(groupId, limit);
  return transactions;
}

export function getGroupOverview(groupId) {
  const totals = db.prepare(`
    SELECT
      COUNT(*) AS transaction_count,
      SUM(CASE WHEN transaction_type = 'expense' THEN base_amount_minor ELSE 0 END) AS expense_total_minor,
      SUM(CASE WHEN transaction_type = 'payment' THEN base_amount_minor ELSE 0 END) AS payment_total_minor
    FROM transactions
    WHERE group_id = ? AND is_active = 1
  `).get(groupId);
  return totals;
}

export function getMemberTimeline(groupId) {
  return db.prepare(`
    SELECT gm.*, u.name, u.username
    FROM group_memberships gm
    JOIN users u ON u.id = gm.user_id
    WHERE gm.group_id = ?
    ORDER BY gm.joined_at ASC, u.name ASC
  `).all(groupId);
}

export function maybeAutoAddMember(groupId, name, date, createdByUserId) {
  if (!name) return null;
  const existing = lookupUserByName(groupId, name);
  if (existing) return existing;
  const userRow = db.prepare('SELECT * FROM users WHERE lower(name) = lower(?) OR lower(username) = lower(?)').get(name, name.toLowerCase());
  if (userRow) {
    db.prepare('INSERT INTO group_memberships (group_id, user_id, joined_at, left_at) VALUES (?, ?, ?, NULL)').run(groupId, userRow.id, date);
    return userRow;
  }
  const insert = db.prepare('INSERT INTO users (name, username, password_hash) VALUES (?, ?, ?)').run(name, name.toLowerCase().replace(/\s+/g, '.'), 'seeded:demo');
  db.prepare('INSERT INTO group_memberships (group_id, user_id, joined_at, left_at) VALUES (?, ?, ?, NULL)').run(groupId, insert.lastInsertRowid, date);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(insert.lastInsertRowid);
}

export { isActiveOnDate };
