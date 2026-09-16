import { agentWalletSignerFromEnv } from "../../../src/client/signer-env.js";
import { VaultFlowClient } from "../../../src/client/vault-flows.js";
import { createRpc } from "../../../src/solana/rpc.js";
const { signer } = await agentWalletSignerFromEnv();
const client = new VaultFlowClient({
  relayerBaseUrl: process.env.SUBLY_RELAYER_URL ?? process.env.SUBLY_FACILITATOR_URL ?? "https://api.demo.sublyfi.com",
  signer, rpc: createRpc(process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com")
});
console.log(JSON.stringify(await client.getBudget(), null, 2));
