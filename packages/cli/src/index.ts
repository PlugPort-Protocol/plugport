#!/usr/bin/env node
// PlugPort CLI Tool
// Developer toolkit: init, dev, playground, migrate, query, status, and protocol management

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { VERSION } from '@plugport/shared';

const program = new Command();

program
    .name('plugport')
    .description('PlugPort CLI - Multi-Protocol Database Middleware on Monad')
    .version(VERSION);

// ---- Init Command ----
program
    .command('init')
    .description('Initialize a new PlugPort project with SDK setup')
    .option('-t, --template <template>', 'Project template (node, python, go)', 'node')
    .option('-d, --db <protocols>', 'Database protocols (comma-separated: mongodb,postgresql,mysql,redis)')

    .action(async (options) => {
        const fs = await import('fs');
        const path = await import('path');
        const cwd = process.cwd();

        let selectedProtocols: string[];


        // Interactive mode if --db flag is not provided
        if (!options.db) {
            const inquirer = await import('inquirer');

            console.log(chalk.cyan.bold('\n  PlugPort Project Setup\n'));

            const answers = await inquirer.default.prompt([
                {
                    type: 'checkbox',
                    name: 'protocols',
                    message: 'Select database protocols to enable:',
                    choices: [
                        { name: `${chalk.green('MongoDB')}    — mongosh / mongoose / native drivers (port 27017)`, value: 'mongodb', checked: true },
                        { name: `${chalk.blue('PostgreSQL')} — psql / Prisma / Sequelize / Knex (port 5432)`, value: 'postgresql' },
                        { name: `${chalk.yellow('MySQL')}      — mysql-cli / mysql2 / TypeORM (port 3306)`, value: 'mysql' },
                        { name: `${chalk.red('Redis')}      — redis-cli / ioredis / Pub/Sub (port 6379)`, value: 'redis' },
                    ],
                    validate: (input: string[]) => input.length > 0 ? true : 'Select at least one protocol',
                },

                {
                    type: 'input',
                    name: 'rpcUrl',
                    message: 'Monad RPC URL:',
                    default: 'https://monad-testnet.drpc.org',
                },
            ]);

            selectedProtocols = answers.protocols;

        } else {
            selectedProtocols = options.db.split(',').map((p: string) => p.trim().toLowerCase());
        }

        const spinner = ora('Scaffolding PlugPort project...').start();

        try {
            // Create project structure
            const dirs = ['src', 'test'];
            for (const dir of dirs) {
                fs.mkdirSync(path.join(cwd, dir), { recursive: true });
            }

            // Determine primary connection based on selected protocols
            const primaryProtocol = selectedProtocols[0] || 'mongodb';
            const sampleConnections: Record<string, { driver: string; dep: string; code: string }> = {
                mongodb: {
                    driver: 'mongodb',
                    dep: '"mongodb": "^6.0.0"',
                    code: `import { MongoClient } from 'mongodb';

async function main() {
  const client = new MongoClient('mongodb://localhost:27017');
  await client.connect();
  const db = client.db('myapp');
  const users = db.collection('users');

  // Insert — stored on Monad blockchain via PlugPort
  await users.insertOne({ name: 'Alice', email: 'alice@example.com', age: 30 });

  // Find
  const docs = await users.find({ name: 'Alice' }).toArray();
  console.log('Found:', docs);

  await client.close();
}

main().catch(console.error);`,
                },
                postgresql: {
                    driver: 'pg',
                    dep: '"pg": "^8.0.0"',
                    code: `import pg from 'pg';

async function main() {
  const client = new pg.Client({ connectionString: 'postgresql://localhost:5432/plugport' });
  await client.connect();

  await client.query('CREATE TABLE IF NOT EXISTS users (id INTEGER, name TEXT, email TEXT)');
  await client.query("INSERT INTO users (id, name, email) VALUES (1, 'Alice', 'alice@example.com')");

  const { rows } = await client.query('SELECT * FROM users WHERE name = $1', ['Alice']);
  console.log('Found:', rows);

  await client.end();
}

main().catch(console.error);`,
                },
                mysql: {
                    driver: 'mysql2',
                    dep: '"mysql2": "^3.0.0"',
                    code: `import mysql from 'mysql2/promise';

async function main() {
  const conn = await mysql.createConnection({ host: 'localhost', port: 3306, user: 'root' });

  await conn.execute('CREATE TABLE IF NOT EXISTS users (id INT, name VARCHAR(255), email VARCHAR(255))');
  await conn.execute("INSERT INTO users (id, name, email) VALUES (1, 'Alice', 'alice@example.com')");

  const [rows] = await conn.execute('SELECT * FROM users WHERE name = ?', ['Alice']);
  console.log('Found:', rows);

  await conn.end();
}

main().catch(console.error);`,
                },
                redis: {
                    driver: 'ioredis',
                    dep: '"ioredis": "^5.0.0"',
                    code: `import Redis from 'ioredis';

async function main() {
  const redis = new Redis(6379);

  await redis.set('greeting', 'Hello from Monad!');
  const val = await redis.get('greeting');
  console.log('Value:', val);

  await redis.hset('user:1', { name: 'Alice', email: 'alice@example.com', age: '30' });
  const user = await redis.hgetall('user:1');
  console.log('User:', user);

  await redis.quit();
}

main().catch(console.error);`,
                },
            };

            const sample = sampleConnections[primaryProtocol] || sampleConnections.mongodb;

            // Create package.json
            const pkg = {
                name: 'my-plugport-app',
                version: '1.0.0',
                type: 'module',
                scripts: {
                    dev: 'tsx src/index.ts',
                    build: 'tsc',
                    test: 'vitest run',
                },
                dependencies: {
                    [sample.driver]: JSON.parse(`{${sample.dep}}`)[sample.driver],
                },
                devDependencies: {
                    typescript: '^5.7.0',
                    tsx: '^4.19.0',
                    vitest: '^3.0.0',
                },
            };
            fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify(pkg, null, 2));

            // Create tsconfig.json
            const tsconfig = {
                compilerOptions: {
                    target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler',
                    strict: true, esModuleInterop: true, outDir: './dist', rootDir: './src',
                },
                include: ['src/**/*'],
            };
            fs.writeFileSync(path.join(cwd, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2));

            // Create sample app
            fs.writeFileSync(path.join(cwd, 'src', 'index.ts'), sample.code);

            // Create .env with protocol configuration
            const envLines = [
                '# PlugPort Server Configuration', '',
                '# Monad Testnet',
                'MONAD_RPC_URL=https://monad-testnet.drpc.org',
                'MONAD_CHAIN_ID=10143',
                'MONAD_PRIVATE_KEY=',
                'MONAD_CONTRACT_ADDRESS=', '',
                '# Protocol Frontends',
                `MONGODB_ENABLED=${selectedProtocols.includes('mongodb')}`,
                `PG_ENABLED=${selectedProtocols.includes('postgresql')}`,
                `MYSQL_ENABLED=${selectedProtocols.includes('mysql')}`,
                `REDIS_ENABLED=${selectedProtocols.includes('redis')}`, '',
                '',
                '# Private Store (Required for private collections)',
                'PRIVATE_STORE_CONTRACT=',
                'WHITELIST_ADDRESSES=',
            ];
            fs.writeFileSync(path.join(cwd, '.env'), envLines.join('\n') + '\n');

            spinner.succeed(chalk.green('Project initialized successfully!'));
            console.log('');
            console.log(chalk.cyan('  Protocols enabled:'));
            for (const p of selectedProtocols) {
                const ports: Record<string, number> = { mongodb: 27017, postgresql: 5432, mysql: 3306, redis: 6379 };
                console.log(chalk.gray(`    ✓ ${p.padEnd(12)} → port ${ports[p] || '?'}`));
            }
            console.log('');

            console.log('');
            console.log(chalk.cyan('  Next steps:'));
            console.log(chalk.gray('  1.'), 'npm install');
            console.log(chalk.gray('  2.'), 'plugport dev    # Start local PlugPort server');
            console.log(chalk.gray('  3.'), 'npm run dev     # Run your app');
            console.log('');
        } catch (err) {
            spinner.fail(chalk.red('Failed to initialize project'));
            console.error(err);
        }
    });

