---
id: dashboard
title: Dashboard
sidebar_label: Dashboard
sidebar_position: 4
---

# Dashboard

PlugPort ships with a built-in Next.js 15 dashboard (`packages/dashboard/`) that provides comprehensive management and analytics for your entire multi-protocol database.

## Tabs

The dashboard is organized into the following sections:

| Section | Tab | Description |
|---------|-----|-------------|
| **General** | Overview | Server health, connected protocols, and collection summary |
| **General** | Collections | Browse all collections or filter by your SIWE wallet ("My Data" vs "Global") |
| **General** | Protocols | Status and connection details for MongoDB, PostgreSQL, MySQL, Redis |
| **Data** | Query Builder | Run queries in MongoDB, PostgreSQL, Redis, or SQLite dialects |
| **Data** | Document Explorer | Browse, edit, delete, import, and export individual documents |
| **Performance** | Index Manager | Create, list, and drop indexes per collection |
| **Performance** | Metrics | 3-way scoped metrics (My Data / Comparison / Global) for QPS, latency, and distribution |
| **Infrastructure** | Deploy & Gas | Smart contract deployment and MonadDb gas cost estimations |
| **Security** | Privacy & ACL | Toggle public/private collection modes and manage on-chain RBAC roles |
| **Security** | API Keys | Generate, rotate, and revoke scoped API keys |

## Running the Dashboard

```bash
pnpm --filter @plugport/dashboard dev
```

The dashboard will be available at [http://localhost:3000](http://localhost:3000).

## Authentication

The dashboard uses Web3-native authentication via [RainbowKit](https://www.rainbowkit.com/) and [SIWE](https://login.xyz/) (Sign-In With Ethereum). Connect your wallet (e.g., MetaMask, Rabby) and sign a message to verify your identity. The Scope Toggle lets you switch between viewing **My Data** (filtered by your wallet), **Global** (all collections), and **Comparison** (side-by-side).
