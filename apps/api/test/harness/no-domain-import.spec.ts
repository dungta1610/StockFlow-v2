import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const PACKAGE_SRC = resolve(__dirname, '../../../../packages/ai-harness/src');
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
 * The harness is a domain-agnostic library: nothing in it may reach into the
 * application.
 *
 * Import *specifiers* are what is scanned, not source text. Scanning text for
 * domain words would light up on the first `ORDER BY` in a repository query and
 * be switched off by the end of the day — a gate nobody trusts stops being a gate.
 */
describe('packages/ai-harness never imports the application', () => {
  it('has no import specifier pointing at apps/', () => {
    const offenders: { file: string; specifier: string }[] = [];
    for (const file of collectTsFiles(PACKAGE_SRC)) {
      for (const match of readFileSync(file, 'utf8').matchAll(IMPORT_SPECIFIER_RE)) {
        const specifier = match[1]!;
        if (specifier.includes('apps/') || specifier.startsWith('@stockflow/')) {
          offenders.push({ file, specifier });
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('sanity-checks the scanner against a deliberately bad import', () => {
    const source = `import { OrderService } from '../../apps/api/src/modules/ordering/x';`;
    const specifiers = [...source.matchAll(IMPORT_SPECIFIER_RE)].map((m) => m[1]!);
    expect(specifiers.some((s) => s.includes('apps/'))).toBe(true);
  });
});
