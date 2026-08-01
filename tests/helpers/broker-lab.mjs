// Isolated-broker test lab.
//
// These helpers stand up a THROWAWAY valkey instance under its own compose
// project name, so a test can exercise a specific bring-up path (e.g. the
// documented command with no --env-file, or a deliberately mis-configured
// broker) without touching — or being masked by — the shared persistent stack.
//
// Every lab uses `expose:` only, exactly like the real stack, so nothing is
// published to the host; the broker is reached from an ephemeral sibling
// container on the lab's own network. Always tear a lab down with `labDown`.
import { docker, composeFile, sleep } from './stack.mjs';

// Build a `docker compose` argument vector bound to an isolated project.
// `envFile: false` (the default) OMITS --env-file entirely — this is what makes
// a lab able to reproduce the documented, interpolation-dependent bring-up.
// `overrideFiles` are merged after the base compose file (compose deep-merges
// them), letting a lab tweak just the valkey service for a specific scenario.
function baseArgs(project, { envFile = false, overrideFiles = [] } = {}) {
  const args = ['compose', '-p', project, '-f', composeFile];
  for (const f of overrideFiles) args.push('-f', f);
  if (envFile) args.push('--env-file', envFile);
  return args;
}

// Run a compose subcommand against a lab project. `extraEnv` is injected into
// the docker CLI's own process environment (compose reads it for `${...}`
// interpolation AND it is inherited by `run` containers).
export function labCompose(project, subArgs, { envFile = false, overrideFiles = [], extraEnv = {}, timeout } = {}) {
  return docker([...baseArgs(project, { envFile, overrideFiles }), ...subArgs], { env: extraEnv, timeout });
}

// Bring the valkey service up (detached) via the given path. Returns the raw
// result so a caller can assert on a start-time FAILURE (fail-closed brokers).
export function labUpValkey(project, opts = {}) {
  return labCompose(project, ['up', '-d', 'valkey'], opts);
}

// `docker compose ps -a` parsed to one record per container (includes stopped
// containers, so a fail-closed broker that exited is observable).
export function labPsAll(project, service = 'valkey', opts = {}) {
  const r = labCompose(
    project,
    ['ps', '-a', '--format', '{{.Service}}|{{.State}}|{{.ExitCode}}|{{.Health}}'],
    opts,
  );
  const rows = r.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((l) => {
      const [svc, state, exit, health] = l.split('|');
      return { service: svc, state, exit: Number(exit), health: health || '' };
    });
  return { code: r.code, raw: r.stdout + r.stderr, row: rows.find((x) => x.service === service) || null };
}

// `docker compose ps` for one service, parsed to its health/state string.
export function labPs(project, service = 'valkey', opts = {}) {
  const r = labCompose(project, ['ps', '--format', '{{.Service}} {{.State}} {{.Health}}'], opts);
  const line = r.stdout.split('\n').map((s) => s.trim()).find((l) => l.startsWith(service + ' '));
  return { code: r.code, raw: r.stdout + r.stderr, line: line || '' };
}

// Combined logs for a lab service.
export function labLogs(project, service = 'valkey', opts = {}) {
  const r = labCompose(project, ['logs', service], opts);
  return r.stdout + '\n' + r.stderr;
}

// PING the lab broker from an ephemeral sibling container on the lab network.
// Pass password via `auth` to send `-a <auth>`; omit it for an UNauthenticated
// ping. Returns { code, out } with stdout+stderr combined.
export function labPing(project, { auth = null, opts = {} } = {}) {
  const cli = ['-h', 'valkey'];
  if (auth !== null) cli.push('-a', auth, '--no-auth-warning');
  cli.push('ping');
  const r = labCompose(
    project,
    ['run', '--rm', '--no-deps', '--entrypoint', 'valkey-cli', 'valkey', ...cli],
    opts,
  );
  return { code: r.code, out: `${r.stdout}\n${r.stderr}` };
}

// Tear a lab down completely (containers + network + volumes). Best-effort.
export function labDown(project, opts = {}) {
  return labCompose(project, ['down', '-v', '--remove-orphans', '--timeout', '5'], opts);
}

export { sleep };
