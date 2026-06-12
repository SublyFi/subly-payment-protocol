import bs58 from "bs58";
import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";
import { PAYMENT_SCHEME, SUBLY_VAULT } from "../src/config/constants.js";
import type { AgentWalletSigner } from "../src/client/agent-wallet-signer.js";
import { computeRequestBindingHash } from "../src/domain/request-binding.js";
import { deriveAssociatedTokenAddress } from "../src/lib/associated-token-account.js";
import { EMPTY_BODY_HASH } from "../src/lib/hash.js";
import { SublyX402Client } from "../src/x402/client.js";
import {
  decodePaymentRequiredHeader,
  decodePaymentSignatureHeader,
  encodeX402Header,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  requestBodyHashFor
} from "../src/x402/headers.js";
import { SublySellerGate } from "../src/x402/seller.js";

const SELLER = bs58.encode(
  nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3)).publicKey
);
const WALLET = bs58.encode(
  nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(4)).publicKey
);
const SELLER_USDC_ATA = deriveAssociatedTokenAddress({
  owner: SELLER,
  mint: SUBLY_VAULT.usdcMint
});
const RESOURCE = "https://api.example.com/v1/data";

function pricedRequest() {
  return {
    sellerRequestId: "seller_req_x402",
    httpMethod: "GET",
    resource: RESOURCE,
    amountRawUsdc: "500000"
  };
}

function bindingHashForPricedRequest() {
  return computeRequestBindingHash({
    sellerRequestId: "seller_req_x402",
    httpMethod: "GET",
    canonicalResourceUrl: RESOURCE,
    requestBodyHash: EMPTY_BODY_HASH,
    seller: SELLER,
    asset: SUBLY_VAULT.usdcMint,
    amountRawUsdc: "500000",
    payTo: SELLER,
    sellerUsdcAta: SELLER_USDC_ATA
  });
}

function signaturePayload(overrides?: Record<string, string>) {
  return {
    x402Version: 2,
    scheme: PAYMENT_SCHEME,
    network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    payload: {
      paymentId: "pay_x402_test",
      requestBindingHash: bindingHashForPricedRequest(),
      preparedMessageHash: "sha256-prepared",
      serializedTransaction: "dHg=",
      agentSignature: "sig",
      temporarySettlementSignature: "tempsig",
      ...overrides
    }
  };
}

function successfulSettlementResponse(overrides?: Record<string, unknown>) {
  return {
    success: true,
    transaction: "sig",
    network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    asset: SUBLY_VAULT.usdcMint,
    amount: "500000",
    extensions: {
      subly: {
        paymentId: "pay_x402_test",
        sellerRequestId: "seller_req_x402",
        requestBindingHash: bindingHashForPricedRequest(),
        payTo: SELLER,
        sellerUsdcAta: SELLER_USDC_ATA,
        sellerTransferRawUsdc: "500000",
        ...(overrides?.subly as Record<string, unknown> | undefined)
      }
    },
    ...overrides
  };
}

describe("x402 headers", () => {
  it("round-trips PaymentRequired headers", () => {
    const gate = new SublySellerGate({
      facilitatorBaseUrl: "https://facilitator.test",
      sellerApiToken: "seller-token",
      payTo: SELLER
    });
    const challenge = gate.paymentRequiredResponse(pricedRequest());

    expect(challenge.statusCode).toBe(402);
    const decoded = decodePaymentRequiredHeader(
      challenge.headers[PAYMENT_REQUIRED_HEADER]!
    );
    expect(decoded.sublyRequirements).toHaveLength(1);
    const requirement = decoded.sublyRequirements[0]!;
    expect(requirement.scheme).toBe(PAYMENT_SCHEME);
    expect(requirement.amountRawUsdc).toBe("500000");
    expect(requirement.extra.sellerUsdcAta).toBe(SELLER_USDC_ATA);
    expect(requirement.extra.vault).toBe(SUBLY_VAULT.address);
  });

  it("rejects non-canonical amounts at challenge issuance", () => {
    const gate = new SublySellerGate({
      facilitatorBaseUrl: "https://facilitator.test",
      sellerApiToken: "seller-token",
      payTo: SELLER
    });
    for (const amountRawUsdc of ["0", "0100", "0.01", "-5", ""]) {
      expect(() =>
        gate.paymentRequiredResponse({ ...pricedRequest(), amountRawUsdc })
      ).toThrowError(/amountRawUsdc/);
      expect(() =>
        gate.bindingHashFor({ ...pricedRequest(), amountRawUsdc })
      ).toThrowError(/amountRawUsdc/);
    }
  });

  it("rejects oversized and malformed headers", () => {
    expect(() => encodeX402Header({ big: "x".repeat(20_000) })).toThrowError(
      /exceeds/
    );
    expect(() => decodePaymentSignatureHeader("!!!not-base64-json!!!")).toThrow();
  });

  it("hashes request bodies canonically", () => {
    expect(requestBodyHashFor(null)).toBe(EMPTY_BODY_HASH);
    expect(requestBodyHashFor("")).toBe(EMPTY_BODY_HASH);
    expect(requestBodyHashFor("{\"a\":1}")).toMatch(/^sha256-[a-f0-9]{64}$/);
  });
});

