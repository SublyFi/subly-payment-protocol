/**
 * Creates the one-time owner-onboarding setup link for this agent wallet's
 * Subly spending mandate. Paste the printed setupUrl into the chat verbatim:
 * the human opens it on their phone and confirms once with Face ID (passkey)
 * or a Solana wallet signature — that single confirmation activates the
 * mandate AND pre-approves the initial deposit. Values are confirm-only:
 * to change them, create a new link.
 *
 * Usage:
 *   pay setup-link [--initial-deposit <rawUsdc>] [--approval-threshold <rawUsdc>]
 *                  [--per-payment-cap <rawUsdc>] [--daily-api-cap <rawUsdc>]
 *                  [--daily-deposit-cap <rawUsdc>] [--ttl-days <days>]
 * Env:
 *   SUBLY_DEMO_AGENT_KEYPAIR or SUBLY_DEMO_AGENT_KEYPAIR_PATH   (required)
 *   SUBLY_RELAYER_URL   Subly relayer API; default https://api.demo.sublyfi.com
 */
import { LocalKeypairAgentWalletSigner } from "../../../src/client/agent-wallet-signer.js";
import { VaultFlowClient, VaultFlowClientError } from "../../../src/client/vault-flows.js";
import { loadKeyPairSigner } from "../../../src/solana/keys.js";
import { createRpc } from "../../../src/solana/rpc.js";

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const USAGE =
  "Usage: pay setup-link [--initial-deposit <rawUsdc>] " +
  "[--approval-threshold <rawUsdc>] [--per-payment-cap <rawUsdc>] " +
  "[--daily-api-cap <rawUsdc>] [--daily-deposit-cap <rawUsdc>] [--ttl-days <days>]";

const FLAG_TO_POLICY_KEY: Record<string, string> = {
  "--approval-threshold": "approvalThresholdRawUsdc",
  "--per-payment-cap": "perPaymentCapRawUsdc",
  "--daily-api-cap": "dailyApiSpendCapRawUsdc",
  "--daily-deposit-cap": "dailyDepositCapRawUsdc"
};

const policy: Record<string, string> = {};
let initialDepositRawUsdc: string | undefined;
let mandateTtlDays: number | undefined;

// Accepts both `--flag value` and `--flag=value`.
const args: string[] = [];
for (const raw of process.argv.slice(2)) {
  const eq = raw.startsWith("--") ? raw.indexOf("=") : -1;
  if (eq > 0) {
    args.push(raw.slice(0, eq), raw.slice(eq + 1));
  } else {
    args.push(raw);
  }
}
for (let i = 0; i < args.length; i += 2) {
  const flag = args[i]!;
  const value = args[i + 1];
  if (value === undefined) {
    fail(`missing value for ${flag}\n${USAGE}`);
  }
  if (flag === "--initial-deposit") {
    if (!/^[1-9]\d*$/.test(value)) {
      fail(`--initial-deposit must be a positive raw USDC integer\n${USAGE}`);
    }
    initialDepositRawUsdc = value;
  } else if (flag === "--ttl-days") {
    const days = Number(value);
    if (!Number.isInteger(days) || days <= 0) {
      fail(`--ttl-days must be a positive integer\n${USAGE}`);
    }
    mandateTtlDays = days;
  } else if (FLAG_TO_POLICY_KEY[flag] !== undefined) {
    if (!/^[1-9]\d*$/.test(value)) {
      fail(`${flag} must be a positive raw USDC integer\n${USAGE}`);
    }
    policy[FLAG_TO_POLICY_KEY[flag]!] = value;
  } else {
    fail(`unrecognized flag: ${flag}\n${USAGE}`);
  }
}

const relayerBaseUrl =
  process.env.SUBLY_RELAYER_URL ??
  process.env.SUBLY_FACILITATOR_URL ??
  "https://api.demo.sublyfi.com";

const keyPairSigner = await loadKeyPairSigner({
  base58Secret: process.env.SUBLY_DEMO_AGENT_KEYPAIR,
  jsonFilePath: process.env.SUBLY_DEMO_AGENT_KEYPAIR_PATH,
  label: "SUBLY_DEMO_AGENT_KEYPAIR"
});
const signer = new LocalKeypairAgentWalletSigner(keyPairSigner);
const vaultFlows = new VaultFlowClient({
  relayerBaseUrl,
  signer,
  rpc: createRpc(
    process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com"
  )
});

console.error(`[setup-link] agent ${signer.walletAddress} -> ${relayerBaseUrl}`);
try {
  const created = await vaultFlows.createSetupSession({
    ...(Object.keys(policy).length === 0 ? {} : { policy }),
    ...(mandateTtlDays === undefined ? {} : { mandateTtlDays }),
    ...(initialDepositRawUsdc === undefined ? {} : { initialDepositRawUsdc })
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        ...created,
        instructions:
          "Paste setupUrl to the user verbatim (expires in 10 minutes, " +
          "single-use). After they confirm on their device, check with: " +
          `pay setup-status ${created.sessionId} — when completed, run the ` +
          "first deposit; its approval is picked up automatically."
      },
      null,
      2
    )}\n`
  );
} catch (error) {
  if (error instanceof VaultFlowClientError) {
    fail(`[setup-link] failed: ${error.message}`);
  }
  throw error;
}
