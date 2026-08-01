// R9 — Scheduled workflow with no explicit timezone.
//
// A Schedule Trigger runs against whatever timezone the n8n instance happens to
// be configured with. Nothing in the workflow records which one that was, so
// "02:15 nightly" silently means a different instant after a deploy to a
// differently configured host, a container image change, or a move between
// regions — and a nightly job that shifts by hours will overlap the window it
// was carefully scheduled to avoid.
//
// Pinning an IANA zone in the workflow makes the schedule a property of the
// workflow rather than of the machine it happens to be running on.
const IANA = /^[A-Za-z]+(?:_[A-Za-z]+)*\/[A-Za-z0-9+_-]+(?:\/[A-Za-z0-9+_-]+)*$/;

export default {
  id: 'R9',
  title: 'Scheduled workflow with no explicit timezone',
  severity: 'warning',
  check(workflow) {
    const triggers = workflow.nodesOfType('n8n-nodes-base.scheduleTrigger');
    if (triggers.length === 0) return [];

    const tz = workflow.settings && workflow.settings.timezone;
    if (typeof tz === 'string' && IANA.test(tz)) return [];

    const detail = tz
      ? `settings.timezone is ${JSON.stringify(tz)}, which is not an IANA zone name`
      : 'settings.timezone is not set, so the schedule follows whatever the host is configured to';

    return triggers.map((n) => ({
      message: `"${n.name}" is a scheduled trigger but ${detail} — the same schedule will mean a different instant on a differently configured instance`,
      node: n.name,
    }));
  },
};
