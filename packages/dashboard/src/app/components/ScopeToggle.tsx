'use client';

import type { ScopeState } from '../types';

export function ScopeToggle({ scope, setScope, allowBoth = false }: { scope: ScopeState; setScope: (s: ScopeState) => void; allowBoth?: boolean }) {
    return (
        <div className="scope-toggle">
            <button
                className={`scope-toggle-btn ${scope === 'my' ? 'active' : ''}`}
                onClick={() => setScope('my')}
            >
                My Data
            </button>
            {allowBoth && (
                <button
                    className={`scope-toggle-btn ${scope === 'both' ? 'active' : ''}`}
                    onClick={() => setScope('both')}
                >
                    Comparison
                </button>
            )}
            <button
                className={`scope-toggle-btn ${scope === 'all' ? 'active' : ''}`}
                onClick={() => setScope('all')}
            >
                Global
            </button>
        </div>
    );
}
