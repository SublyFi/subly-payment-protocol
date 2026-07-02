import { createKeyPairSignerFromBytes } from "@solana/kit";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import type { SelectPaymentRequirements } from "@x402/fetch";
import { ExactSvmScheme, toClientSvmSigner } from "@x402/svm";
import type {
  FetchResponseLike,
  StandardX402FetchLike
} from "../../../src/client/standard-x402-payer.js";
import {
  standardRequirementMatchesSelected,
  type SelectedSolanaRequirement
} from "../../../src/x402/standard-requirements.js";

/**
 * Builds the x402 payment `fetch` for the published client using the OFFICIAL
 * x402 Foundation Solana implementation (@x402/svm + @x402/fetch, kit v5). It
 * derives the agent's SVM signer from the raw 64-byte secret, registers the
 * Exact SVM scheme only for the preflight-approved CAIP-2 network, and returns
 * a fetch that transparently pays the matching 402 challenge.
 *
 * This replaces PayAI's x402-solana, whose transaction builder rejected
 * off-curve (PDA) seller payTo addresses; @x402/svm derives the destination ATA
 * with @solana-program/token, which handles off-curve owners correctly.
 */
export async function createSvmX402Fetch(params: {
  agentSecretKey: Uint8Array;
  rpcUrl: string;
}): Promise<StandardX402FetchLike> {
  const signer = toClientSvmSigner(
    await createKeyPairSignerFromBytes(params.agentSecretKey)
  );

  return (url, init, expected) => {
    const wrapped = wrapFetchWithPaymentFromConfig(fetch, {
      schemes: [
        {
          network: expected.requirement.network as `${string}:${string}`,
          client: new ExactSvmScheme(signer, { rpcUrl: params.rpcUrl })
        }
      ],
      paymentRequirementsSelector: (_x402Version, requirements) =>
        selectExpectedRequirement(requirements, expected)
    });

    return wrapped(url, init as RequestInit) as unknown as Promise<FetchResponseLike>;
  };
}

function selectExpectedRequirement(
  requirements: unknown[],
  expected: SelectedSolanaRequirement
): ReturnType<SelectPaymentRequirements> {
  const match = requirements.find((candidate) =>
    standardRequirementMatchesSelected(candidate, expected)
  );
  if (match === undefined) {
    throw new Error(
      "x402 challenge changed after preflight; refusing to pay an unchecked requirement"
    );
  }
  return match as ReturnType<SelectPaymentRequirements>;
}
