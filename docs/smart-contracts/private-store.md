# PlugPortPrivateStore — Encrypted Database with ACL

## Overview

`PlugPortPrivateStore.sol` enables **private, encrypted databases** on Monad. Data is encrypted client-side with AES-256-GCM before reaching the blockchain. Only the database owner and whitelisted addresses can read or write data.

## Security Model

```
┌──────────────┐     plaintext      ┌──────────────────┐   encrypted    ┌────────────────────┐
│  Application │  ───────────────▶  │  EncryptionLayer │  ──────────▶  │  Monad Blockchain  │
│  (any proto) │                    │  (AES-256-GCM)   │               │  (PrivateStore)    │
└──────────────┘                    └──────────────────┘               └────────────────────┘
                                            │                                    │
                                     ┌──────┴───────┐                    ┌───────┴────────┐
                                     │  AES Key     │                    │  ACL Check     │
                                     │  (from HKDF) │                    │  (whitelist)   │
                                     └──────────────┘                    └────────────────┘
```

### Key Properties

1. **Contract never sees plaintext** — data is encrypted before leaving your server
2. **AES-256-GCM** — authenticated encryption (tamper detection)
3. **Key derived from owner's Ethereum private key** via HKDF
4. **On-chain data is opaque bytes** — even validators cannot read it
5. **Address-based ACL** — only owner + whitelisted addresses can call contract functions
6. **Key sharing via ECDH** — secure key distribution without exposing the AES key

## Encryption Details

### Key Derivation (HKDF)

```
Owner's Private Key (32 bytes)
         │
    HMAC-SHA256(salt="plugport-private-store-v1", IKM=privateKey)
         │
    PRK (32 bytes)
         │
    HMAC-SHA256(PRK, info="aes-256-gcm-encryption-key" || 0x01)
         │
    AES-256 Key (32 bytes)
```

### Wire Format

Every encrypted value stored on-chain has this format:

```
[12-byte IV] [16-byte Auth Tag] [N-byte Ciphertext]
```

- **IV (Initialization Vector)**: Randomly generated per-write for semantic security
- **Auth Tag**: GCM authentication tag for tamper detection
- **Ciphertext**: AES-256-GCM encrypted data

### Key Sharing (ECDH)

When the owner adds a whitelisted address, the AES key needs to be shared securely:

```
Owner                                          Whitelisted Address
  │                                                      │
  ├── Derives shared secret via ECDH ──────────────────▶ │
  │   (owner.privateKey × recipient.publicKey)           │
  │                                                      │
  ├── Derives encryption key from shared secret          │
  │   SHA-256(sharedSecret)                              │
  │                                                      │
  ├── Encrypts AES key with derived encryption key       │
  │   AES-256-GCM(derivedKey, aesKey)                    │
  │                                                      │
  ├── Stores encrypted key share on-chain ──────────────▶│
  │   setKeyShare(recipient, encryptedKey)               │
  │                                                      │
  │                                                      ├── Derives same shared secret
  │                                                      │   (recipient.privateKey × owner.publicKey)
  │                                                      │
  │                                                      ├── Decrypts key share
  │                                                      │   AES key recovered!
  │                                                      │
```

## Contract API

### Access Control

| Function | Who Can Call | Description |
|----------|-------------|-------------|
| `addToWhitelist(address)` | Owner only | Grant read/write access |
| `removeFromWhitelist(address)` | Owner only | Revoke access (also deletes key share) |
| `isWhitelisted(address)` | Anyone | Check if address is authorized |
| `getWhitelistedAddresses()` | Authorized only | List all whitelisted addresses |
| `setKeyShare(recipient, encryptedKey)` | Owner only | Store encrypted AES key for recipient |
| `getMyKeyShare()` | Authorized only | Retrieve your encrypted key share |

### Storage (same as PlugPortStore, but access-controlled)

| Function | Description |
|----------|-------------|
| `put(key, encryptedValue)` | Store encrypted data |
| `get(key)` | Retrieve encrypted data |
| `del(key)` | Delete a key |
| `exists(key)` | Check if key exists |
| `batchWrite(putKeys, putValues, deleteKeys)` | Batch operations |
| `getKeys(offset, limit)` | Paginated key listing |

## Compatibility

**The encryption layer is compatible with ALL PlugPort protocols:**

| Protocol | Works with Private Mode? | Notes |
|----------|--------------------------|-------|
| MongoDB | ✅ | `mongosh mongodb://localhost:27017` |
| PostgreSQL | ✅ | `psql postgresql://localhost:5432/plugport` |
| MySQL | ✅ | `mysql -h localhost -P 3306` |
| Redis | ✅ | `redis-cli -p 6379` |
| HTTP API | ✅ | `curl http://localhost:8080/api/v1/...` |

Encryption is transparent to the protocol frontends. The `EncryptionLayer` sits between the `DocumentStore` and the `KVAdapter`, encrypting all values on write and decrypting on read.

## Setup Guide

### 1. Deploy the Contract

Deploy `PlugPortPrivateStore.sol` on Monad testnet with your gas station address.

### 2. Configure via Dashboard

You no longer need to use `.env` files to configure privacy. Use the PlugPort Dashboard:

1. Open a collection.
2. Go to the "Privacy" tab.
3. Toggle "Private Mode" on.
4. The Dashboard will prompt you to deploy a `PlugPortPrivateStore` via your wallet.

### 3. Manage Whitelists (Dashboard or API)

Whitelists are managed per-collection, rather than globally:

- **Dashboard:** Add/Remove addresses in the "Privacy" tab.
- **HTTP API:**
  ```bash
  curl -X POST http://localhost:8080/api/v1/collections/my_private_collection/whitelist \
    -H "Authorization: Bearer your-wallet-key" \
    -d '{"address": "0xAlice...", "action": "add"}'
  ```

### 4. Share Keys with Whitelisted Addresses

```typescript
import { encryptKeyForRecipient } from '@plugport/server/storage/encryption-layer';

// Owner encrypts AES key for Alice
const encryptedShare = encryptKeyForRecipient(
  aesKey,                    // 32-byte AES key
  alicePublicKey,            // Alice's secp256k1 public key
  ownerPrivateKey,           // Owner's private key
);

// Store on-chain
await contract.setKeyShare(aliceAddress, encryptedShare);
```

### 5. Whitelisted Address Decrypts Key

```typescript
import { decryptKeyShare } from '@plugport/server/storage/encryption-layer';

// Alice retrieves and decrypts her key share
const encryptedShare = await contract.getMyKeyShare();
const aesKey = decryptKeyShare(
  encryptedShare,
  ownerPublicKey,            // Owner's public key
  alicePrivateKey,           // Alice's private key
);

// Alice can now decrypt database data with aesKey
```

## Security Considerations

- **Key rotation**: Changing the AES key requires re-encrypting all data and re-sharing keys
- **Revocation**: Removing an address from the whitelist deletes their key share, but they may have cached the AES key locally. Re-encryption is recommended for sensitive data.
- **On-chain metadata**: While values are encrypted, key hashes (bytes32) are visible on-chain. Use non-descriptive key schemes.
