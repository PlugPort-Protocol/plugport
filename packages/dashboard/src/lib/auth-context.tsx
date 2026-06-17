'use client';

import {
    createContext,
    useContext,
    useState,
    useCallback,
    useEffect,
    useRef,
    type ReactNode,
} from 'react';
import { useAccount, useDisconnect, useSignMessage } from 'wagmi';

// ---- Types ----

export type AuthMethod = 'wallet' | 'apiKey' | 'none';

interface AuthState {
    /** Authenticated wallet address (lowercase, checksummed) */
    address: string | null;
    /** Current auth method */
    authMethod: AuthMethod;
    /** JWT token from SIWE verification */
    jwt: string | null;
    /** Whether user is fully authenticated */
    isAuthenticated: boolean;
    /** Custom server URL (null = default public server) */
    serverUrl: string | null;
    /** Sign in with SIWE */
    signIn: () => Promise<void>;
    /** Sign out / disconnect */
    signOut: () => void;
    /** Set custom server URL */
    setServerUrl: (url: string | null) => void;
    /** Set JWT after SIWE verification */
    setJwt: (jwt: string | null) => void;
}

const AuthContext = createContext<AuthState>({
    address: null,
    authMethod: 'none',
    jwt: null,
    isAuthenticated: false,
    serverUrl: null,
    signIn: async () => {},
    signOut: () => {},
    setServerUrl: () => {},
    setJwt: () => {},
});

// ---- API Helpers ----

function getApiBase(serverUrl: string | null): string {
    if (serverUrl) return serverUrl;
    return process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080';
}

// ---- Provider ----

export function AuthProvider({ children }: { children: ReactNode }) {
    const { address: walletAddress, isConnected } = useAccount();
    const { disconnect } = useDisconnect();
    const { signMessageAsync } = useSignMessage();

    const [jwt, setJwtState] = useState<string | null>(null);
    const [serverUrl, setServerUrlState] = useState<string | null>(null);
    const isSigningInRef = useRef(false);

    // Load persisted state from localStorage
    useEffect(() => {
        if (typeof window === 'undefined') return;
        const savedJwt = localStorage.getItem('plugport_jwt');
        const savedUrl = localStorage.getItem('plugport_server_url');
        if (savedJwt) setJwtState(savedJwt);
        if (savedUrl) setServerUrlState(savedUrl);
    }, []);

    // Clear JWT when wallet disconnects
    useEffect(() => {
        if (!isConnected) {
            setJwtState(null);
            localStorage.removeItem('plugport_jwt');
        }
    }, [isConnected]);

    const setJwt = useCallback((token: string | null) => {
        setJwtState(token);
        if (token) {
            localStorage.setItem('plugport_jwt', token);
        } else {
            localStorage.removeItem('plugport_jwt');
        }
    }, []);

    const setServerUrl = useCallback((url: string | null) => {
        setServerUrlState(url);
        if (url) {
            localStorage.setItem('plugport_server_url', url);
        } else {
            localStorage.removeItem('plugport_server_url');
        }
    }, []);

    const signIn = useCallback(async () => {
        if (!walletAddress || !isConnected) return;
        if (isSigningInRef.current) return;

        isSigningInRef.current = true;
        const apiBase = getApiBase(serverUrl);

        try {
            // Step 1: Get nonce
            const nonceRes = await fetch(`${apiBase}/api/v1/auth/nonce`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ address: walletAddress }),
            });
            if (!nonceRes.ok) throw new Error('Failed to get nonce');
            const { nonce } = await nonceRes.json();

            // Step 2: Create SIWE message
            const domain = typeof window !== 'undefined' ? window.location.host : 'plugport.xyz';
            const origin = typeof window !== 'undefined' ? window.location.origin : 'https://plugport.xyz';
            const message = [
                `${domain} wants you to sign in with your Ethereum account:`,
                walletAddress,
                '',
                'Sign in to PlugPort Dashboard',
                '',
                `URI: ${origin}`,
                `Version: 1`,
                `Chain ID: 10143`,
                `Nonce: ${nonce}`,
                `Issued At: ${new Date().toISOString()}`,
            ].join('\n');

            // Step 3: Request wallet signature (via wagmi)
            const signature = await signMessageAsync({ message });

            // Step 4: Verify on server
            const verifyRes = await fetch(`${apiBase}/api/v1/auth/verify`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message, signature, address: walletAddress }),
            });
            if (!verifyRes.ok) throw new Error('Signature verification failed');
            const { token } = await verifyRes.json();

            setJwt(token);
        } catch (err) {
            console.error('SIWE sign-in failed:', err);
            throw err;
        } finally {
            isSigningInRef.current = false;
        }
    }, [walletAddress, isConnected, serverUrl, setJwt, signMessageAsync]);

    const signOut = useCallback(() => {
        setJwt(null);
        disconnect();
    }, [setJwt, disconnect]);

    // Determine auth method
    const authMethod: AuthMethod = jwt && isConnected
        ? 'wallet'
        : process.env.NEXT_PUBLIC_TDBX_API_KEY
            ? 'apiKey'
            : 'none';

    const isAuthenticated = authMethod !== 'none';
    const address = isConnected && walletAddress ? walletAddress.toLowerCase() : null;

    // Auto sign-in when wallet connects
    useEffect(() => {
        if (isConnected && walletAddress && !jwt) {
            signIn().catch((err) => {
                console.error('Auto sign-in failed', err);
                disconnect(); // Disconnect wallet if they reject the signature
            });
        }
    }, [isConnected, walletAddress, jwt, signIn, disconnect]);

    return (
        <AuthContext.Provider
            value={{
                address,
                authMethod,
                jwt,
                isAuthenticated,
                serverUrl,
                signIn,
                signOut,
                setServerUrl,
                setJwt,
            }}
        >
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth() {
    return useContext(AuthContext);
}
