import type { Base64EncodedWireTransaction } from "@solana/kit";
import { SPL_TOKEN_PROGRAM_ID } from "../config/constants.js";
import type { VaultConfig } from "../config/vault.js";
import { deriveAssociatedTokenAddress } from "../lib/associated-token-account.js";
import type { SolanaRpc } from "../solana/rpc.js";
import { WITHDRAWAL_ROUNDING_RAW_USDC } from "../domain/withdrawal-rounding.js";

/** Independently preview the exact unsigned withdrawal using the client's RPC.
 * The relayer's share quote is not an authority for how much USDC to liquidate.
 * This is an additional pre-sign check, not an on-chain principal guarantee.
 */
export async function assertWithdrawalPreview(input: {
  rpc: SolanaRpc;
  serializedTransaction: string;
  wallet: string;
  vault: Readonly<VaultConfig>;
  amountRawUsdc: bigint;
  purpose?: "yield_realize";
}): Promise<void> {
  const destination = deriveAssociatedTokenAddress({ owner: input.wallet, mint: input.vault.usdcMint });
  const simulation = await input.rpc.simulateTransaction(
    input.serializedTransaction as Base64EncodedWireTransaction,
    { encoding: "base64", commitment: "confirmed", sigVerify: false,
      replaceRecentBlockhash: false, innerInstructions: true }
  ).send({ abortSignal: AbortSignal.timeout(15_000) });
  if (simulation.value.err !== null) {
    throw new Error("Withdrawal preview failed on the client RPC; no transaction was signed. Check liquidity, RPC and blockhash, then prepare again.");
  }
  let received = 0n;
  for (const group of simulation.value.innerInstructions ?? []) {
    for (const instruction of group.instructions) {
      if (!("parsed" in instruction) || instruction.programId !== SPL_TOKEN_PROGRAM_ID) continue;
      const parsed = instruction.parsed as { type?: unknown; info?: Record<string, unknown> };
      if (parsed.type !== "transfer" && parsed.type !== "transferChecked") continue;
      const info = parsed.info;
      if (!info || (info.destination !== destination && info.source !== destination)) continue;
      const raw = parsed.type === "transferChecked"
        ? (info.tokenAmount as { amount?: unknown } | undefined)?.amount : info.amount;
      if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
        throw new Error("Withdrawal preview returned an invalid token amount");
      }
      const amount = BigInt(raw);
      if (info.destination === destination) received += amount;
      if (info.source === destination) received -= amount;
    }
  }
  const minimum = input.purpose === "yield_realize"
    ? input.amountRawUsdc : input.amountRawUsdc - WITHDRAWAL_ROUNDING_RAW_USDC;
  if (received <= 0n || received > input.amountRawUsdc + WITHDRAWAL_ROUNDING_RAW_USDC ||
      received < minimum) {
    throw new Error("Withdrawal preview differs from the requested USDC amount; no transaction was signed");
  }
}
