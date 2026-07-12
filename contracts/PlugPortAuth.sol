// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

/**
 * @title PlugPortAuth
 * @notice On-chain authentication contract for PlugPort.
 *         Manages wallet-derived API keys via hash commitments (keccak256)
 *         and stores SCRAM-SHA-256 verifiers for MongoDB wire protocol auth.
 *
 * @dev Architecture:
 *   - Standalone contract (not per-user) — all wallets share one instance.
 *   - Dedicated gas station for meta-transactions — users never need MON.
 *   - Self-sovereign: only the key owner (verified via msg.sender or EIP-712
 *     signature) can register, revoke, or rotate their own keys.
 *
 * Key lifecycle:
 *   1. User's wallet signs a deterministic message to derive an API key.
 *   2. Client computes keccak256(apiKey) as the hash commitment.
 *   3. Client computes SCRAM salt, StoredKey, and ServerKey from the API key.
 *   4. Client calls registerKey() directly or signs a meta-tx for the gas station.
 *   5. Server reads on-chain verifiers during SCRAM handshake (free RPC read).
 *   6. For HTTP auth, server hashes the provided API key and calls validateKey().
 *
 * Security constraints:
 *   - Only msg.sender (direct) or verified EIP-712 signer (meta-tx) can
 *     register/revoke their own keys. No admin can modify another user's keys.
 *   - Maximum 10 API keys per wallet address (storage abuse prevention).
 *   - The owner role only controls gas station transfer — zero access to user keys.
 *   - Gas station can only relay user-signed meta-transactions.
 *   - Nonce-based replay protection for meta-transactions.
 *   - SCRAM verifiers (StoredKey, ServerKey) are one-way derivations.
 *   - Hash commitments (keccak256) are irreversible.
 *   - Key revocation is immediate and on-chain.
 */
