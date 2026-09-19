import { agentWalletSignerFromEnv } from "../../../src/client/signer-env.js";
import { VaultFlowClient } from "../../../src/client/vault-flows.js";
import { createRpc } from "../../../src/solana/rpc.js";
import { PAY_COMMAND } from "../../../demo/cli-command.js";

const [command, ...args] = process.argv.slice(2);
const flags: Record<string, string> = {
  "--approval-threshold": "approvalThresholdRawUsdc",
  "--per-payment-cap": "perPaymentCapRawUsdc",
  "--daily-api-cap": "dailyApiSpendCapRawUsdc",
  "--monthly-api-cap": "monthlyApiSpendCapRawUsdc",
  "--daily-deposit-cap": "dailyDepositCapRawUsdc",
  "--allowed-payees": "allowedPayToAddresses",
  "--deposit-policy": "depositPolicy",
  "--withdrawal-policy": "withdrawalPolicy"
};
const policy: Record<string, string | string[] | null> = {};
let mandateTtlDays: number | undefined;
let sessionId: string | undefined;

if (command === "owner-link") {
  const values = args.flatMap(arg => {
    const equal = arg.startsWith("--") ? arg.indexOf("=") : -1;
    return equal > 0 ? [arg.slice(0, equal), arg.slice(equal + 1)] : [arg];
  });
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index]!;
    const value = values[index + 1];
    if (value === undefined) throw new Error(`Missing value for ${flag}`);
    if (flag === "--ttl-days") {
      mandateTtlDays = Number(value);
      if (!Number.isSafeInteger(mandateTtlDays) || mandateTtlDays < 1 || mandateTtlDays > 3650) {
        throw new Error("--ttl-days must be an integer between 1 and 3650");
      }
    } else if (Object.hasOwn(flags, flag)) {
      if (flag === "--allowed-payees") {
        const addresses = value.split(",").map(address => address.trim());
        if (value !== "any" && !addresses.every(address => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address))) {
          throw new Error("--allowed-payees must be comma-separated Solana addresses or any");
        }
        policy[flags[flag]!] = value === "any" ? null : addresses;
        continue;
      }
      if (value === "none" && ["--approval-threshold", "--daily-api-cap", "--monthly-api-cap", "--daily-deposit-cap"].includes(flag)) {
        policy[flags[flag]!] = null;
        continue;
      }
      if (flag.endsWith("-policy")) {
        if (!["agent_allowed", "owner_approval_required"].includes(value)) {
          throw new Error(`${flag} must be agent_allowed or owner_approval_required`);
        }
      } else if (!(flag === "--approval-threshold" ? /^(0|[1-9]\d*)$/ : /^[1-9]\d*$/).test(value)) {
        throw new Error(`${flag} must be a positive raw USDC integer`);
      }
      policy[flags[flag]!] = value;
    } else throw new Error(`Unrecognized owner-link flag: ${flag}`);
  }
} else if (command === "owner-status") {
  if (args.length !== 1) throw new Error(`Usage: ${PAY_COMMAND} owner-status <st_sessionId>`);
  sessionId = args[0];
  if (!/^st_[0-9a-f]{32}$/.test(sessionId!)) throw new Error("Provide the original st_ session ID (32 lowercase hexadecimal characters)");
} else if (command === "recovery-start" || command === "recovery-status") {
  if (args.length !== 0) throw new Error(`${command} accepts no arguments; it uses the configured wallet and vault`);
} else throw new Error("Unknown owner command");

const { signer } = await agentWalletSignerFromEnv();
const client = new VaultFlowClient({ signer,
  relayerBaseUrl: process.env.SUBLY_RELAYER_URL ?? process.env.SUBLY_FACILITATOR_URL ?? "https://api.demo.sublyfi.com",
  rpc: createRpc(process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com") });

let result;
if (command === "owner-link") {
  const created = await client.createOwnerSession({
      ...(Object.keys(policy).length ? { policy } : {}),
      ...(mandateTtlDays === undefined ? {} : { mandateTtlDays }) });
  result = { ...created,
    instructions: "Open ownerUrl on the original relayer domain and approve with the current owner credential. " +
      "Review the proposed policy, reactivate your revoked mandate, revoke access, or cancel recovery. " +
      `The link expires in 10 minutes. Then run ${PAY_COMMAND} owner-status ${created.sessionId}.` };
} else if (command === "owner-status") {
  result = await client.getOwnerSession(sessionId!);
} else if (command === "recovery-start") {
  result = await client.startOwnerRecovery();
} else {
  result = await client.getOwnerStatus();
}
console.log(JSON.stringify(result, null, 2));
