// Documentation gate for the env-access posture.
//
// The deployment README makes a specific, falsifiable set of claims about what a
// Code node can reach and why. Documentation that drifts from the stack is worse
// than none, because a reader trusts it — so every claim here is tied to the
// thing that implements it, in both directions.
//
// This is the same discipline the linter/anti-pattern gate already applies: a
// claim with no implementation is a lie waiting to happen, and an implementation
// with no claim is a decision nobody can review.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './helpers/stack.mjs';

const compose = readFileSync(join(repoRoot, 'deployment', 'docker-compose.yml'), 'utf8');
const readme = readFileSync(join(repoRoot, 'deployment', 'README.md'), 'utf8');
const envExample = readFileSync(join(repoRoot, '.env.example'), 'utf8');

const FLAG = 'N8N_BLOCK_ENV_ACCESS_IN_NODE=false';

test('the flag is still false — this whole section is void if it ever changes', () => {
  assert.ok(compose.includes(FLAG), `${FLAG} must be present in the compose file`);
  assert.ok(
    !compose.includes('N8N_BLOCK_ENV_ACCESS_IN_NODE=true'),
    'the flag must not be set true: n8n Code nodes cannot read credentials, so the HMAC ' +
      'verification would silently stop working',
  );
});

test('an explanatory comment sits IMMEDIATELY BESIDE the flag, not elsewhere in the file', () => {
  const lines = compose.split('\n');
  // Only actual environment ENTRIES, not prose about the flag: a comment
  // elsewhere in the file that merely names it is not a place the flag is set.
  const flagLines = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => l.trim().startsWith('- ') && l.includes(FLAG));

  assert.equal(
    flagLines.length, 2,
    `expected the flag on both n8n services, found ${flagLines.length} occurrence(s)`,
  );

  for (const { i } of flagLines) {
    // Walk back over the contiguous comment block directly above the flag. A
    // comment three keys away is not "beside" it — a reader scanning the
    // environment map must meet the explanation at the flag itself.
    const block = [];
    for (let j = i - 1; j >= 0 && lines[j].trim().startsWith('#'); j--) block.unshift(lines[j]);

    assert.ok(
      block.length > 0,
      `the flag on line ${i + 1} has no comment immediately above it — a reader meeting ` +
        '`false` with no explanation has to guess whether it was deliberate',
    );

    const text = block.join('\n');
    assert.match(
      text, /credential/i,
      `the comment beside the flag on line ${i + 1} must say why it cannot be true — that n8n ` +
        'Code nodes cannot access credentials',
    );
    assert.match(
      text, /README|env-secret-surface|one secret|ONE secret/i,
      `the comment beside the flag on line ${i + 1} must point at the bound or where it is ` +
        'documented, not merely state the constraint',
    );
  }
});