describe("SublySellerGate.settle", () => {
  function gateWithFacilitator(responses: {
    verify: unknown;
    settle: unknown;
  }) {
    const calls: string[] = [];
    const gate = new SublySellerGate({
      facilitatorBaseUrl: "https://facilitator.test",
      sellerApiToken: "seller-token",
      payTo: SELLER,
      fetchImpl: async (url) => {
        calls.push(url);
        const body = url.endsWith("/verify") ? responses.verify : responses.settle;
        return { status: 200, json: async () => body };
      }
    });
    return { gate, calls };
  }

  it("grants access only after a successful facilitator settle", async () => {
    const settlement = successfulSettlementResponse();
    const { gate, calls } = gateWithFacilitator({
      verify: { isValid: true, paymentId: "pay_x402_test" },
      settle: settlement
    });

    const result = await gate.settle({
      paymentSignatureHeader: encodeX402Header(signaturePayload()),
      request: pricedRequest()
    });

    expect(result.granted).toBe(true);
    expect(calls).toEqual([
      "https://facilitator.test/v1/x402/verify",
      "https://facilitator.test/v1/x402/settle"
    ]);
    if (result.granted) {
      expect(result.paymentId).toBe("pay_x402_test");
      expect(result.responseHeaders["payment-response"]).toBe(
        encodeX402Header(settlement)
      );
    }
  });

  it("denies instead of throwing when the settle-time priced request is non-canonical", async () => {
    const gate = new SublySellerGate({
      facilitatorBaseUrl: "https://facilitator.test",
      sellerApiToken: "seller-token",
      payTo: SELLER,
      fetchImpl: async () => {
        throw new Error("facilitator must not be called");
      }
    });

    await expect(
      gate.settle({
        paymentSignatureHeader: encodeX402Header(signaturePayload()),
        request: { ...pricedRequest(), amountRawUsdc: "0100" }
      })
    ).resolves.toEqual({
      granted: false,
      reason: "invalid_priced_request"
    });
  });

  it("rejects a payload bound to different request facts before calling the facilitator", async () => {
    const { gate, calls } = gateWithFacilitator({
      verify: { isValid: true },
      settle: { success: true }
    });

    const result = await gate.settle({
      paymentSignatureHeader: encodeX402Header(
        signaturePayload({ requestBindingHash: "sha256-other" })
      ),
      request: pricedRequest()
    });

    expect(result).toMatchObject({
      granted: false,
      reason: "request_binding_mismatch"
    });
    expect(calls).toHaveLength(0);
  });

  it("denies access when settlement fails", async () => {
    const { gate } = gateWithFacilitator({
      verify: { isValid: true },
      settle: {
        success: false,
        error: { code: "budget_illiquid", message: "no instant liquidity" }
      }
    });

    const result = await gate.settle({
      paymentSignatureHeader: encodeX402Header(signaturePayload()),
      request: pricedRequest()
    });

    expect(result).toMatchObject({ granted: false, reason: "budget_illiquid" });
  });

  it("denies access when the settlement receipt does not match the priced request", async () => {
    const { gate } = gateWithFacilitator({
      verify: { isValid: true },
      settle: successfulSettlementResponse({ amount: "1" })
    });

    const result = await gate.settle({
      paymentSignatureHeader: encodeX402Header(signaturePayload()),
      request: pricedRequest()
    });

    expect(result).toMatchObject({ granted: false, reason: "amount_mismatch" });
  });
});

