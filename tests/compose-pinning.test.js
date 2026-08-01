// Version-pinning gate. Renders `docker compose config` and asserts every
// image is pinned to an explicit tag AND a sha256 digest — no `latest`, no
// untagged reference. Does not require the stack to be running.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compose } from './helpers/stack.mjs';

function renderedImages() {
  const r = compose(['config']);
  assert.equal(r.code, 0, `docker compose config failed: ${r.stderr}`);
  return r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('image:'))
    .map((l) => l.replace(/^image:\s*/, '').replace(/^["']|["']$/g, ''));
}

test('every service image carries an explicit tag and a sha256 digest', () => {
  const images = renderedImages();
  assert.ok(images.length >= 4, `expected at least 4 images, found ${images.length}`);
  for (const img of images) {
    assert.doesNotMatch(img, /:latest(@|$)/, `image must not use :latest -> ${img}`);
    assert.match(
      img,
      /^[^\s]+:[^@\s]+@sha256:[0-9a-f]{64}$/,
      `image must be pinned as name:tag@sha256:<digest> -> ${img}`,
    );
  }
});