// ---- Dev Command ----
program
    .command('dev')
    .description('Start local PlugPort server and dashboard for development')
    .option('-p, --port <port>', 'HTTP API port', '8080')
    .option('-w, --wire-port <port>', 'Wire protocol port', '27017')
    .option('--no-dashboard', 'Skip starting the dashboard')
    .action(async (options) => {
        console.log(chalk.cyan.bold('\n  PlugPort Development Server\n'));

        const { spawn } = await import('child_process');
        const path = await import('path');

        // Start server
        const serverSpinner = ora('Starting PlugPort server...').start();

        const env = {
            ...process.env,
            HTTP_PORT: options.port,
            WIRE_PORT: options.wirePort,
        };

        try {
            const serverProc = spawn('npx', ['tsx', path.resolve(import.meta.dirname || '.', '../../server/src/index.ts')], {
                env,
                stdio: 'pipe',
            });

            serverProc.stdout?.on('data', (data: Buffer) => {
                const msg = data.toString();
                if (msg.includes('Ready to accept connections')) {
                    serverSpinner.succeed(chalk.green(`PlugPort server running on port ${options.port}`));
                    console.log(chalk.gray(`  HTTP API:  http://localhost:${options.port}`));
                    console.log(chalk.gray(`  Wire:      mongodb://localhost:${options.wirePort}`));
                    console.log(chalk.gray(`  Health:    http://localhost:${options.port}/health`));
                    console.log('');
                }
            });

            serverProc.stderr?.on('data', (data: Buffer) => {
                const msg = data.toString().trim();
                if (msg && !msg.includes('ExperimentalWarning')) {
                    console.error(chalk.yellow(`  [server] ${msg}`));
                }
            });

            serverProc.on('error', () => {
                serverSpinner.fail(chalk.red('Failed to start server'));
            });

            if (options.dashboard !== false) {
                setTimeout(async () => {
                    try {
                        const open = (await import('open')).default;
                        await open(`http://localhost:${options.port}/health`);
                    } catch { /* ignore */ }
                }, 2000);
            }

            process.on('SIGINT', () => {
                serverProc.kill('SIGTERM');
                process.exit(0);
            });
        } catch (err) {
            serverSpinner.fail(chalk.red('Failed to start server'));
            console.error(err);
        }
    });

