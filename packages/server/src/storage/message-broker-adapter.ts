// PlugPort Message Broker Adapter
// Server-side adapter connecting Redis SUBSCRIBE/PUBLISH commands to
// the on-chain PlugPortMessageBroker.sol smart contract.
//
// Architecture:
//   PUBLISH  → On-chain transaction via gas station wallet (costs MON gas)
//   SUBSCRIBE → WebSocket event listener on MessagePublished events
//   Messages are immutable, on-chain, and verifiable
//
// Requires:
//   - MESSAGEBROKER_CONTRACT_ADDRESS in env
//   - MONAD_WS_URL (WebSocket-capable RPC endpoint: wss://...)
//   - MONAD_PRIVATE_KEY (gas station wallet for the message broker)

import { ethers } from 'ethers';

// ---- ABI (PlugPortMessageBroker.sol) ----

const MESSAGE_BROKER_ABI = [
    // Write functions
    'function publish(bytes32 channelHash, bytes calldata message) external',
    'function publishWithName(bytes32 channelHash, string calldata channelName, bytes calldata message) external',
    'function updateSubscriberCount(bytes32 channelHash, uint256 count) external',
    'function transferGasStation(address newGasStation) external',

    // View functions
    'function getHistory(bytes32 channelHash, uint256 count) external view returns (bytes[] memory)',
    'function getSequence(bytes32 channelHash) external view returns (uint256)',
    'function getHistoryLength(bytes32 channelHash) external view returns (uint256)',
    'function channelSubscriberCount(bytes32) external view returns (uint256)',
    'function channelSequence(bytes32) external view returns (uint256)',
    'function totalMessages() external view returns (uint256)',
    'function gasStation() external view returns (address)',
    'function MAX_HISTORY() external view returns (uint256)',

    // Events
    'event MessagePublished(bytes32 indexed channel, uint256 indexed sequence, address indexed publisher, bytes message, uint256 timestamp)',
    'event ChannelCreated(bytes32 indexed channel, string name)',
] as const;

// ---- Types ----

export interface MessageBrokerConfig {
    contractAddress: string;
    wsUrl: string;        // WebSocket RPC URL (wss://...)
    rpcUrl: string;       // HTTP RPC URL for write transactions
    privateKey: string;   // Gas station private key (hex, no 0x prefix)
    chainId: number;
}

export interface ChannelSubscription {
    channel: string;
    channelHash: string;
    callbacks: Set<(message: string) => void>;
    listener: any; // ethers event listener handle
}

// ---- Message Broker Adapter ----

/**
 * Connects Redis Pub/Sub commands to the on-chain PlugPortMessageBroker contract.
 *
 * PUBLISH → sends on-chain transaction (gas station pays)
 * SUBSCRIBE → listens for MessagePublished events via WebSocket
 */
export class MessageBrokerAdapter {
    private wsProvider: ethers.WebSocketProvider | null = null;
    private httpProvider: ethers.JsonRpcProvider;
    private wallet: ethers.Wallet;
    private readContract: ethers.Contract | null = null;  // WebSocket provider (for events)
    private writeContract: ethers.Contract;                // HTTP provider (for transactions)
    private subscriptions: Map<string, ChannelSubscription> = new Map();
    private config: MessageBrokerConfig;
    private connected: boolean = false;
    private destroyed: boolean = false;

    // ---- Reconnect state ----
    //
    // ethers v6's WebSocketProvider ships with its own close/reconnect
    // handling entirely commented out (see provider-websocket.js —
    // `const reconnect = false;` inside dead code), so a dropped
    // connection would otherwise leave every subscription silently and
    // permanently dead until the process restarts, with nothing logged.
    // This adapter hooks the raw underlying socket directly instead.
    private reconnectAttempt = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private static readonly BASE_RECONNECT_DELAY_MS = 1_000;
    private static readonly MAX_RECONNECT_DELAY_MS = 30_000;

    constructor(config: MessageBrokerConfig) {
        this.config = config;

        // HTTP provider for write transactions
        this.httpProvider = new ethers.JsonRpcProvider(config.rpcUrl, config.chainId);
        this.wallet = new ethers.Wallet(config.privateKey, this.httpProvider);
        this.writeContract = new ethers.Contract(
            config.contractAddress,
            MESSAGE_BROKER_ABI,
            this.wallet,
        );
    }

    /**
     * Initialize WebSocket connection for event subscriptions.
     * Must be called before subscribe() works.
     */
    async connect(): Promise<void> {
        if (this.connected) return;
        await this.establishWebSocket();
    }

