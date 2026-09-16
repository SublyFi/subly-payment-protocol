/**
 * Read-only checks for the CURRENT two-transaction x402 integration.
 * Uses only a public wallet address, never loads signers and never submits.
 * The legacy atomic settlement diagnostic is legacy-settlement-validate.ts.
 */
import assert from "node:assert/strict";
import { address } from "@solana/kit";
import { getSetComputeUnitLimitInstruction, getSetComputeUnitPriceInstruction } from "@solana-program/compute-budget";
import { SUBLY_VAULT, RATE_SCALE } from "../src/config/constants.js";
import { PythHermesFeeEstimator, pythHermesConnectionFromEnv } from "../src/domain/pyth-fee-estimator.js";
import { YIELD_REALIZE_ROUNDING_RAW_USDC } from "../src/domain/withdrawal-rounding.js";
import { KaminoVaultAdapter, grossWithdrawForNetTarget } from "../src/kamino/vault-adapter.js";
import { KaminoApiClient } from "../src/kamino/api-client.js";
import { deriveAssociatedTokenAddress } from "../src/lib/associated-token-account.js";
import { ceilDiv, parsePositiveRawUnits } from "../src/lib/raw-units.js";
import { createRpc } from "../src/solana/rpc.js";
import { buildVersionedTransaction } from "../src/solana/tx.js";
import { assertWithdrawalPreview } from "../src/client/withdrawal-preview.js";