// ---- Playground Command ----
program
    .command('playground')
    .description('Launch interactive PlugPort playground with sample data')
    .action(async () => {
        console.log(chalk.cyan.bold('\n  PlugPort Playground\n'));

        const spinner = ora('Setting up playground environment...').start();

        try {
            const { spawn } = await import('child_process');
            const path = await import('path');

            const serverProc = spawn('npx', ['tsx', path.resolve(import.meta.dirname || '.', '../../server/src/index.ts')], {
                env: { ...process.env, HTTP_PORT: '8080', WIRE_PORT: '27017' },
                stdio: 'pipe',
            });

            await new Promise<void>((resolve) => {
                const timeout = setTimeout(resolve, 3000);
                serverProc.stdout?.on('data', (data: Buffer) => {
                    if (data.toString().includes('Ready')) { clearTimeout(timeout); resolve(); }
                });
            });

            spinner.text = 'Loading sample data...';

            const baseUrl = 'http://localhost:8080';
            const sampleCollections = [
                {
                    name: 'users',
                    documents: [
                        { name: 'Alice Johnson', email: 'alice@example.com', age: 28, role: 'admin' },
                        { name: 'Bob Smith', email: 'bob@example.com', age: 34, role: 'user' },
                        { name: 'Charlie Brown', email: 'charlie@example.com', age: 22, role: 'user' },
                        { name: 'Diana Prince', email: 'diana@example.com', age: 31, role: 'moderator' },
                        { name: 'Eve Wilson', email: 'eve@example.com', age: 45, role: 'admin' },
                    ],
                },
                {
                    name: 'products',
                    documents: [
                        { name: 'Widget Pro', price: 29.99, category: 'electronics', stock: 150 },
                        { name: 'Gadget X', price: 49.99, category: 'electronics', stock: 75 },
                        { name: 'Book: MongoDB Patterns', price: 39.99, category: 'books', stock: 200 },
                        { name: 'Coffee Mug', price: 12.99, category: 'kitchen', stock: 500 },
                    ],
                },
                {
                    name: 'orders',
                    documents: [
                        { userId: 'alice', product: 'Widget Pro', quantity: 2, total: 59.98, status: 'shipped' },
                        { userId: 'bob', product: 'Gadget X', quantity: 1, total: 49.99, status: 'pending' },
                        { userId: 'charlie', product: 'Coffee Mug', quantity: 3, total: 38.97, status: 'delivered' },
                    ],
                },
            ];

            for (const coll of sampleCollections) {
                await fetch(`${baseUrl}/api/v1/collections/${coll.name}/insertMany`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ documents: coll.documents }),
                });
            }

            await fetch(`${baseUrl}/api/v1/collections/users/createIndex`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ field: 'email', unique: true }),
            });

            await fetch(`${baseUrl}/api/v1/collections/products/createIndex`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ field: 'category', unique: false }),
            });

            spinner.succeed(chalk.green('Playground ready!'));
            console.log('');
            console.log(chalk.cyan('  Sample collections loaded:'));
            console.log(chalk.gray('    - users (5 docs, indexed on email)'));
            console.log(chalk.gray('    - products (4 docs, indexed on category)'));
            console.log(chalk.gray('    - orders (3 docs)'));
            console.log('');
            console.log(chalk.cyan('  Try these:'));
            console.log(chalk.gray('    curl http://localhost:8080/api/v1/collections'));
            console.log(chalk.gray('    mongosh mongodb://localhost:27017'));
            console.log(chalk.gray('    psql postgresql://localhost:5432/plugport'));
            console.log(chalk.gray('    redis-cli -p 6379'));
            console.log('');
            console.log(chalk.yellow('  Press Ctrl+C to stop'));

            process.on('SIGINT', () => {
                serverProc.kill('SIGTERM');
                console.log(chalk.gray('\n  Playground stopped.'));
                process.exit(0);
            });

            await new Promise(() => { });
        } catch (err) {
            spinner.fail(chalk.red('Failed to start playground'));
            console.error(err);
        }
    });