    /**
     * Attempts a WebSocket connection and, on success, wires up a
     * socket-level watchdog so a later drop triggers automatic
     * reconnect-with-backoff instead of going silently dead. Falls back to
     * slower HTTP polling only if a WebSocket connection can't be
     * established at all, while continuing to retry the WebSocket in the
     * background.
     */
    private async establishWebSocket(): Promise<void> {
        try {
            const wsProvider = new ethers.WebSocketProvider(this.config.wsUrl);
            // The constructor itself can't surface a network-level failure
            // (the handshake happens asynchronously) — force a real
            // round-trip so a bad URL or unreachable endpoint fails here,
            // not as a mysterious silent hang later.
            await wsProvider.getBlockNumber();

            this.wsProvider = wsProvider;
            this.readContract = new ethers.Contract(
                this.config.contractAddress,
                MESSAGE_BROKER_ABI,
                this.wsProvider,
            );
            this.connected = true;
            this.reconnectAttempt = 0;
            this.watchSocketHealth(wsProvider);
            console.log('[PlugPort] MessageBroker WebSocket connected');

            // Re-attach any subscriptions that existed before a drop —
            // a no-op on the very first connect (subscriptions is empty).
            for (const subscription of this.subscriptions.values()) {
                this.attachListener(subscription);
            }
        } catch (err) {
            console.error('[PlugPort] MessageBroker WebSocket connection failed:', err);
            if (!this.connected) {
                // No prior working connection yet — fall back to HTTP
                // polling so the adapter is at least functional while the
                // WebSocket keeps retrying in the background.
                this.readContract = new ethers.Contract(
                    this.config.contractAddress,
                    MESSAGE_BROKER_ABI,
                    this.httpProvider,
                );
                this.connected = true;
            }
            this.scheduleReconnect();
        }
    }

    /**
     * Hooks the raw underlying WebSocket's close/error events — bypassing
     * ethers' own disabled reconnect handling — to detect a dropped
     * connection and trigger scheduleReconnect().
     */
    private watchSocketHealth(wsProvider: ethers.WebSocketProvider): void {
        const raw: any = (wsProvider as any).websocket;
        if (!raw?.on) return;

        const onDrop = (reason: string) => {
            // Ignore events from a socket we've already replaced/torn down.
            if (this.destroyed || this.wsProvider !== wsProvider) return;
            console.warn(`[PlugPort] MessageBroker WebSocket dropped (${reason}) — scheduling reconnect`);
            this.connected = false;
            this.wsProvider = null;
            this.scheduleReconnect();
        };
        raw.on('close', (code: number) => onDrop(`close code=${code}`));
        raw.on('error', (err: Error) => onDrop(`error: ${err.message}`));
    }

