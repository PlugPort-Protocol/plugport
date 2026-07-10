---
id: message-broker
title: PlugPortMessageBroker — On-Chain Pub/Sub
sidebar_label: Message Broker
sidebar_position: 1
---

# PlugPortMessageBroker — On-Chain Pub/Sub

## Overview

`PlugPortMessageBroker.sol` provides Redis-compatible Pub/Sub messaging backed by Monad smart contract events. Messages published to channels are emitted as on-chain events, making them **immutable, verifiable, and decentralized**.

## Architecture

```
┌─────────────┐    PUBLISH     ┌──────────────────────┐    emit event     ┌────────────────────┐
│  redis-cli  │  ──────────▶   │   PlugPort Server    │  ──────────────▶  │   Monad Blockchain │
│  (ioredis)  │                │  (MessageBrokerAdap) │                   │  (MessageBroker)   │
└─────────────┘                └──────────────────────┘                   └────────────────────┘
                                        ▲                                         │
┌─────────────┐    SUBSCRIBE            │       eth_subscribe (WebSocket)          │
│  redis-cli  │  ──────────▶   ◀────────┼─────────────────────────────────────────┘
│  (ioredis)  │                         │
└─────────────┘                         │
```

### How It Works

1. **PUBLISH** `channel` `message`
   - PlugPort server encodes the message and calls `publishWithName()` on the smart contract
   - The gas station wallet pays the gas fee (~45,000 gas)
   - The contract emits a `MessagePublished` event with the channel hash, sequence number, and message bytes

2. **SUBSCRIBE** `channel`
   - PlugPort server starts an `eth_subscribe("logs")` WebSocket listener filtered by the channel hash
   - When a `MessagePublished` event is received, the message is decoded and pushed to the subscriber

3. **History Replay**
   - The contract stores the last 100 messages per channel in a ring buffer
   - New subscribers can call `getHistory(channelHash, count)` to catch up

## Contract API

### Write Functions (cost gas)

| Function | Gas (~) | Description |
|----------|---------|-------------|
| `publish(channelHash, message)` | 45,000 | Publish a message, emit event |
| `publishWithName(channelHash, channelName, message)` | 50,000 | Publish + register channel name (first use) |
| `updateSubscriberCount(channelHash, count)` | 25,000 | Update subscriber count (informational) |
| `transferGasStation(newGasStation)` | 25,000 | Transfer gas station rights |

### View Functions (free)

| Function | Description |
|----------|-------------|
| `getHistory(channelHash, count)` | Get last N messages for a channel |
| `getSequence(channelHash)` | Get current sequence number |
| `getHistoryLength(channelHash)` | Get number of messages in history |
| `channelSubscriberCount(hash)` | Get subscriber count |
| `totalMessages()` | Total messages across all channels |

## Gas Station

> **IMPORTANT**: The MessageBroker uses a **DEDICATED** gas station wallet, separate from the PlugPortStore gas station.

This separation ensures that:
- Pub/Sub gas costs don't affect database operations
- Each gas station can be independently funded and monitored
- Rate limiting can be applied per-gas-station

### Setting Up

1. Generate a new keypair for the Pub/Sub gas station
2. Fund it with MON on the Monad testnet
3. Deploy `PlugPortMessageBroker.sol` with the gas station address as constructor arg
4. Set `MESSAGEBROKER_CONTRACT_ADDRESS` and `MONAD_WS_URL` in `.env`

## Usage Examples

### Redis CLI

```bash
# Terminal 1: Subscribe
redis-cli -p 6379 SUBSCRIBE news

# Terminal 2: Publish
redis-cli -p 6379 PUBLISH news "Breaking: PlugPort v2 released!"
```

### Node.js (ioredis)

```typescript
import Redis from 'ioredis';

const sub = new Redis(6379);
const pub = new Redis(6379);

// Subscribe
sub.subscribe('chat:general', (err, count) => {
  console.log(`Subscribed to ${count} channels`);
});

sub.on('message', (channel, message) => {
  console.log(`${channel}: ${message}`);
  // This message was published on-chain and is immutable!
});

// Publish (triggers on-chain transaction)
await pub.publish('chat:general', 'Hello from PlugPort!');
```

### History Replay

```typescript
import { ethers } from 'ethers';

const provider = new ethers.JsonRpcProvider('https://monad-testnet.drpc.org');
const contract = new ethers.Contract(ADDRESS, ABI, provider);

// Get last 10 messages for a channel
const channelHash = ethers.keccak256(ethers.toUtf8Bytes('chat:general'));
const messages = await contract.getHistory(channelHash, 10);

for (const msg of messages) {
  console.log(ethers.toUtf8String(msg));
}
```

## Deployment

```bash
# Using Hardhat or Remix:
# 1. Deploy PlugPortMessageBroker.sol with gas station address
# 2. Fund the gas station with MON
# 3. Update .env:

MESSAGEBROKER_CONTRACT_ADDRESS=0x...deployed_address...
MONAD_WS_URL=wss://monad-testnet.drpc.org
```

## Gas Cost Estimates (Monad Testnet)

| Operation | Gas | Cost at 0.1 gwei |
|-----------|-----|-------------------|
| publish() | ~45,000 | ~0.0000045 MON |
| publishWithName() | ~50,000 | ~0.000005 MON |
| updateSubscriberCount() | ~25,000 | ~0.0000025 MON |

> Gas on Monad is extremely cheap. At 0.1 gwei, publishing 1 million messages costs ~0.5 MON.
