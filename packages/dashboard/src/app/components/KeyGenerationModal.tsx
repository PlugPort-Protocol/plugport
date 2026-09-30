'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export type KeyModalPhase = 'signing' | 'registering' | 'done';

interface Props {
    phase: KeyModalPhase;
    /** 'generate' for a new key, 'rotate' for a replacement. */
    kind: 'generate' | 'rotate';
    /** The freshly derived key; shown once `phase` is 'done'. */
    apiKey: string | null;
    onClose: () => void;
}

const STEPS: { id: Exclude<KeyModalPhase, 'done'>; label: string; hint: string }[] = [
    { id: 'signing', label: 'Approve in your wallet', hint: 'Confirm the signature requests' },
    { id: 'registering', label: 'Register on-chain', hint: 'Waiting for Monad to confirm' },
];

const ORDER: KeyModalPhase[] = ['signing', 'registering', 'done'];

async function copyText(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        // Clipboard API is unavailable on insecure origins / some webviews.
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            const ok = document.execCommand('copy');
            document.body.removeChild(ta);
            return ok;
        } catch {
            return false;
        }
    }
}

export function KeyGenerationModal({ phase, kind, apiKey, onClose }: Props) {
    const [copied, setCopied] = useState(false);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const done = phase === 'done' && !!apiKey;

    // Portal target. Rendering in place breaks `position: fixed`: an ancestor
    // with a transform (the tab's fade-in animation) becomes the containing block,
    // so the overlay centred on the whole page instead of the viewport.
    const [mounted, setMounted] = useState(false);
    useEffect(() => setMounted(true), []);

    // Keep the page behind from scrolling while the sheet is open.
    useEffect(() => {
        const prev = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => { document.body.style.overflow = prev; };
    }, []);

    const copy = useCallback(async () => {
        if (!apiKey) return;
        if (await copyText(apiKey)) {
            setCopied(true);
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => setCopied(false), 2200);
        }
    }, [apiKey]);

    useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

    // Only dismissable once the key is on screen; mid-flight it must stay open.
    useEffect(() => {
        if (!done) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [done, onClose]);

    const current = ORDER.indexOf(phase);
    const title = done
        ? (kind === 'rotate' ? 'Key rotated' : 'Your key is ready')
        : (kind === 'rotate' ? 'Rotating your key' : 'Creating your key');

    if (!mounted) return null;

    return createPortal(
        <div className="kg-overlay" role="dialog" aria-modal="true" aria-labelledby="kg-title">
            <div className={`kg-sheet${done ? ' kg-sheet-done' : ''}`}>
                <div className={`kg-badge${done ? ' kg-badge-done' : ''}`} aria-hidden="true">
                    {done ? (
                        <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                            <path className="kg-check" d="M5 12.5l4.5 4.5L19 7.5" />
                        </svg>
                    ) : (
                        <span className="kg-ring" />
                    )}
                </div>

                <h2 className="kg-title" id="kg-title">{title}</h2>

                {!done ? (
                    <>
                        <p className="kg-sub">This can take up to a minute. Keep this window open.</p>
                        <ol className="kg-steps">
                            {STEPS.map((s, i) => {
                                const state = i < current ? 'complete' : i === current ? 'active' : 'pending';
                                return (
                                    <li key={s.id} className={`kg-step kg-step-${state}`}>
                                        <span className="kg-dot">
                                            {state === 'complete' ? (
                                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
                                            ) : state === 'active' ? <span className="kg-dot-pulse" /> : null}
                                        </span>
                                        <span className="kg-step-text">
                                            <span className="kg-step-label">{s.label}</span>
                                            <span className="kg-step-hint">{s.hint}</span>
                                        </span>
                                    </li>
                                );
                            })}
                        </ol>
                    </>
                ) : (
                    <>
                        <p className="kg-sub">Copy it now. For your security it won&apos;t be shown again.</p>
                        <button
                            type="button"
                            className={`kg-key${copied ? ' kg-key-copied' : ''}`}
                            onClick={copy}
                            aria-label="Copy API key to clipboard"
                        >
                            <code className="kg-key-text">{apiKey}</code>
                            <span className="kg-key-cta" aria-live="polite">
                                {copied ? (
                                    <>
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
                                        Copied to clipboard
                                    </>
                                ) : (
                                    <>
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="12" height="12" rx="2.5" /><path d="M5 15V6.5A2.5 2.5 0 0 1 7.5 4H15" /></svg>
                                        Click to copy
                                    </>
                                )}
                            </span>
                        </button>
                        <button type="button" className="kg-done" onClick={onClose}>Done</button>
                    </>
                )}
            </div>
        </div>,
        document.body,
    );
}