describe("SublyX402Client", () => {
  function fakeSigner(): AgentWalletSigner & { signedIntents: unknown[] } {
    const signedIntents: unknown[] = [];
    return {
      walletAddress: WALLET,
      validationMode: "structured_intent_transaction",
      signedIntents,
      async signPayment(params) {
        signedIntents.push(params.intent);
        return {
          serializedTransaction: params.serializedTransaction,
          agentSignature: "agent-signature"
        };
      },
      async signDeposit() {
        throw new Error("not used");
      },
      async signWithdrawal() {
        throw new Error("not used");
      },
      async signApiMessage() {
        return "fake-api-signature";
      }
    };
  }

  function sellerChallengeHeader() {
    const gate = new SublySellerGate({
      facilitatorBaseUrl: "https://facilitator.test",
      sellerApiToken: "seller-token",
      payTo: SELLER
    });
    return gate.paymentRequiredResponse(pricedRequest()).headers[
      PAYMENT_REQUIRED_HEADER
    ]!;
  }

  function prepareResponse() {
    return {
      paymentId: "pay_from_prepare",
      requestBindingHash: bindingHashForPricedRequest(),
      preparedMessageHash: "sha256-prepared",
      temporarySettlementSignature: "temp-signature",
      intentJson: {
        serializedTransaction: "c2VyaWFsaXplZA==",
        signingIntent: { paymentId: "pay_from_prepare", wallet: WALLET }
      }
    };
  }

  it("prepares, signs, and builds the PAYMENT-SIGNATURE header", async () => {
    const signer = fakeSigner();
    const requests: Array<{ url: string; body: unknown }> = [];
    const client = new SublyX402Client({
      facilitatorBaseUrl: "https://facilitator.test",
      signer,
      fetchImpl: async (url, init) => {
        requests.push({ url, body: JSON.parse(init?.body ?? "{}") });
        return {
          status: 200,
          headers: { get: () => null },
          json: async () => prepareResponse()
        };
      }
    });

    const { headerValue, paymentId } = await client.buildPaymentSignatureHeader({
      paymentRequiredHeader: sellerChallengeHeader(),
      httpMethod: "GET",
      url: RESOURCE
    });

    expect(paymentId).toBe("pay_from_prepare");
    const prepareBody = requests[0]!.body as Record<string, unknown>;
    expect(requests[0]!.url).toBe(
      "https://facilitator.test/v1/payments/prepare"
    );
    expect(prepareBody.wallet).toBe(WALLET);
    expect(prepareBody.sellerRequestId).toBe("seller_req_x402");
    expect(prepareBody.requestBodyHash).toBe(EMPTY_BODY_HASH);
    expect(prepareBody.dustRecipientUsdcAta).toBe(
      deriveAssociatedTokenAddress({ owner: WALLET, mint: SUBLY_VAULT.usdcMint })
    );
    expect(signer.signedIntents).toHaveLength(1);

    const payload = decodePaymentSignatureHeader(headerValue);
    expect(payload.payload.paymentId).toBe("pay_from_prepare");
    expect(payload.payload.agentSignature).toBe("agent-signature");
    expect(payload.payload.temporarySettlementSignature).toBe("temp-signature");
  });

  it("rejects challenges whose resource does not match the request URL", async () => {
    const client = new SublyX402Client({
      facilitatorBaseUrl: "https://facilitator.test",
      signer: fakeSigner(),
      fetchImpl: async () => {
        throw new Error("should not reach the facilitator");
      }
    });

    await expect(
      client.buildPaymentSignatureHeader({
        paymentRequiredHeader: sellerChallengeHeader(),
        httpMethod: "GET",
        url: "https://api.example.com/v1/other"
      })
    ).rejects.toMatchObject({ reason: "resource_mismatch" });
  });

  it("retries the request once with the payment header on 402", async () => {
    const signer = fakeSigner();
    const sellerCalls: Array<Record<string, string> | undefined> = [];
    const client = new SublyX402Client({
      facilitatorBaseUrl: "https://facilitator.test",
      signer,
      fetchImpl: async (url, init) => {
        if (url === RESOURCE) {
          sellerCalls.push(init?.headers);
          const paid =
            init?.headers?.[PAYMENT_SIGNATURE_HEADER] !== undefined;
          return {
            status: paid ? 200 : 402,
            headers: {
              get: (name: string) =>
                !paid && name === PAYMENT_REQUIRED_HEADER
                  ? sellerChallengeHeader()
                  : null
            },
            json: async () => (paid ? { data: "protected" } : {})
          };
        }
        return {
          status: 200,
          headers: { get: () => null },
          json: async () => prepareResponse()
        };
      }
    });

    const response = await client.fetchWithPayment(RESOURCE);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: "protected" });
    expect(sellerCalls).toHaveLength(2);
    expect(sellerCalls[1]?.[PAYMENT_SIGNATURE_HEADER]).toBeDefined();
  });
});
