import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const COPILOT = resolve(__dirname, '../../src/modules/copilot');
/** Where the rule applies: the layers that answer requests and run tools. */
const GUARDED = ['application', 'http'].map((dir) => resolve(COPILOT, dir));
const IMPORT_SPECIFIER_RE = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;
const SQL_RE = /\b(SELECT|INSERT INTO|UPDATE|DELETE FROM)\b/;

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * The copilot reaches data only through application services.
 *
 * This is the architectural claim the whole phase rests on: adding an agent added
 * no new way into the database, so it added no new place for a guard to be
 * missing. One file is allowed to speak SQL, and it is the repository behind the
 * proposals table — which is why the exception is named here rather than assumed.
 *
 * It also rules out text-to-SQL by construction. There is nowhere to put it.
 */
describe('modules/copilot does not touch the database', () => {
  const allowed = resolve(COPILOT, 'infrastructure/sql-proposal.repository.ts');

  it('has SQL in exactly one file', () => {
    const offenders = tsFiles(COPILOT)
      .filter((f) => f !== allowed)
      .filter((f) => SQL_RE.test(readFileSync(f, 'utf8')));

    expect(offenders).toEqual([]);
  });

  it('imports neither pg nor any repository from application/ or http/', () => {
    // `copilot.module.ts` is excluded by being outside those two directories: binding
    // a port to its implementation is composition, not data access. ESLint draws the
    // same line.
    const offenders: { file: string; specifier: string }[] = [];
    for (const file of GUARDED.flatMap(tsFiles)) {
      for (const match of readFileSync(file, 'utf8').matchAll(IMPORT_SPECIFIER_RE)) {
        const specifier = match[1]!;
        if (specifier === 'pg' || specifier.includes('/infrastructure/')) {
          offenders.push({ file, specifier });
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('sanity-checks the scanner', () => {
    expect(SQL_RE.test('const q = `SELECT 1`;')).toBe(true);
    expect(SQL_RE.test('orders.list(db, scope, filter, paging)')).toBe(false);
  });
});
