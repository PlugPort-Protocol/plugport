#!/usr/bin/env node
// PlugPort CLI Tool
// Developer toolkit: init, dev, playground, migrate, and query operations

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { VERSION } from '@plugport/shared';

const program = new Command();

program
    .name('plugport')
    .description('PlugPort CLI - MongoDB-compatible store on MonadDb')
    .version(VERSION);

// ---- Init Command ----
program
    .command('init')
    .description('Initialize a new PlugPort project with SDK setup')
    .option('-t, --template <template>', 'Project template (node, python, go)', 'node')
    .action(async (options) => {
        const spinner = ora('Scaffolding PlugPort project...').start();

        const fs = await import('fs');
        const path = await import('path');
        const cwd = process.cwd();

        try {
            // Create project structure
            const dirs = ['src', 'test'];
            for (const dir of dirs) {
                fs.mkdirSync(path.join(cwd, dir), { recursive: true });
            }

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
                    '@plugport/sdk': 'latest',
                },
                devDependencies: {
                    typescript: '^5.7.0',
                    tsx: '^4.19.0',
                    vitest: '^3.0.0',
                },
            };

            fs.writeFileSync(
                path.join(cwd, 'package.json'),
                JSON.stringify(pkg, null, 2),
            );

            // Create tsconfig.json
            const tsconfig = {
                compilerOptions: {
                    target: 'ES2022',
                    module: 'ESNext',
                    moduleResolution: 'bundler',
                    strict: true,
                    esModuleInterop: true,
                    outDir: './dist',
                    rootDir: './src',
                },
                include: ['src/**/*'],
            };

            fs.writeFileSync(
                path.join(cwd, 'tsconfig.json'),
                JSON.stringify(tsconfig, null, 2),
            );

            // Create sample app
            const sampleApp = `import { PlugPortClient } from '@plugport/sdk';

async function main() {
  // Connect to PlugPort server
  const client = await PlugPortClient.connect('http://localhost:8080');
  const db = client.db('myapp');
  const users = db.collection('users');

  // Insert a document
  const result = await users.insertOne({
    name: 'Alice',
    email: 'alice@example.com',
    age: 30,
  });
  console.log('Inserted:', result);

  // Find documents
  const docs = await users.find({ name: 'Alice' });
  console.log('Found:', docs);

  // Update a document
  const updateResult = await users.updateOne(
    { name: 'Alice' },
    { $set: { age: 31 } },
  );
  console.log('Updated:', updateResult);

  // Create an index
  await users.createIndex('email', { unique: true });

  await client.close();
}

main().catch(console.error);
`;

            fs.writeFileSync(path.join(cwd, 'src', 'index.ts'), sampleApp);

            // Create .env
            fs.writeFileSync(
                path.join(cwd, '.env'),
                'PLUGPORT_URL=http://localhost:8080\n',
            );

            spinner.succeed(chalk.green('Project initialized successfully!'));
            console.log('');
            console.log(chalk.cyan('  Next steps:'));
            console.log(chalk.gray('  1.'), 'npm install');
            console.log(chalk.gray('  2.'), 'plugport dev    # Start local PlugPort server');
            console.log(chalk.gray('  3.'), 'npm run dev    # Run your app');
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
            // Try to start the server
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

            // Open dashboard
            if (options.dashboard !== false) {
                setTimeout(async () => {
                    try {
                        const open = (await import('open')).default;
                        await open(`http://localhost:${options.port}/health`);
                    } catch {
                        // Ignore if can't open browser
                    }
                }, 2000);
            }

            // Handle shutdown
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
            // Start server in background
            const { spawn } = await import('child_process');
            const path = await import('path');

            const serverProc = spawn('npx', ['tsx', path.resolve(import.meta.dirname || '.', '../../server/src/index.ts')], {
                env: { ...process.env, HTTP_PORT: '8080', WIRE_PORT: '27017' },
                stdio: 'pipe',
            });

            // Wait for server to start
            await new Promise<void>((resolve) => {
                const timeout = setTimeout(resolve, 3000);
                serverProc.stdout?.on('data', (data: Buffer) => {
                    if (data.toString().includes('Ready')) {
                        clearTimeout(timeout);
                        resolve();
                    }
                });
            });

            spinner.text = 'Loading sample data...';

            // Insert sample data
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

            // Create indexes
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
            console.log(chalk.gray('    curl -X POST http://localhost:8080/api/v1/collections/users/find -H "Content-Type: application/json" -d \'{"filter":{"role":"admin"}}\''));
            console.log(chalk.gray('    mongosh mongodb://localhost:27017'));
            console.log('');
            console.log(chalk.yellow('  Press Ctrl+C to stop'));

            process.on('SIGINT', () => {
                serverProc.kill('SIGTERM');
                console.log(chalk.gray('\n  Playground stopped.'));
                process.exit(0);
            });

            // Keep process alive
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

            const rl = readline.createInterface({
                input: fileStream,
                crlfDelay: Infinity
            });

            // Batch insert
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

            // Insert remaining documents in the final batch
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

// ---- Status Command ----
program
    .command('status')
    .description('Show PlugPort server status')
    .option('-u, --url <url>', 'PlugPort server URL', 'http://localhost:8080')
    .action(async (options) => {
        try {
            const response = await fetch(`${options.url}/health`);
            const health = await response.json() as Record<string, unknown>;

            console.log(chalk.cyan.bold('\n  PlugPort Server Status\n'));
            console.log(chalk.gray('  Status:    '), chalk.green(String(health.status)));
            console.log(chalk.gray('  Version:   '), health.version);
            console.log(chalk.gray('  Uptime:    '), `${Math.floor(health.uptime as number)}s`);
            console.log(chalk.gray('  Keys:      '), (health.storage as Record<string, unknown>).keyCount);
            console.log('');
        } catch {
            console.log(chalk.red('\n  Server is not running or not reachable'));
            console.log(chalk.gray('  Start with: plugport dev\n'));
        }
    });

program.parse();
