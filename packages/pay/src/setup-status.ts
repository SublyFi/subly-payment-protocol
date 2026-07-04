/**
 * Checks whether the human completed a Subly setup link. The session view is
 * a public capability read — no wallet key needed. Prints the session JSON:
 * status pending | completed | expired; on completed it includes the
 * mandateHash and (when an initial deposit was bundled) its pre-approved
 * approvalId, valid ~15 minutes — deposit promptly.
 *
 * Usage:
 *   pay setup-status <st_sessionId | setupUrl>
 * Env:
 *   SUBLY_RELAYER_URL   Subly relayer API; default https://api.demo.sublyfi.com
 */
function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const arg = process.argv[2];
if (arg === undefined) {
  fail("Usage: pay setup-status <st_sessionId | setupUrl>");
}
// Accept the full setupUrl too — agents often have only the pasted link.
const match = arg.match(/st_[0-9a-f]+/i);
if (match === null) {
  fail(`no session id (st_...) found in: ${arg}`);
}
const sessionId = match[0];

const relayerBaseUrl =
  process.env.SUBLY_RELAYER_URL ??
  process.env.SUBLY_FACILITATOR_URL ??
  "https://api.demo.sublyfi.com";

const response = await fetch(
  `${relayerBaseUrl}/v1/setup-sessions/${encodeURIComponent(sessionId)}`
);
const text = await response.text();
if (response.status !== 200) {
  process.stdout.write(`${text}\n`);
  process.exit(1);
}
process.stdout.write(`${text}\n`);
