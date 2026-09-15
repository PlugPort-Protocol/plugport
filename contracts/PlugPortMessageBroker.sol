// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

/**
 * @title PlugPortMessageBroker
 * @notice On-chain message broker for Redis-compatible Pub/Sub.
 *         Messages are published as events — subscribers listen via WebSocket.
 *         Uses a DEDICATED gas station (separate from PlugPortStore's gas station).
 *
 * @dev Architecture:
 *   - PUBLISH → emit MessagePublished event (costs gas, paid by gas station)
 *   - SUBSCRIBE → client listens for MessagePublished events via eth_subscribe
 *   - Messages are immutable, on-chain, and verifiable
 *   - Channel names are hashed to bytes32 for storage efficiency
 *   - Gas station is independent from PlugPortStore's gas station
 *
 * Gas costs (Monad testnet estimates):
 *   - publish(): ~45,000 gas (event emit + history write)
 *   - updateSubscriberCount(): ~25,000 gas
 *   - getHistory(): 0 gas (view function)
 */
contract PlugPortMessageBroker {
    address public gasStation;

    /// @dev Channel subscriber count tracking (informational)
    mapping(bytes32 => uint256) public channelSubscriberCount;

    /// @dev Message sequence number per channel (monotonically increasing)
    mapping(bytes32 => uint256) public channelSequence;

    /// @dev Store last N messages per channel for replay (ring buffer)
    mapping(bytes32 => bytes[]) private channelHistory;
    uint256 public constant MAX_HISTORY = 100;

    /// @dev Total messages published across all channels
    uint256 public totalMessages;

    // ---- Events (these ARE the pub/sub delivery mechanism) ----

    event MessagePublished(
        bytes32 indexed channel,
        uint256 indexed sequence,
        address indexed publisher,
        bytes message,
        uint256 timestamp
    );

    event ChannelCreated(bytes32 indexed channel, string name);
    event GasStationTransferred(address indexed previousGasStation, address indexed newGasStation);

    // ---- Modifiers ----

    modifier onlyGasStation() {
        require(msg.sender == gasStation, "MessageBroker: not gas station");
        _;
    }

    // ---- Constructor ----

    /**
     * @notice Deploy with a DEDICATED gas station address for Pub/Sub operations.
     *         This should be a separate wallet from PlugPortStore's gas station.
     * @param _gasStation The address authorized to publish messages. If address(0), defaults to msg.sender.
     */
    constructor(address _gasStation) {
        address station = _gasStation == address(0) ? msg.sender : _gasStation;
        gasStation = station;
        emit GasStationTransferred(address(0), station);
    }

    // ---- Publish (costs gas, paid by gas station) ----

    /**
     * @notice Publish a message to a channel.
     *         Emits a MessagePublished event that subscribers receive via WebSocket.
     * @param channelHash keccak256 of the channel name
     * @param message Raw message bytes (typically UTF-8 encoded string)
     */
    function publish(
        bytes32 channelHash,
        bytes calldata message
    ) external onlyGasStation {
        channelSequence[channelHash]++;
        uint256 seq = channelSequence[channelHash];
        totalMessages++;

        // Store in history ring buffer. During the initial fill (push)
        // phase, sequence `s` lands at index `s - 1` (seq 1 -> index 0,
        // seq 2 -> index 1, ...). Once full, the overwrite index must stay
        // consistent with that same mapping — `(seq - 1) % MAX_HISTORY` —
        // not `seq % MAX_HISTORY`, which is off by one and corrupts replay
        // order for every subscriber catching up via getHistory().
        if (channelHistory[channelHash].length < MAX_HISTORY) {
            channelHistory[channelHash].push(message);
        } else {
            channelHistory[channelHash][(seq - 1) % MAX_HISTORY] = message;
        }

        emit MessagePublished(channelHash, seq, msg.sender, message, block.timestamp);
    }

    /**
     * @notice Publish a message and also register the channel name (first use).
     * @param channelHash keccak256 of the channel name
     * @param channelName The human-readable channel name (for indexing)
     * @param message Raw message bytes
     */
    function publishWithName(
        bytes32 channelHash,
        string calldata channelName,
        bytes calldata message
    ) external onlyGasStation {
        // Register channel name if first message
        if (channelSequence[channelHash] == 0) {
            emit ChannelCreated(channelHash, channelName);
        }

        channelSequence[channelHash]++;
        uint256 seq = channelSequence[channelHash];
        totalMessages++;

        if (channelHistory[channelHash].length < MAX_HISTORY) {
            channelHistory[channelHash].push(message);
        } else {
            channelHistory[channelHash][(seq - 1) % MAX_HISTORY] = message;
        }

        emit MessagePublished(channelHash, seq, msg.sender, message, block.timestamp);
    }

    // ---- Read Operations (free - view functions) ----

    /**
     * @notice Get recent messages for a channel (for new subscriber catch-up / replay).
     *         Reads in true chronological order regardless of whether the
     *         ring buffer has wrapped — array index order alone is only
     *         chronological during the initial fill; once full, the oldest
     *         surviving entry sits wherever the next write will land.
     * @param channelHash keccak256 of the channel name
     * @param count Maximum number of messages to return
     * @return messages Array of recent message bytes, oldest first
     */
    function getHistory(
        bytes32 channelHash,
        uint256 count
    ) external view returns (bytes[] memory messages) {
        bytes[] storage history = channelHistory[channelHash];
        uint256 total = history.length;
        uint256 len = total < count ? total : count;
        messages = new bytes[](len);
        if (len == 0) return messages;

        // Not yet wrapped (total < MAX_HISTORY): index order IS chronological
        // order, since entries were only ever appended, never overwritten.
        // Wrapped (total == MAX_HISTORY): the oldest surviving entry sits at
        // the position the *next* write would use — `channelSequence %
        // MAX_HISTORY` — since the ring buffer always overwrites the oldest
        // entry first.
        uint256 head = total < MAX_HISTORY ? 0 : (channelSequence[channelHash] % MAX_HISTORY);
        uint256 start = (head + (total - len)) % MAX_HISTORY;

        for (uint256 i = 0; i < len; i++) {
            messages[i] = history[(start + i) % MAX_HISTORY];
        }
    }

    /**
     * @notice Get the current sequence number for a channel.
     * @param channelHash keccak256 of the channel name
     * @return Current sequence number (0 if channel has never been used)
     */
    function getSequence(bytes32 channelHash) external view returns (uint256) {
        return channelSequence[channelHash];
    }

    /**
     * @notice Get the number of messages stored in history for a channel.
     * @param channelHash keccak256 of the channel name
     * @return Number of messages in history buffer
     */
    function getHistoryLength(bytes32 channelHash) external view returns (uint256) {
        return channelHistory[channelHash].length;
    }

    // ---- Subscriber Count (informational, updated by PlugPort server) ----

    /**
     * @notice Update subscriber count for a channel (informational only).
     *         Called by the PlugPort server to track active subscriptions.
     * @param channelHash keccak256 of the channel name
     * @param count Current number of active subscribers
     */
    function updateSubscriberCount(
        bytes32 channelHash,
        uint256 count
    ) external onlyGasStation {
        channelSubscriberCount[channelHash] = count;
    }

    // ---- Gas Station Management ----

    /**
     * @notice Transfer gas station rights to a new address.
     *         Only the current gas station can call this.
     * @param newGasStation The new address to authorize for publishing.
     */
    function transferGasStation(address newGasStation) external onlyGasStation {
        require(newGasStation != address(0), "MessageBroker: zero address");
        emit GasStationTransferred(gasStation, newGasStation);
        gasStation = newGasStation;
    }
}
