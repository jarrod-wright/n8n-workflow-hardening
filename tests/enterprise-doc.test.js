// The high-availability architecture document.
//
// The risk this file guards against is not a missing document — it is an
// OVER-CLAIMING one. A queue-mode stack with a main and a worker looks
// redundant, and calling it "highly available" is the single easiest false claim
// to make in this subject area. The stack shipped here is single-main: losing
// main stops webhook ingress and scheduled triggers however many workers are
// healthy. The document must say that, and these assertions are what keep it
// saying it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { denylistHits } from './helpers/denylist.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOC = join(repoRoot, 'deployment', 'docs', 'enterprise-ha-architecture.md');

test('the high-availability architecture document exists', () => {
  assert.ok(existsSync(DOC), 'deployment/docs/enterprise-ha-architecture.md must exist');
});

const doc = existsSync(DOC) ? readFileSync(DOC, 'utf8') : '';

test('the licence boundary is explicit', () => {
  assert.match(doc, /Enterprise/, 'the document must name the Enterprise tier');
  assert.match(doc, /licensed/, 'the document must state that the architecture is licensed');
  assert.match(
    doc, /Self-hosted Enterprise plans/,
    "the licence claim must quote n8n's own feature-availability wording rather than paraphrase it",
  );
});

test('the architecture is grounded in official sources, not recollection', () => {
  const citesModule = /n8n-io\/terraform-aws-n8n/.test(doc);
  const citesScalingDocs = /docs\.n8n\.io\/deploy\/host-n8n\/configure-n8n\/scaling/.test(doc);
  assert.ok(
    citesModule || citesScalingDocs,
    'the document must reference the official Terraform module or the official scaling documentation',
  );
});

test('the multi-main mechanism is described, not gestured at', () => {
  // A description that omits any of these is not an architecture, it is a
  // diagram. Sticky sessions in particular are the most commonly skipped
  // requirement, and skipping them produces failures that look like flakiness.
  for (const [label, re] of [
    ['multiple main processes', /more than one .?main|multiple .{0,3}main/i],
    ['load balancer', /load balancer/i],
    ['sticky sessions', /sticky session/i],
    ['leader election', /leader/i],
    ['shared Postgres', /shared Postgres|Postgres.{0,20}shared/i],
    ['shared Redis', /shared Redis|Redis.{0,20}shared/i],
  ]) {
    assert.match(doc, re, `the multi-main description must cover ${label}`);
  }
  assert.match(
    doc, /N8N_MULTI_MAIN_SETUP_ENABLED/,
    'the variable that actually turns the feature on must be named',
  );
});

test('the shipped stack is NOT claimed to be multi-main or highly available', () => {
  assert.match(
    doc, /single-main/,
    'the document must state plainly that the stack shipped here is single-main',
  );
  assert.match(
    doc, /not multi-main/i,
    'the document must deny the multi-main claim explicitly, not merely omit it',
  );
  assert.match(
    doc, /single point of failure/i,
    'the consequence of a single main must be stated, not left for the reader to infer',
  );

  // The over-claim this guards against, in the forms it would actually take.
  for (const overclaim of [
    /this (?:stack|repository|repo) is highly available/i,
    /(?:ships|provides|delivers) (?:a )?high(?:ly)?[- ]availab/i,
    /multi-main (?:stack|setup) (?:is )?(?:included|shipped) here/i,
  ]) {
    assert.doesNotMatch(doc, overclaim, `the document must not claim the shipped stack is HA (${overclaim})`);
  }
});

test('metrics are correctly identified as ungated and log streaming as Enterprise', () => {
  // Getting this backwards is the easy mistake, and it changes what a reader
  // can actually reproduce: metrics are why this exhibit can demonstrate
  // observability at all.
  assert.match(doc, /Log Streaming is available on all Enterprise plans/,
    "log streaming's Enterprise gating must be quoted from the official wording");
  assert.match(doc, /Prometheus metrics[\s\S]{0,120}?Not gated/i,
    'Prometheus metrics must be identified as NOT Enterprise-gated');
});

test('the cross-link names each plane project and attributes host hardening correctly', () => {
  // This assertion previously required only that `n8n-hardened-reference`
  // appeared somewhere, and its own message called that project "the host/VPS
  // hardening project". Both were true of a WRONG document: the project
  // disclaims the host and OS plane in its own README, and this document sent
  // readers there for exactly that. A presence check cannot distinguish a
  // correct attribution from an inverted one, so the gate mandated the defect
  // it was meant to prevent.
  assert.match(
    doc, /n8n-hardened-reference/,
    'the document must cross-link the container-plane project it composes with',
  );
  assert.match(
    doc, /vps-hardening-reference/,
    'host and OS hardening must be attributed to the host-plane project by name, not left implicit or misattributed',
  );
  assert.match(doc, /host/i, 'the cross-link must say which plane each project covers');
});

test('the document carries no internal vocabulary', () => {
  const hits = denylistHits(doc);
  assert.deepEqual(hits, [], `enterprise-ha-architecture.md carries internal vocabulary:\n  ${hits.join('\n  ')}`);
});
