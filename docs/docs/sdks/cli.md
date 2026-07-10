---
id: cli
title: CLI Tool
sidebar_label: CLI
sidebar_position: 4
---

# PlugPort CLI

The `@plugport/cli` package provides developer tools for working with PlugPort.

## Installation

```bash
npm install -g @plugport/cli
# or use directly with npx
npx @plugport/cli <command>
```

## Commands

### `plugport init`

Scaffolds a new PlugPort project.

```bash
plugport init
plugport init --template node  # node, python, go
```

Creates: `package.json`, `tsconfig.json`, `src/index.ts` (sample app), `.env`

### `plugport dev`

Starts a local PlugPort server for development.

```bash
plugport dev
plugport dev --port 9090
plugport dev --wire-port 27018
plugport dev --no-dashboard
```

### `plugport playground`

Starts a server with pre-loaded sample data and indexes - perfect for experimentation.

```bash
plugport playground
```

Loads 3 sample collections:
- `users` (5 docs, indexed on email)
- `products` (4 docs, indexed on category)
- `orders` (3 docs)

### `plugport query <collection>`

Run queries from the command line.

```bash
plugport query users
plugport query users --filter '{"role": "admin"}'
plugport query products --filter '{"price": {"$lt": 50}}' --limit 5
plugport query users --url http://remote-server:8080
```

### `plugport migrate`

Import MongoDB JSON dump files into PlugPort.

```bash
# Import from a MongoDB export
plugport migrate --file users.json --collection users

# With custom server URL
plugport migrate --file dump.json --collection data --url http://server:8080
```

### `plugport status`

Show server status and health information.

```bash
plugport status
plugport status --url http://remote-server:8080
```

Output:
```
  PlugPort Server Status

  Status:     ok
  Version:    1.0.0
  Uptime:     2h 45m
  Keys:       1,234
```

### `plugport protocol`

Manage database protocol frontends (MongoDB, PostgreSQL, MySQL, Redis).

```bash
# List all protocols and their status
plugport protocol list

# Enable a protocol
plugport protocol enable postgresql

# Disable a protocol
plugport protocol disable mysql
```

### `plugport whitelist`

Manage the private store address whitelist.

```bash
# Add an address
plugport whitelist add 0xabc123...

# Remove an address
plugport whitelist remove 0xabc123...

# List all whitelisted addresses
plugport whitelist list
```
