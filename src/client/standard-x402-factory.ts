import { createX402Client } from "x402-solana/client";
import type { AgentWalletSigner } from "./agent-wallet-signer.js";
import { createRelayerX402Payer } from "./relayer-payer.js";
import {
  StandardX402Payer,
  type FetchResponseLike,
  type StandardX402StateStore
} from "./standard-x402-payer.js";
import { createX402WalletAdapter } from "./web3-wallet-adapter.js";
import type { SolanaRpc } from "../solana/rpc.js";
import {
  decodeStandardPaymentRequiredHeader,
  parseStandardChallenge,
  standardRequirementMatchesSelected,
  type SelectedSolanaRequirement,
  type StandardExactRequirement,
  type StandardPaymentRequired
} from "../x402/standard-requirements.js";
import {
  encodeX402Header,
  PAYMENT_REQUIRED_HEADER
} from "../x402/headers.js";

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
  stateStore?: StandardX402StateStore;
}

export function createStandardX402Payer(
  config: StandardX402PayerFactoryConfig
): StandardX402Payer {
  const wallet = createX402WalletAdapter(config.agentSecretKey);
  const x402Fetch = (
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string },
    expected: SelectedSolanaRequirement
  ) => {
    const client = createX402Client({
      wallet,
      network: config.network ?? "solana",
      rpcUrl: config.rpcUrl,
      amount: expected.amountRawUsdc,
      customFetch: guardedFetchForExpectedRequirement(expected)
    });
    return client.fetch(url, init as RequestInit) as Promise<FetchResponseLike>;
  };

  return createRelayerX402Payer({
    facilitatorBaseUrl: config.facilitatorBaseUrl,
    signer: config.signer,
    rpc: config.rpc,
    x402Fetch,
    defaultMaxAmountRawUsdc: config.defaultMaxAmountRawUsdc,
    ...(config.stateStore === undefined ? {} : { stateStore: config.stateStore })
  });
}

export function guardedFetchForExpectedRequirement(
  expected: SelectedSolanaRequirement
): typeof fetch {
  return async (input, init) => {
    const response = await fetch(input, init);
    if (response.status !== 402) {
      return response;
    }
    return narrowChallengeToExpectedRequirement(response, expected);
  };
}

async function narrowChallengeToExpectedRequirement(
  response: Response,
  expected: SelectedSolanaRequirement
): Promise<Response> {
  const header = response.headers.get(PAYMENT_REQUIRED_HEADER);
  let paymentRequired: StandardPaymentRequired;
  let matchingRequirement: StandardExactRequirement | null = null;

  if (header !== null) {
    const decoded = decodeStandardPaymentRequiredHeader(header);
    paymentRequired = decoded.paymentRequired;
    matchingRequirement =
      decoded.solanaExactRequirements.find((candidate) =>
        standardRequirementMatchesSelected(candidate, expected)
      ) ?? null;
  } else {
    const parsed = parseStandardChallenge(await response.clone().json());
    paymentRequired = parsed.paymentRequired;
    matchingRequirement =
      parsed.solanaExactRequirements.find((candidate) =>
        standardRequirementMatchesSelected(candidate, expected)
      ) ?? null;
  }

  if (matchingRequirement === null) {
    throw new Error(
      "x402 challenge changed after preflight; refusing to pay an unchecked requirement"
    );
  }

  const narrowed: StandardPaymentRequired = {
    ...paymentRequired,
    accepts: [matchingRequirement]
  };
  const headers = new Headers(response.headers);
  headers.set(PAYMENT_REQUIRED_HEADER, encodeX402Header(narrowed));
  headers.set("content-type", "application/json");

  return new Response(JSON.stringify(narrowed), {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
