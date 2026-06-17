const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, 'src/protocols/redis-server.ts');
let code = fs.readFileSync(file, 'utf-8');

const regex = /private async executeCommand\(socket: net\.Socket, args: string\[\]\): Promise<void> \{([\s\S]*?)    \/\/ ---- Pub\/Sub Helpers ----/g;
const match = regex.exec(code);
if (!match) {
    console.error("Match not found!");
    process.exit(1);
}

let body = match[1];

// Remove Pub/Sub logic from executeRedisCommand
// Replace this.kvStore with kvStore
body = body.replace(/this\.kvStore/g, 'kvStore');

// Remove socket.write(encode...(...)) -> return ...
body = body.replace(/socket\.write\(encodeSimpleString\('([^']+)'\)\);/g, "return '$1';");
body = body.replace(/socket\.write\(encodeInteger\(([^)]+)\)\);/g, "return $1;");
body = body.replace(/socket\.write\(encodeBulkString\(null\)\);/g, "return null;");
body = body.replace(/socket\.write\(encodeBulkString\(([^)]+)\)\);/g, "return $1;");
body = body.replace(/socket\.write\(encodeArray\(([^)]+)\)\);/g, "return $1;");
body = body.replace(/socket\.write\(encodeError\(([^)]+)\)\);/g, "throw new Error($1);");
body = body.replace(/socket\.write\(args\[1\] \? encodeBulkString\(args\[1\]\) : encodeSimpleString\('PONG'\)\);/g, "return args[1] || 'PONG';");
body = body.replace(/socket\.end\(\);/g, "");

const newFunc = `
export async function executeRedisCommand(kvStore: KVAdapter, args: string[]): Promise<any> {
${body}}
`;

fs.writeFileSync(file, code + '\n' + newFunc);
console.log("Generated executeRedisCommand.");