// ---- Migrate Command ----
program
    .command('migrate')
    .description('Import data from MongoDB dump into PlugPort')
    .option('-f, --file <file>', 'Path to MongoDB JSON dump file')
    .option('-c, --collection <collection>', 'Target collection name')
    .option('-u, --url <url>', 'PlugPort server URL', 'http://localhost:8080')
    .action(async (options) => {
        if (!options.file) {
            console.error(chalk.red('Error: --file is required'));
            process.exit(1);
        }

        const spinner = ora(`Importing from ${options.file}...`).start();

        try {
            const fs = await import('fs');
            const path = await import('path');
            const readline = await import('readline');

            const collectionName = options.collection || path.basename(options.file, path.extname(options.file));
            const fileStream = fs.createReadStream(path.resolve(options.file));
            const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

            const batchSize = 100;
            let imported = 0;
            let batch: unknown[] = [];

            for await (const line of rl) {
                if (!line.trim()) continue;
                batch.push(JSON.parse(line));

                if (batch.length >= batchSize) {
                    await fetch(`${options.url}/api/v1/collections/${collectionName}/insertMany`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ documents: batch }),
                    });
                    imported += batch.length;
                    spinner.text = `Importing... ${imported}`;
                    batch = [];
                }
            }

            if (batch.length > 0) {
                await fetch(`${options.url}/api/v1/collections/${collectionName}/insertMany`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ documents: batch }),
                });
                imported += batch.length;
            }

            spinner.succeed(chalk.green(`Imported ${imported} documents into "${collectionName}"`));
        } catch (err) {
            spinner.fail(chalk.red('Import failed'));
            console.error(err);
        }
    });

// ---- Query Command ----
program
    .command('query <collection>')
    .description('Run a query against a PlugPort collection')
    .option('-f, --filter <json>', 'Filter as JSON string', '{}')
    .option('-l, --limit <n>', 'Limit results', '10')
    .option('-u, --url <url>', 'PlugPort server URL', 'http://localhost:8080')
    .action(async (collection, options) => {
        try {
            const filter = JSON.parse(options.filter);
            const response = await fetch(`${options.url}/api/v1/collections/${collection}/find`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filter, limit: parseInt(options.limit) }),
            });

            const result = await response.json() as { cursor: { firstBatch: unknown[] } };
            console.log(JSON.stringify(result.cursor.firstBatch, null, 2));
        } catch (err) {
            console.error(chalk.red('Query failed:'), err instanceof Error ? err.message : err);
        }
    });

