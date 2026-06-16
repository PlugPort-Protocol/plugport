// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

/**
 * @title PlugPortPrivateStore
 * @notice Encrypted key-value store with address-based access control (ACL).
 *         Data is encrypted client-side (AES-256-GCM) before storage.
 *         Only the owner and whitelisted addresses can read/write.
 *
 * @dev Security model:
 *   - Data is stored encrypted on-chain (contract never sees plaintext)
 *   - Encryption key is managed client-side by the owner (derived from private key)
 *   - Owner shares decryption key with whitelisted addresses via ECDH key exchange
 *   - Contract enforces access control: only whitelisted addresses can call get/put
 *   - On-chain data is opaque bytes — even validators cannot read it
 *   - Removing a whitelisted address also deletes their encrypted key share
 *
 * Key sharing flow:
 *   1. Owner generates AES-256 key (deterministic from their private key via HKDF)
 *   2. Owner encrypts AES key with each whitelisted address's ECDH public key
 *   3. Encrypted key shares are stored on-chain via setKeyShare()
 *   4. Whitelisted addresses decrypt the key share with their private key
 *   5. Now they can decrypt/encrypt data with the shared AES key
 */
contract PlugPortPrivateStore {
    address public owner;
    address public gasStation;

    /// @dev Whitelist: address → authorized flag
    mapping(address => bool) public whitelist;
    
    /// @dev Track all whitelisted addresses for enumeration
    address[] private whitelistedAddresses;
    mapping(address => uint256) private whitelistIndex;
    uint256 public whitelistCount;

    /// @dev Encrypted KV storage (same pattern as PlugPortStore)
    mapping(bytes32 => bytes) private store;
    mapping(bytes32 => bool) private keyExists;
    bytes32[] private keyRegistry;
    mapping(bytes32 => uint256) private keyIndexMap;
    uint256 public keyCount;

    /// @dev Encrypted symmetric key shares (owner → whitelisted address)
    /// Each share is the AES key encrypted with the recipient's ECDH public key
    mapping(address => bytes) public encryptedKeyShares;

    // ---- Events ----

    event AddressWhitelisted(address indexed account);
    event AddressRemoved(address indexed account);
    event EncryptedKeyUpdated(bytes32 indexed key, uint256 valueLength);
    event EncryptedKeyDeleted(bytes32 indexed key);
    event KeyShareUpdated(address indexed recipient);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event GasStationTransferred(address indexed previousGasStation, address indexed newGasStation);

    // ---- Modifiers ----

    modifier onlyOwner() {
        require(msg.sender == owner, "PrivateStore: not owner");
        _;
    }

    modifier onlyAuthorized() {
        require(
            msg.sender == owner || msg.sender == gasStation || whitelist[msg.sender],
            "PrivateStore: not authorized"
        );
        _;
    }

    // ---- Constructor ----

    /**
     * @notice Deploy a private database.
     *         The deployer becomes the owner and is auto-whitelisted.
     * @param _gasStation The address authorized for gas-subsidized writes.
     *                    Pass address(0) to default to msg.sender.
     */
    constructor(address _gasStation) {
        owner = msg.sender;
        address station = _gasStation == address(0) ? msg.sender : _gasStation;
        gasStation = station;
        
        // Owner is always whitelisted
        whitelist[msg.sender] = true;
        whitelistedAddresses.push(msg.sender);
        whitelistIndex[msg.sender] = 0;
        whitelistCount = 1;
        
        emit OwnershipTransferred(address(0), msg.sender);
        emit GasStationTransferred(address(0), station);
        emit AddressWhitelisted(msg.sender);
    }

    // ---- Access Control ----

    /**
     * @notice Add an address to the whitelist.
     *         Only the owner can whitelist new addresses.
     * @param account The address to authorize for read/write access.
     */
    function addToWhitelist(address account) external onlyOwner {
        require(account != address(0), "PrivateStore: zero address");
        require(!whitelist[account], "PrivateStore: already whitelisted");
        
        whitelist[account] = true;
        whitelistIndex[account] = whitelistedAddresses.length;
        whitelistedAddresses.push(account);
        whitelistCount++;
        
        emit AddressWhitelisted(account);
    }

    /**
     * @notice Remove an address from the whitelist.
     *         Also deletes their encrypted key share (they can no longer decrypt new data).
     *         Owner cannot be removed.
     * @param account The address to de-authorize.
     */
    function removeFromWhitelist(address account) external onlyOwner {
        require(account != owner, "PrivateStore: cannot remove owner");
        require(whitelist[account], "PrivateStore: not whitelisted");
        
        whitelist[account] = false;
        delete encryptedKeyShares[account];
        
        // Swap-and-pop from address list
        uint256 idx = whitelistIndex[account];
        uint256 lastIdx = whitelistedAddresses.length - 1;
        if (idx != lastIdx) {
            address lastAddr = whitelistedAddresses[lastIdx];
            whitelistedAddresses[idx] = lastAddr;
            whitelistIndex[lastAddr] = idx;
        }
        whitelistedAddresses.pop();
        delete whitelistIndex[account];
        whitelistCount--;
        
        emit AddressRemoved(account);
    }

    /**
     * @notice Check if an address is whitelisted.
     */
    function isWhitelisted(address account) external view returns (bool) {
        return whitelist[account];
    }

    /**
     * @notice Get all whitelisted addresses.
     */
    function getWhitelistedAddresses() external view onlyAuthorized returns (address[] memory) {
        return whitelistedAddresses;
    }

    /**
     * @notice Store encrypted symmetric key for a whitelisted address.
     *         The key is encrypted with the recipient's ECDH public key.
     * @param recipient The whitelisted address to share the key with.
     * @param encryptedKey The AES-256 key encrypted with recipient's public key.
     */
    function setKeyShare(
        address recipient,
        bytes calldata encryptedKey
    ) external onlyOwner {
        require(whitelist[recipient], "PrivateStore: recipient not whitelisted");
        encryptedKeyShares[recipient] = encryptedKey;
        emit KeyShareUpdated(recipient);
    }

    /**
     * @notice Retrieve your encrypted key share.
     *         Decrypt with your private key to obtain the AES-256 database key.
     */
    function getMyKeyShare() external view onlyAuthorized returns (bytes memory) {
        return encryptedKeyShares[msg.sender];
    }

    // ---- Encrypted Storage (same KVAdapter pattern, access-controlled) ----

    /**
     * @notice Store an encrypted key-value pair.
     *         Value must be encrypted client-side before calling this function.
     * @param key The bytes32 key (keccak256 hash of the original string key)
     * @param encryptedValue The encrypted bytes value
     */
    function put(bytes32 key, bytes calldata encryptedValue) external onlyAuthorized {
        store[key] = encryptedValue;
        if (!keyExists[key]) {
            keyExists[key] = true;
            keyIndexMap[key] = keyRegistry.length;
            keyRegistry.push(key);
            keyCount++;
        }
        emit EncryptedKeyUpdated(key, encryptedValue.length);
    }

    /**
     * @notice Get an encrypted value by key.
     *         Decrypt client-side with the shared AES-256 key.
     * @param key The bytes32 key
     * @return The encrypted bytes value
     */
    function get(bytes32 key) external view onlyAuthorized returns (bytes memory) {
        return store[key];
    }

    /**
     * @notice Delete an encrypted key-value pair.
     */
    function del(bytes32 key) external onlyAuthorized {
        if (!keyExists[key]) return;
        
        delete store[key];
        keyExists[key] = false;
        
        // Swap-and-pop from key registry for O(1) removal
        uint256 idx = keyIndexMap[key];
        uint256 lastIdx = keyRegistry.length - 1;
        if (idx != lastIdx) {
            bytes32 lastKey = keyRegistry[lastIdx];
            keyRegistry[idx] = lastKey;
            keyIndexMap[lastKey] = idx;
        }
        keyRegistry.pop();
        delete keyIndexMap[key];
        keyCount--;
        
        emit EncryptedKeyDeleted(key);
    }

    /**
     * @notice Check if a key exists.
     */
    function exists(bytes32 key) external view onlyAuthorized returns (bool) {
        return keyExists[key];
    }

    /**
     * @notice Batch write: put multiple encrypted key-value pairs and delete keys.
     * @param putKeys Keys to insert/update
     * @param putValues Corresponding encrypted values
     * @param deleteKeys Keys to delete
     */
    function batchWrite(
        bytes32[] calldata putKeys,
        bytes[] calldata putValues,
        bytes32[] calldata deleteKeys
    ) external onlyAuthorized {
        require(putKeys.length == putValues.length, "PrivateStore: length mismatch");
        
        for (uint256 i = 0; i < putKeys.length; i++) {
            store[putKeys[i]] = putValues[i];
            if (!keyExists[putKeys[i]]) {
                keyExists[putKeys[i]] = true;
                keyIndexMap[putKeys[i]] = keyRegistry.length;
                keyRegistry.push(putKeys[i]);
                keyCount++;
            }
            emit EncryptedKeyUpdated(putKeys[i], putValues[i].length);
        }
        
        for (uint256 i = 0; i < deleteKeys.length; i++) {
            if (keyExists[deleteKeys[i]]) {
                delete store[deleteKeys[i]];
                keyExists[deleteKeys[i]] = false;
                
                // Swap-and-pop
                uint256 idx = keyIndexMap[deleteKeys[i]];
                uint256 lastIdx = keyRegistry.length - 1;
                if (idx != lastIdx) {
                    bytes32 lastKey = keyRegistry[lastIdx];
                    keyRegistry[idx] = lastKey;
                    keyIndexMap[lastKey] = idx;
                }
                keyRegistry.pop();
                delete keyIndexMap[deleteKeys[i]];
                keyCount--;
                
                emit EncryptedKeyDeleted(deleteKeys[i]);
            }
        }
    }

    /**
     * @notice Get a page of keys from the registry.
     */
    function getKeys(uint256 offset, uint256 limit) external view onlyAuthorized returns (bytes32[] memory keys) {
        uint256 registryLen = keyRegistry.length;
        if (offset >= registryLen) return new bytes32[](0);
        uint256 end = offset + limit > registryLen ? registryLen : offset + limit;
        keys = new bytes32[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            keys[i - offset] = keyRegistry[i];
        }
    }

    /**
     * @notice Get the total number of keys in the registry.
     */
    function getRegistryLength() external view onlyAuthorized returns (uint256) {
        return keyRegistry.length;
    }

    // ---- Ownership Management ----

    /**
     * @notice Transfer ownership to a new address.
     *         The new owner is automatically whitelisted.
     * @param newOwner The new owner address.
     */
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "PrivateStore: zero address");
        
        if (!whitelist[newOwner]) {
            whitelist[newOwner] = true;
            whitelistIndex[newOwner] = whitelistedAddresses.length;
            whitelistedAddresses.push(newOwner);
            whitelistCount++;
            emit AddressWhitelisted(newOwner);
        }
        
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /**
     * @notice Transfer gas station rights to a new address.
     * @param newGasStation The new gas station address.
     */
    function transferGasStation(address newGasStation) external onlyOwner {
        require(newGasStation != address(0), "PrivateStore: zero address");
        emit GasStationTransferred(gasStation, newGasStation);
        gasStation = newGasStation;
    }
}
