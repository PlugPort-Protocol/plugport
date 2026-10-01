// A SCRAM-SHA-256 client for tests (RFC 5802 / 7677), shared by the MongoDB
// and PostgreSQL login tests.

import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';

/** The SCRAM verifier the dashboard registers on-chain for an API key. */
export function verifierFor(password: string, salt = randomBytes(16)) {
    const salted = pbkdf2Sync(password, salt, 4096, 32, 'sha256');
    const clientKey = createHmac('sha256', salted).update('Client Key').digest();
    return {
        active: true,
        salt: '0x' + salt.toString('hex'),
        storedKey: '0x' + createHash('sha256').update(clientKey).digest('hex'),
        serverKey: '0x' + createHmac('sha256', salted).update('Server Key').digest('hex'),
    };
}

/** A SCRAM-SHA-256 client. `exchange` sends client-first, then client-final, returning the server's replies. */
export async function scramLogin(user: string, password: string, exchange: (msg: string, step: 1 | 2) => Promise<string>) {
    const clientNonce = randomBytes(18).toString('base64');
    const clientFirstBare = `n=${user},r=${clientNonce}`;
    const serverFirst = await exchange(`n,,${clientFirstBare}`, 1);
    const fields = Object.fromEntries(serverFirst.split(',').map((f) => [f[0], f.slice(2)]));
    const salted = pbkdf2Sync(password, Buffer.from(fields.s, 'base64'), Number(fields.i), 32, 'sha256');
    const clientKey = createHmac('sha256', salted).update('Client Key').digest();
    const storedKey = createHash('sha256').update(clientKey).digest();
    const withoutProof = `c=biws,r=${fields.r}`;
    const authMessage = `${clientFirstBare},${serverFirst},${withoutProof}`;
    const signature = createHmac('sha256', storedKey).update(authMessage).digest();
    const proof = Buffer.from(clientKey.map((b, i) => b ^ signature[i]));
    const serverFinal = await exchange(`${withoutProof},p=${proof.toString('base64')}`, 2);
    const expected = createHmac('sha256', createHmac('sha256', salted).update('Server Key').digest()).update(authMessage).digest('base64');
    return { serverVerified: serverFinal === `v=${expected}` };
}
