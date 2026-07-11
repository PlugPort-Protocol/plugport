---
id: testing
title: Testing & Load Testing
sidebar_label: Testing
sidebar_position: 2
---

# Testing & Load Testing

PlugPort includes unit tests, integration tests, compatibility tests, and `k6` load tests.

## Unit Tests

Each package has its own unit test suite using [Vitest](https://vitest.dev/).

```bash
# Run all unit tests across the monorepo
pnpm -r test

# Run only the server unit tests
pnpm --filter @plugport/server test
```

## Integration Tests

The integration test suite (`tests/integration/`) makes real HTTP requests against a running PlugPort server. It uses `start-server-and-test` to automatically boot the server before running the tests.

```bash
pnpm --filter @plugport/tests test:integration
```

## Compatibility Tests

A dedicated compatibility suite verifies that PlugPort behaves identically to the standard MongoDB driver for all supported operations.

```bash
pnpm --filter @plugport/tests test:compat
```

## Load Testing

[k6](https://k6.io/) scripts are located in `tests/load/`. The `crud-mix.js` script simulates a mix of inserts, finds, and updates over HTTP REST.

### Prerequisites

- Install [k6](https://k6.io/docs/get-started/installation/).
- Start the PlugPort server (`pnpm --filter @plugport/server dev`).

### Running

```bash
k6 run tests/load/crud-mix.js
```

Modify the VU count and duration directly in the script to benchmark different concurrency levels.
