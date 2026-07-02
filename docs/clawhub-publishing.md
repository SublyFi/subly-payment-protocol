# Publishing the subly-pay skill to ClawHub (operator)

ClawHub is the OpenClaw skill registry (the "npm publish" of OpenClaw). After
publishing, participants install with `openclaw skills install subly-pay` and
get updates via `openclaw skills update`. The skill itself is just `SKILL.md`;
at runtime it shells out to `npx -y @subly_fi/pay fetch <url>`, so it needs no
repo and carries no secrets.

## One-time

```bash
npm i -g clawhub
clawhub login            # browser; uses your GitHub account
clawhub whoami           # confirm
```

Caveat: ClawHub requires the publishing GitHub account to be at least one week
old. A brand-new account is rejected.

## Each release

```bash
# from the repo root:
clawhub skill publish ./skills/subly-pay \
  --slug subly-pay \
  --name "Subly pay" \
  --version 0.1.1 \
  --changelog "Initial release: pay x402 resources from Kamino vault yield."

# server-side security scan results (the skill runs npx + network, which the
# scan will report — expected for a payment skill):
clawhub scan download subly-pay --version 0.1.1
```

Bump `--version` (semver) on every change, in lockstep with the SKILL.md
`version` field and any change to the underlying `@subly_fi/pay` package.

## After publishing

Participants (no clone):

```bash
openclaw skills install subly-pay        # or --global for ~/.openclaw/skills
export SUBLY_DEMO_AGENT_KEYPAIR_PATH=~/.subly/agent.json
# then ask the OpenClaw agent to fetch a paid Subly URL
```
