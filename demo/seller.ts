/**
 * Demo seller: a paid HTTP API gated by Subly yield payments.
 *
 * Serves GET /api/premium/alpha. Requests without PAYMENT-SIGNATURE get a 402
 * challenge; retries are settled through the Subly facilitator
 * (settle-before-deliver) and only then receive the premium response.
 *
 * Required env:
 *   SUBLY_SELLER_API_TOKEN    facilitator seller token
 *   SUBLY_DEMO_SELLER_WALLET  seller wallet address that receives USDC
 * Optional env:
 *   SUBLY_FACILITATOR_URL       default http://localhost:3000
 *   SUBLY_DEMO_SELLER_PORT      default 4021
 *   SUBLY_DEMO_SELLER_BASE_URL  default http://localhost:<port>
 *   SUBLY_DEMO_PRICE_RAW_USDC   default 10000 (= 0.01 USDC)
 *   SUBLY_DEMO_CHALLENGE_RATE_PER_MIN         per-IP challenge issuance
 *                               rate (default 10/min, burst 10)
 *   SUBLY_DEMO_CHALLENGE_RATE_GLOBAL_PER_MIN  global challenge issuance
 *                               rate (default 120/min, burst 120)
 *   SUBLY_DEMO_TRUST_PROXY      set to 1 behind a reverse proxy so the
 *                               per-IP limit keys on X-Forwarded-For
 */
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  decodePaymentSignatureHeader,
  PAYMENT_SIGNATURE_HEADER
} from "../src/x402/headers.js";
import { TokenBucketRateLimiter } from "../src/x402/rate-limit.js";
import { SublySellerGate, type PricedRequest } from "../src/x402/seller.js";
import { fail, formatRawUsdc, requireEnv } from "./shared.js";

const RESOURCE_PATH = "/api/premium/alpha";
const MAX_OPEN_CHALLENGES = 1000;

const sellerApiToken = requireEnv("SUBLY_SELLER_API_TOKEN");
const sellerWallet = requireEnv("SUBLY_DEMO_SELLER_WALLET");
const facilitatorBaseUrl =
  process.env.SUBLY_FACILITATOR_URL ?? "http://localhost:3000";
const port = Number.parseInt(process.env.SUBLY_DEMO_SELLER_PORT ?? "4021", 10);
const baseUrl = (
  process.env.SUBLY_DEMO_SELLER_BASE_URL ?? `http://localhost:${port}`
).replace(/\/$/, "");
const priceRawUsdc = process.env.SUBLY_DEMO_PRICE_RAW_USDC ?? "10000";
if (!/^[1-9]\d*$/.test(priceRawUsdc)) {
  fail(
    "SUBLY_DEMO_PRICE_RAW_USDC must be a positive integer in raw USDC units " +
      "without leading zeros (e.g. 10000 = 0.01 USDC), got: " +
      priceRawUsdc
  );
}
const maxTimeoutSeconds = 120;
// Bounds gate.settle: without it a stalled facilitator connection would pin
// `settling` (and 409 every retry) until undici's ~300s default timeout.
const facilitatorTimeoutMs = 30_000;

const gate = new SublySellerGate({
  facilitatorBaseUrl,
  sellerApiToken,
  payTo: sellerWallet,
  maxTimeoutSeconds,
  fetchImpl: (url, init) =>
    fetch(url, { ...init, signal: AbortSignal.timeout(facilitatorTimeoutMs) })
});

// Challenge issuance is unauthenticated, so it is rate limited per client IP
// and globally; otherwise a cheap request flood pins the challenge store at
// MAX_OPEN_CHALLENGES and starves legitimate buyers with 503s.
const perIpRatePerMin = Number(
  process.env.SUBLY_DEMO_CHALLENGE_RATE_PER_MIN ?? "10"
);
const globalRatePerMin = Number(
  process.env.SUBLY_DEMO_CHALLENGE_RATE_GLOBAL_PER_MIN ?? "120"
);
if (!Number.isFinite(perIpRatePerMin) || perIpRatePerMin <= 0) {
  fail("SUBLY_DEMO_CHALLENGE_RATE_PER_MIN must be a positive number");
}
if (!Number.isFinite(globalRatePerMin) || globalRatePerMin <= 0) {
  fail("SUBLY_DEMO_CHALLENGE_RATE_GLOBAL_PER_MIN must be a positive number");
}
const perIpChallengeLimiter = new TokenBucketRateLimiter({
  capacity: perIpRatePerMin,
  refillPerSecond: perIpRatePerMin / 60
});
const globalChallengeLimiter = new TokenBucketRateLimiter({
  capacity: globalRatePerMin,
  refillPerSecond: globalRatePerMin / 60
});
const GLOBAL_LIMITER_KEY = "global";

// Challenges are keyed by request binding hash: the retry's PAYMENT-SIGNATURE
// carries the hash, which maps back to the exact priced request we quoted.
// `settling` prevents concurrent retries with the same header from settling
// (and delivering) twice.
const openChallenges = new Map<
  string,
  { request: PricedRequest; expiresAtMs: number; settling: boolean }
>();

function pruneExpiredChallenges(): void {
  const now = Date.now();
  for (const [hash, entry] of openChallenges) {
    if (entry.expiresAtMs <= now && !entry.settling) {
      openChallenges.delete(hash);
    }
  }
}

