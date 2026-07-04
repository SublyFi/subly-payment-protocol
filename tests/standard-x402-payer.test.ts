import { describe, expect, it, vi } from "vitest";
import { SOLANA_MAINNET_NETWORK, SUBLY_VAULT } from "../src/config/constants.js";
import { encodeX402Header, PAYMENT_REQUIRED_HEADER } from "../src/x402/headers.js";
import { EMPTY_BODY_HASH } from "../src/lib/hash.js";
import { sha256HexOf } from "../src/lib/canonical-json.js";
import {
  StandardX402Payer,
  StandardX402PayError,
  type FetchLike,
  type FetchResponseLike,
  type StandardX402FetchLike,
  type StandardX402PendingPaymentRecord,
  type StandardX402StateStore,
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

function memoryStore(
  initial: StandardX402PendingPaymentRecord[] = []
): StandardX402StateStore & { records: StandardX402PendingPaymentRecord[] } {
  return {
    records: initial,
    load() {
      return this.records;
    },
    save(records) {
      this.records = records;
    }
  };
}

describe("StandardX402Payer", () => {
  it("maps a mandate approval_required refusal to a structured retry step", async () => {
    const realizer: YieldRealizer = {
      ensureUsdcAvailable: vi.fn(async (input: { approvalId?: string }) => {
        if (input.approvalId === "apr_ok") {
          return {
            realizedRawUsdc: 10_500n,
            txSignature: "realizeSig111",
            withdrawalId: "wdr_1"
          };
        }
        throw Object.assign(new Error("approval required"), {
          code: "approval_required",
          detail: {
            approvalId: "apr_ok",
            approveUrl: "https://app.subly.fi/approve/apr_ok",
            expiresAtMs: 123
          }
        });
      })
    };
    const probeFetch: FetchLike = async () =>
      resp({
        status: 402,
        headers: {
          [PAYMENT_REQUIRED_HEADER.toLowerCase()]: encodeX402Header(challenge())
        }
      });
    const x402Fetch: StandardX402FetchLike = async () =>
      resp({ status: 200, body: "paid" });
    const payer = new StandardX402Payer({
      realizer,
      x402Fetch,
      probeFetch,
      defaultMaxAmountRawUsdc: 1_000_000n
    });

    // First attempt: refused BEFORE anything moved, with the approve link.
    const refusal = await payer.pay({ url: URL }).catch((error) => error);
    expect(refusal).toBeInstanceOf(StandardX402PayError);
    expect((refusal as StandardX402PayError).reason).toBe("approval_required");
    expect((refusal as StandardX402PayError).detail).toMatchObject({
      approvalId: "apr_ok",
      approveUrl: "https://app.subly.fi/approve/apr_ok"
    });

    // Retry with the approvalId goes through.
    const result = await payer.pay({ url: URL, approvalId: "apr_ok" });
    expect(result.paid).toBe(true);
    expect(realizer.ensureUsdcAvailable).toHaveBeenLastCalledWith(
      expect.objectContaining({ approvalId: "apr_ok" })
    );
  });

  it("reports the settled payment tx back to the realizer (best-effort)", async () => {
    const reportPayment = vi.fn(async () => undefined);
    const realizer: YieldRealizer = {
      ensureUsdcAvailable: vi.fn(async () => ({
        realizedRawUsdc: 10_500n,
        txSignature: "realizeSig111",
        withdrawalId: "wdr_report"
      })),
      reportPayment
    };
    const probeFetch: FetchLike = async () =>
      resp({
        status: 402,
        headers: {
          [PAYMENT_REQUIRED_HEADER.toLowerCase()]: encodeX402Header(challenge())
        }
      });
    const settleHeader = Buffer.from(
      JSON.stringify({ success: true, transaction: "payTx555" }),
      "utf8"
    ).toString("base64");
    const x402Fetch: StandardX402FetchLike = async () =>
      resp({
        status: 200,
        body: "paid",
        headers: { "x-payment-response": settleHeader }
      });
    const payer = new StandardX402Payer({
      realizer,
      x402Fetch,
      probeFetch,
      defaultMaxAmountRawUsdc: 1_000_000n
    });

    const result = await payer.pay({ url: URL });
    expect(result.payment?.paymentTxSignature).toBe("payTx555");
    expect(reportPayment).toHaveBeenCalledWith({
      withdrawalId: "wdr_report",
      paymentTxSignature: "payTx555"
    });
  });

  it("a failing report-back never fails the delivered payment", async () => {
    const realizer: YieldRealizer = {
      ensureUsdcAvailable: vi.fn(async () => ({
        realizedRawUsdc: 10_500n,
        txSignature: "realizeSig111",
        withdrawalId: "wdr_report"
      })),
      reportPayment: vi.fn(async () => {
        throw new Error("relayer offline");
      })
    };
    const probeFetch: FetchLike = async () =>
      resp({
        status: 402,
        headers: {
          [PAYMENT_REQUIRED_HEADER.toLowerCase()]: encodeX402Header(challenge())
        }
      });
    const settleHeader = Buffer.from(
      JSON.stringify({ success: true, transaction: "payTx556" }),
      "utf8"
    ).toString("base64");
    const x402Fetch: StandardX402FetchLike = async () =>
      resp({
        status: 200,
        body: "paid",
        headers: { "x-payment-response": settleHeader }
      });
    const payer = new StandardX402Payer({
      realizer,
      x402Fetch,
      probeFetch,
      defaultMaxAmountRawUsdc: 1_000_000n
    });

    const result = await payer.pay({ url: URL });
    expect(result.paid).toBe(true);
    expect(result.payment?.paymentTxSignature).toBe("payTx556");
  });

  it("probes, realizes yield, then pays via the x402 client", async () => {
    const realizer = okRealizer();
    const probeFetch: FetchLike = async () =>
      resp({
        status: 402,
        headers: { [PAYMENT_REQUIRED_HEADER]: encodeX402Header(challenge()) }
      });
    const x402Fetch = vi.fn<StandardX402FetchLike>(
      async (_url, _init, expected) => {
        expect(expected.payTo).toBe("J7ZvJEspvwP1oRxQZ7mYmNmT22NTm3GWq3t7HEbvPZYx");
        expect(expected.amountRawUsdc).toBe(10_000n);
        return resp({ status: 200, body: { data: "screener rows" } });
      }
    );

    const payer = new StandardX402Payer({
      realizer,
      x402Fetch,
      probeFetch,
      defaultMaxAmountRawUsdc: 20_000n
    });

    const result = await payer.pay({ url: URL });

    // The payer declares the payment binding to the realizer so the relayer's
    // spending-mandate layer can enforce caps against "what is being paid".
    expect(realizer.ensureUsdcAvailable).toHaveBeenCalledWith({
      amountRawUsdc: 10_000n,
      payment: {
        payTo: "J7ZvJEspvwP1oRxQZ7mYmNmT22NTm3GWq3t7HEbvPZYx",
        amountRawUsdc: "10000",
        resourceUrlHash: sha256HexOf(URL),
        method: "GET"
      }
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
    const x402Fetch: StandardX402FetchLike = async () =>
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
    const x402Fetch = vi.fn<StandardX402FetchLike>(async () =>
      resp({ status: 200 })
    );
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

  it("refuses without realizing when the Solana requirement has no feePayer", async () => {
    const realizer = okRealizer();
    const x402Fetch = vi.fn<StandardX402FetchLike>(async () =>
      resp({ status: 200 })
    );
    const missingFeePayer = challenge();
    (missingFeePayer.accepts[1] as { extra?: unknown }).extra = {};
    const payer = new StandardX402Payer({
      realizer,
      x402Fetch,
      probeFetch: async () =>
        resp({
          status: 402,
          headers: {
            [PAYMENT_REQUIRED_HEADER]: encodeX402Header(missingFeePayer)
          }
        }),
      defaultMaxAmountRawUsdc: 20_000n
    });

    await expect(payer.pay({ url: URL })).rejects.toMatchObject({
      reason: "no_payable_requirement"
    });
    expect(realizer.ensureUsdcAvailable).not.toHaveBeenCalled();
    expect(x402Fetch).not.toHaveBeenCalled();
  });

  it("passes through a non-402 response without paying", async () => {
    const realizer = okRealizer();
    const probeFetch: FetchLike = async () =>
      resp({ status: 200, body: "already free" });
    const x402Fetch = vi.fn<StandardX402FetchLike>(async () =>
      resp({ status: 200 })
    );

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

  it("coalesces concurrent identical standard x402 purchases", async () => {
    let releaseProbe: () => void = () => {
      throw new Error("probe promise was not created");
    };
    const probeFetch = vi.fn<FetchLike>(
      () =>
        new Promise((resolve) => {
          releaseProbe = () =>
            resolve(
              resp({
                status: 402,
                headers: {
                  [PAYMENT_REQUIRED_HEADER]: encodeX402Header(challenge())
                }
              })
            );
        })
    );
    const realizer = okRealizer();
    const x402Fetch = vi.fn<StandardX402FetchLike>(async () =>
      resp({ status: 200, body: "ok" })
    );
    const payer = new StandardX402Payer({
      realizer,
      x402Fetch,
      probeFetch,
      defaultMaxAmountRawUsdc: 20_000n
    });

    const first = payer.pay({ url: URL });
    const second = payer.pay({ url: URL });
    expect(probeFetch).toHaveBeenCalledTimes(1);
    releaseProbe();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toBe(secondResult);
    expect(realizer.ensureUsdcAvailable).toHaveBeenCalledTimes(1);
    expect(x402Fetch).toHaveBeenCalledTimes(1);
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

  it("records unknown outcome after yield realization and blocks blind retry", async () => {
    const store = memoryStore();
    const payer = new StandardX402Payer({
      realizer: okRealizer(),
      x402Fetch: async () => resp({ status: 500, body: "lost delivery" }),
      probeFetch: async () =>
        resp({
          status: 402,
          headers: { [PAYMENT_REQUIRED_HEADER]: encodeX402Header(challenge()) }
        }),
      defaultMaxAmountRawUsdc: 20_000n,
      stateStore: store,
      nowMs: () => 1_000
    });

    await expect(payer.pay({ url: URL })).rejects.toMatchObject({
      reason: "payment_outcome_unknown"
    });
    expect(store.records).toHaveLength(1);
    expect(store.records[0]?.status).toBe("external_outcome_unknown");

    const restarted = new StandardX402Payer({
      realizer: okRealizer(),
      x402Fetch: async () => resp({ status: 200 }),
      probeFetch: async () =>
        resp({
          status: 402,
          headers: { [PAYMENT_REQUIRED_HEADER]: encodeX402Header(challenge()) }
        }),
      defaultMaxAmountRawUsdc: 20_000n,
      stateStore: store
    });

    await expect(restarted.pay({ url: URL })).rejects.toMatchObject({
      reason: "payment_outcome_unknown"
    });
  });

  it("refuses to call x402 when the pending marker cannot be persisted", async () => {
    const x402Fetch = vi.fn<StandardX402FetchLike>(async () =>
      resp({ status: 200, body: "ok" })
    );
    const store: StandardX402StateStore = {
      load: () => [],
      save: () => {
        throw new Error("disk full");
      }
    };
    const payer = new StandardX402Payer({
      realizer: okRealizer(),
      x402Fetch,
      probeFetch: async () =>
        resp({
          status: 402,
          headers: { [PAYMENT_REQUIRED_HEADER]: encodeX402Header(challenge()) }
        }),
      defaultMaxAmountRawUsdc: 20_000n,
      stateStore: store
    });

    await expect(payer.pay({ url: URL })).rejects.toMatchObject({
      reason: "state_persist_failed"
    });
    expect(x402Fetch).not.toHaveBeenCalled();
  });

  it("allows an explicit forceNewPayment retry after unknown outcome", async () => {
    const store = memoryStore([
      {
        key: `GET:${URL}:${EMPTY_BODY_HASH}`,
        url: URL,
        method: "GET",
        requestBodyHash: EMPTY_BODY_HASH,
        amountRawUsdc: "10000",
        payTo: "payTo",
        feePayer: null,
        realizedRawUsdc: "10000",
        realizeTxSignature: "sig",
        status: "external_outcome_unknown",
        createdAtMs: 1,
        updatedAtMs: 1
      }
    ]);
    const payer = new StandardX402Payer({
      realizer: okRealizer(),
      x402Fetch: async () => resp({ status: 200, body: "ok" }),
      probeFetch: async () =>
        resp({
          status: 402,
          headers: { [PAYMENT_REQUIRED_HEADER]: encodeX402Header(challenge()) }
        }),
      defaultMaxAmountRawUsdc: 20_000n,
      stateStore: store
    });

    const result = await payer.pay({ url: URL, forceNewPayment: true });
    expect(result.paid).toBe(true);
    expect(store.records).toEqual([]);
  });
});
