# AI Usage

## Tools used

- GitHub Copilot inside VS Code for code generation, refactors, and bug fixing.
- Copilot Chat browser and terminal tools for validation and navigation.

## Key prompts

- Build a shared-expenses app with login, group membership windows, expense entry, settlement payments, and CSV import reporting.
- Make the importer preserve raw rows, canonicalize data, and surface anomalies instead of guessing.
- Render a group page that shows both one-number balances and traceable settlement suggestions.

## Incorrect AI outputs I caught

### 1. SQLite bootstrapped before the data directory existed

What happened:

- The first version opened the database before creating the `data` directory.

How I caught it:

- `npm start` failed immediately with a SQLite directory error.

What changed:

- The directory creation moved before database construction in `src/db.js`.

### 2. Manual expense form data was sent to the importer in the wrong shape

What happened:

- The expense form passed raw request fields into the import pipeline instead of a canonical row object.

How I caught it:

- Submitting the form from the browser returned a 500 and the import route could not apply the row cleanly.

What changed:

- I added `buildManualCanonical()` in `server.js` to normalize form submissions before import.

### 3. Approved import rows could not be re-applied cleanly

What happened:

- The first approval path tried to re-run the duplicate detector instead of applying the saved canonical row directly.

How I caught it:

- Reading the importer flow showed that an approved row could still be blocked as a duplicate.

What changed:

- I added a direct saved-row application path in `src/importer.js` and used it from `resolveImportDecision()`.
