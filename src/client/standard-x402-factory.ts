import { createX402Client } from "x402-solana/client";
import type { AgentWalletSigner } from "./agent-wallet-signer.js";
import { createRelayerX402Payer } from "./relayer-payer.js";
import {
  StandardX402Payer,
  type FetchLike,
  type FetchResponseLike
} from "./standard-x402-payer.js";
import { createX402WalletAdapter } from "./web3-wallet-adapter.js";
import type { SolanaRpc } from "../solana/rpc.js";

/**
 * Assembles the distribution-form standard-x402 payer: a Subly-relayer-backed
 * yield realizer (sponsor stays on the server) plus the PayAI x402-solana
 * client that builds/signs the actual USDC transfer. This is the single wiring
 * point shared by the CLI and the MCP server.
 */
export interface StandardX402PayerFactoryConfig {
  facilitatorBaseUrl: string;
  /** Structured-intent signer over the agent keypair (for realize withdrawals). */
  signer: AgentWalletSigner;
  /** Raw 64-byte agent secret key (for the x402 transfer signature). */
  agentSecretKey: Uint8Array;
  rpc: SolanaRpc;
  rpcUrl: string;
  defaultMaxAmountRawUsdc: bigint;
  network?: "solana" | "solana-devnet";
  /**
   * Demo/experience mode: realize the full price from vault yield on every
   * payment instead of reusing leftover ATA balance. See RelayerYieldRealizer.
   */
  forceRealizeFullAmount?: boolean;
}

export function createStandardX402Payer(
  config: StandardX402PayerFactoryConfig
): StandardX402Payer {
  const client = createX402Client({
    wallet: createX402WalletAdapter(config.agentSecretKey),
    network: config.network ?? "solana",
    rpcUrl: config.rpcUrl
  });

  const x402Fetch: FetchLike = (url, init) =>
    client.fetch(url, init) as Promise<FetchResponseLike>;

  return createRelayerX402Payer({
    facilitatorBaseUrl: config.facilitatorBaseUrl,
    signer: config.signer,
    rpc: config.rpc,
    x402Fetch,
    defaultMaxAmountRawUsdc: config.defaultMaxAmountRawUsdc,
    ...(config.forceRealizeFullAmount === undefined
      ? {}
      : { forceRealizeFullAmount: config.forceRealizeFullAmount })
  });
}
