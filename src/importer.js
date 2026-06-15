import crypto from 'crypto';
import { parse } from 'csv-parse/sync';
import { db } from './db.js';
import { maybeAutoAddMember, isActiveOnDate } from './balances.js';

function normalizeHeader(header) {
  return String(header || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

function asArray(value) {
  if (!value) return [];
  return String(value)
    .split(/[|;/,]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseAmount(input) {
  if (input === null || input === undefined || input === '') return null;
  const text = String(input).trim();
  const currencyMatch = text.match(/(usd|inr|eur|gbp|cad|aud|\$|₹|€|£)/i);
  const currencySymbol = currencyMatch?.[1] || null;
  const cleaned = text.replace(/[^0-9,.-]/g, '').replace(/,(?=\d{3}\b)/g, '');
  const amount = Number(cleaned);
  if (Number.isNaN(amount)) return null;
  const currency = currencySymbol === '$' ? 'USD' : currencySymbol === '₹' ? 'INR' : currencySymbol === '€' ? 'EUR' : currencySymbol === '£' ? 'GBP' : currencySymbol ? currencySymbol.toUpperCase() : null;
  return { amount, currency };
}

function parseDate(input) {
  if (!input) return null;
  const text = String(input).trim();
  const parts = [text, text.replace(/\./g, '-').replace(/\//g, '-')];
  for (const candidate of parts) {
    const date = new Date(candidate);
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString().slice(0, 10);
    }
  }
  const match = text.match(/^(\d{1,2})-(\d{1,2})-(\d{2,4})$/);
  if (match) {
    const day = match[1].padStart(2, '0');
    const month = match[2].padStart(2, '0');
    const year = match[3].length === 2 ? `20${match[3]}` : match[3];
    return `${year}-${month}-${day}`;
  }
  return null;
}

function toMinor(amount) {
  return Math.round(Number(amount) * 100);
}

function sha(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function inferCurrency(row, amountResult) {
  const currency = row.currency || row.curr || row.foreign_currency || amountResult?.currency || 'INR';
  return String(currency).trim().toUpperCase();
}

function mapHeaders(row) {
  const mapped = {};
  for (const [key, value] of Object.entries(row)) {
    mapped[normalizeHeader(key)] = value;
  }
  return mapped;
}

function detectSplitType(row) {
  const raw = String(row.split_type || row.split || row.allocation || row.splitmode || '').trim().toLowerCase();
  if (!raw) return 'equal';
  if (/(equal|even|split equally)/.test(raw)) return 'equal';
  if (/(exact|custom|fixed)/.test(raw)) return 'exact';
  if (/(percent|percentage)/.test(raw)) return 'percentage';
  if (/(shares|ratio)/.test(raw)) return 'shares';
  if (/(settlement|payment|repayment|settle)/.test(raw)) return 'payment';
  return raw;
}

function detectNames(row) {
  return {
    payer: row.payer || row.paid_by || row.paidby || row.from || row.by,
    counterparty: row.recipient || row.payee || row.paid_to || row.to || row.with,
    participants: asArray(row.participants || row.split_among || row.members || row.people || row.for_whom || row.users)
  };
}

function canonicalizeRow(row, rowNumber, defaultCurrency = 'INR') {
  const mapped = mapHeaders(row);
  const amountResult = parseAmount(mapped.amount || mapped.total || mapped.value || mapped.spent || mapped.cost);
  const date = parseDate(mapped.date || mapped.expense_date || mapped.spent_on || mapped.when || mapped.transaction_date);
  const names = detectNames(mapped);
  const splitType = detectSplitType(mapped);
  const currency = inferCurrency(mapped, amountResult) || defaultCurrency;
  const exchangeRate = Number(mapped.exchange_rate || mapped.fx_rate || mapped.rate || mapped.usd_inr || 1) || 1;
  const description = String(mapped.description || mapped.note || mapped.memo || mapped.purpose || mapped.details || '').trim();
  const raw = { ...mapped };
  return {
    rowNumber,
    raw,
    date,
    description,
    amount: amountResult?.amount ?? null,
    currency,
    exchangeRate,
    splitType,
    payer: names.payer ? String(names.payer).trim() : '',
    counterparty: names.counterparty ? String(names.counterparty).trim() : '',
    participants: names.participants,
    exactShares: asArray(mapped.exact_shares || mapped.amounts || mapped.shares_exact),
    percentageShares: asArray(mapped.percentages || mapped.split_percentages),
    kind: splitType === 'payment' ? 'payment' : 'expense'
  };
}

function rowFingerprint(canonical) {
  return sha(JSON.stringify({
    date: canonical.date,
    description: canonical.description.toLowerCase(),
    amount: canonical.amount,
    currency: canonical.currency,
    payer: canonical.payer.toLowerCase(),
    counterparty: canonical.counterparty.toLowerCase(),
    splitType: canonical.splitType,
    participants: canonical.participants.map((item) => item.toLowerCase()).sort(),
    kind: canonical.kind
  }));
}

function createAnomaly(jobId, rowNumber, type, severity, message, policyAction, details = {}) {
  db.prepare(`
    INSERT INTO import_anomalies (import_job_id, row_number, type, severity, message, policy_action, details_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(jobId, rowNumber, type, severity, message, policyAction, JSON.stringify(details));
}

function findDuplicate(jobId, fingerprint) {
  return db.prepare('SELECT * FROM import_rows WHERE import_job_id = ? AND row_hash = ?').get(jobId, fingerprint);
}

function recordTransactionFromCanonical({ importRowId, groupId, canonical, createdByUserId, amountMinor, baseAmountMinor, payerUserId, counterpartyUserId, transactionType }) {
  const insert = db.prepare(`
    INSERT INTO transactions (
      group_id, import_row_id, transaction_type, expense_date, description, payer_user_id, counterparty_user_id,
      amount_minor, currency, fx_rate, base_amount_minor, split_type, raw_json, created_by_user_id, is_active
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(
    groupId,
    importRowId,
    transactionType,
    canonical.date,
    canonical.description || (transactionType === 'payment' ? 'Payment' : 'Imported expense'),
    payerUserId,
    counterpartyUserId ?? null,
    amountMinor,
    canonical.currency,
    canonical.exchangeRate || 1,
    baseAmountMinor,
    canonical.splitType,
    JSON.stringify(canonical.raw),
    createdByUserId
  );
  return insert.lastInsertRowid;
}

function buildTransactionForCanonical({ importRowId, groupId, canonical, createdByUserId, payerUserId, counterpartyUserId, transactionType }) {
  const amountMinor = toMinor(canonical.amount || 0);
  const baseAmountMinor = Math.round(amountMinor * (canonical.currency === 'INR' ? 1 : canonical.exchangeRate || 1));
  const txId = recordTransactionFromCanonical({
    importRowId,
    groupId,
    canonical,
    createdByUserId,
    amountMinor,
    baseAmountMinor,
    payerUserId,
    counterpartyUserId,
    transactionType
  });
  return { txId, amountMinor, baseAmountMinor };
}

function buildExpenseSplits({ txId, payerUserId, canonical, groupId, baseAmountMinor }) {
  let shares = [];
  if (canonical.splitType === 'equal' || canonical.splitType === 'custom') {
    const participants = canonical.participants.length ? canonical.participants : [canonical.payer];
    const activeIds = participants
      .map((name) => maybeAutoAddMember(groupId, name, canonical.date, payerUserId)?.id)
      .filter(Boolean)
      .filter((userId) => isActiveOnDate(groupId, userId, canonical.date));
    const count = activeIds.length || 1;
    const share = Math.round(baseAmountMinor / count);
    shares = activeIds.map((userId, index) => ({ userId, shareMinor: index === count - 1 ? baseAmountMinor - share * (count - 1) : share, shareKind: 'equal', rawValue: '1/n' }));
  } else if (canonical.splitType === 'exact') {
    const participants = canonical.participants.length ? canonical.participants : [canonical.payer];
    const ids = participants.map((name) => maybeAutoAddMember(groupId, name, canonical.date, payerUserId)?.id).filter(Boolean);
    const values = canonical.exactShares.map((item) => Number(item));
    shares = ids.map((userId, index) => ({ userId, shareMinor: Math.round((values[index] || 0) * 100), shareKind: 'exact', rawValue: String(values[index] || 0) }));
  } else if (canonical.splitType === 'percentage') {
    const participants = canonical.participants.length ? canonical.participants : [canonical.payer];
    const ids = participants.map((name) => maybeAutoAddMember(groupId, name, canonical.date, payerUserId)?.id).filter(Boolean);
    const percentages = canonical.percentageShares.map((item) => Number(String(item).replace('%', '')));
    const computed = percentages.map((pct) => Math.round(baseAmountMinor * (pct / 100)));
    shares = ids.map((userId, index) => ({ userId, shareMinor: computed[index] || 0, shareKind: 'percentage', rawValue: String(percentages[index] || 0) }));
    const total = shares.reduce((sum, item) => sum + item.shareMinor, 0);
    if (shares.length && total !== baseAmountMinor) {
      shares[shares.length - 1].shareMinor += baseAmountMinor - total;
    }
  } else if (canonical.splitType === 'shares') {
    const participants = canonical.participants.length ? canonical.participants : [canonical.payer];
    const ids = participants.map((name) => maybeAutoAddMember(groupId, name, canonical.date, payerUserId)?.id).filter(Boolean);
    const ratios = canonical.raw.shares || canonical.raw.share_counts || canonical.raw.split_shares || [];
    const numericRatios = ids.map((_, index) => Number(String(ratios[index] || '1').replace(/[^0-9.-]/g, '')) || 1);
    const totalRatio = numericRatios.reduce((sum, item) => sum + item, 0) || 1;
    let running = 0;
    shares = ids.map((userId, index) => {
      const shareMinor = index === ids.length - 1 ? baseAmountMinor - running : Math.round(baseAmountMinor * (numericRatios[index] / totalRatio));
      running += shareMinor;
      return { userId, shareMinor, shareKind: 'shares', rawValue: String(numericRatios[index]) };
    });
  }
  if (shares.length === 0) {
    const participant = maybeAutoAddMember(groupId, canonical.payer, canonical.date, payerUserId);
    if (participant) {
      shares = [{ userId: participant.id, shareMinor: baseAmountMinor, shareKind: 'default', rawValue: 'payer' }];
    }
  }
  const insert = db.prepare('INSERT INTO transaction_splits (transaction_id, user_id, share_minor, share_kind, raw_value) VALUES (?, ?, ?, ?, ?)');
  for (const share of shares) {
    insert.run(txId, share.userId, share.shareMinor, share.shareKind, share.rawValue);
  }
}

function insertImportRow(jobId, canonical, rowHash) {
  const info = db.prepare(`
    INSERT INTO import_rows (import_job_id, row_number, raw_json, canonical_json, row_hash, is_applied)
    VALUES (?, ?, ?, ?, ?, 0)
  `).run(jobId, canonical.rowNumber, JSON.stringify(canonical.raw), JSON.stringify(canonical), rowHash);
  return info.lastInsertRowid;
}

function importCanonicalRow({ jobId, groupId, canonical, createdByUserId }) {
  const rowHash = rowFingerprint(canonical);
  const duplicate = findDuplicate(jobId, rowHash);
  if (duplicate) {
    createAnomaly(jobId, canonical.rowNumber, 'duplicate_row', 'warning', 'Row matches a previously imported row in this file.', 'requires_approval', { duplicateImportRowId: duplicate.id });
    return { applied: false, duplicate: true };
  }

  const importRowId = insertImportRow(jobId, canonical, rowHash);
  let payer = maybeAutoAddMember(groupId, canonical.payer, canonical.date, createdByUserId);
  if (!payer) {
    createAnomaly(jobId, canonical.rowNumber, 'missing_payer', 'error', 'Could not determine payer.', 'requires_review', {});
    return { applied: false, importRowId };
  }

  if (!isActiveOnDate(groupId, payer.id, canonical.date)) {
    createAnomaly(jobId, canonical.rowNumber, 'payer_outside_membership', 'warning', 'Payer was not active in the group on this date.', 'keep_but_flag', { payer: canonical.payer });
  }

  if (canonical.amount === null || canonical.date === null) {
    createAnomaly(jobId, canonical.rowNumber, 'missing_core_field', 'error', 'Date or amount is missing or invalid.', 'requires_review', {});
    return { applied: false, importRowId };
  }

  if (canonical.amount < 0) {
    createAnomaly(jobId, canonical.rowNumber, 'negative_amount', 'warning', 'Negative amount interpreted as a refund.', 'keep_as_signed', { amount: canonical.amount });
  }

  if (canonical.currency !== 'INR' && canonical.exchangeRate === 1) {
    createAnomaly(jobId, canonical.rowNumber, 'missing_exchange_rate', 'error', `Foreign currency row in ${canonical.currency} needs an exchange rate.`, 'requires_review', { currency: canonical.currency });
    return { applied: false, importRowId };
  }

  if (canonical.kind === 'payment' || /settle|settlement|paid back|repay/i.test(canonical.description)) {
    const counterparty = maybeAutoAddMember(groupId, canonical.counterparty || canonical.raw.recipient || canonical.raw.to || canonical.raw.payee, canonical.date, createdByUserId);
    if (!counterparty) {
      createAnomaly(jobId, canonical.rowNumber, 'missing_counterparty', 'error', 'Payment rows need a recipient.', 'requires_review', {});
      return { applied: false, importRowId };
    }
    const { txId } = buildTransactionForCanonical({
      importRowId,
      groupId,
      canonical,
      createdByUserId,
      payerUserId: payer.id,
      counterpartyUserId: counterparty.id,
      transactionType: 'payment'
    });
    db.prepare('UPDATE import_rows SET is_applied = 1 WHERE id = ?').run(importRowId);
    db.prepare('UPDATE import_jobs SET applied_count = applied_count + 1 WHERE id = ?').run(jobId);
    return { applied: true, importRowId, txId };
  }

  const { txId, baseAmountMinor } = buildTransactionForCanonical({
    importRowId,
    groupId,
    canonical,
    createdByUserId,
    payerUserId: payer.id,
    counterpartyUserId: null,
    transactionType: 'expense'
  });
  buildExpenseSplits({ txId, payerUserId: payer.id, canonical, groupId, baseAmountMinor });

  const participants = canonical.participants.map((name) => maybeAutoAddMember(groupId, name, canonical.date, createdByUserId)).filter(Boolean);
  const inactive = participants.filter((member) => !isActiveOnDate(groupId, member.id, canonical.date));
  if (inactive.length > 0) {
    createAnomaly(jobId, canonical.rowNumber, 'inactive_member', 'warning', 'One or more split members were not active on the transaction date.', 'kept_excluded_from_balance', { inactive: inactive.map((member) => member.name) });
  }

  const totalShares = db.prepare('SELECT SUM(share_minor) AS total FROM transaction_splits WHERE transaction_id = ?').get(txId).total || 0;
  if (totalShares !== baseAmountMinor) {
    createAnomaly(jobId, canonical.rowNumber, 'split_mismatch', 'warning', 'Split total did not match transaction total exactly.', 'adjust_last_share', { expected: baseAmountMinor, actual: totalShares });
  }

  db.prepare('UPDATE import_rows SET is_applied = 1 WHERE id = ?').run(importRowId);
  db.prepare('UPDATE import_jobs SET applied_count = applied_count + 1 WHERE id = ?').run(jobId);
  return { applied: true, importRowId, txId };
}

export function parseImportFile(text) {
  const records = parse(text, { columns: true, skip_empty_lines: true, relax_quotes: true, relax_column_count: true, trim: true });
  return records.map((row, index) => canonicalizeRow(row, index + 2));
}

export function runImportJob({ groupId, createdByUserId, filename, rows, mode }) {
  const jobInfo = db.prepare(`
    INSERT INTO import_jobs (group_id, created_by_user_id, filename, mode, status, completed_at)
    VALUES (?, ?, ?, ?, 'completed', datetime('now'))
  `).run(groupId, createdByUserId, filename, mode);
  const jobId = jobInfo.lastInsertRowid;

  let anomalies = 0;
  let applied = 0;
  let skipped = 0;
  for (const row of rows) {
    const result = importCanonicalRow({ jobId, groupId, canonical: row, createdByUserId });
    if (result.applied) applied += 1;
    else skipped += 1;
  }
  anomalies = db.prepare('SELECT COUNT(*) AS count FROM import_anomalies WHERE import_job_id = ?').get(jobId).count;
  db.prepare('UPDATE import_jobs SET anomaly_count = ?, applied_count = ?, skipped_count = ? WHERE id = ?').run(anomalies, applied, skipped, jobId);
  return { importJobId: jobId, applied, skipped, anomalies };
}

function applySavedImportRow({ importRow, job, decidedByUserId }) {
  const canonical = JSON.parse(importRow.canonical_json);
  const payer = maybeAutoAddMember(job.group_id, canonical.payer, canonical.date, decidedByUserId);
  if (!payer || canonical.amount === null || canonical.date === null) {
    return { applied: false };
  }

  if (canonical.kind === 'payment' || /settle|settlement|paid back|repay/i.test(canonical.description)) {
    const counterparty = maybeAutoAddMember(job.group_id, canonical.counterparty || canonical.raw.recipient || canonical.raw.to || canonical.raw.payee, canonical.date, decidedByUserId);
    if (!counterparty) return { applied: false };
    const { txId } = buildTransactionForCanonical({
      importRowId: importRow.id,
      groupId: job.group_id,
      canonical,
      createdByUserId: decidedByUserId,
      payerUserId: payer.id,
      counterpartyUserId: counterparty.id,
      transactionType: 'payment'
    });
    db.prepare('UPDATE import_rows SET is_applied = 1 WHERE id = ?').run(importRow.id);
    return { applied: true, txId };
  }

  const { txId, baseAmountMinor } = buildTransactionForCanonical({
    importRowId: importRow.id,
    groupId: job.group_id,
    canonical,
    createdByUserId: decidedByUserId,
    payerUserId: payer.id,
    counterpartyUserId: null,
    transactionType: 'expense'
  });
  buildExpenseSplits({ txId, payerUserId: payer.id, canonical, groupId: job.group_id, baseAmountMinor });
  db.prepare('UPDATE import_rows SET is_applied = 1 WHERE id = ?').run(importRow.id);
  return { applied: true, txId };
}

export function resolveImportDecision({ importId, anomalyId, decision, decidedByUserId }) {
  const anomaly = db.prepare('SELECT * FROM import_anomalies WHERE id = ? AND import_job_id = ?').get(anomalyId, importId);
  if (!anomaly) return;
  db.prepare('UPDATE import_anomalies SET decision = ?, decided_at = datetime(\'now\'), decided_by_user_id = ? WHERE id = ?').run(decision, decidedByUserId, anomaly.id);
  if (decision === 'approve') {
    const row = db.prepare('SELECT * FROM import_rows WHERE import_job_id = ? AND row_number = ?').get(importId, anomaly.row_number);
    if (!row) return;
    const job = db.prepare('SELECT * FROM import_jobs WHERE id = ?').get(importId);
    if (!job) return;
    if (!db.prepare('SELECT 1 FROM transactions WHERE import_row_id = ?').get(row.id)) {
      applySavedImportRow({ importRow: row, job, decidedByUserId });
    }
  }
}
