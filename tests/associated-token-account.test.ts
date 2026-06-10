import { describe, expect, it } from "vitest";
import { SUBLY_VAULT } from "../src/config/constants.js";
import { deriveAssociatedTokenAddress } from "../src/lib/associated-token-account.js";

describe("associated token account derivation", () => {
  it("matches the SPL associated token address derivation for USDC", () => {
    expect(
      deriveAssociatedTokenAddress({
        owner: "11111111111111111111111111111111",
        mint: SUBLY_VAULT.usdcMint
      })
    ).toBe("HJt8Tjdsc9ms9i4WCZEzhzr4oyf3ANcdzXrNdLPFqm3M");
  });
});
