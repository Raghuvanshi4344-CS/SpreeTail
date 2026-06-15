# Decision Log

## 1. SQLite instead of an external database

Options considered:

- SQLite
- PostgreSQL
- MySQL

Choice: SQLite for the working app.

Why:

- It satisfies the relational-database requirement.
- It keeps the local setup minimal for a 2-day build.
- The full traceability model is easier to bring up from scratch in a fresh workspace.

## 2. Server-rendered Express app instead of a heavier SPA

Options considered:

- Next.js
- React SPA with API server
- Express with server-rendered templates

Choice: Express + EJS.

Why:

- Fast to build and easy to inspect in a live review.
- Keeps business logic in plain JS modules.
- Makes traceability and import debugging easier to follow in code.

## 3. Import rows are canonicalized before persistence

Options considered:

- Store the raw CSV line only
- Normalize everything immediately
- Store both raw and canonical forms

Choice: store both raw and canonical forms.

Why:

- Raw form preserves the source of truth.
- Canonical form supports deterministic balance calculations.
- The live session can inspect either one.

## 4. Settlement suggestions are derived, not stored

Options considered:

- Persist settlement suggestions
- Compute them from balances on demand

Choice: compute on demand.

Why:

- Settlements change when a balance changes.
- Derived suggestions avoid stale data.
- It keeps the explanation simple in the review.

## 5. Membership is date-bound

Options considered:

- One current membership list
- Date-bound membership windows

Choice: date-bound membership windows.

Why:

- It directly answers the Sam/Meera cases.
- It allows old expenses to remain valid without rewriting history.
- It makes balance tracing explainable row by row.
