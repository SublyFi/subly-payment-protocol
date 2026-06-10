import { createSolanaRpc, type Rpc, type SolanaRpcApi } from "@solana/kit";

export type SolanaRpc = Rpc<SolanaRpcApi>;

export function createRpcFromEnv(env: NodeJS.ProcessEnv = process.env): SolanaRpc {
  const url = env.SOLANA_RPC_URL;
  if (url === undefined || url.length === 0) {
    throw new Error("SOLANA_RPC_URL must be configured");
  }

  return createSolanaRpc(url);
}