contract PlugPortAuth {

    // ---- Types ----

    struct KeyEntry {
        bytes32 commitment;       // keccak256(apiKey)
        bytes32 salt;             // SCRAM salt: keccak256(abi.encodePacked(owner, keyIndex))
        bytes32 storedKey;        // SCRAM StoredKey (HMAC-SHA-256 derived)
        bytes32 serverKey;        // SCRAM ServerKey (HMAC-SHA-256 derived)
        uint8   keyIndex;         // Derivation index (0, 1, 2...)
        bool    active;           // Can be revoked without deletion
        uint256 createdAt;        // Block timestamp of registration
    }

    // ---- Constants ----

    /// @dev Maximum number of API keys per wallet address
    uint8 public constant MAX_KEYS_PER_ADDRESS = 10;

    /// @dev EIP-712 domain separator components
    bytes32 public constant REGISTER_TYPEHASH = keccak256(
        "RegisterKey(address owner,bytes32 commitment,bytes32 salt,bytes32 storedKey,bytes32 serverKey,uint256 nonce)"
    );
    bytes32 public constant REVOKE_TYPEHASH = keccak256(
        "RevokeKey(address owner,uint8 keyIndex,uint256 nonce)"
    );
    bytes32 public constant ROTATE_TYPEHASH = keccak256(
        "RotateKey(address owner,uint8 oldKeyIndex,bytes32 newCommitment,bytes32 newSalt,bytes32 newStoredKey,bytes32 newServerKey,uint256 nonce)"
    );

    // ---- State ----

    /// @dev Contract deployer — can only transfer gas station role
    address public owner;

    /// @dev Gas station address — authorized to relay meta-transactions
    address public gasStation;

    /// @dev Per-wallet API key storage
    mapping(address => KeyEntry[]) private keys;

    /// @dev Number of registered keys per wallet (including revoked)
    mapping(address => uint8) public keyCount;

    /// @dev Replay protection nonces for meta-transactions
    mapping(address => uint256) public nonces;

    /// @dev EIP-712 domain separator (computed at deployment)
    bytes32 public immutable DOMAIN_SEPARATOR;

    // ---- Events ----

    event KeyRegistered(address indexed keyOwner, uint8 keyIndex, uint256 timestamp);
    event KeyRevoked(address indexed keyOwner, uint8 keyIndex, uint256 timestamp);
    event KeyRotated(address indexed keyOwner, uint8 oldKeyIndex, uint8 newKeyIndex, uint256 timestamp);
    event GasStationTransferred(address indexed previousGasStation, address indexed newGasStation);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ---- Modifiers ----

    modifier onlyOwner() {
        require(msg.sender == owner, "PlugPortAuth: not owner");
        _;
    }

    modifier onlyGasStation() {
        require(msg.sender == gasStation, "PlugPortAuth: not gas station");
        _;
    }

    // ---- Constructor ----

    /**
     * @notice Deploy the PlugPortAuth contract.
     * @param _gasStation The address of the gas station wallet.
     *                    Pass address(0) to default to msg.sender.
     */
    constructor(address _gasStation) {
        owner = msg.sender;
        address station = _gasStation == address(0) ? msg.sender : _gasStation;
        gasStation = station;

        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("PlugPortAuth"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );

        emit OwnershipTransferred(address(0), msg.sender);
        emit GasStationTransferred(address(0), station);
    }

    // ---- Direct Key Management (user pays gas) ----

    /**
     * @notice Register a new API key for the caller.
     * @param commitment  keccak256(apiKey) — the hash commitment.
     * @param salt        SCRAM salt (deterministic from address + keyIndex).
     * @param storedKey   SCRAM StoredKey (HMAC-SHA-256 derived from API key).
     * @param serverKey   SCRAM ServerKey (HMAC-SHA-256 derived from API key).
     */
    function registerKey(
        bytes32 commitment,
        bytes32 salt,
        bytes32 storedKey,
        bytes32 serverKey
    ) external {
        _registerKey(msg.sender, commitment, salt, storedKey, serverKey);
    }

    /**
     * @notice Revoke an API key by index.
     * @param keyIndex The index of the key to revoke.
     */
    function revokeKey(uint8 keyIndex) external {
        _revokeKey(msg.sender, keyIndex);
    }

    /**
     * @notice Atomically revoke an old key and register a new one.
     * @param oldKeyIndex     The index of the key to revoke.
     * @param newCommitment   keccak256(newApiKey).
     * @param newSalt         SCRAM salt for the new key.
     * @param newStoredKey    SCRAM StoredKey for the new key.
     * @param newServerKey    SCRAM ServerKey for the new key.
     */
    function rotateKey(
        uint8 oldKeyIndex,
        bytes32 newCommitment,
        bytes32 newSalt,
        bytes32 newStoredKey,
        bytes32 newServerKey
    ) external {
        // Revoke first to ensure atomicity — if revoke fails, no orphan key is created
        _revokeKey(msg.sender, oldKeyIndex);
        uint8 newIndex = _registerKey(msg.sender, newCommitment, newSalt, newStoredKey, newServerKey);
        emit KeyRotated(msg.sender, oldKeyIndex, newIndex, block.timestamp);
    }

    // ---- Meta-Transaction Key Management (gas station pays gas) ----

    /**
     * @notice Register a key on behalf of a user via meta-transaction.
     *         The gas station calls this with the user's EIP-712 signature.
     * @param keyOwner    The wallet address that owns the key.
     * @param commitment  keccak256(apiKey).
     * @param salt        SCRAM salt.
     * @param storedKey   SCRAM StoredKey.
     * @param serverKey   SCRAM ServerKey.
     * @param nonce       The user's current nonce (replay protection).
     * @param signature   EIP-712 signature from the key owner.
     */
    function registerKeyMeta(
        address keyOwner,
        bytes32 commitment,
        bytes32 salt,
        bytes32 storedKey,
        bytes32 serverKey,
        uint256 nonce,
        bytes calldata signature
    ) external onlyGasStation {
        // Verify nonce
        require(nonce == nonces[keyOwner], "PlugPortAuth: invalid nonce");

        // Verify EIP-712 signature
        bytes32 structHash = keccak256(abi.encode(
            REGISTER_TYPEHASH,
            keyOwner,
            commitment,
            salt,
            storedKey,
            serverKey,
            nonce
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
        address signer = _recoverSigner(digest, signature);
        require(signer == keyOwner, "PlugPortAuth: invalid signature");

        // Increment nonce (replay protection)
        nonces[keyOwner]++;

        // Register the key
        _registerKey(keyOwner, commitment, salt, storedKey, serverKey);
    }

    /**
     * @notice Revoke a key on behalf of a user via meta-transaction.
     * @param keyOwner    The wallet address that owns the key.
     * @param keyIndex    The index of the key to revoke.
     * @param nonce       The user's current nonce.
     * @param signature   EIP-712 signature from the key owner.
     */
    function revokeKeyMeta(
        address keyOwner,
        uint8 keyIndex,
        uint256 nonce,
        bytes calldata signature
    ) external onlyGasStation {
        // Verify nonce
        require(nonce == nonces[keyOwner], "PlugPortAuth: invalid nonce");

        // Verify EIP-712 signature
        bytes32 structHash = keccak256(abi.encode(
            REVOKE_TYPEHASH,
            keyOwner,
            keyIndex,
            nonce
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
        address signer = _recoverSigner(digest, signature);
        require(signer == keyOwner, "PlugPortAuth: invalid signature");

        // Increment nonce
        nonces[keyOwner]++;

        // Revoke the key
        _revokeKey(keyOwner, keyIndex);
    }

    /**
     * @notice Atomically rotate a key on behalf of a user via meta-transaction.
     *         The gas station calls this with the user's EIP-712 signature.
     * @param keyOwner        The wallet address.
     * @param oldKeyIndex     The index of the key to revoke.
     * @param newCommitment   keccak256(newApiKey).
     * @param newSalt         SCRAM salt for the new key.
     * @param newStoredKey    SCRAM StoredKey for the new key.
     * @param newServerKey    SCRAM ServerKey for the new key.
     * @param nonce           The user's current nonce (replay protection).
     * @param signature       EIP-712 signature from the key owner.
     */
    function rotateKeyMeta(
        address keyOwner,
        uint8 oldKeyIndex,
        bytes32 newCommitment,
        bytes32 newSalt,
        bytes32 newStoredKey,
        bytes32 newServerKey,
        uint256 nonce,
        bytes calldata signature
    ) external onlyGasStation {
        // Verify nonce
        require(nonce == nonces[keyOwner], "PlugPortAuth: invalid nonce");

        // Verify EIP-712 signature
        bytes32 structHash = keccak256(abi.encode(
            ROTATE_TYPEHASH,
            keyOwner,
            oldKeyIndex,
            newCommitment,
            newSalt,
            newStoredKey,
            newServerKey,
            nonce
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
        address signer = _recoverSigner(digest, signature);
        require(signer == keyOwner, "PlugPortAuth: invalid signature");

        // Increment nonce
        nonces[keyOwner]++;

        // Revoke first, then register (atomic within single tx)
        _revokeKey(keyOwner, oldKeyIndex);
        uint8 newIndex = _registerKey(keyOwner, newCommitment, newSalt, newStoredKey, newServerKey);
        emit KeyRotated(keyOwner, oldKeyIndex, newIndex, block.timestamp);
    }

    // ---- View Functions (free RPC reads) ----

    /**
     * @notice Get the SCRAM verifier for a key. Used during saslStart/saslContinue.
     * @param addr      The wallet address.
     * @param keyIndex  The key derivation index.
     * @return salt       SCRAM salt.
     * @return storedKey  SCRAM StoredKey.
     * @return serverKey  SCRAM ServerKey.
     * @return active     Whether the key is active.
     */
    function getVerifier(address addr, uint8 keyIndex) external view returns (
        bytes32 salt,
        bytes32 storedKey,
        bytes32 serverKey,
        bool active
    ) {
        require(keyIndex < keys[addr].length, "PlugPortAuth: key not found");
        KeyEntry storage entry = keys[addr][keyIndex];
        return (entry.salt, entry.storedKey, entry.serverKey, entry.active);
    }

    /**
     * @notice Get the hash commitment for a key.
     * @param addr      The wallet address.
     * @param keyIndex  The key derivation index.
     * @return The keccak256(apiKey) commitment.
     */
    function getCommitment(address addr, uint8 keyIndex) external view returns (bytes32) {
        require(keyIndex < keys[addr].length, "PlugPortAuth: key not found");
        return keys[addr][keyIndex].commitment;
    }

    /**
     * @notice Validate an API key hash against all active commitments for an address.
     *         Used by the HTTP server to validate x-api-key header.
     * @param addr     The wallet address.
     * @param keyHash  keccak256(apiKey) to validate.
     * @return True if keyHash matches any active commitment for this address.
     */
    function validateKey(address addr, bytes32 keyHash) external view returns (bool) {
        KeyEntry[] storage userKeys = keys[addr];
        for (uint256 i = 0; i < userKeys.length; i++) {
            if (userKeys[i].active && userKeys[i].commitment == keyHash) {
                return true;
            }
        }
        return false;
    }

    /**
     * @notice Get all active key indices for an address.
     * @param addr The wallet address.
     * @return activeIndices Array of active key indices.
     */
    function getActiveKeys(address addr) external view returns (uint8[] memory) {
        KeyEntry[] storage userKeys = keys[addr];
        
        // Count active keys first
        uint8 activeCount = 0;
        for (uint256 i = 0; i < userKeys.length; i++) {
            if (userKeys[i].active) activeCount++;
        }

        // Build result array
        uint8[] memory activeIndices = new uint8[](activeCount);
        uint8 idx = 0;
        for (uint256 i = 0; i < userKeys.length; i++) {
            if (userKeys[i].active) {
                activeIndices[idx] = userKeys[i].keyIndex;
                idx++;
            }
        }
        return activeIndices;
    }

    /**
     * @notice Quick check if a specific key is active.
     * @param addr      The wallet address.
     * @param keyIndex  The key derivation index.
     * @return True if the key exists and is active.
     */
    function isKeyActive(address addr, uint8 keyIndex) external view returns (bool) {
        if (keyIndex >= keys[addr].length) return false;
        return keys[addr][keyIndex].active;
    }

    /**
     * @notice Get the total number of registered keys for an address (including revoked).
     * @param addr The wallet address.
     * @return The number of keys.
     */
    function getKeyCount(address addr) external view returns (uint8) {
        return keyCount[addr];
    }

    // ---- Admin Functions ----

    /**
     * @notice Transfer gas station role to a new address.
     *         Only the contract owner can call this.
     * @param newGasStation The new gas station address.
     */
    function transferGasStation(address newGasStation) external onlyOwner {
        require(newGasStation != address(0), "PlugPortAuth: zero address");
        emit GasStationTransferred(gasStation, newGasStation);
        gasStation = newGasStation;
    }

    /**
     * @notice Transfer contract ownership.
     *         Only the current owner can call this.
     * @param newOwner The new owner address.
     */
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "PlugPortAuth: zero address");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // ---- Internal Functions ----

    /**
     * @dev Register a key for a given owner. Shared by direct and meta-tx flows.
     * @return The keyIndex of the newly registered key.
     */
    function _registerKey(
        address keyOwner,
        bytes32 commitment,
        bytes32 salt,
        bytes32 storedKey,
        bytes32 serverKey
    ) internal returns (uint8) {
        require(commitment != bytes32(0), "PlugPortAuth: empty commitment");
        require(keyCount[keyOwner] < MAX_KEYS_PER_ADDRESS, "PlugPortAuth: max keys reached");

        uint8 newIndex = keyCount[keyOwner];

        keys[keyOwner].push(KeyEntry({
            commitment: commitment,
            salt: salt,
            storedKey: storedKey,
            serverKey: serverKey,
            keyIndex: newIndex,
            active: true,
            createdAt: block.timestamp
        }));

        keyCount[keyOwner]++;

        emit KeyRegistered(keyOwner, newIndex, block.timestamp);
        return newIndex;
    }

    /**
     * @dev Revoke a key for a given owner. Shared by direct and meta-tx flows.
     */
    function _revokeKey(address keyOwner, uint8 keyIndex) internal {
        require(keyIndex < keys[keyOwner].length, "PlugPortAuth: key not found");
        require(keys[keyOwner][keyIndex].active, "PlugPortAuth: key already revoked");
        keys[keyOwner][keyIndex].active = false;
        emit KeyRevoked(keyOwner, keyIndex, block.timestamp);
    }

    /**
     * @dev Recover the signer address from an EIP-712 digest and signature.
     * @param digest    The EIP-712 digest (hash of domain separator + struct hash).
     * @param signature The 65-byte ECDSA signature (r, s, v).
     * @return The recovered signer address.
     */
    function _recoverSigner(bytes32 digest, bytes calldata signature) internal pure returns (address) {
        require(signature.length == 65, "PlugPortAuth: invalid signature length");

        bytes32 r;
        bytes32 s;
        uint8 v;

        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }

        // EIP-2 compliance: restrict s to lower half of secp256k1 order
        require(
            uint256(s) <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0,
            "PlugPortAuth: invalid signature s"
        );
        require(v == 27 || v == 28, "PlugPortAuth: invalid signature v");

        address signer = ecrecover(digest, v, r, s);
        require(signer != address(0), "PlugPortAuth: invalid signature");
        return signer;
    }
}
