// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title PlugPortStore
 * @notice On-chain key-value store for PlugPort on Monad.
 *         Stores arbitrary bytes values indexed by bytes32 keys.
 *         Only the gas station address can write; reads are free.
 *
 * @dev Key encoding: keccak256(utf8(plugport_key)) → bytes32
 *      Value encoding: JSON document bytes stored as-is
 *
 * Gas optimization notes:
 *   - batchPut() saves ~21000 base gas per call vs individual puts
 *   - Key registry enables enumeration but adds ~20000 gas per new key
 *   - Use events + off-chain indexing for prefix-based scans
 */
contract PlugPortStore {
    // ---- State ----

    address public gasStation;

    /// @dev key → value mapping (core storage)
    mapping(bytes32 => bytes) private store;

    /// @dev key → exists flag (for enumeration and exists checks)
    mapping(bytes32 => bool) private keyExists;

    /// @dev Ordered key registry for on-chain enumeration
    bytes32[] private keyRegistry;

    /// @dev key → index in keyRegistry (for O(1) deletion)
    mapping(bytes32 => uint256) private keyIndex;

    /// @dev Total number of active keys
    uint256 public keyCount;

    // ---- Events ----

    event KeyUpdated(bytes32 indexed key, uint256 valueLength);
    event KeyDeleted(bytes32 indexed key);
    event BatchWritten(uint256 putCount, uint256 deleteCount);
    event GasStationTransferred(address indexed previousGasStation, address indexed newGasStation);

    // ---- Modifiers ----

    modifier onlyGasStation() {
        require(msg.sender == gasStation, "PlugPortStore: caller is not the gas station");
        _;
    }

    // ---- Constructor ----

    /**
     * @notice Deploy with a specific gas station address.
     *         Pass address(0) or your own address to set yourself as the gas station.
     * @param _gasStation The address authorized to write data. If address(0), defaults to msg.sender.
     */
    constructor(address _gasStation) {
        address station = _gasStation == address(0) ? msg.sender : _gasStation;
        gasStation = station;
        emit GasStationTransferred(address(0), station);
    }

    // ---- Gas Station Management ----

    /**
     * @notice Transfer gas station rights to a new address.
     *         Only the current gas station can call this.
     * @param newGasStation The new address to authorize for writes.
     */
    function transferGasStation(address newGasStation) external onlyGasStation {
        require(newGasStation != address(0), "PlugPortStore: zero address");
        emit GasStationTransferred(gasStation, newGasStation);
        gasStation = newGasStation;
    }

    // ---- Write Operations (require MON gas, gas-station-only) ----

    /**
     * @notice Store a key-value pair. Overwrites if key exists.
     * @param key The bytes32 key (keccak256 hash of the original string key)
     * @param value The raw bytes value to store
     */
    function put(bytes32 key, bytes calldata value) external onlyGasStation {
        _put(key, value);
    }

    /**
     * @notice Delete a key-value pair.
     * @param key The bytes32 key to delete
     */
    function del(bytes32 key) external onlyGasStation {
        _del(key);
    }

    /**
     * @notice Batch write multiple key-value pairs and deletions in a single tx.
     *         Saves ~21000 gas per avoided transaction overhead.
     * @param putKeys Keys to insert/update
     * @param putValues Corresponding values
     * @param deleteKeys Keys to delete
     */
    function batchWrite(
        bytes32[] calldata putKeys,
        bytes[] calldata putValues,
        bytes32[] calldata deleteKeys
    ) external onlyGasStation {
        require(putKeys.length == putValues.length, "PlugPortStore: length mismatch");

        for (uint256 i = 0; i < putKeys.length; i++) {
            _put(putKeys[i], putValues[i]);
        }

        for (uint256 i = 0; i < deleteKeys.length; i++) {
            _del(deleteKeys[i]);
        }

        emit BatchWritten(putKeys.length, deleteKeys.length);
    }

    // ---- Read Operations (free - no gas for calls) ----

    /**
     * @notice Get a value by key.
     * @param key The bytes32 key
     * @return The stored bytes value (empty if key doesn't exist)
     */
    function get(bytes32 key) external view returns (bytes memory) {
        return store[key];
    }

    /**
     * @notice Check if a key exists.
     * @param key The bytes32 key
     * @return True if the key has a stored value
     */
    function exists(bytes32 key) external view returns (bool) {
        return keyExists[key];
    }

    /**
     * @notice Get a page of keys from the registry.
     *         Used for on-chain enumeration (scan fallback).
     * @param offset Starting index in the registry
     * @param limit Maximum number of keys to return
     * @return keys Array of stored keys
     */
    function getKeys(uint256 offset, uint256 limit) external view returns (bytes32[] memory keys) {
        uint256 registryLen = keyRegistry.length;
        if (offset >= registryLen) {
            return new bytes32[](0);
        }

        uint256 end = offset + limit;
        if (end > registryLen) {
            end = registryLen;
        }

        keys = new bytes32[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            keys[i - offset] = keyRegistry[i];
        }
    }

    /**
     * @notice Get the total number of keys in the registry (includes gaps from deletions).
     * @return The length of the key registry array
     */
    function getRegistryLength() external view returns (uint256) {
        return keyRegistry.length;
    }

    // ---- Internal Helpers ----

    function _put(bytes32 key, bytes calldata value) internal {
        store[key] = value;

        if (!keyExists[key]) {
            keyExists[key] = true;
            keyIndex[key] = keyRegistry.length;
            keyRegistry.push(key);
            keyCount++;
        }

        emit KeyUpdated(key, value.length);
    }

    function _del(bytes32 key) internal {
        if (!keyExists[key]) return;

        delete store[key];
        keyExists[key] = false;

        // Swap-and-pop from key registry for O(1) removal
        uint256 idx = keyIndex[key];
        uint256 lastIdx = keyRegistry.length - 1;

        if (idx != lastIdx) {
            bytes32 lastKey = keyRegistry[lastIdx];
            keyRegistry[idx] = lastKey;
            keyIndex[lastKey] = idx;
        }

        keyRegistry.pop();
        delete keyIndex[key];
        keyCount--;

        emit KeyDeleted(key);
    }
}
