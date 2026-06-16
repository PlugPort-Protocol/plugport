// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

/**
 * @title PlugPortRelational
 * @notice Batch read operations for JOIN optimization.
 *         Wraps an existing PlugPortStore to provide multi-key reads in a single RPC call.
 *         Reduces JOIN RPC round-trips from O(N) to O(1).
 *
 * @dev Usage:
 *   1. Deploy with the address of your existing PlugPortStore contract
 *   2. Configure RELATIONAL_CONTRACT_ADDRESS in PlugPort server .env
 *   3. JoinEngine will automatically use batchGet() for optimized multi-key reads
 *
 * Gas: All functions are view-only (free, no gas required)
 */

interface IPlugPortStore {
    function get(bytes32 key) external view returns (bytes memory);
    function exists(bytes32 key) external view returns (bool);
    function keyCount() external view returns (uint256);
    function getKeys(uint256 offset, uint256 limit) external view returns (bytes32[] memory);
}

contract PlugPortRelational {
    IPlugPortStore public store;

    /**
     * @notice Deploy with the address of an existing PlugPortStore contract.
     * @param _store Address of the deployed PlugPortStore
     */
    constructor(address _store) {
        require(_store != address(0), "PlugPortRelational: zero address");
        store = IPlugPortStore(_store);
    }

    /**
     * @notice Batch get multiple keys in a single RPC call.
     *         Used by JoinEngine to fetch right-side join keys efficiently.
     *
     * @param keys Array of bytes32 keys to fetch
     * @return values Array of stored values (empty bytes for missing keys)
     * @return keyExists Array of booleans indicating key existence
     *
     * @dev Performance:
     *   - Without batchGet: N individual eth_call → N RPC round-trips
     *   - With batchGet: 1 eth_call → 1 RPC round-trip
     *   - For 1000-key JOIN: ~1002 RPC calls → ~3 RPC calls
     */
    function batchGet(
        bytes32[] calldata keys
    ) external view returns (bytes[] memory values, bool[] memory keyExists) {
        values = new bytes[](keys.length);
        keyExists = new bool[](keys.length);

        for (uint256 i = 0; i < keys.length; i++) {
            keyExists[i] = store.exists(keys[i]);
            if (keyExists[i]) {
                values[i] = store.get(keys[i]);
            }
        }
    }

    /**
     * @notice Count how many keys from a set exist in the store.
     *         Used by JoinEngine query planner to estimate join cardinality.
     *
     * @param keys Array of bytes32 keys to check
     * @return count Number of keys that exist
     */
    function batchExists(
        bytes32[] calldata keys
    ) external view returns (uint256 count) {
        for (uint256 i = 0; i < keys.length; i++) {
            if (store.exists(keys[i])) {
                count++;
            }
        }
    }

    /**
     * @notice Get multiple values and check which keys belong to a specific
     *         prefix/collection. Used for JOIN filtering.
     *
     * @param keys Array of bytes32 keys to fetch
     * @param filterKeys Array of bytes32 keys to check existence for
     * @return values Array of stored values for the `keys` parameter
     * @return filterResults Array of booleans for the `filterKeys` parameter
     */
    function batchGetWithFilter(
        bytes32[] calldata keys,
        bytes32[] calldata filterKeys
    ) external view returns (bytes[] memory values, bool[] memory filterResults) {
        values = new bytes[](keys.length);
        for (uint256 i = 0; i < keys.length; i++) {
            if (store.exists(keys[i])) {
                values[i] = store.get(keys[i]);
            }
        }

        filterResults = new bool[](filterKeys.length);
        for (uint256 i = 0; i < filterKeys.length; i++) {
            filterResults[i] = store.exists(filterKeys[i]);
        }
    }

    /**
     * @notice Get the total key count from the underlying store.
     * @return Total number of active keys
     */
    function getKeyCount() external view returns (uint256) {
        return store.keyCount();
    }
}
