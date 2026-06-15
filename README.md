# Spreatail

Shared-expenses app for a flatshare with dated memberships, explicit import anomalies, and traceable balances.

## Local setup

1. Install dependencies:

```bash
npm install
```

2. Start the app:

```bash
npm start
```

3. Open `http://localhost:3000`.

## Demo login

Use any seeded account below with password `demo1234`:

- `aisha`
- `rohan`
- `priya`
- `meera`
- `dev`
- `sam`

## What the app does

- Login and signup with session cookies.
- Create groups with membership timelines.
- Create expenses, split them several ways, and record payments.
- Import CSV files through the app and review every anomaly in an import report.
- Compute balances and settlement suggestions from the relational database.

## Import policy summary

The importer never silently guesses on core data issues. It records each anomaly, stores the raw row and canonicalized row, and applies a documented policy per anomaly class.

High-level policies:

- Negative amounts are treated as refunds or reversals, but still logged.
- Foreign currency rows require an exchange rate before they can affect balances.
- Membership dates control whether a person participates in an expense.
- Settlement rows are stored as payments, not expenses.
- Duplicate rows are detected within an import job and surfaced for approval.

## AI used

This project was developed with GitHub Copilot acting as the primary coding collaborator. The AI usage log, prompt history, and known mistakes are documented in [AI_USAGE.md](AI_USAGE.md).
