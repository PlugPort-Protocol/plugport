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
import { SiweMessage } from 'siwe';

// ---- Types ----

export type AuthMethod = 'wallet' | 'apiKey' | 'none';

interface AuthState {
    /** Authenticated wallet address (lowercase) */
    address: string | null;
    /** Current auth method */
    authMethod: AuthMethod;
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
}

const AuthContext = createContext<AuthState>({
    address: null,
    authMethod: 'none',
    isAuthenticated: false,
    serverUrl: null,
    signIn: async () => {},
    signOut: () => {},
    setServerUrl: () => {},
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

    const [authenticatedAddress, setAuthenticatedAddress] = useState<string | null>(null);
    const [serverUrl, setServerUrlState] = useState<string | null>(null);
    const isSigningInRef = useRef(false);

    // Load persisted state from localStorage
    useEffect(() => {
        if (typeof window === 'undefined') return;
        const savedUrl = localStorage.getItem('plugport_server_url');
        if (savedUrl) setServerUrlState(savedUrl);
    }, []);

    // Check session on mount (cookie-based — no local JWT to restore)
    useEffect(() => {
        if (typeof window === 'undefined') return;
        const apiBase = getApiBase(serverUrl);
        fetch(`${apiBase}/api/v1/auth/me`, { credentials: 'include' })
            .then(async (res) => {
                if (res.ok) {
                    const data = await res.json();
                    setAuthenticatedAddress(data.address);
                } else {
                    setAuthenticatedAddress(null);
                }
            })
            .catch(() => setAuthenticatedAddress(null));
    }, [serverUrl]);

    // Clear authenticated state when wallet disconnects
    useEffect(() => {
        if (!isConnected) {
            setAuthenticatedAddress(null);
        }
    }, [isConnected]);

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
            // Step 1: Get nonce (stored in session cookie by the server)
            const nonceRes = await fetch(`${apiBase}/api/v1/auth/nonce`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ address: walletAddress }),
                credentials: 'include',
            });
            if (!nonceRes.ok) throw new Error('Failed to get nonce');
            const { nonce } = await nonceRes.json();

            // Step 2: Create EIP-4361 SIWE message using the official package
            const domain = typeof window !== 'undefined' ? window.location.host : 'plugport.xyz';
            const origin = typeof window !== 'undefined' ? window.location.origin : 'https://plugport.xyz';
            const siweMessage = new SiweMessage({
                domain,
                address: walletAddress,
                statement: 'Sign in to PlugPort Dashboard',
                uri: origin,
                version: '1',
                chainId: 10143,
                nonce,
            });
            const message = siweMessage.prepareMessage();

            // Step 3: Request wallet signature (via wagmi)
            const signature = await signMessageAsync({ message });

            // Step 4: Verify on server (sets httpOnly session cookie)
            const verifyRes = await fetch(`${apiBase}/api/v1/auth/verify`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message, signature }),
                credentials: 'include',
            });
            if (!verifyRes.ok) throw new Error('Signature verification failed');
            const { address: verifiedAddress } = await verifyRes.json();

            setAuthenticatedAddress(verifiedAddress);
        } catch (err) {
            console.error('SIWE sign-in failed:', err);
            throw err;
        } finally {
            isSigningInRef.current = false;
        }
    }, [walletAddress, isConnected, serverUrl, signMessageAsync]);

    const signOut = useCallback(async () => {
        const apiBase = getApiBase(serverUrl);
        // Destroy server session
        try {
            await fetch(`${apiBase}/api/v1/auth/logout`, {
                method: 'POST',
                credentials: 'include',
            });
        } catch {
            // Best-effort — disconnect wallet regardless
        }
        setAuthenticatedAddress(null);
        disconnect();
    }, [serverUrl, disconnect]);

    // Determine auth method
    const authMethod: AuthMethod = authenticatedAddress && isConnected
        ? 'wallet'
        : process.env.NEXT_PUBLIC_TDBX_API_KEY
            ? 'apiKey'
            : 'none';

    const isAuthenticated = authMethod !== 'none';
    const address = isConnected && walletAddress ? walletAddress.toLowerCase() : null;

    // Auto sign-in when wallet connects
    useEffect(() => {
        if (isConnected && walletAddress && !authenticatedAddress) {
            signIn().catch((err) => {
                console.error('Auto sign-in failed', err);
                disconnect(); // Disconnect wallet if they reject the signature
            });
        }
    }, [isConnected, walletAddress, authenticatedAddress, signIn, disconnect]);

    return (
        <AuthContext.Provider
            value={{
                address,
                authMethod,
                isAuthenticated,
                serverUrl,
                signIn,
                signOut,
                setServerUrl,
            }}
        >
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth() {
    return useContext(AuthContext);
}
