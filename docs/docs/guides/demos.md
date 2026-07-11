---
id: demos
title: Demos
sidebar_label: Demos
sidebar_position: 5
---

# Demos & Examples

PlugPort ships with fully-functional demo applications in the `demos/` directory. These demonstrate how to build real applications on top of PlugPort's verifiable multi-protocol storage using the `@plugport/sdk`.

> **Prerequisite**: The PlugPort server must be running locally (`pnpm --filter @plugport/server dev`) before starting any demo.

## E-Commerce Demo

**Path**: `demos/ecommerce/`

An Express.js backend demonstrating cart and product management powered by the PlugPort SDK.

**Highlights:**
- Product catalog and cart state management via PlugPort collections.
- Seed script (`pnpm seed`) to populate sample product data.
- Uses `@plugport/sdk` to connect over the HTTP API.

**To Run:**
```bash
# From the monorepo root (dependencies are already linked via pnpm workspace)
pnpm --filter @plugport/demo-ecommerce dev
```

## Real-Time Chat Demo

**Path**: `demos/chat/`

A WebSocket-based chat server demonstrating real-time messaging with verifiable message history.

**Highlights:**
- Bi-directional messaging using the `ws` WebSocket library.
- Messages stored persistently through `@plugport/sdk`.
- Verifiable chat log history backed by MonadDb's Merkle Patricia Trie.

**To Run:**
```bash
pnpm --filter @plugport/demo-chat dev
```
