# Security Policy

This repository is a reference implementation for hardening n8n workflows and
the stack they run on. It ships no hosted service, but it does ship
configuration, a Docker Compose stack, and a static linter that other people may
copy into production. A defect in any of those is worth reporting.

## Supported versions

| Version | Supported |
|---|---|
| `main` | Yes — fixes land here |
| tagged releases | Latest tag only |

The stack pins the n8n image and every node `typeVersion` it depends on
(`typeversions.json`). A report against an unpinned or substantially older
version is still welcome, but the fix will target the pinned version.

## Reporting a vulnerability

**Do not open a public issue for a security defect.** Public issues are visible
to everyone the moment they are filed, including before a fix exists.

Report privately by either route:

1. **GitHub private vulnerability reporting** — the *Security* tab of this
   repository, *Report a vulnerability*. This is preferred: it keeps the report,
   the discussion, and the advisory in one place.
2. **Email** — `SECURITY_CONTACT_PLACEHOLDER@example.invalid`

> Replace `SECURITY_CONTACT_PLACEHOLDER@example.invalid` with a real, monitored
> address before publishing a fork of this repository. It is a deliberate
> placeholder: this reference repository does not publish a contact address, and
> a security policy that names an unmonitored mailbox is worse than one that
> names none.

### What to include

- the affected path (workflow, compose service, linter rule, or tooling script);
- the version, tag, or commit you tested against;
- a reproduction — the smallest request, workflow, or fixture that shows it;
- the impact you believe it has, and any mitigation you already know of.

**Never include a real secret in a report.** Redact tokens, keys, and signatures.
If a credential has leaked, rotate it first and say that it was rotated.

### What to expect

| Stage | Target |
|---|---|
| Acknowledgement | 5 working days |
| Initial assessment | 10 working days |
| Fix or documented mitigation | 90 days, sooner where the severity warrants |

These are targets for a reference repository maintained outside of a support
contract, not a contractual SLA.

## Disclosure

Coordinated disclosure. A reporter who follows this policy will be credited in
the advisory unless they ask not to be. Please give the fix a chance to ship
before publishing details.

## Scope

**In scope**

- authentication and signature verification in the shipped workflows;
- secret handling — anything that widens what a Code node can read through
  `$env`, or that places a secret value in a committed file;
- the Compose stack's exposure surface, defaults, and container hardening;
- linter rules that pass a workflow they should flag (a false negative is a
  security defect in a security tool).

**Out of scope**

- vulnerabilities in n8n itself — report those to
  [n8n's own security process](https://github.com/n8n-io/n8n/security);
- the mock upstream API and mock model provider under `deployment/`. These are
  deliberately unauthenticated test doubles bound to the internal Compose
  network, and are not intended to run anywhere else;
- findings that require an attacker to already hold the deployment's secrets;
- automated scanner output with no demonstrated impact.

## Hardening notes for operators

If you deploy from this repository, the following are your responsibility, not
this repository's:

- generate fresh values for every variable in `.env.example` — the placeholders
  are not credentials and must never reach an environment;
- keep `N8N_ENCRYPTION_KEY` stable and backed up; losing it makes every stored
  credential permanently undecryptable;
- terminate TLS in front of n8n and restrict who can reach the webhook surfaces;
- keep the broker's password set and the broker unpublished to the host, as the
  shipped Compose stack does.
