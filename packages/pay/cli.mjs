#!/usr/bin/env node
// Single dispatcher bin for @subly_fi/pay so `npx -y @subly_fi/pay <subcommand>`
// resolves cleanly. Subcommands map to the bundled entry points; argv is
// reshaped so each entry sees its own positional args at the usual index.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TARGETS = {
  mcp: "mcp-server.js",
  fetch: "pay.js",
  deposit: "deposit.js",
  withdraw: "withdraw.js",
  "setup-link": "setup-link.js",
  "setup-status": "setup-status.js"
};

const [sub, ...rest] = process.argv.slice(2);
const target = sub === undefined ? undefined : TARGETS[sub];
if (target === undefined) {
  console.error(
    "usage: pay <mcp|fetch <url>|deposit <amountRawUsdc>|withdraw <amountRawUsdc>|setup-link|setup-status <sessionId|setupUrl>>"
  );
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
process.argv = [process.argv[0], join(here, target), ...rest];
await import(`./${target}`);
