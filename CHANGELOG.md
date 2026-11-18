# Changelog

## 2026-11-17 - CI proves the suite, including the live stack

- New: GitHub Actions CI. Every push runs the offline suite, an aggregate lint that fails on any ERROR finding, and the live queue-mode stack (n8n main + worker, Valkey broker, PostgreSQL, the two mocks, Prometheus and Grafana) with the failure-injection suites against it.
- The Docker-dependent tests (broker path, rendered-compose gates) moved out of `test:offline` into a new `test:stack`, so the offline suite runs on a clean checkout with no Docker installed, and the stack tests run where the stack is up.
- New: `npm run lint:all` - lints every workflow the repository ships and exits non-zero on any ERROR finding.
- The deployment service table now lists every service the stack actually runs (it was missing the mock model provider, Prometheus and Grafana).