async function main() {
  const rpcUrl = process.env.SOLANA_RPC_URL || process.env.SOLANA_MAINNET_RPC_URL;
  assert(rpcUrl, "Set SOLANA_RPC_URL (or SOLANA_MAINNET_RPC_URL) in .env or the process environment");
  const rpc = createRpc(rpcUrl);
  assert.equal(await rpc.getGenesisHash().send(), "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
    "The validation RPC must be Solana mainnet");
  console.log("PASS: mainnet RPC genesis");
  const walletText = process.env.SUBLY_VALIDATE_WALLET;
  assert(walletText, "Set SUBLY_VALIDATE_WALLET to a PUBLIC wallet address with vault shares; no private key is needed");
  const wallet = address(walletText);
  const sponsor = address(process.env.SUBLY_VALIDATE_SPONSOR ?? wallet);
  const amount = parsePositiveRawUnits(process.env.SUBLY_VALIDATE_AMOUNT ?? "10000", "SUBLY_VALIDATE_AMOUNT");
  const drift = Number(process.env.SUBLY_VALIDATE_DRIFT_S ?? "15");
  assert(Number.isInteger(drift) && drift >= 0 && drift <= 60, "SUBLY_VALIDATE_DRIFT_S must be 0..60 seconds");
  const oracle = new PythHermesFeeEstimator(pythHermesConnectionFromEnv());
  const fee = await oracle.estimatePaymentFee({ wallet, seller: wallet, amountRawUsdc: amount });
  console.log("PASS: authenticated live fee price", { source: fee.source, observedAt: fee.observedAt,
    estimatedFeeDebtRawUsdc: fee.estimatedFeeDebtRawUsdc.toString() });
  const adapter = new KaminoVaultAdapter({ rpc, vaultAddress: SUBLY_VAULT.address, vaultConfig: SUBLY_VAULT,
    extraLookupTables: [...(SUBLY_VAULT.extraLookupTables ?? []),
      ...(process.env.SUBLY_EXTRA_LOOKUP_TABLES ?? "").split(",").map(s => s.trim()).filter(Boolean)] });
  await adapter.validateConfiguration();
  const context = await adapter.loadContext();
  const shares = await adapter.getUserSharesRaw(wallet, context);
  assert(shares.totalSharesRaw > 0n, "Wallet has no vault shares; withdrawal validation is incomplete");
  assert((await rpc.getBalance(sponsor).send()).value > 0n, "Simulated fee payer needs a funded system account");
  console.log("PASS: pinned vault configuration and wallet position", {
    wallet, vault: SUBLY_VAULT.address, sharesRaw: shares.totalSharesRaw.toString(),
    positionValueRawUsdc: (shares.totalSharesRaw * context.exchangeRateScaled / RATE_SCALE).toString(),
    slot: context.slot.toString() });
  const lookupTables = await adapter.loadLookupTables(context);
  const transactions: Array<{ purpose?: "yield_realize"; serializedTransaction: string }> = [];
  for (const purpose of [undefined, "yield_realize"] as const) {
    const gross = grossWithdrawForNetTarget({
      targetNetRawUsdc: amount + (purpose === "yield_realize" ? YIELD_REALIZE_ROUNDING_RAW_USDC : 0n),
      penaltyBps: context.withdrawalPenaltyBps, penaltyLamports: context.withdrawalPenaltyLamports });
    const redeem = ceilDiv(gross * RATE_SCALE, context.exchangeRateScaled);
    assert(redeem <= shares.totalSharesRaw, "Requested amount exceeds wallet shares");
    assert(gross <= context.instantRedeemCapacityRawUsdc, "Requested amount exceeds instant vault liquidity");
    const instructions = [getSetComputeUnitLimitInstruction({ units: 1_000_000 }),
      getSetComputeUnitPriceInstruction({ microLamports: 1n }),
      ...await adapter.buildNormalWithdrawInstructions({ wallet, sharesToRedeemRaw: redeem, context, rentPayer: sponsor })];
    const built = await buildVersionedTransaction({ feePayer: sponsor, blockhash: context.blockhash,
      lastValidBlockHeight: context.lastValidBlockHeight, instructions, lookupTables });
    const tx = { serializedTransaction: built.serializedBase64, ...(purpose ? { purpose } : {}) };
    await assertWithdrawalPreview({ rpc, wallet, vault: SUBLY_VAULT, amountRawUsdc: amount, ...tx });
    transactions.push(tx);
    console.log(`PASS: ${purpose ?? "normal exit"} transaction and independent client preview`, {
      bytes: Buffer.from(built.serializedBase64, "base64").length, requestedRawUsdc: amount.toString() });
  }
  if (drift > 0) {
    console.log(`Checking the same unsigned transactions again after ${drift}s...`);
    await new Promise(resolve => setTimeout(resolve, drift * 1_000));
    for (const tx of transactions) await assertWithdrawalPreview({ rpc, wallet, vault: SUBLY_VAULT, amountRawUsdc: amount, ...tx });
    console.log("PASS: delayed client previews");
  }
  const pnl = await new KaminoApiClient(process.env.SUBLY_KAMINO_API_BASE).getUserVaultPnl({ wallet, vault: SUBLY_VAULT.address });
  console.log("INFO: Kamino historical cost basis", pnl?.costBasisRawUsdc?.toString() ?? "unavailable; fresh ledger sync conservatively treats current value as principal");
  const ata = deriveAssociatedTokenAddress({ owner: wallet, mint: SUBLY_VAULT.usdcMint });
  const token = await rpc.getAccountInfo(address(ata), { encoding: "base64" }).send();
  const walletUsdc = token.value === null ? 0n : Buffer.from(token.value.data[0], "base64").readBigUInt64LE(64);
  console.log("INFO: wallet USDC and minimum deposit", { walletUsdcRaw: walletUsdc.toString(),
    minimumDepositWithRoundingRaw: (context.minDepositAmountRaw + 10n).toString() });
  console.log("Read-only withdrawal/price checks passed. Deposit execution, owner approval, real accrued yield, seller settlement and public-host deployment are NOT certified by this command. Run test:fork for the disposable end-to-end fixture.");
}

main().catch(error => {
  // RPC exceptions can carry headers and authenticated URLs. Never dump them.
  let message = error instanceof Error ? error.message : "Unexpected validation failure";
  for (const [name, value] of Object.entries(process.env)) {
    if (value && /API_KEY|RPC_URL/.test(name)) message = message.replaceAll(value, "[redacted]");
  }
  console.error("Validation failed:", message.replace(/https?:\/\/[^\s"'<>]+/g, "[endpoint omitted]"));
  process.exitCode = 1;
});
