import type { SolanaRpc } from "../solana/rpc.js";
import type { AgentWalletSigner } from "./agent-wallet-signer.js";
import { RelayerYieldRealizer } from "./relayer-yield-realizer.js";
import {
  StandardX402Payer,
  type StandardX402FetchLike,
  type StandardX402StateStore
} from "./standard-x402-payer.js";

/**
 * Composes the distribution-form standard-x402 payer from a Subly-relayer yield
 * realizer plus an INJECTED x402 payment fetch. This module deliberately does
 * NOT import any concrete x402 client library, so it can be bundled into the
 * published client on any @solana/kit version (the payment lib — PayAI's
 * x402-solana on kit v2, or the official @x402/svm on kit v5 — is supplied by
 * the caller as `x402Fetch`).
 */
export interface RelayerX402PayerConfig {
  facilitatorBaseUrl: string;
  /** Structured-intent signer over the agent keypair (for realize withdrawals). */
  signer: AgentWalletSigner;
  rpc: SolanaRpc;
  /** The x402 client's fetch: given a 402, builds/signs/retries the payment. */
  x402Fetch: StandardX402FetchLike;
  defaultMaxAmountRawUsdc: bigint;
  stateStore?: StandardX402StateStore;
}

export function createRelayerX402Payer(
  config: RelayerX402PayerConfig
): StandardX402Payer {
  const realizer = new RelayerYieldRealizer({
    facilitatorBaseUrl: config.facilitatorBaseUrl,
    signer: config.signer,
    rpc: config.rpc
  });

  return new StandardX402Payer({
    realizer,
    x402Fetch: config.x402Fetch,
    defaultMaxAmountRawUsdc: config.defaultMaxAmountRawUsdc,
    ...(config.stateStore === undefined ? {} : { stateStore: config.stateStore })
  });
}