// ---- Status Command (enhanced) ----
program
    .command('status')
    .description('Show comprehensive PlugPort server status including all protocols')
    .option('-u, --url <url>', 'PlugPort server URL', 'http://localhost:8080')
    .action(async (options) => {
        try {
            const response = await fetch(`${options.url}/health`);
            const health = await response.json() as Record<string, unknown>;

            console.log(chalk.cyan.bold('\n  PlugPort Server Status\n'));
            console.log(chalk.gray('  Status:    '), chalk.green(String(health.status)));
            console.log(chalk.gray('  Version:   '), health.version);
            console.log(chalk.gray('  Uptime:    '), `${Math.floor(health.uptime as number)}s`);
            console.log(chalk.gray('  Keys:      '), (health.storage as Record<string, unknown>)?.keyCount ?? 'N/A');

            // Show protocol status
            const protocols = health.protocols as Array<Record<string, unknown>> | undefined;
            if (protocols && protocols.length > 0) {
                console.log('');
                console.log(chalk.cyan('  Protocol Frontends:'));
                console.log(chalk.gray('  ─────────────────────────────────────────────'));

                const colorMap: Record<string, (s: string) => string> = {
                    mongodb: chalk.green,
                    postgresql: chalk.blue,
                    mysql: chalk.yellow,
                    redis: chalk.red,
                    http: chalk.cyan,
                };

                for (const p of protocols) {
                    const colorFn = colorMap[p.name as string] || chalk.white;
                    const statusIcon = p.enabled ? chalk.green('●') : chalk.gray('○');
                    const connStr = p.enabled ? chalk.gray(` ${p.connectionString}`) : '';
                    const conns = p.enabled ? chalk.gray(` (${p.connections} conn)`) : '';
                    console.log(`  ${statusIcon} ${colorFn(String(p.name).padEnd(12))} :${String(p.port).padEnd(6)}${conns}${connStr}`);
                }
            }

            // Check if crypto is enabled
            const cryptoEnabled = health.cryptoEnabled as boolean | undefined;
            if (cryptoEnabled) {
                console.log('');
                console.log(chalk.gray('  Cryptography:'), chalk.yellow('ENABLED (AES-256-GCM ready)'));
            }

            console.log('');
        } catch {
            console.log(chalk.red('\n  Server is not running or not reachable'));
            console.log(chalk.gray('  Start with: plugport dev\n'));
        }
    });

// ---- Protocol Management Commands ----
const protocolCmd = program
    .command('protocol')
    .description('Manage database protocol frontends');

protocolCmd
    .command('list')
    .description('List all available protocols and their status')
    .option('-u, --url <url>', 'PlugPort server URL', 'http://localhost:8080')
    .action(async (options) => {
        try {
            const response = await fetch(`${options.url}/health`);
            const health = await response.json() as Record<string, unknown>;
            const protocols = health.protocols as Array<Record<string, unknown>> | undefined;

            console.log(chalk.cyan.bold('\n  Protocol Frontends\n'));

            const allProtocols = [
                { name: 'mongodb', port: 27017, desc: 'MongoDB Wire Protocol' },
                { name: 'postgresql', port: 5432, desc: 'PostgreSQL v3 Wire Protocol' },
                { name: 'mysql', port: 3306, desc: 'MySQL Text Protocol' },
                { name: 'redis', port: 6379, desc: 'Redis RESP Protocol' },
                { name: 'http', port: 8080, desc: 'HTTP REST API' },
            ];

            for (const proto of allProtocols) {
                const live = protocols?.find(p => p.name === proto.name);
                const enabled = live?.enabled ?? false;
                const icon = enabled ? chalk.green('✓ ENABLED ') : chalk.gray('✗ DISABLED');
                const conns = enabled ? chalk.gray(` ${live?.connections || 0} connections`) : '';
                console.log(`  ${icon}  ${chalk.white(proto.name.padEnd(12))} :${String(proto.port).padEnd(6)} ${chalk.gray(proto.desc)}${conns}`);
            }
            console.log('');
        } catch {
            console.log(chalk.red('\n  Server is not running'));
            console.log(chalk.gray('  Start with: plugport dev\n'));
        }
    });

