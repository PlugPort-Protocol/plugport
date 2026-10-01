// Server side of SCRAM-SHA-256 (RFC 5802 / 7677), shared by the MongoDB and
// PostgreSQL wire servers so both log in the same way.
//
// Credentials: a username that is a wallet address (optionally "0xADDR:N" for
// key N) uses that API key's verifier from the on-chain registry — the
// connection then acts as that wallet. Any other username uses a verifier
// derived from the server's master API_KEY (the operator). The password itself
// never crosses the wire.

import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import { getAuthContract } from './auth-contract.js';

export const SCRAM_ITERATIONS = 4096;

export interface ScramCredentials {
    salt: Buffer;
    storedKey: Buffer;
    serverKey: Buffer;
    iterations: number;
    /** Set when the credentials are a wallet's on-chain key: the login is that wallet. */
    wallet?: string;
}

export interface ScramSession {
    clientFirstBare: string;
    serverFirstMessage: string;
    serverNonce: string;
    credentials: ScramCredentials;
}

/** "n,,n=<user>,r=<nonce>" → its parts. */
export function parseClientFirst(clientFirstMessage: string): { clientFirstBare: string; username: string; clientNonce: string } {
    const clientFirstBare = clientFirstMessage.replace(/^[npy],[^,]*,/, '');
    const fields = Object.fromEntries(clientFirstBare.split(',').map((f) => [f[0], f.substring(2)]));
    return { clientFirstBare, username: fields.n || '', clientNonce: fields.r || '' };
}

/** The operator's verifier, derived from the master API key. */
export function masterKeyCredentials(apiKey: string | undefined): ScramCredentials {
    const salt = createHash('sha256').update(`${apiKey || 'plugport'}:scram-salt`).digest().subarray(0, 16);
    const salted = pbkdf2Sync(apiKey || '', salt, SCRAM_ITERATIONS, 32, 'sha256');
    const clientKey = createHmac('sha256', salted).update('Client Key').digest();
    return {
        salt,
        storedKey: createHash('sha256').update(clientKey).digest(),
        serverKey: createHmac('sha256', salted).update('Server Key').digest(),
        iterations: SCRAM_ITERATIONS,
    };
}

function fromVerifier(verifier: { salt: string; storedKey: string; serverKey: string }, wallet: string): ScramCredentials {
    return {
        salt: Buffer.from(verifier.salt.replace('0x', ''), 'hex').subarray(0, 16),
        storedKey: Buffer.from(verifier.storedKey.replace('0x', ''), 'hex'),
        serverKey: Buffer.from(verifier.serverKey.replace('0x', ''), 'hex'),
        iterations: SCRAM_ITERATIONS,
        wallet: wallet.toLowerCase(),
    };
}

/**
 * Credentials for `username`. A wallet with several active keys must name one
 * ("0xADDR:N"): SCRAM commits to one key's salt before the client proves
 * anything, so trying each key isn't possible, and picking one silently made
 * logins with any other key fail as a bare "wrong password".
 */
export async function resolveScramCredentials(username: string, apiKey: string | undefined): Promise<{ ok: true; credentials: ScramCredentials } | { ok: false; errmsg: string }> {
    const authContract = getAuthContract();
    if (authContract.isReadable && username.startsWith('0x')) {
        const colon = username.indexOf(':', 2);
        const wallet = colon > 0 ? username.substring(0, colon) : username;
        const keyIndex = colon > 0 ? parseInt(username.substring(colon + 1), 10) : -1;
        try {
            if (keyIndex >= 0) {
                const verifier = await authContract.getVerifier(wallet, keyIndex);
                if (verifier?.active) return { ok: true, credentials: fromVerifier(verifier, wallet) };
            } else {
                const activeKeys = await authContract.getActiveKeys(wallet);
                if (activeKeys.length > 1) {
                    const indexes = activeKeys.map((k: { keyIndex: number }) => k.keyIndex).join(', ');
                    return {
                        ok: false,
                        errmsg: `This wallet has ${activeKeys.length} active API keys (indexes ${indexes}). Log in as ${wallet}:<keyIndex> to say which key you are using, e.g. ${wallet}:${activeKeys[activeKeys.length - 1].keyIndex}.`,
                    };
                }
                if (activeKeys.length === 1) {
                    const verifier = await authContract.getVerifier(wallet, activeKeys[0].keyIndex);
                    if (verifier?.active) return { ok: true, credentials: fromVerifier(verifier, wallet) };
                }
            }
        } catch {
            // On-chain lookup failed — fall through to the master key, which the
            // client's proof will then fail to match unless it is the master key.
        }
    }
    return { ok: true, credentials: masterKeyCredentials(apiKey) };
}

/** Build server-first-message for a client-first-message. */
export function startScram(clientFirstMessage: string, credentials: ScramCredentials): ScramSession {
    const { clientFirstBare, clientNonce } = parseClientFirst(clientFirstMessage);
    const serverNonce = clientNonce + randomBytes(24).toString('base64');
    return {
        clientFirstBare,
        serverNonce,
        credentials,
        serverFirstMessage: `r=${serverNonce},s=${credentials.salt.toString('base64')},i=${credentials.iterations}`,
    };
}

/** Check client-final-message's proof; on success, the server-final-message (server signature). */
export function finishScram(session: ScramSession, clientFinalMessage: string): { ok: true; serverFinalMessage: string } | { ok: false; errmsg: string } {
    const fields = Object.fromEntries(clientFinalMessage.split(',').map((f) => {
        const eq = f.indexOf('=');
        return [f.substring(0, eq), f.substring(eq + 1)];
    }));
    if (fields.r !== session.serverNonce) return { ok: false, errmsg: 'SCRAM nonce mismatch.' };
    const clientProof = Buffer.from(fields.p || '', 'base64');
    const withoutProof = clientFinalMessage.substring(0, clientFinalMessage.lastIndexOf(',p='));
    const authMessage = `${session.clientFirstBare},${session.serverFirstMessage},${withoutProof}`;
    const { storedKey, serverKey } = session.credentials;
    const clientSignature = createHmac('sha256', storedKey).update(authMessage).digest();
    if (clientProof.length !== clientSignature.length) return { ok: false, errmsg: 'Authentication failed.' };
    const clientKey = Buffer.from(clientProof.map((b, i) => b ^ clientSignature[i]));
    if (!timingSafeEqual(createHash('sha256').update(clientKey).digest(), storedKey)) return { ok: false, errmsg: 'Authentication failed.' };
    return { ok: true, serverFinalMessage: `v=${createHmac('sha256', serverKey).update(authMessage).digest('base64')}` };
}

/**
 * Check a password the client sent itself (MySQL and Redis logins, over TLS)
 * against SCRAM credentials: the same on-chain verifier, so one API key logs in
 * the same way on every protocol.
 */
export function verifyScramPassword(credentials: ScramCredentials, password: string): boolean {
    const salted = pbkdf2Sync(password, credentials.salt, credentials.iterations, 32, 'sha256');
    const storedKey = createHash('sha256').update(createHmac('sha256', salted).update('Client Key').digest()).digest();
    return storedKey.length === credentials.storedKey.length && timingSafeEqual(storedKey, credentials.storedKey);
}

/** A wallet login name: `0xADDR` or `0xADDR:N`. */
export function isWalletLogin(username: string): boolean {
    return /^0x[0-9a-fA-F]{40}(:\d+)?$/.test(username);
}
