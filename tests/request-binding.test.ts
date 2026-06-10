import { describe, expect, it } from "vitest";
import { SUBLY_VAULT } from "../src/config/constants.js";
import { EMPTY_BODY_HASH } from "../src/lib/hash.js";
import { computeRequestBindingHash } from "../src/domain/request-binding.js";

describe("request binding hash", () => {
  const base = {
    sellerRequestId: "seller_req_1",
    httpMethod: "get",
    canonicalResourceUrl: "https://api.example.com/v1/data",
    requestBodyHash: EMPTY_BODY_HASH,
    seller: "seller",
    asset: SUBLY_VAULT.usdcMint,
    amountRawUsdc: "10000",
    payTo: "payTo",
    sellerUsdcAta: "sellerUsdcAta"
  };

  it("is stable and normalizes HTTP method case", () => {
    expect(computeRequestBindingHash(base)).toBe(
      computeRequestBindingHash({
        ...base,
        httpMethod: "GET"
      })
    );
  });

  it("changes when seller request binding fields change", () => {
    expect(computeRequestBindingHash(base)).not.toBe(
      computeRequestBindingHash({
        ...base,
        sellerRequestId: "seller_req_2"
      })
    );
  });

  it("changes when the seller token account changes", () => {
    expect(computeRequestBindingHash(base)).not.toBe(
      computeRequestBindingHash({
        ...base,
        sellerUsdcAta: "differentSellerUsdcAta"
      })
    );
  });
});
