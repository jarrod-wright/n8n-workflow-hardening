// R13 — Resumable state kept in workflow static data.
//
// `$getWorkflowStaticData()` looks like the obvious place to keep a sync cursor,
// a last-seen id, or a de-duplication set. It is the wrong place for anything
// you would be upset to lose:
//
//   * it does not survive a re-import, so deploying the workflow silently resets
//     it — and a reset cursor means either re-processing everything or, worse,
//     skipping everything before "now";
//   * nothing else can read it. No watchdog, no operator, no query. When the
//     sync is stuck, the one number that would explain why is invisible;
//   * it is written at the end of a successful execution, so a run that dies
//     part-way leaves it holding a value that does not describe what actually
//     happened.
//
// A cursor is state your recovery depends on. Put it in the database, where it
// can be read, audited, and corrected by hand at 3am.
const STATIC_DATA = /\$getWorkflowStaticData\s*\(/;
const STATE_HINT = /cursor|watermark|lastSeen|last_seen|lastRun|last_run|offset|checkpoint|since|processed/i;

export default {
  id: 'R13',
  title: 'Resumable state kept in workflow static data',
  severity: 'error',
  check(workflow) {
    const out = [];
    for (const node of workflow.nodes) {
      const js = (node.parameters && node.parameters.jsCode) || '';
      if (!STATIC_DATA.test(js)) continue;

      // Static data is not always misuse — a cache of something cheap to
      // recompute is fine. It is resumable state that must not live there, so
      // the finding needs evidence that this is what it is being used for.
      if (!STATE_HINT.test(js)) continue;

      out.push({
        message:
          `"${node.name}" keeps resumable state in workflow static data — it does not survive a ` +
          're-import, nothing else can read it, and a run that dies part-way leaves it wrong. ' +
          'Store a cursor in the database.',
        node: node.name,
      });
    }
    return out;
  },
};