    /**
     * Schedules a reconnect attempt with exponential backoff (capped at
     * MAX_RECONNECT_DELAY_MS). A no-op if one is already pending or the
     * adapter has been intentionally disconnected.
     */
    private scheduleReconnect(): void {
        if (this.destroyed || this.reconnectTimer) return;
        const delay = Math.min(
            MessageBrokerAdapter.BASE_RECONNECT_DELAY_MS * 2 ** this.reconnectAttempt,
            MessageBrokerAdapter.MAX_RECONNECT_DELAY_MS,
        );
        this.reconnectAttempt++;
        console.log(`[PlugPort] MessageBroker: reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.establishWebSocket().catch((err) => {
                console.error('[PlugPort] MessageBroker reconnect attempt failed:', err);
            });
        }, delay);
    }

    /**
     * Publish a message to a channel.
     * Sends an on-chain transaction (gas paid by the dedicated Pub/Sub gas station).
     *
     * @param channel The channel name (e.g., "news", "chat:general")
     * @param message The message string to publish
     * @returns Number of known subscribers
     */
    async publish(channel: string, message: string): Promise<number> {
        const channelHash = ethers.keccak256(ethers.toUtf8Bytes(channel));
        const msgBytes = ethers.toUtf8Bytes(message);

        try {
            const tx = await this.writeContract.publishWithName(
                channelHash,
                channel,
                msgBytes,
            );
            await tx.wait();
        } catch (err: any) {
            // Fallback to publish without name if publishWithName fails
            try {
                const tx = await this.writeContract.publish(channelHash, msgBytes);
                await tx.wait();
            } catch (innerErr: any) {
                throw new Error(`MessageBroker publish failed: ${innerErr.message}`);
            }
        }

        // Return local subscriber count
        return this.subscriptions.get(channel)?.callbacks.size || 0;
    }

    /**
     * Subscribe to messages on a channel.
     * Listens for MessagePublished events via WebSocket.
     *
     * @param channel The channel name
     * @param callback Called when a message is received on this channel
     */
    async subscribe(channel: string, callback: (message: string) => void): Promise<void> {
        await this.connect();

        const channelHash = ethers.keccak256(ethers.toUtf8Bytes(channel));

        let subscription = this.subscriptions.get(channel);
        if (subscription) {
            subscription.callbacks.add(callback);
            return;
        }

        // Create new subscription
        subscription = {
            channel,
            channelHash,
            callbacks: new Set([callback]),
            listener: null,
        };
        this.subscriptions.set(channel, subscription);
        this.attachListener(subscription);
    }

    /**
     * Builds the event-listener callback for a subscription. Extracted so
     * the exact same listener closure (bound to the subscription's live
     * `callbacks` set) can be reused across a reconnect, rather than
     * re-created and losing track of previously-registered callbacks.
     */
    private createListener(subscription: ChannelSubscription): (...args: any[]) => void {
        return (...args: any[]) => {
            // ethers v6 event format: args are individual values, last arg is the event object
            const event = args[args.length - 1];
            try {
                const messageBytes = event.args?.message || args[3];
                const messageStr = ethers.toUtf8String(messageBytes);
                for (const cb of subscription.callbacks) {
                    try { cb(messageStr); } catch { /* ignore callback errors */ }
                }
            } catch {
                // Ignore decode errors
            }
        };
    }

    /**
     * Registers a subscription's listener against the current
     * readContract. Used both for a brand-new subscribe() and to
     * re-attach existing subscriptions after a reconnect.
     */
    private attachListener(subscription: ChannelSubscription): void {
        if (!this.readContract) return;
        const filter = this.readContract.filters.MessagePublished(subscription.channelHash);
        const listener = subscription.listener ?? this.createListener(subscription);
        this.readContract.on(filter, listener);
        subscription.listener = listener;
    }

    /**
     * Unsubscribe from a channel.
     * Removes the event listener.
     *
     * @param channel The channel name
     */
    async unsubscribe(channel: string): Promise<void> {
        const subscription = this.subscriptions.get(channel);
        if (!subscription) return;

        const channelHash = ethers.keccak256(ethers.toUtf8Bytes(channel));
        const filter = this.readContract?.filters.MessagePublished(channelHash);
        if (filter && subscription.listener) {
            this.readContract?.removeListener(filter, subscription.listener);
        }

        this.subscriptions.delete(channel);
    }

    /**
     * Get recent message history for a channel (for late-joining subscribers).
     *
     * @param channel The channel name
     * @param count Maximum number of messages to retrieve
     * @returns Array of message strings
     */
    async getHistory(channel: string, count: number = 10): Promise<string[]> {
        const channelHash = ethers.keccak256(ethers.toUtf8Bytes(channel));
        const contract = this.readContract || this.writeContract;

        const historyBytes: string[] = await contract.getHistory(channelHash, count);
        return historyBytes.map((bytes: string) => {
            try {
                return ethers.toUtf8String(bytes);
            } catch {
                return bytes;
            }
        });
    }

    /**
     * Get the current sequence number for a channel.
     */
    async getSequence(channel: string): Promise<number> {
        const channelHash = ethers.keccak256(ethers.toUtf8Bytes(channel));
        const contract = this.readContract || this.writeContract;
        const seq = await contract.getSequence(channelHash);
        return Number(seq);
    }

    /**
     * Get total messages published across all channels.
     */
    async getTotalMessages(): Promise<number> {
        const contract = this.readContract || this.writeContract;
        return Number(await contract.totalMessages());
    }

    /**
     * Get the number of active subscriptions.
     */
    getActiveSubscriptionCount(): number {
        return this.subscriptions.size;
    }

    /**
     * Disconnect WebSocket and clean up all subscriptions.
     * Also cancels any pending reconnect attempt — after an intentional
     * disconnect(), a dropped/never-connected socket should stay down.
     */
    async disconnect(): Promise<void> {
        this.destroyed = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        // Remove all event listeners
        for (const [channel] of this.subscriptions) {
            await this.unsubscribe(channel);
        }

        // Close WebSocket
        if (this.wsProvider) {
            await this.wsProvider.destroy();
            this.wsProvider = null;
        }

        this.readContract = null;
        this.connected = false;
    }
}

/**
 * Factory: create a MessageBrokerAdapter from environment config.
 */
export function createMessageBrokerAdapter(config: {
    contractAddress: string;
    wsUrl: string;
    rpcUrl: string;
    privateKey: string;
    chainId: number;
}): MessageBrokerAdapter {
    return new MessageBrokerAdapter(config);
}
