import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import solc from 'solc';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface CompiledContract {
    abi: unknown[];
    bytecode: string;
}

export function compileContract(contractName: string): CompiledContract {
    const fileName = `${contractName}.sol`;
    const source = readFileSync(join(__dirname, fileName), 'utf8');

    const input = {
        language: 'Solidity',
        sources: {
            [fileName]: { content: source },
        },
        settings: {
            optimizer: { enabled: true, runs: 200 },
            outputSelection: {
                '*': {
                    '*': ['abi', 'evm.bytecode.object'],
                },
            },
        },
    };

    const output = JSON.parse(solc.compile(JSON.stringify(input)));

    if (output.errors) {
        const fatal = output.errors.filter((e: { severity: string }) => e.severity === 'error');
        for (const err of output.errors) {
            console.error(err.formattedMessage ?? err.message);
        }
        if (fatal.length > 0) {
            throw new Error(`Compilation of ${fileName} failed with ${fatal.length} error(s)`);
        }
    }

    const contract = output.contracts[fileName][contractName];
    return {
        abi: contract.abi,
        bytecode: '0x' + contract.evm.bytecode.object,
    };
}

// Allow running directly: tsx compile.ts <ContractName>
if (import.meta.url === `file://${process.argv[1]}`) {
    const name = process.argv[2] ?? 'PlugPortStore';
    const { abi, bytecode } = compileContract(name);
    console.log(`Compiled ${name}: ${bytecode.length / 2 - 1} bytes bytecode, ${abi.length} ABI entries`);
}
