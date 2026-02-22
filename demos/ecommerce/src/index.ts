// PlugPort E-Commerce Demo - Cart and product management using PlugPort SDK

import express from 'express';
import cors from 'cors';
import { PlugPortClient } from '@plugport/sdk';

const app = express();
app.use(cors());
app.use(express.json());

const PLUGPORT_URL = process.env.PLUGPORT_URL || 'http://localhost:8080';
let client: PlugPortClient;

async function init() {
    client = await PlugPortClient.connect(PLUGPORT_URL);
    const db = client.db('ecommerce');

    const products = db.collection('products');
    const carts = db.collection('carts');
    const orders = db.collection('orders');

    // Seed sample products
    const existingProducts = await products.find({});
    if (existingProducts.length === 0) {
        await products.insertMany([
            { name: 'Monad Dev Kit', price: 49.99, category: 'hardware', stock: 100, image: '/images/devkit.png', description: 'Essential toolkit for Monad developers' },
            { name: 'PlugPort Cloud License', price: 29.99, category: 'software', stock: 999, description: 'Annual cloud license for PlugPort managed service' },
            { name: 'Blockchain Storage SSD', price: 199.99, category: 'hardware', stock: 50, description: '2TB NVMe optimized for blockchain node storage' },
            { name: 'MPT Visualizer Pro', price: 14.99, category: 'software', stock: 999, description: 'Merkle Patricia Trie visualization and debugging tool' },
            { name: 'Monad Validator Node', price: 599.99, category: 'hardware', stock: 25, description: 'Pre-configured validator node hardware' },
            { name: 'PlugPort T-Shirt', price: 24.99, category: 'merch', stock: 200, description: 'Premium cotton tee with PlugPort branding' },
        ]);
        await products.createIndex('category');
        await products.createIndex('name', { unique: true });
        console.log('Seeded sample products');
    }

    // ---- Product Routes ----
    app.get('/api/products', async (_req, res) => {
        const docs = await products.find({});
        res.json(docs);
    });

    app.get('/api/products/:category', async (req, res) => {
        const docs = await products.find({ category: req.params.category });
        res.json(docs);
    });

    // ---- Cart Routes ----
    app.get('/api/cart/:userId', async (req, res) => {
        const cart = await carts.findOne({ userId: req.params.userId });
        res.json(cart || { userId: req.params.userId, items: [], total: 0 });
    });

    app.post('/api/cart/:userId/add', async (req, res) => {
        const { productId, quantity = 1 } = req.body;
        const product = await products.findOne({ _id: productId });
        if (!product) return res.status(404).json({ error: 'Product not found' });

        const existing = await carts.findOne({ userId: req.params.userId });
        if (existing) {
            const items = (existing.items as Array<Record<string, unknown>>) || [];
            const existingItem = items.find((i) => i.productId === productId);
            if (existingItem) {
                existingItem.quantity = (existingItem.quantity as number) + quantity;
            } else {
                items.push({ productId, name: product.name, price: product.price, quantity });
            }
            const total = items.reduce((s: number, i) => s + (i.price as number) * (i.quantity as number), 0);
            await carts.updateOne({ userId: req.params.userId }, { $set: { items, total } });
        } else {
            const items = [{ productId, name: product.name, price: product.price, quantity }];
            await carts.insertOne({ userId: req.params.userId, items, total: (product.price as number) * quantity });
        }

        const cart = await carts.findOne({ userId: req.params.userId });
        res.json(cart);
    });

    app.post('/api/cart/:userId/checkout', async (req, res) => {
        const cart = await carts.findOne({ userId: req.params.userId });
        if (!cart || !(cart.items as unknown[])?.length) {
            return res.status(400).json({ error: 'Cart is empty' });
        }

        // Create order
        const order = await orders.insertOne({
            userId: req.params.userId,
            items: cart.items,
            total: cart.total,
            status: 'confirmed',
            createdAt: new Date().toISOString(),
        });

        // Clear cart
        await carts.deleteOne({ userId: req.params.userId });

        res.json({ orderId: order.insertedId, status: 'confirmed', total: cart.total });
    });

    // ---- Order Routes ----
    app.get('/api/orders/:userId', async (req, res) => {
        const userOrders = await orders.find({ userId: req.params.userId });
        res.json(userOrders);
    });

    // Health
    app.get('/health', async (_req, res) => {
        const health = await client.health();
        res.json({ demo: 'ecommerce', plugport: health.status });
    });

    const PORT = parseInt(process.env.PORT || '3001');
    app.listen(PORT, () => {
        console.log(`E-Commerce Demo API running on http://localhost:${PORT}`);
        console.log(`Using PlugPort at ${PLUGPORT_URL}`);
    });
}

init().catch(console.error);
