import { describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/api/server.js";
import { SublyService } from "../src/domain/payment-service.js";

describe("API request rate limiting", () => {
  it("limits legacy verification before authentication and payment verification", async () => {
    const service = new SublyService();
    const verify = vi.spyOn(service, "verifyPaymentPayload");
    const server = buildServer(service, {
      apiRatePerMinute: 1,
      enableLegacySellerApi: true,
      sellerApiToken: "test-seller-token"
    });
    try {
      const first = await server.inject({ method: "POST", url: "/v1/x402/verify", payload: {} });
      expect(first.statusCode).toBe(401);
      const limited = await server.inject({
        method: "POST", url: "/v1/x402/verify", payload: {},
        headers: { authorization: "Bearer test-seller-token" }
      });
      expect(limited.statusCode).toBe(429);
      expect(limited.json().error.code).toBe("rate_limited");
      expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
      expect(verify).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("prevents another authenticated admin request from reaching the ledger", async () => {
    const service = new SublyService();
    const list = vi.spyOn(service.ledger, "listLiquidityPolicies");
    const server = buildServer(service, { apiRatePerMinute: 1, adminApiToken: "test-admin-token" });
    const request = {
      method: "GET" as const, url: "/v1/admin/liquidity-policies",
      headers: { authorization: "Bearer test-admin-token" }
    };
    try {
      expect((await server.inject(request)).statusCode).toBe(200);
      expect((await server.inject(request)).statusCode).toBe(429);
      expect(list).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });

  it("ignores forged forwarded addresses when proxy trust is disabled", async () => {
    const server = buildServer(new SublyService(), { apiRatePerMinute: 1, trustProxy: false });
    try {
      expect((await server.inject({
        method: "GET", url: "/v1/vaults", remoteAddress: "192.0.2.1",
        headers: { "x-forwarded-for": "198.51.100.1" }
      })).statusCode).toBe(200);
      expect((await server.inject({
        method: "GET", url: "/v1/vaults", remoteAddress: "192.0.2.1",
        headers: { "x-forwarded-for": "198.51.100.2" }
      })).statusCode).toBe(429);
      expect((await server.inject({
        method: "GET", url: "/v1/vaults", remoteAddress: "192.0.2.2"
      })).statusCode).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("keeps health probes available after the API allowance is exhausted", async () => {
    const server = buildServer(new SublyService(), { apiRatePerMinute: 1 });
    try {
      expect((await server.inject({ method: "GET", url: "/v1/vaults" })).statusCode).toBe(200);
      expect((await server.inject({ method: "GET", url: "/v1/vaults" })).statusCode).toBe(429);
      for (const url of ["/healthz", "/readyz", "/healthz", "/readyz"]) {
        expect((await server.inject({ method: "GET", url })).statusCode).toBe(200);
      }
      expect((await server.inject({ method: "GET", url: "/v1/vaults" })).statusCode).toBe(429);
    } finally {
      await server.close();
    }
  });
});
