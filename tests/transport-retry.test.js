// The transport-retry boundary in tests/helpers/stack.mjs.
//
// The harness restarts the n8n main process to make it register a newly
// imported workflow, which leaves this process's connection pool holding
// sockets to a server that no longer exists. A request assigned to one of those
// fails in a couple of milliseconds with no HTTP response at all, and the
// caller's catch turns it into `status: 0` — an arbitrary test failing for a
// reason unrelated to what it asserts.
//
// The retry that closes that hole is only safe because of where its boundary
// sits: it fires when NO HTTP response was received, and never otherwise. This
// file is what makes that a measured property rather than a claim, because the
// consequence of getting it wrong is severe and silent — a retry that fired on a
// response status could turn a rejected request into an accepted one on the
// second attempt and quietly hollow out every authentication assertion in the
// suite.
//
// It runs against a local `node:http` server rather than the stack, so it needs
// no containers and always runs.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { httpRequest, httpNoPool } from './helpers/stack.mjs';

// Start a server whose behaviour per request is decided by `handler`, and count
// what actually arrived on the wire — the only trustworthy witness to whether a
// request was retried.
async function withServer(handler, run) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url });
    handler(req, res, seen.length);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/probe`;
  try {
    return await run(url, seen);
  } finally {
    server.close();
  }
}

// Capture stderr writes from the helper without silencing genuine failures.
async function captureStderr(run) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => { lines.push(args.join(' ')); };
  try {
    return { result: await run(), lines };
  } finally {
    console.error = original;
  }
}

describe('an HTTP response is a successful transport outcome', () => {
  // This is the safety boundary. 401 and 403 are the statuses the two webhook
  // surfaces answer with when authentication fails, and a retry on either would
  // be indistinguishable from weakening the assertion that checks it.
  for (const status of [200, 202, 401, 403, 500]) {
    test(`${status} is returned unchanged and the request is sent exactly once`, async () => {
      await withServer(
        (req, res) => { res.writeHead(status); res.end(`status ${status}`); },
        async (url, seen) => {
          const res = await httpRequest(url, { method: 'POST', body: '{}' });
          assert.equal(res.status, status, 'the caller must see the status the server sent');
          assert.equal(res.text, `status ${status}`, 'the body must arrive unchanged');
          assert.equal(
            seen.length, 1,
            `a ${status} response must never be retried — the server saw ${seen.length} request(s)`,
          );
        },
      );
    });
  }
});

describe('a transport failure with no response is retried', () => {
  test('a socket destroyed before any response is retried and then succeeds', async () => {
    await withServer(
      (req, res, n) => {
        if (n === 1) { req.socket.destroy(); return; }   // no response at all
        res.writeHead(200); res.end('recovered');
      },
      async (url, seen) => {
        const { result, lines } = await captureStderr(() => httpRequest(url, { method: 'POST', body: '{}' }));
        assert.equal(result.status, 200);
        assert.equal(result.text, 'recovered');
        assert.ok(seen.length >= 2, `the request must have been retried; server saw ${seen.length}`);
        // §2.6 — a retry nobody can see is a broken instrument.
        assert.ok(
          lines.some((l) => l.includes('[transport-retry]')),
          `every retry must announce itself on stderr; captured:\n${lines.join('\n')}`,
        );
      },
    );
  });

  test('retries are bounded at two, and the original error survives', async () => {
    await withServer(
      (req) => { req.socket.destroy(); },              // never responds
      async (url, seen) => {
        const { lines } = await captureStderr(async () => {
          await assert.rejects(
            () => httpRequest(url, { method: 'POST', body: '{}' }),
            (err) => {
              // The real cause must reach the caller, not a synthesised one.
              const codes = [];
              for (let cur = err; cur; cur = cur.cause) if (cur.code) codes.push(cur.code);
              assert.ok(
                codes.some((c) => ['ECONNRESET', 'UND_ERR_SOCKET', 'EPIPE'].includes(c)),
                `the original transport cause must survive; saw codes: ${codes.join(', ') || '(none)'}`,
              );
              return true;
            },
          );
        });
        assert.equal(seen.length, 3, `one attempt plus two retries; server saw ${seen.length}`);
        assert.ok(
          lines.some((l) => l.includes('exhausted')),
          `exhaustion must be reported, not swallowed; captured:\n${lines.join('\n')}`,
        );
      },
    );
  });
});

test('a failure that is not a transport failure is not retried at all', async () => {
  // Nothing is listening on this port, so the connection is refused. A refused
  // connection means the stack is down, and the suite must fail fast and loudly
  // rather than retry its way into a slower, more confusing failure.
  //
  // The port is claimed and released rather than hard-coded: a fixed low port
  // risks colliding with the fetch specification's blocked-port list, which
  // fails for an entirely different reason and would make this test pass or fail
  // for the wrong one.
  const closed = createServer();
  await new Promise((r) => closed.listen(0, '127.0.0.1', r));
  const port = closed.address().port;
  await new Promise((r) => closed.close(r));

  const dead = `http://127.0.0.1:${port}/probe`;
  const started = Date.now();
  await assert.rejects(
    () => httpRequest(dead, { method: 'POST', body: '{}' }),
    (err) => {
      const codes = [];
      for (let cur = err; cur; cur = cur.cause) if (cur.code) codes.push(cur.code);
      assert.ok(
        codes.includes('ECONNREFUSED'),
        `expected a refused connection to surface as ECONNREFUSED; saw: ${codes.join(', ') || '(none)'}`,
      );
      return true;
    },
  );
  assert.ok(Date.now() - started < 2000, 'a refused connection must fail fast, with no retry backoff');
});

test('the non-pooling path opens a fresh connection every time', async () => {
  // The property the retry depends on: a retry that could re-draw a socket from
  // the poisoned pool would fix nothing. Two sequential requests over this path
  // must arrive on two different sockets.
  await withServer(
    (req, res) => { res.writeHead(200); res.end(req.socket.remotePort.toString()); },
    async (url) => {
      const a = await httpNoPool(url, { method: 'POST', body: '{}' });
      const b = await httpNoPool(url, { method: 'POST', body: '{}' });
      assert.equal(a.status, 200);
      assert.equal(b.status, 200);
      assert.notEqual(
        a.text, b.text,
        'both requests arrived on the same client socket, so the connection was reused',
      );
    },
  );
});
