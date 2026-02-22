// PlugPort Chat Demo - Real-time chat backend with WebSocket support
// Messages stored in PlugPort, delivered in real-time via WebSocket

import express from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { PlugPortClient } from '@plugport/sdk';

const app = express();
app.use(cors());
app.use(express.json());

const server = createServer(app);
const wss = new WebSocketServer({ server });

const PLUGPORT_URL = process.env.PLUGPORT_URL || 'http://localhost:8080';

interface ChatRoom {
    clients: Map<string, WebSocket>;
}

const rooms = new Map<string, ChatRoom>();

function broadcast(roomId: string, data: unknown, excludeUser?: string) {
    const room = rooms.get(roomId);
    if (!room) return;
    const msg = JSON.stringify(data);
    for (const [userId, ws] of room.clients) {
        if (userId !== excludeUser && ws.readyState === WebSocket.OPEN) {
            ws.send(msg);
        }
    }
}

async function init() {
    const client = await PlugPortClient.connect(PLUGPORT_URL);
    const db = client.db('chat');
    const messages = db.collection('messages');
    const roomsMeta = db.collection('rooms');
    const users = db.collection('users');

    // Create indexes
    await messages.createIndex('roomId');
    await messages.createIndex('timestamp');
    await users.createIndex('username', { unique: true });

    // WebSocket handling
    wss.on('connection', (ws, req) => {
        let currentUser: string | null = null;
        let currentRoom: string | null = null;

        ws.on('message', async (raw) => {
            try {
                const data = JSON.parse(raw.toString());

                switch (data.type) {
                    case 'join': {
                        currentUser = data.userId;
                        currentRoom = data.roomId;

                        if (!rooms.has(currentRoom!)) {
                            rooms.set(currentRoom!, { clients: new Map() });
                            // Create room metadata
                            await roomsMeta.insertOne({
                                roomId: currentRoom,
                                name: data.roomName || currentRoom,
                                createdAt: new Date().toISOString(),
                            }).catch(() => { }); // Ignore if exists
                        }

                        rooms.get(currentRoom!)!.clients.set(currentUser!, ws);

                        // Send recent messages
                        const recent = await messages.find(
                            { roomId: currentRoom },
                            { sort: { timestamp: -1 }, limit: 50 },
                        );
                        ws.send(JSON.stringify({ type: 'history', messages: recent.reverse() }));

                        // Notify room
                        broadcast(currentRoom!, {
                            type: 'system',
                            message: `${currentUser} joined the room`,
                            timestamp: Date.now(),
                        }, currentUser!);
                        break;
                    }

                    case 'message': {
                        if (!currentUser || !currentRoom) break;

                        const msg = {
                            roomId: currentRoom,
                            userId: currentUser,
                            text: data.text,
                            timestamp: Date.now(),
                        };

                        // Store in PlugPort
                        await messages.insertOne(msg);

                        // Broadcast to room
                        broadcast(currentRoom, { type: 'message', ...msg });
                        // Also send to sender
                        ws.send(JSON.stringify({ type: 'message', ...msg }));
                        break;
                    }

                    case 'typing': {
                        if (!currentUser || !currentRoom) break;
                        broadcast(currentRoom, {
                            type: 'typing',
                            userId: currentUser,
                        }, currentUser);
                        break;
                    }
                }
            } catch (err) {
                ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
            }
        });

        ws.on('close', () => {
            if (currentUser && currentRoom) {
                const room = rooms.get(currentRoom);
                if (room) {
                    room.clients.delete(currentUser);
                    broadcast(currentRoom, {
                        type: 'system',
                        message: `${currentUser} left the room`,
                        timestamp: Date.now(),
                    });
                    if (room.clients.size === 0) rooms.delete(currentRoom);
                }
            }
        });
    });

    // REST API for room management
    app.get('/api/rooms', async (_req, res) => {
        const allRooms = await roomsMeta.find({});
        res.json(allRooms.map(r => ({
            ...r,
            activeUsers: rooms.get(r.roomId as string)?.clients.size || 0,
        })));
    });

    app.get('/api/rooms/:roomId/messages', async (req, res) => {
        const limit = parseInt(req.query.limit as string) || 100;
        const msgs = await messages.find(
            { roomId: req.params.roomId },
            { sort: { timestamp: -1 }, limit },
        );
        res.json(msgs.reverse());
    });

    app.post('/api/users/register', async (req, res) => {
        const { username, displayName } = req.body;
        try {
            const result = await users.insertOne({
                username,
                displayName: displayName || username,
                createdAt: new Date().toISOString(),
                status: 'online',
            });
            res.json({ userId: result.insertedId, username });
        } catch (err) {
            res.status(400).json({ error: 'Username already taken' });
        }
    });

    app.get('/health', async (_req, res) => {
        const health = await client.health();
        res.json({
            demo: 'chat',
            plugport: health.status,
            activeRooms: rooms.size,
            connectedUsers: Array.from(rooms.values()).reduce((s, r) => s + r.clients.size, 0),
        });
    });

    const PORT = parseInt(process.env.PORT || '3002');
    server.listen(PORT, () => {
        console.log(`Chat Demo running on http://localhost:${PORT}`);
        console.log(`WebSocket on ws://localhost:${PORT}`);
        console.log(`Using PlugPort at ${PLUGPORT_URL}`);
    });
}

init().catch(console.error);
