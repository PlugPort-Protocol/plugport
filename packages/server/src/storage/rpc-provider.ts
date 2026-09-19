// JSON-RPC provider construction for the Monad public RPC.
//
// ethers' JsonRpcProvider batches calls that are made close together into a
// single JSON-RPC array request. Measured against testnet-rpc.monad.xyz:
//
//   ethers default (batching), 25 concurrent reads   77 of 100 failed
//   ethers with batchMaxCount: 1, 25 concurrent        0 of 100 failed
//   raw JSON-RPC batches of 2 / 5 / 10              ~1 of every 8 / 20 / 20 calls succeeded
//   raw parallel (unbatched) requests, 25 at once   13 of 25 succeeded
//   raw sequential requests                         10 of 10 succeeded (~280 ms each)
//
// The failures surface as "missing revert data" (CALL_EXCEPTION) even though
// the contract call is fine — which is why reads looked randomly flaky and a
// wallet's key list could come back empty. With batchMaxCount: 1 ethers sends
// one request per call and, in practice, works through them one at a time,
// which is the access pattern this RPC tolerates.
//
// The trade-off is throughput: roughly 3-5 calls per second. That is fine for
// small, latency-tolerant read paths (e.g. one wallet's keys) and is why bulk
// readers (document scans, registry replay) are not switched over blindly.

import { ethers } from 'ethers';

export function createRpcProvider(rpcUrl: string, chainId: number, name = 'monad'): ethers.JsonRpcProvider {
    const network = ethers.Network.from({ chainId, name });
    // staticNetwork also skips the eth_chainId probe ethers otherwise repeats.
    return new ethers.JsonRpcProvider(rpcUrl, network, { staticNetwork: network, batchMaxCount: 1 });
}
