import { agentWalletSignerFromEnv } from "../../../src/client/signer-env.js";
import { VaultFlowClient, vaultOperationKind } from "../../../src/client/vault-flows.js";
import { createRpc } from "../../../src/solana/rpc.js";

const [intentId, ...extra] = process.argv.slice(2);
if (intentId === undefined || extra.length !== 0) {
  throw new Error("Usage: pay status <dep_...|wdr_...> (the original intent ID)");
}
vaultOperationKind(intentId);
const { signer } = await agentWalletSignerFromEnv();
const client = new VaultFlowClient({
  relayerBaseUrl: process.env.SUBLY_RELAYER_URL ?? process.env.SUBLY_FACILITATOR_URL ?? "https://api.demo.sublyfi.com",
  signer,
  rpc: createRpc(process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com")
});
// Only wallet-auth message signing is needed; this call never signs a transaction.
console.log(JSON.stringify(await client.getOperationStatus(intentId), null, 2));
