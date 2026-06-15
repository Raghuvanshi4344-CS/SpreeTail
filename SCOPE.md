# Scope and Schema

## Import anomaly classes

The importer currently detects these classes of data problems:

- `duplicate_row` - a row already seen in the same import job.
- `missing_core_field` - missing or invalid date or amount.
- `missing_payer` - no payer could be resolved.
- `missing_counterparty` - a settlement/payment row has no recipient.
- `negative_amount` - amount is negative and treated as a refund/reversal.
- `missing_exchange_rate` - foreign currency row without an explicit exchange rate.
- `payer_outside_membership` - payer not active on the transaction date.
- `inactive_member` - split participant outside the membership window.
- `split_mismatch` - computed split total does not match the transaction total exactly.

## Policies applied

- Core missing fields stop the row from being applied.
- Refund-like negative rows are preserved with a warning rather than deleted.
- Foreign currency rows are blocked until an exchange rate is supplied.
- Membership windows control balance participation.
- Duplicate rows are flagged and require human approval before any further action.

## Database schema

- `users` - login identity records.
- `sessions` - hashed session tokens with expiry.
- `groups` - shared expense groups and their base currency.
- `group_memberships` - dated membership windows.
- `import_jobs` - one row per import run.
- `import_rows` - raw and canonical row snapshots.
- `import_anomalies` - anomaly records with policy actions and user decisions.
- `transactions` - expenses and payments.
- `transaction_splits` - per-user split allocation for each transaction.
- `imports` - legacy placeholder table retained for compatibility.

## Traceability notes

Every imported row is preserved as raw JSON and canonical JSON. The import report shows both, so a reviewer can trace the balance back to the specific source row and the decision taken on any anomaly.
