# Implementation Plan: SQL Buffer Limit & Statement Timeouts

While reviewing the **SQL Protocol Coverage** section, it is determined that although the AST Depth Limit (max 5) is successfully implemented to prevent complex `JOIN` parsing loops, there are **two critical missing protections** for PostgreSQL and MySQL:

1. **SQL String Buffer Limit:** The 10,000 character limit on raw SQL strings was never implemented in the sql-parser. Right now, a malicious client could send a 100MB string to the `pg-server` or `mysql-server`, causing the `node-sql-parser` to consume massive amounts of memory (OOM DoS).
2. **Statement Timeout:** The `statement_timeout` was never implemented for the execution layer. A heavy aggregation or unindexed scan could hang the execution context indefinitely.

## Proposed Changes

---

### SQL Translator (`packages/server/src/protocols/`)

#### [MODIFY] `packages/server/src/protocols/sql-translator.ts`
- Add a strict character limit check (10,000 chars) at the very beginning of the `translate(sql: string)` method. If it exceeds this limit, throw a `SQL parse error: Query exceeds maximum allowed length of 10000 characters`.

---

### SQL Servers (`packages/server/src/protocols/`)

#### [MODIFY] `packages/server/src/protocols/pg-server.ts`
- Wrap the `executeTranslated` call in `Promise.race` with a `setTimeout` (e.g., 30 seconds default). If the timeout is reached, throw a timeout error and send a clean Postgres error frame back to the client.

#### [MODIFY] `packages/server/src/protocols/mysql-server.ts`
- Wrap the `executeTranslated` call in `Promise.race` with a `setTimeout` (30 seconds). If it times out, send a MySQL `ERR` packet.

## Open Questions

- Is a **30-second default timeout** acceptable for PostgreSQL/MySQL queries, or would you prefer a different limit (e.g. 15s or 60s)?
- Should we expose this timeout limit as a `.env` variable (e.g., `SQL_STATEMENT_TIMEOUT_MS`), or is hardcoding 30,000ms fine for now?

## Verification Plan

### Automated Tests
- Run `npm run test` to verify we haven't broken any existing SQL parsing or protocol tests.

### Manual Verification
- We can temporarily mock an infinite promise in `this.store.find` to verify the 30-second timeout properly interrupts the execution and sends an error to the client instead of hanging the connection.