protocolCmd
    .command('enable <protocol>')
    .description('Enable a protocol frontend (mongodb, postgresql, mysql, redis)')
    .option('-u, --url <url>', 'PlugPort server URL', 'http://localhost:8080')
    .action(async (protocol, options) => {
        const validProtocols = ['mongodb', 'postgresql', 'mysql', 'redis'];
        if (!validProtocols.includes(protocol)) {
            console.error(chalk.red(`Invalid protocol "${protocol}". Valid: ${validProtocols.join(', ')}`));
            process.exit(1);
        }

        const spinner = ora(`Enabling ${protocol}...`).start();
        try {
            const response = await fetch(`${options.url}/api/v1/protocols/${protocol}/enable`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            });

            if (response.ok) {
                const ports: Record<string, number> = { mongodb: 27017, postgresql: 5432, mysql: 3306, redis: 6379 };
                spinner.succeed(chalk.green(`${protocol} enabled on port ${ports[protocol]}`));
            } else {
                const err = await response.json() as Record<string, string>;
                spinner.fail(chalk.red(`Failed: ${err.errmsg || response.statusText}`));
            }
        } catch {
            spinner.fail(chalk.red('Server not reachable'));
        }
    });

protocolCmd
    .command('disable <protocol>')
    .description('Disable a protocol frontend')
    .option('-u, --url <url>', 'PlugPort server URL', 'http://localhost:8080')
    .action(async (protocol, options) => {
        const spinner = ora(`Disabling ${protocol}...`).start();
        try {
            const response = await fetch(`${options.url}/api/v1/protocols/${protocol}/disable`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            });

            if (response.ok) {
                spinner.succeed(chalk.green(`${protocol} disabled`));
            } else {
                const err = await response.json() as Record<string, string>;
                spinner.fail(chalk.red(`Failed: ${err.errmsg || response.statusText}`));
            }
        } catch {
            spinner.fail(chalk.red('Server not reachable'));
        }
    });

// ---- Whitelist Management ----
const whitelistCmd = program
    .command('whitelist')
    .description('Manage private store address whitelist');

whitelistCmd
    .command('add <address>')
    .description('Add an Ethereum address to the whitelist')
    .option('-u, --url <url>', 'PlugPort server URL', 'http://localhost:8080')
    .action(async (address, options) => {
        const spinner = ora(`Adding ${address.substring(0, 10)}... to whitelist`).start();
        try {
            const response = await fetch(`${options.url}/api/v1/whitelist`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ address, action: 'add' }),
            });
            if (response.ok) {
                spinner.succeed(chalk.green(`Address ${address} added to whitelist`));
            } else {
                spinner.fail(chalk.red('Failed to add address'));
            }
        } catch {
            spinner.fail(chalk.red('Server not reachable'));
        }
    });

whitelistCmd
    .command('remove <address>')
    .description('Remove an Ethereum address from the whitelist')
    .option('-u, --url <url>', 'PlugPort server URL', 'http://localhost:8080')
    .action(async (address, options) => {
        const spinner = ora(`Removing ${address.substring(0, 10)}... from whitelist`).start();
        try {
            const response = await fetch(`${options.url}/api/v1/whitelist`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ address, action: 'remove' }),
            });
            if (response.ok) {
                spinner.succeed(chalk.green(`Address ${address} removed from whitelist`));
            } else {
                spinner.fail(chalk.red('Failed to remove address'));
            }
        } catch {
            spinner.fail(chalk.red('Server not reachable'));
        }
    });

whitelistCmd
    .command('list')
    .description('List all whitelisted addresses')
    .option('-u, --url <url>', 'PlugPort server URL', 'http://localhost:8080')
    .action(async (options) => {
        try {
            const response = await fetch(`${options.url}/api/v1/whitelist`);
            const data = await response.json() as { addresses: string[] };
            console.log(chalk.cyan.bold('\n  Whitelisted Addresses\n'));
            if (data.addresses?.length) {
                data.addresses.forEach((addr, i) => {
                    console.log(chalk.gray(`  ${i + 1}.`), addr);
                });
            } else {
                console.log(chalk.gray('  No addresses whitelisted'));
            }
            console.log('');
        } catch {
            console.log(chalk.red('\n  Server not reachable\n'));
        }
    });

program.parse();
