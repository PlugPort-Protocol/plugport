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
import { useAccount, useDisconnect, useSignMessage, useSwitchChain } from 'wagmi';
import { TARGET_CHAIN_ID } from './wallet-provider';
import { SiweMessage } from 'siwe';
import { getApiBase, setServerUrl as setSharedServerUrl } from './api';

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
    /** Connected wallet is on a different chain than this deployment's */
    isWrongNetwork: boolean;
    /** Move the wallet to the deployment's chain (adds it first if the wallet doesn't know it) */
    switchToTargetNetwork: () => Promise<void>;
    /** Resolves once the wallet is on the right chain; call before signing on-chain actions */
    ensureNetwork: () => Promise<void>;
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
    isWrongNetwork: false,
    switchToTargetNetwork: async () => {},
    ensureNetwork: async () => {},
    setServerUrl: () => {},
});

// ---- Provider ----

export function AuthProvider({ children }: { children: ReactNode }) {
    const { address: walletAddress, isConnected, chainId: walletChainId } = useAccount();
    const { disconnect } = useDisconnect();
    const { signMessageAsync } = useSignMessage();
    const { switchChainAsync } = useSwitchChain();

    const [authenticatedAddress, setAuthenticatedAddress] = useState<string | null>(null);
    const [serverUrl, setServerUrlState] = useState<string | null>(null);
    const isSigningInRef = useRef(false);

    // Load persisted state from localStorage
    useEffect(() => {
        if (typeof window === 'undefined') return;
        const savedUrl = localStorage.getItem('plugport_server_url');
        if (savedUrl) {
            setServerUrlState(savedUrl);
            setSharedServerUrl(savedUrl);
        }
    }, []);

    // Check session on mount (cookie-based — no local JWT to restore)
    useEffect(() => {
        if (typeof window === 'undefined') return;
        const apiBase = getApiBase();
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
        setSharedServerUrl(url);
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
        const apiBase = getApiBase();

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
        const apiBase = getApiBase();
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

    const isWrongNetwork = isConnected && walletChainId !== undefined && walletChainId !== TARGET_CHAIN_ID;

    // switchChain asks the wallet to switch and, if it has never heard of the
    // chain, falls back to wallet_addEthereumChain using the config above — so
    // one approval covers both "add Monad Testnet" and "switch to it".
    const switchToTargetNetwork = useCallback(async () => {
        if (walletChainId === TARGET_CHAIN_ID) return;
        await switchChainAsync({ chainId: TARGET_CHAIN_ID });
    }, [walletChainId, switchChainAsync]);

    const ensureNetwork = switchToTargetNetwork;

    // Ask once per (wallet, chain) as soon as we see a wrong network. Tracking
    // the attempt means declining the prompt doesn't re-trigger it in a loop;
    // the wallet panel keeps a one-click retry available instead.
    const autoSwitchAttemptRef = useRef<string | null>(null);
    useEffect(() => {
        if (!isConnected || !walletAddress) {
            autoSwitchAttemptRef.current = null;
            return;
        }
        if (walletChainId === undefined || walletChainId === TARGET_CHAIN_ID) return;
        const attempt = `${walletAddress}:${walletChainId}`;
        if (autoSwitchAttemptRef.current === attempt) return;
        autoSwitchAttemptRef.current = attempt;
        switchToTargetNetwork().catch(() => { /* declined — banner offers a retry */ });
    }, [isConnected, walletAddress, walletChainId, switchToTargetNetwork]);

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
                isWrongNetwork,
                switchToTargetNetwork,
                ensureNetwork,
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
