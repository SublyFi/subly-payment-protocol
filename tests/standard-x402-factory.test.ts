import { afterEach, describe, expect, it, vi } from "vitest";
import { guardedFetchForExpectedRequirement } from "../src/client/standard-x402-factory.js";
import { SOLANA_MAINNET_NETWORK, SUBLY_VAULT } from "../src/config/constants.js";
import {
  decodeStandardPaymentRequiredHeader,
  parseStandardChallenge,
  selectPayableSolanaRequirement
} from "../src/x402/standard-requirements.js";
import { encodeX402Header, PAYMENT_REQUIRED_HEADER } from "../src/x402/headers.js";

const URL = "https://api.nansen.ai/api/v1/token-screener";

function challenge(params?: { amount?: string; payTo?: string }) {
  return {
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        amount: params?.amount ?? "10000",
        payTo: "0x93053f1e7A5eFEDa532Fe69CbbE43cBEc3A0F13f",
        maxTimeoutSeconds: 300
      },
      {
        scheme: "exact",
        network: SOLANA_MAINNET_NETWORK,
        asset: SUBLY_VAULT.usdcMint,
        amount: params?.amount ?? "10000",
        payTo: params?.payTo ?? "J7ZvJEspvwP1oRxQZ7mYmNmT22NTm3GWq3t7HEbvPZYx",
        maxTimeoutSeconds: 300,
        extra: { feePayer: "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4" }
      }
    ]
  };
}

function selectedFrom(challengeBody: unknown) {
  return selectPayableSolanaRequirement(
    parseStandardChallenge(challengeBody).solanaExactRequirements
  );
}

function paymentRequiredResponse(challengeBody: unknown): Response {
  return new Response(JSON.stringify(challengeBody), {
    status: 402,
    headers: {
      [PAYMENT_REQUIRED_HEADER]: encodeX402Header(challengeBody),
      "content-type": "application/json"
    }
  });
}

describe("guardedFetchForExpectedRequirement", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("narrows a matching challenge to only the preflight-approved requirement", async () => {
    const expected = selectedFrom(challenge());
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => paymentRequiredResponse(challenge()))
    );

    const response = await guardedFetchForExpectedRequirement(expected)(URL);
    const body = (await response.json()) as { accepts: unknown[] };
    const decoded = decodeStandardPaymentRequiredHeader(
      response.headers.get(PAYMENT_REQUIRED_HEADER) ?? ""
    );

    expect(response.status).toBe(402);
    expect(body.accepts).toHaveLength(1);
    expect(decoded.solanaExactRequirements).toHaveLength(1);
    expect(decoded.solanaExactRequirements[0]?.amount).toBe("10000");
  });

  it("rejects when the later challenge changes amount or recipient", async () => {
    const expected = selectedFrom(challenge());
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        paymentRequiredResponse(
          challenge({
            amount: "50000",
            payTo: "DifferentPayTo111111111111111111111111111111"
          })
        )
      )
    );

    await expect(
      guardedFetchForExpectedRequirement(expected)(URL)
    ).rejects.toThrow(/challenge changed/);
  });
});
