import { describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.js";
import { SublyService } from "../src/domain/payment-service.js";

describe("API server auth", () => {
  it("keeps health and supported endpoints public", async () => {
    const server = buildServer(new SublyService(), {
      sellerApiToken: null,
      adminApiToken: null
    });

    const health = await server.inject({
      method: "GET",
      url: "/healthz"
    });
    const supported = await server.inject({
      method: "GET",
      url: "/v1/x402/supported"
    });

    expect(health.statusCode).toBe(200);
    expect(supported.statusCode).toBe(200);
    await server.close();
  });

  it("rejects protected endpoints when auth is not configured", async () => {
    const server = buildServer(new SublyService(), {
      sellerApiToken: null,
      adminApiToken: null
    });

    const response = await server.inject({
      method: "POST",
      url: "/v1/admin/liquidity-policies",
      payload: {}
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("admin_auth_not_configured");
    await server.close();
  });

  it("rejects protected endpoints with an invalid token", async () => {
    const server = buildServer(new SublyService(), {
      adminApiToken: "admin-secret"
    });

    const response = await server.inject({
      method: "POST",
      url: "/v1/wallets/agent",
      headers: {
        authorization: "Bearer wrong"
      },
      payload: {}
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("unauthorized");
    await server.close();
  });

  it("does not allow a seller token to call admin endpoints", async () => {
    const server = buildServer(new SublyService(), {
      sellerApiToken: "seller-secret",
      adminApiToken: "admin-secret"
    });

    const response = await server.inject({
      method: "POST",
      url: "/v1/admin/settlements/recover",
      headers: {
        authorization: "Bearer seller-secret"
      },
      payload: {}
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("unauthorized");
    await server.close();
  });

  it("refuses to start when two role tokens share the same value", async () => {
    expect(() =>
      buildServer(new SublyService(), {
        sellerApiToken: "shared-secret",
        adminApiToken: "shared-secret"
      })
    ).toThrowError(/must not share the same value/);
  });

  it("allows the admin token to poll deposit status", async () => {
    const server = buildServer(new SublyService(), {
      sellerApiToken: "seller-secret",
      adminApiToken: "admin-secret"
    });

    const response = await server.inject({
      method: "GET",
      url: "/v1/deposits/dep_test",
      headers: {
        authorization: "Bearer admin-secret"
      }
    });

    // Auth passes; the request fails later because no vault flow service is
    // wired in this test (501), not with a 401.
    expect(response.statusCode).toBe(501);
    expect(response.json().error.code).toBe("vault_flows_unavailable");
    await server.close();
  });

  it("does not allow the seller token to poll deposit status", async () => {
    const server = buildServer(new SublyService(), {
      sellerApiToken: "seller-secret",
      adminApiToken: "admin-secret"
    });

    const response = await server.inject({
      method: "GET",
      url: "/v1/deposits/dep_test",
      headers: {
        authorization: "Bearer seller-secret"
      }
    });

    expect(response.statusCode).toBe(401);
    await server.close();
  });

  it("serves operational metrics to the admin token", async () => {
    const server = buildServer(new SublyService(), {
      sellerApiToken: "seller-secret",
      adminApiToken: "admin-secret",
      sponsorMonitoring: {
        sponsorAddress: "Sponsor111",
        getSponsorBalanceLamports: async () => 42_000_000n,
        minSponsorBalanceLamports: 100_000_000n
      }
    });

    const response = await server.inject({
      method: "GET",
      url: "/v1/admin/monitoring",
      headers: {
        authorization: "Bearer admin-secret"
      }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.metrics.settlementLatencyMs.count).toBe(0);
    expect(body.sponsor).toEqual({
      address: "Sponsor111",
      balanceLamports: "42000000",
      minBalanceLamports: "100000000",
      belowMinimum: true
    });
    await server.close();
  });

  it("does not allow an admin token to call seller settlement endpoints", async () => {
    const server = buildServer(new SublyService(), {
      sellerApiToken: "seller-secret",
      adminApiToken: "admin-secret"
    });

    const response = await server.inject({
      method: "POST",
      url: "/v1/x402/verify",
      headers: {
        authorization: "Bearer admin-secret"
      },
      payload: {}
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("unauthorized");
    await server.close();
  });
});
