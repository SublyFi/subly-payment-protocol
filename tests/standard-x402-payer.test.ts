import { describe, expect, it, vi } from "vitest";
import { SOLANA_MAINNET_NETWORK, SUBLY_VAULT } from "../src/config/constants.js";
import { encodeX402Header, PAYMENT_REQUIRED_HEADER } from "../src/x402/headers.js";
import {
  StandardX402Payer,
  StandardX402PayError,
  type FetchLike,
  type FetchResponseLike,
  type YieldRealizer
} from "../src/client/standard-x402-payer.js";

const URL = "https://api.nansen.ai/api/v1/token-screener";

function challenge(amount = "10000") {
  return {
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        amount,
        payTo: "0x93053f1e7A5eFEDa532Fe69CbbE43cBEc3A0F13f",
        maxTimeoutSeconds: 300,
        extra: { name: "USD Coin", version: "2" }
      },
      {
        scheme: "exact",
        network: SOLANA_MAINNET_NETWORK,
        asset: SUBLY_VAULT.usdcMint,
        amount,
        payTo: "J7ZvJEspvwP1oRxQZ7mYmNmT22NTm3GWq3t7HEbvPZYx",
        maxTimeoutSeconds: 300,
        extra: { feePayer: "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4" }
      }
    ]
  };
}

function resp(params: {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}): FetchResponseLike {
  const headers = params.headers ?? {};
  const bodyText =
    typeof params.body === "string"
      ? params.body
      : JSON.stringify(params.body ?? {});
  return {
    status: params.status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => bodyText,
    json: async () => (params.body === undefined ? {} : params.body)
  };
}

function okRealizer(): YieldRealizer {
  return {
    ensureUsdcAvailable: vi.fn(async () => ({
      realizedRawUsdc: 10_500n,
      txSignature: "realizeSig111"
    }))
  };
}

describe("StandardX402Payer", () => {
  it("probes, realizes yield, then pays via the x402 client", async () => {
    const realizer = okRealizer();
    const probeFetch: FetchLike = async () =>
      resp({
        status: 402,
        headers: { [PAYMENT_REQUIRED_HEADER]: encodeX402Header(challenge()) }
      });
    const x402Fetch = vi.fn<FetchLike>(async () =>
      resp({ status: 200, body: { data: "screener rows" } })
    );

    const payer = new StandardX402Payer({
      realizer,
      x402Fetch,
      probeFetch,
      defaultMaxAmountRawUsdc: 20_000n
    });

    const result = await payer.pay({ url: URL });

    expect(realizer.ensureUsdcAvailable).toHaveBeenCalledWith({
      amountRawUsdc: 10_000n
    });
    expect(x402Fetch).toHaveBeenCalledTimes(1);
    expect(result.paid).toBe(true);
    expect(result.status).toBe(200);
    expect(result.payment?.amountRawUsdc).toBe("10000");
    expect(result.payment?.feePayer).toBe(
      "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4"
    );
    expect(result.payment?.realizeTxSignature).toBe("realizeSig111");
  });

  it("reads the challenge from the JSON body when no header is present", async () => {
    const realizer = okRealizer();
    const probeFetch: FetchLike = async () =>
      resp({ status: 402, body: challenge() });
    const x402Fetch: FetchLike = async () =>
      resp({ status: 200, body: { ok: true } });

    const payer = new StandardX402Payer({
      realizer,
      x402Fetch,
      probeFetch,
      defaultMaxAmountRawUsdc: 20_000n
    });

    const result = await payer.pay({ url: URL });
    expect(result.paid).toBe(true);
  });

  it("refuses without realizing or paying when the price exceeds the cap", async () => {
    const realizer = okRealizer();
    const x402Fetch = vi.fn<FetchLike>(async () => resp({ status: 200 }));
    const probeFetch: FetchLike = async () =>
      resp({
        status: 402,
        headers: {
          [PAYMENT_REQUIRED_HEADER]: encodeX402Header(challenge("50000"))
        }
      });

    const payer = new StandardX402Payer({
      realizer,
      x402Fetch,
      probeFetch,
      defaultMaxAmountRawUsdc: 10_000n
    });

    await expect(payer.pay({ url: URL })).rejects.toMatchObject({
      reason: "amount_exceeds_client_cap"
    });
    expect(realizer.ensureUsdcAvailable).not.toHaveBeenCalled();
    expect(x402Fetch).not.toHaveBeenCalled();
  });

  it("passes through a non-402 response without paying", async () => {
    const realizer = okRealizer();
    const probeFetch: FetchLike = async () =>
      resp({ status: 200, body: "already free" });
    const x402Fetch = vi.fn<FetchLike>(async () => resp({ status: 200 }));

    const payer = new StandardX402Payer({
      realizer,
      x402Fetch,
      probeFetch,
      defaultMaxAmountRawUsdc: 20_000n
    });

    const result = await payer.pay({ url: URL });
    expect(result.paid).toBe(false);
    expect(realizer.ensureUsdcAvailable).not.toHaveBeenCalled();
    expect(x402Fetch).not.toHaveBeenCalled();
  });

  it("raises no_payable_requirement when only EVM rails are offered", async () => {
    const realizer = okRealizer();
    const evmOnly = {
      x402Version: 2,
      accepts: [
        {
          scheme: "exact",
          network: "eip155:8453",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          amount: "10000",
          payTo: "0x93053f1e7A5eFEDa532Fe69CbbE43cBEc3A0F13f"
        }
      ]
    };
    const payer = new StandardX402Payer({
      realizer,
      x402Fetch: async () => resp({ status: 200 }),
      probeFetch: async () =>
        resp({
          status: 402,
          headers: { [PAYMENT_REQUIRED_HEADER]: encodeX402Header(evmOnly) }
        }),
      defaultMaxAmountRawUsdc: 20_000n
    });

    await expect(payer.pay({ url: URL })).rejects.toBeInstanceOf(
      StandardX402PayError
    );
  });
});
