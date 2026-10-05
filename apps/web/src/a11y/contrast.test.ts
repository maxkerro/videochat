// Read from disk: under vitest's CSS handling a `?raw` import of a .css file comes back empty.
// (Loaded through `any` -- the web app's TypeScript config has no Node types, and shouldn't.)
const fsModule = 'node:fs';
const pathModule = 'node:path';
/* eslint-disable @typescript-eslint/no-explicit-any */
const fs: any = await import(/* @vite-ignore */ fsModule);
const path: any = await import(/* @vite-ignore */ pathModule);
const cwd: string = (globalThis as any).process.cwd();
// Tests run with apps/web as the working directory (or the repo root via turbo).
const tokensPath: string = [
  path.resolve(cwd, 'src/styles/tokens.css'),
  path.resolve(cwd, 'apps/web/src/styles/tokens.css'),
].find((p: string) => fs.existsSync(p));
const css: string = fs.readFileSync(tokensPath, 'utf8');
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * CHAT-038 AC: "contrast checked in both themes". axe can't measure colours in jsdom, so the
 * pairs the UI actually puts together are checked against the design tokens directly: WCAG 2.2
 * AA, 4.5:1 for text, 3:1 for focus rings and other non-text UI (the reaction "pressed" border,
 * the input border on focus).
 */

function tokens(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--(color-[\w-]+):\s*(#[0-9a-f]{6})/gi)) out[m[1]!] = m[2]!;
  return out;
}

const light = tokens(css.slice(0, css.indexOf('@media (prefers-color-scheme: dark)')));
const dark = tokens(css.slice(css.indexOf(":root[data-theme='dark']")));

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const TEXT_PAIRS: Array<[string, string]> = [
  ['color-text', 'color-bg'],
  ['color-text', 'color-surface'],
  ['color-text', 'color-surface-sunken'],
  ['color-text', 'color-bubble-other'],
  ['color-text-muted', 'color-bg'],
  ['color-text-muted', 'color-surface'],
  ['color-text-muted', 'color-surface-sunken'],
  ['color-bubble-own-text', 'color-bubble-own'],
  ['color-accent-text', 'color-accent'],
  ['color-accent', 'color-surface'],
  ['color-danger', 'color-surface'],
  ['color-text', 'color-accent-soft'],
];
const UI_PAIRS: Array<[string, string]> = [
  ['color-focus', 'color-bg'],
  ['color-focus', 'color-surface'],
  ['color-accent', 'color-accent-soft'],
];

describe.each([
  ['light', light],
  ['dark', dark],
])('%s theme contrast (CHAT-038)', (_name, t) => {
  it.each(TEXT_PAIRS)('%s on %s is at least 4.5:1', (fg, bg) => {
    expect(contrast(t[fg]!, t[bg]!)).toBeGreaterThanOrEqual(4.5);
  });
  it.each(UI_PAIRS)('%s against %s is at least 3:1', (fg, bg) => {
    expect(contrast(t[fg]!, t[bg]!)).toBeGreaterThanOrEqual(3);
  });
});

export {};
