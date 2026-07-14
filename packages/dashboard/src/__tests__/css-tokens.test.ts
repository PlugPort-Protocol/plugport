// T3: Visual regression tests for CSS token correctness ("Statecraft" theme)
// Validates that CSS custom properties are correctly defined in :root (dark-first)
// and [data-theme='light'], and that button classes use CSS variables.
//
// These tests parse the raw CSS file to assert:
// 1. Layout/spacing tokens are in :root (not re-defined per theme)
// 2. Light theme only overrides color/shadow tokens
// 3. Button classes use CSS variables, not hardcoded backgrounds

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

let cssContent: string;

beforeAll(() => {
    cssContent = readFileSync(
        resolve(__dirname, '../app/globals.css'),
        'utf-8',
    );
});

/**
 * Extract the content of a CSS block by finding the selector and then
 * matching balanced braces. This handles nested braces in CSS values like rgba().
 */
function extractBlock(css: string, selectorPattern: string): string {
    const regex = new RegExp(selectorPattern + '\\s*\\{');
    const match = regex.exec(css);
    if (!match) return '';

    let depth = 0;
    let start = -1;
    const idx = match.index + match[0].length;

    for (let i = idx; i < css.length; i++) {
        if (css[i] === '{') {
            depth++;
        } else if (css[i] === '}') {
            if (depth === 0) {
                return css.substring(idx, i);
            }
            depth--;
        }
        if (start === -1) start = i;
    }
    return '';
}

/**
 * Extract CSS custom properties from a block of CSS text.
 */
function extractCustomProperties(block: string): Map<string, string> {
    const props = new Map<string, string>();
    const propRegex = /--([\w-]+)\s*:\s*([^;]+);/g;
    let propMatch;
    while ((propMatch = propRegex.exec(block)) !== null) {
        props.set(`--${propMatch[1]}`, propMatch[2].trim());
    }
    return props;
}