function reissueChallenge(
  request: FastifyRequest,
  reply: FastifyReply
): FastifyReply {
  if (!perIpChallengeLimiter.tryTake(request.ip)) {
    const retryAfter = perIpChallengeLimiter.retryAfterSeconds(request.ip);
    console.log(`[seller] challenge issuance rate limited for ${request.ip}`);
    return reply
      .status(429)
      .header("retry-after", String(Math.max(1, retryAfter)))
      .send({
        error: {
          code: "challenge_rate_limited",
          message: "Too many challenge requests; retry shortly"
        }
      });
  }
  if (!globalChallengeLimiter.tryTake(GLOBAL_LIMITER_KEY)) {
    const retryAfter =
      globalChallengeLimiter.retryAfterSeconds(GLOBAL_LIMITER_KEY);
    console.log("[seller] challenge issuance rate limited globally");
    return reply
      .status(429)
      .header("retry-after", String(Math.max(1, retryAfter)))
      .send({
        error: {
          code: "challenge_rate_limited",
          message: "Too many challenge requests; retry shortly"
        }
      });
  }
  if (openChallenges.size >= MAX_OPEN_CHALLENGES) {
    console.log(
      `[seller] challenge issuance refused: ${openChallenges.size} challenges already open`
    );
    return reply.status(503).send({
      error: {
        code: "too_many_open_challenges",
        message: "Too many open payment challenges; retry shortly"
      }
    });
  }

  const priced: PricedRequest = {
    sellerRequestId: randomUUID(),
    httpMethod: "GET",
    resource: `${baseUrl}${RESOURCE_PATH}`,
    amountRawUsdc: priceRawUsdc,
    description: "Subly demo premium alpha feed"
  };
  openChallenges.set(gate.bindingHashFor(priced), {
    request: priced,
    expiresAtMs: Date.now() + maxTimeoutSeconds * 1000,
    settling: false
  });

  console.log(
    `[seller] 402 challenge issued: ${formatRawUsdc(priceRawUsdc)} USDC ` +
      `(sellerRequestId=${priced.sellerRequestId})`
  );
  const challenge = gate.paymentRequiredResponse(priced);
  return reply
    .status(challenge.statusCode)
    .headers(challenge.headers)
    .send(challenge.body);
}

const PREMIUM_INSIGHTS = [
  "Vault utilization is trending up; expect supply APY to follow this week.",
  "Stablecoin inflows to Solana lending markets hit a 30-day high.",
  "Curator rebalanced toward shorter-duration reserves; liquidity looks deep.",
  "Yield spread between staked and unstaked shares narrowed to near zero."
];

const server = Fastify({
  logger: false,
  trustProxy: process.env.SUBLY_DEMO_TRUST_PROXY === "1"
});

server.get(RESOURCE_PATH, async (request, reply) => {
  pruneExpiredChallenges();

  const paymentHeader = request.headers[PAYMENT_SIGNATURE_HEADER];
  if (typeof paymentHeader !== "string") {
    return reissueChallenge(request, reply);
  }

  let bindingHash: string;
  try {
    bindingHash = decodePaymentSignatureHeader(paymentHeader).payload
      .requestBindingHash;
  } catch {
    console.log("[seller] retry rejected: malformed PAYMENT-SIGNATURE header");
    return reissueChallenge(request, reply);
  }

  const entry = openChallenges.get(bindingHash);
  // The settling guard must win over expiry: reissuing a fresh challenge
  // while a settle for the same header is still in flight would invite a
  // second payment for the same resource fetch.
  if (entry !== undefined && entry.settling) {
    console.log(
      "[seller] retry rejected: settlement already in progress for this challenge"
    );
    return reply.status(409).send({
      error: {
        code: "settlement_in_progress",
        message: "A settlement for this payment is already in progress"
      }
    });
  }
  if (entry === undefined || entry.expiresAtMs <= Date.now()) {
    openChallenges.delete(bindingHash);
    console.log(
      "[seller] retry rejected: unknown or expired challenge, reissuing 402"
    );
    return reissueChallenge(request, reply);
  }

  console.log(
    `[seller] payment retry received (sellerRequestId=${entry.request.sellerRequestId}); ` +
      "verifying and settling at the facilitator..."
  );
  entry.settling = true;
  let result;
  try {
    result = await gate.settle({
      paymentSignatureHeader: paymentHeader,
      request: entry.request
    });
  } catch (error) {
    // The challenge stays open: the facilitator's /verify and /settle are
    // idempotent, so retrying the same PAYMENT-SIGNATURE recovers the receipt
    // even if the settlement actually landed before the connection failed.
    entry.settling = false;
    console.log(
      `[seller] settlement attempt failed to reach the facilitator: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return reply.status(502).send({
      error: {
        code: "facilitator_unreachable",
        message:
          "Settlement could not be completed; retry with the same PAYMENT-SIGNATURE"
      }
    });
  }

  if (!result.granted) {
    entry.settling = false;
    console.log(`[seller] settlement denied: ${result.reason}`);
    return reply.status(402).send({
      error: { code: "payment_not_settled", reason: result.reason }
    });
  }

  // The entry is kept (not deleted) until its TTL: if this response is lost
  // in transit, the buyer can retry the same PAYMENT-SIGNATURE and the
  // facilitator's idempotent /settle returns the same receipt, so the paid
  // content is redelivered instead of a fresh 402 charging a second payment.
  entry.settling = false;
  console.log(
    `[seller] payment settled (paymentId=${result.paymentId}); delivering premium response`
  );
  return reply.headers(result.responseHeaders).send({
    product: "subly-demo-premium-alpha",
    insight:
      PREMIUM_INSIGHTS[Math.floor(Math.random() * PREMIUM_INSIGHTS.length)],
    paymentId: result.paymentId,
    generatedAt: new Date().toISOString()
  });
});

await server.listen({ port, host: "0.0.0.0" });
console.log(`[seller] paid API listening on ${baseUrl}${RESOURCE_PATH}`);
console.log(
  `[seller] price ${formatRawUsdc(priceRawUsdc)} USDC, payTo ${sellerWallet}`
);
console.log(`[seller] facilitator: ${facilitatorBaseUrl}`);