// Each claim the README makes, paired with the artefact that makes it true.
// Adding a claim without an implementation, or removing an implementation while
// leaving the claim, fails here.
const CLAIMS = [
  {
    claim: /Code nodes cannot access credentials/i,
    because: () => assert.ok(compose.includes(FLAG), 'the flag is false in compose'),
    what: 'the flag is false because credentials are unreachable from a Code node',
  },
  {
    claim: /_FILE/,
    because: () => {
      for (const v of ['N8N_ENCRYPTION_KEY_FILE', 'DB_POSTGRESDB_PASSWORD_FILE', 'QUEUE_BULL_REDIS_PASSWORD_FILE']) {
        assert.ok(compose.includes(v), `${v} must be set in compose`);
      }
    },
    what: 'all three _FILE variables are actually configured',
  },
  {
    claim: /materialise-secrets/,
    because: () => {
      readFileSync(join(repoRoot, 'tools', 'materialise-secrets.mjs'), 'utf8');
      assert.ok(compose.includes('./secrets/n8n.env'), 'the n8n services must read the generated narrow env file');
    },
    what: 'the generator exists and the compose file consumes its output',
  },
  {
    claim: /env-secret-surface\.test\.js/,
    because: () => {
      const t = readFileSync(join(repoRoot, 'tests', 'env-secret-surface.test.js'), 'utf8');
      assert.match(t, /ORDER_INTAKE_HMAC_SECRET/, 'the allowlist must name the one permitted secret');
    },
    what: 'the enforcing test exists and allowlists exactly the claimed secret',
  },
  {
    claim: /env-corpus-surface\.test\.js/,
    because: () => {
      const t = readFileSync(join(repoRoot, 'tests', 'env-corpus-surface.test.js'), 'utf8');
      assert.match(t, /ORDER_INTAKE_HMAC_SECRET/, 'the corpus gate must name the one permitted reference');
      // The README claims all three notations are matched. That claim is only
      // true if the matcher actually handles the bracket forms.
      assert.match(t, /\\\[/, 'the corpus matcher must handle bracket-form references');
    },
    what: 'the corpus gate exists and matches the bracket forms the README claims',
  },
  {
    // The claim is that the corpus holds exactly ONE $env reference. Verified
    // here against the workflow files themselves, not against the test that
    // checks them — a claim backed only by "a test exists" is backed by nothing.
    claim: /exactly one `\$env` reference in the whole workflow corpus/i,
    because: () => {
      const CORPUS = [
        '01-order-intake/workflow.json', '02-crm-sync/workflow.json',
        '03-support-triage/workflow.json', '_shared/dlq-replay/workflow.json',
        '_shared/global-error-handler/workflow.json', '_shared/sync-watchdog/workflow.json',
      ];
      const RE = /\$env\s*(?:\.\s*([A-Za-z_]\w*)|\[\s*\\?["']([A-Za-z_]\w*)\\?["']\s*\])/g;
      const found = new Set();
      for (const rel of CORPUS) {
        for (const m of readFileSync(join(repoRoot, rel), 'utf8').matchAll(RE)) {
          found.add(m[1] || m[2]);
        }
      }
      assert.deepEqual(
        [...found], ['ORDER_INTAKE_HMAC_SECRET'],
        `the README claims one $env reference in the corpus; found ${[...found].join(', ')}`,
      );
    },
    what: 'the workflow files really do hold exactly one $env reference',
  },
  {
    claim: /`Workflow Config`/,
    because: () => {
      // Claimed as the mechanism that replaced $env, so every workflow that used
      // to read a URL from the environment must actually carry the node.
      for (const rel of [
        '01-order-intake/workflow.json', '02-crm-sync/workflow.json',
        '_shared/dlq-replay/workflow.json', '_shared/global-error-handler/workflow.json',
        '_shared/sync-watchdog/workflow.json',
      ]) {
        const w = JSON.parse(readFileSync(join(repoRoot, rel), 'utf8'));
        assert.ok(
          w.nodes.some((n) => n.name === 'Workflow Config'),
          `${rel} must carry the Workflow Config node the README describes`,
        );
      }
    },
    what: 'every migrated workflow actually carries the config node',
  },
  {
    claim: /went from nine variables to \*\*three\*\*/i,
    because: () => {
      const gen = readFileSync(join(repoRoot, 'tools', 'materialise-secrets.mjs'), 'utf8');
      const list = gen.match(/const N8N_ENV_ALLOWLIST = \[([\s\S]*?)\];/);
      assert.ok(list, 'the allowlist must still be declared');
      const entries = [...list[1].matchAll(/'([A-Z0-9_]+)'/g)].map((m) => m[1]);
      assert.equal(
        entries.length, 3,
        `the README claims three variables reach the n8n services; the allowlist has ${entries.length}: ${entries.join(', ')}`,
      );
      for (const removed of [
        'UPSTREAM_API_URL', 'ALERT_WEBHOOK_URL', 'CRM_DELTA_URL', 'CRM_SYNC_URL',
        'LLM_PRIMARY_BASE_URL', 'LLM_FALLBACK_BASE_URL',
      ]) {
        assert.ok(!entries.includes(removed), `${removed} is claimed removed but is still delivered`);
      }
    },
    what: 'the allowlist really is down to three, and the six named ones are gone',
  },
  {
    claim: /env-file-precedence\.test\.js/,
    because: () => readFileSync(join(repoRoot, 'tests', 'env-file-precedence.test.js'), 'utf8'),
    what: 'the VAR/VAR_FILE collision gate exists',
  },
  {
    claim: /credential-import-hygiene\.test\.js/,
    because: () => readFileSync(join(repoRoot, 'tests', 'credential-import-hygiene.test.js'), 'utf8'),
    what: 'the credential-import hygiene gate exists',
  },
  {
    claim: /Header Auth/i,
    because: () => {
      for (const wf of ['01-order-intake', '03-support-triage']) {
        const w = JSON.parse(readFileSync(join(repoRoot, wf, 'workflow.json'), 'utf8'));
        const hook = w.nodes.find((n) => n.type === 'n8n-nodes-base.webhook');
        assert.equal(hook.parameters.authentication, 'headerAuth', `${wf} webhook must use Header Auth`);
        assert.ok(hook.credentials?.httpHeaderAuth, `${wf} webhook must reference an httpHeaderAuth credential`);
      }
    },
    what: 'BOTH webhooks are actually wired to a Header Auth credential',
  },
  {
    claim: /holds\s+\*{0,2}its own\*{0,2}\s+credential/i,
    because: () => {
      const ids = ['01-order-intake', '03-support-triage'].map((wf) => {
        const w = JSON.parse(readFileSync(join(repoRoot, wf, 'workflow.json'), 'utf8'));
        return w.nodes.find((n) => n.type === 'n8n-nodes-base.webhook').credentials.httpHeaderAuth.id;
      });
      assert.notEqual(ids[0], ids[1], 'the two webhooks must reference DIFFERENT credentials');
    },
    what: 'the two webhooks hold distinct credentials, so one can be revoked alone',
  },
  {
    claim: /no recovery path|permanently undecryptable/i,
    because: () => assert.match(envExample, /no recovery path/i, '.env.example must carry the same warning'),
    what: 'the encryption-key consequence is documented where an operator sets it',
  },
];

test('the claim list is not empty — an empty list would verify nothing', () => {
  assert.ok(CLAIMS.length >= 8, `expected the README's claims to be covered, found ${CLAIMS.length}`);
});

for (const { claim, because, what } of CLAIMS) {
  test(`README claim ${claim} is backed by its implementation: ${what}`, () => {
    assert.match(readme, claim, `the README no longer makes this claim — remove its check too, or restore it`);
    because();
  });
}

test('the README does not promise the flag can be turned on', () => {
  // The previous version of this section offered "set N8N_BLOCK_ENV_ACCESS_IN_NODE=true"
  // as a hardened alternative. It cannot be done — Code nodes cannot read
  // credentials — so recommending it would send a reader to break their own
  // authentication.
  assert.ok(
    !/N8N_BLOCK_ENV_ACCESS_IN_NODE=true/.test(readme),
    'the README must not recommend setting the flag true; it breaks HMAC verification',
  );
});
