// Shared reader for the clean-room denylist, so a per-document test asserts
// against the SAME matchers `tools/grep-gate.mjs` enforces repo-wide rather than
// against a second, drifting copy of the rules.
//
// The repo-wide gate is what actually blocks a release; these per-file
// assertions exist so that a document which introduces internal vocabulary
// fails in the test that owns that document, naming it, instead of surfacing as
// a whole-suite abort from the grep gate several steps earlier.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function denylistMatchers() {
  const text = readFileSync(join(repoRoot, 'tools', 'internal-vocab-denylist.txt'), 'utf8');
  const matchers = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const re = line.match(/^\/(.*)\/([a-z]*)$/);
    if (re) {
      matchers.push({ label: line, regex: new RegExp(re[1], re[2].includes('g') ? re[2] : `${re[2]}g`) });
    } else {
      const escaped = line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      matchers.push({ label: line, regex: new RegExp(escaped, 'gi') });
    }
  }
  return matchers;
}

// Every denylist hit in `text`, as `"<term>" matched <matcher>` strings.
export function denylistHits(text) {
  const hits = [];
  for (const { label, regex } of denylistMatchers()) {
    regex.lastIndex = 0;
    let m;
    while ((m = regex.exec(text)) !== null) {
      hits.push(`"${m[0]}" matched ${label}`);
      if (m.index === regex.lastIndex) regex.lastIndex++;
    }
  }
  return hits;
}
