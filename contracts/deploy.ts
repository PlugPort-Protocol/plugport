import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { compileContract } from './compile.ts';

function loadEnvFile(path: string): Record<string, string> {
    const env: Record<string, string> = {};
    if (!existsSync(path)) return env;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        const value = trimmed.slice(eq + 1).trim();
        env[key] = value;
    }
    return env;
}

const networkArg = process.argv.includes('--network')
    ? process.argv[process.argv.indexOf('--network') + 1]
    : 'testnet';

const rootDir = join(import.meta.dirname, '..');
const envFile = join(rootDir, `.env.${networkArg}`);
const env = { ...loadEnvFile(envFile), ...process.env };

const rpcUrl = env.MONAD_RPC_URL;
const privateKey = env.MONAD_PRIVATE_KEY;

if (!rpcUrl || !privateKey) {
    console.error(`Missing MONAD_RPC_URL or MONAD_PRIVATE_KEY in ${envFile}`);
    process.exit(1);
}

const contractName = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'PlugPortStore';

console.log(`Network: ${networkArg} (${envFile})`);
console.log(`Compiling ${contractName}...`);
const { abi, bytecode } = compileContract(contractName);

const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { batchMaxCount: 1 });
const wallet = new ethers.Wallet(privateKey, provider);

console.log(`Deployer / gas station address: ${wallet.address}`);
const balance = await provider.getBalance(wallet.address);
console.log(`Balance: ${ethers.formatEther(balance)} MON`);

if (balance === 0n) {
    console.error('Deployer wallet has no MON — fund it before deploying.');
    process.exit(1);
}

const factory = new ethers.ContractFactory(abi, bytecode, wallet);

function getConstructorArgs(name: string): unknown[] {
    switch (name) {
        // These take a gas station address; address(0) defaults to the deployer.
        case 'PlugPortStore':
        case 'PlugPortAuth':
        case 'PlugPortPrivateStore':
        case 'PlugPortMessageBroker':
            return [ethers.ZeroAddress];
        // Wraps an existing PlugPortStore — needs its address.
        case 'PlugPortRelational': {
            const storeAddress = env.MONAD_CONTRACT_ADDRESS;
            if (!storeAddress) {
                throw new Error(
                    `PlugPortRelational requires MONAD_CONTRACT_ADDRESS to be set in ${envFile} (deploy PlugPortStore first)`
                );
            }
            return [storeAddress];
        }
        case 'PlugPortPrivateStoreFactory':
            return [];
        default:
            return [];
    }
}

const constructorArgs = getConstructorArgs(contractName);

console.log('Deploying...');
const contract = await factory.deploy(...constructorArgs, { gasLimit: 6_000_000n });
const receipt = await contract.deploymentTransaction()?.wait();

console.log(`Deployed ${contractName} at: ${await contract.getAddress()}`);
console.log(`Tx hash: ${receipt?.hash}`);
console.log(`Gas used: ${receipt?.gasUsed.toString()}`);
