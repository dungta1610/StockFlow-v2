import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const PLATFORM_DIR = resolve(__dirname, '../../src/platform');
const IMPORT_SPECIFIER_RE = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectTsFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Gate for docs/code-standards.md's "platform/ never imports modules/": mechanism
 * (`platform/`) must never know about business policy (`modules/`) — see
 * docs/adr/0017 for why the outbox relay's dispatcher routing and the reservation
 * sweep both live in `modules/ordering` instead.
 */
describe('platform/ never imports modules/', () => {
  it('has no import specifier that resolves into modules/', () => {
    const offenders: { file: string; specifier: string }[] = [];
    for (const file of collectTsFiles(PLATFORM_DIR)) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(IMPORT_SPECIFIER_RE)) {
        const specifier = match[1]!;
        if (specifier.includes('/modules/') || specifier.startsWith('modules/')) {
          offenders.push({ file, specifier });
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('sanity-checks the scanner against a deliberately bad import', () => {
    const source = `import { X } from '../../modules/ordering/x';`;
    const specifiers = [...source.matchAll(IMPORT_SPECIFIER_RE)].map((m) => m[1]);
    expect(specifiers.some((s) => s!.includes('/modules/'))).toBe(true);
  });
});