describe('T3: CSS Token Correctness', () => {
    describe(':root layout and spacing tokens', () => {
        it('should define --sidebar-width in :root (84px dock rail)', () => {
            const block = extractBlock(cssContent, ':root');
            const rootProps = extractCustomProperties(block);
            expect(rootProps.has('--sidebar-width')).toBe(true);
            expect(rootProps.get('--sidebar-width')).toContain('84px');
        });

        it('should define --header-height in :root', () => {
            const block = extractBlock(cssContent, ':root');
            const rootProps = extractCustomProperties(block);
            expect(rootProps.has('--header-height')).toBe(true);
            expect(rootProps.get('--header-height')).toBe('64px');
        });

        it('should define --radius-sm, --radius-md, --radius-lg, --radius-xl in :root', () => {
            const block = extractBlock(cssContent, ':root');
            const rootProps = extractCustomProperties(block);
            expect(rootProps.has('--radius-sm')).toBe(true);
            expect(rootProps.has('--radius-md')).toBe(true);
            expect(rootProps.has('--radius-lg')).toBe(true);
            expect(rootProps.has('--radius-xl')).toBe(true);
        });

        it('should define --transition-fast, --transition-base, --transition-slow in :root', () => {
            const block = extractBlock(cssContent, ':root');
            const rootProps = extractCustomProperties(block);
            expect(rootProps.has('--transition-fast')).toBe(true);
            expect(rootProps.has('--transition-base')).toBe(true);
            expect(rootProps.has('--transition-slow')).toBe(true);
        });

        it('should define gradient tokens in :root', () => {
            const block = extractBlock(cssContent, ':root');
            const rootProps = extractCustomProperties(block);
            expect(rootProps.has('--gradient-primary')).toBe(true);
            expect(rootProps.has('--gradient-secondary')).toBe(true);
        });
    });

    describe(':root is the dark palette (dark-first)', () => {
        it('should use a dark --bg-primary in :root', () => {
            const block = extractBlock(cssContent, ':root');
            const rootProps = extractCustomProperties(block);
            expect(rootProps.get('--bg-primary')).toBe('#0a0d14');
        });

        it('should use a light --text-primary in :root', () => {
            const block = extractBlock(cssContent, ':root');
            const rootProps = extractCustomProperties(block);
            expect(rootProps.get('--text-primary')).toBe('#e8ecf4');
        });
    });

    describe("[data-theme='light'] overrides only color/shadow tokens", () => {
        it('should NOT re-define --sidebar-width in light theme', () => {
            const block = extractBlock(cssContent, "\\[data-theme='light'\\]");
            const lightProps = extractCustomProperties(block);
            expect(lightProps.has('--sidebar-width')).toBe(false);
        });

        it('should NOT re-define --radius-* tokens in light theme', () => {
            const block = extractBlock(cssContent, "\\[data-theme='light'\\]");
            const lightProps = extractCustomProperties(block);
            expect(lightProps.has('--radius-sm')).toBe(false);
            expect(lightProps.has('--radius-md')).toBe(false);
            expect(lightProps.has('--radius-lg')).toBe(false);
            expect(lightProps.has('--radius-xl')).toBe(false);
        });

        it('should NOT re-define --transition-* tokens in light theme', () => {
            const block = extractBlock(cssContent, "\\[data-theme='light'\\]");
            const lightProps = extractCustomProperties(block);
            expect(lightProps.has('--transition-fast')).toBe(false);
            expect(lightProps.has('--transition-base')).toBe(false);
            expect(lightProps.has('--transition-slow')).toBe(false);
        });

        it('should NOT re-define --header-height in light theme', () => {
            const block = extractBlock(cssContent, "\\[data-theme='light'\\]");
            const lightProps = extractCustomProperties(block);
            expect(lightProps.has('--header-height')).toBe(false);
        });

        it('should override --bg-primary in light theme with a light color', () => {
            const block = extractBlock(cssContent, "\\[data-theme='light'\\]");
            const lightProps = extractCustomProperties(block);
            expect(lightProps.has('--bg-primary')).toBe(true);
            expect(lightProps.get('--bg-primary')).not.toBe('#0a0d14');
        });

        it('should override --text-primary in light theme with a dark color', () => {
            const block = extractBlock(cssContent, "\\[data-theme='light'\\]");
            const lightProps = extractCustomProperties(block);
            expect(lightProps.has('--text-primary')).toBe(true);
            expect(lightProps.get('--text-primary')).not.toBe('#e8ecf4');
        });

        it('should override shadow tokens in light theme', () => {
            const block = extractBlock(cssContent, "\\[data-theme='light'\\]");
            const lightProps = extractCustomProperties(block);
            expect(lightProps.has('--shadow-sm')).toBe(true);
            expect(lightProps.has('--shadow-md')).toBe(true);
        });
    });

    describe('Button classes use CSS variables', () => {
        it('.btn-primary should use var(--accent-primary), not hardcoded background', () => {
            const block = extractBlock(cssContent, '\\.btn-primary(?!:)');
            expect(block).toContain('var(--accent-primary)');
            // Should NOT contain hardcoded hex colors for background
            expect(block).not.toMatch(/background:\s*#[0-9a-fA-F]{3,8}\s*;/);
            expect(block).not.toMatch(/background:\s*black\s*;/);
        });

        it('.btn-secondary should use var(--bg-card), not hardcoded background', () => {
            const block = extractBlock(cssContent, '\\.btn-secondary(?!:)');
            expect(block).toContain('var(--bg-card)');
            // Should NOT contain hardcoded hex colors for background
            expect(block).not.toMatch(/background:\s*#[0-9a-fA-F]{3,8}\s*;/);
            expect(block).not.toMatch(/background:\s*blue\s*;/);
        });

        it('.btn-secondary should use var(--text-secondary) for color', () => {
            const block = extractBlock(cssContent, '\\.btn-secondary(?!:)');
            expect(block).toContain('var(--text-secondary)');
        });
    });

    describe(':root has complete color system', () => {
        it('should define all accent colors in :root', () => {
            const block = extractBlock(cssContent, ':root');
            const rootProps = extractCustomProperties(block);
            expect(rootProps.has('--accent-primary')).toBe(true);
            expect(rootProps.has('--accent-secondary')).toBe(true);
            expect(rootProps.has('--accent-error')).toBe(true);
            expect(rootProps.has('--accent-success')).toBe(true);
            expect(rootProps.has('--accent-warning')).toBe(true);
        });

        it('should define all bg tokens in :root', () => {
            const block = extractBlock(cssContent, ':root');
            const rootProps = extractCustomProperties(block);
            expect(rootProps.has('--bg-primary')).toBe(true);
            expect(rootProps.has('--bg-secondary')).toBe(true);
            expect(rootProps.has('--bg-card')).toBe(true);
        });

        it('should define all text tokens in :root', () => {
            const block = extractBlock(cssContent, ':root');
            const rootProps = extractCustomProperties(block);
            expect(rootProps.has('--text-primary')).toBe(true);
            expect(rootProps.has('--text-secondary')).toBe(true);
            expect(rootProps.has('--text-tertiary')).toBe(true);
        });
    });
});
