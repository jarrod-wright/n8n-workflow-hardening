// Rule registry. Each rule is imported and added here; the engine runs whatever
// this array contains. The catalogue of what each rule catches, and the
// production incident behind it, is in docs/anti-patterns.md.
import r1 from './r1-missing-error-workflow.js';
import r2 from './r2-unpinned-typeversion.js';
import r3 from './r3-webhook-no-response.js';
import r4 from './r4-side-effect-no-retry.js';
import r5 from './r5-sql-injection.js';
import r6 from './r6-hardcoded-secret.js';
import r7 from './r7-error-swallowed.js';
import r8 from './r8-http-no-timeout.js';
import r9 from './r9-schedule-no-timezone.js';
import r10 from './r10-llm-output-unvalidated.js';
import r11 from './r11-autofixing-output-parser.js';
import r12 from './r12-single-provider-ai.js';
import r13 from './r13-state-in-static-data.js';

export const rules = [r1, r2, r3, r4, r5, r6, r7, r8, r9, r10, r11, r12, r13];

export function ruleById(id) {
  return rules.find((r) => r.id === id) || null;
}
