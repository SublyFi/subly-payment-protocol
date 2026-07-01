import { describe, expect, it } from "vitest";
import { SOLANA_MAINNET_NETWORK, SUBLY_VAULT } from "../src/config/constants.js";
import { encodeX402Header } from "../src/x402/headers.js";
import {
  decodeStandardPaymentRequiredHeader,
  parseStandardChallenge,
  selectPayableSolanaRequirement,
  StandardX402ChallengeError
} from "../src/x402/standard-requirements.js";

/** A trimmed copy of the live Nansen token-screener 402 body (2026-07-01). */
function nansenChallenge() {
  return {
    x402Version: 2,
    error: "Payment required",
    resource: {
      url: "https://api.nansen.ai/api/v1/token-screener",
      description: "Retrieve token screener data"
    },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        amount: "10000",
        payTo: "0x93053f1e7A5eFEDa532Fe69CbbE43cBEc3A0F13f",
        maxTimeoutSeconds: 300,
        extra: { name: "USD Coin", version: "2" }
      },
      {
        scheme: "exact",
        network: "eip155:56",
        asset: "0x55d398326f99059fF775485246999027B3197955",
        amount: "10000000000000000",
        payTo: "0x93053f1e7A5eFEDa532Fe69CbbE43cBEc3A0F13f",
        maxTimeoutSeconds: 300,
        extra: {
          name: "Tether USD",
          version: "1",
          assetTransferMethod: "permit2-exact"
        }
      },
      {
        scheme: "exact",
        network: SOLANA_MAINNET_NETWORK,
        asset: SUBLY_VAULT.usdcMint,
        amount: "10000",
        payTo: "J7ZvJEspvwP1oRxQZ7mYmNmT22NTm3GWq3t7HEbvPZYx",
        maxTimeoutSeconds: 300,
        extra: { feePayer: "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4" }
      }
    ]
  };
}

describe("parseStandardChallenge", () => {
  it("extracts only the Solana exact requirements", () => {
    const { solanaExactRequirements } = parseStandardChallenge(
      nansenChallenge()
    );
    expect(solanaExactRequirements).toHaveLength(1);
    expect(solanaExactRequirements[0]?.network).toBe(SOLANA_MAINNET_NETWORK);
    expect(solanaExactRequirements[0]?.asset).toBe(SUBLY_VAULT.usdcMint);
  });

  it("rejects a non-x402 object", () => {
    expect(() => parseStandardChallenge({ foo: "bar" })).toThrow(
      StandardX402ChallengeError
    );
  });

  it("ignores malformed accepts entries without throwing", () => {
    const { solanaExactRequirements } = parseStandardChallenge({
      x402Version: 2,
      accepts: [
        { scheme: "exact", network: "solana:x" }, // missing asset/amount/payTo
        {
          scheme: "exact",
          network: SOLANA_MAINNET_NETWORK,
          asset: SUBLY_VAULT.usdcMint,
          amount: "10000",
          payTo: "J7ZvJEspvwP1oRxQZ7mYmNmT22NTm3GWq3t7HEbvPZYx"
        }
      ]
    });
    expect(solanaExactRequirements).toHaveLength(1);
  });
});

describe("selectPayableSolanaRequirement", () => {
  it("selects the mainnet USDC requirement and its feePayer", () => {
    const { solanaExactRequirements } = parseStandardChallenge(
      nansenChallenge()
    );
    const selected = selectPayableSolanaRequirement(solanaExactRequirements);
    expect(selected.amountRawUsdc).toBe(10_000n);
    expect(selected.payTo).toBe("J7ZvJEspvwP1oRxQZ7mYmNmT22NTm3GWq3t7HEbvPZYx");
    expect(selected.feePayer).toBe("2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4");
  });

  it("throws when no Solana USDC requirement is present", () => {
    expect(() => selectPayableSolanaRequirement([])).toThrow(
      StandardX402ChallengeError
    );
  });

  it("throws when the asset is a different mint", () => {
    const { solanaExactRequirements } = parseStandardChallenge({
      x402Version: 2,
      accepts: [
        {
          scheme: "exact",
          network: SOLANA_MAINNET_NETWORK,
          asset: "So11111111111111111111111111111111111111112",
          amount: "10000",
          payTo: "J7ZvJEspvwP1oRxQZ7mYmNmT22NTm3GWq3t7HEbvPZYx"
        }
      ]
    });
    expect(() =>
      selectPayableSolanaRequirement(solanaExactRequirements)
    ).toThrow(StandardX402ChallengeError);
  });
});

describe("decodeStandardPaymentRequiredHeader", () => {
  it("decodes a base64 payment-required header", () => {
    const header = encodeX402Header(nansenChallenge());
    const { solanaExactRequirements } =
      decodeStandardPaymentRequiredHeader(header);
    expect(solanaExactRequirements).toHaveLength(1);
    expect(
      selectPayableSolanaRequirement(solanaExactRequirements).amountRawUsdc
    ).toBe(10_000n);
  });
});
