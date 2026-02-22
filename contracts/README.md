# PlugPort Smart Contract Deployment (Remix)

## Prerequisites

- MetaMask with Monad testnet configured:
  - **Network Name**: Monad Testnet
  - **RPC URL**: `https://monad-testnet.drpc.org`
  - **Chain ID**: `10143`
  - **Currency Symbol**: `MON`
  - **Block Explorer**: `https://testnet.monadvision.com`
- MON tokens in your wallet (get from [faucet.monad.xyz](https://faucet.monad.xyz))

## Deploy via Remix

1. Open [Remix IDE](https://remix.ethereum.org)
2. Create a new file: `PlugPortStore.sol`
3. Paste the contents of `contracts/PlugPortStore.sol`
4. Go to **Solidity Compiler** tab:
   - Compiler version: `0.8.20` or newer
   - Enable **Optimization** (200 runs) to save deployment gas
   - Click **Compile**
5. Go to **Deploy & Run** tab:
   - Environment: **Injected Provider - MetaMask**
   - Ensure MetaMask is connected to **Monad Testnet (10143)**
   - In the **Deploy** section, expand the constructor parameter:
     - **`_gasStation`**: Enter the address that will pay gas for write operations
     - Pass `0x0000000000000000000000000000000000000000` to default to your own wallet
   - Click **Deploy**
   - Confirm the transaction in MetaMask
6. Copy the deployed **contract address**

## Transferring Gas Station Rights

The current gas station address can transfer write rights to a new address:

1. In Remix, find the deployed contract
2. Call `transferGasStation(newAddress)` with the new gas station address
3. Only the current gas station can perform this transfer

## Configure PlugPort Server

Add to your `.env` file:

```env
MONAD_RPC_URL=https://monad-testnet.drpc.org
MONAD_CHAIN_ID=10143
MONAD_PRIVATE_KEY=<gas_station_wallet_private_key_without_0x>
MONAD_CONTRACT_ADDRESS=<deployed_contract_address>
```

> **IMPORTANT**: The `MONAD_PRIVATE_KEY` must be for the **gas station address** — the wallet authorized to write data to the contract.

## Verify on Explorer

Visit `https://testnet.monadvision.com/address/<contract_address>` to verify deployment.
