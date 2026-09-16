import { describe, expect, it } from "vitest";
import { assertWithdrawalPreview } from "../src/client/withdrawal-preview.js";
import { SUBLY_VAULT } from "../src/config/constants.js";
import { previewRpc } from "./helpers/withdrawal-preview.js";
import type { SolanaRpc } from "../src/solana/rpc.js";

const wallet = "GPqt7ksu6LoKAx7PXEDb54bjrN5fs9R61TkzyL5X3H1M";
const request = { wallet, vault: SUBLY_VAULT, serializedTransaction: "unsigned", amountRawUsdc: 10_000n };

describe("withdrawal preview before signing", () => {
  it("refuses even a one-unit shortfall when realizing an exact payment", async () => {
    await expect(assertWithdrawalPreview({ ...request, purpose: "yield_realize", rpc: previewRpc(wallet, 9_999n) })).rejects.toThrow("differs");
    await expect(assertWithdrawalPreview({ ...request, rpc: previewRpc(wallet, 9_999n) })).resolves.toBeUndefined();
  });
  it.each([10_000n, 10_005n, 10_010n])("accepts a fully funded realize within the fixed allowance: %s", async amount => {
    await expect(assertWithdrawalPreview({ ...request, purpose: "yield_realize", rpc: previewRpc(wallet, amount) })).resolves.toBeUndefined();
  });
  it("refuses excessive liquidation even for yield realization", async () => {
    await expect(assertWithdrawalPreview({ ...request, purpose: "yield_realize", rpc: previewRpc(wallet, 10_011n) })).rejects.toThrow("differs");
  });
  it("accepts the requested amount with bounded whole-share rounding", async () => {
    await expect(assertWithdrawalPreview({ ...request, rpc: previewRpc(wallet, 10_003n) })).resolves.toBeUndefined();
  });
  it.each([1_000_000n, 100n, 0n])("refuses a changed on-chain output of %s", async amount => {
    await expect(assertWithdrawalPreview({ ...request, rpc: previewRpc(wallet, amount) })).rejects.toThrow("differs");
  });
  it("fails closed when simulation cannot provide parsed token transfers", async () => {
    const rpc = { simulateTransaction: () => ({ send: async () => ({ value: { err: null, innerInstructions: null } }) }) } as unknown as SolanaRpc;
    await expect(assertWithdrawalPreview({ ...request, rpc })).rejects.toThrow("differs");
  });
  it("fails closed when the RPC simulation rejects the transaction", async () => {
    const rpc = { simulateTransaction: () => ({ send: async () => ({ value: { err: { InstructionError: [1, "error"] } } }) }) } as unknown as SolanaRpc;
    await expect(assertWithdrawalPreview({ ...request, rpc })).rejects.toThrow("preview failed");
  });
});
