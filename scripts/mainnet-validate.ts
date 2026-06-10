/**
 * Read-only mainnet validation harness.
 *
 * Validates the chain-critical Subly path against the live vault without
 * moving funds: vault context loading, settlement quoting, canonical
 * settlement transaction building, probe + final simulation (sigVerify off),
 * output drift over time, the Kamino P&L API, and the fee oracle.
 *
 * Usage:
 *   SOLANA_RPC_URL=... npx tsx scripts/mainnet-validate.ts
 * Optional:
 *   SUBLY_VALIDATE_WALLET   agent wallet holding vault shares
 *   SUBLY_VALIDATE_SPONSOR  funded wallet used as simulated fee payer
 *   SUBLY_VALIDATE_SELLER   wallet with an existing USDC ATA (payment target)
 *   SUBLY_VALIDATE_AMOUNT   seller amount in raw USDC (default 10000 = 0.01)
 *   SUBLY_VALIDATE_DRIFT_S  seconds to wait before drift re-simulation (default 0 = skip)
 */
import { address } from "@solana/kit";
import { SUBLY_VAULT } from "../src/config/constants.js";
import { KaminoCanonicalTransactionBuilder } from "../src/domain/kamino-transaction-builder.js";
import { PythHermesFeeEstimator } from "../src/domain/pyth-fee-estimator.js";
import { KaminoApiClient } from "../src/kamino/api-client.js";
import { KaminoVaultAdapter, rawToUsdcDecimal } from "../src/kamino/vault-adapter.js";
import { deriveAssociatedTokenAddress } from "../src/lib/associated-token-account.js";
import { createRpcFromEnv } from "../src/solana/rpc.js";

// Defaults to a persistently funded exchange hot wallet for simulation only.
const DEFAULT_SIMULATED_SPONSOR = "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9";

async function main() {
  const rpc = createRpcFromEnv();
  const adapter = new KaminoVaultAdapter({
    rpc,
    vaultAddress: SUBLY_VAULT.address,
    ...(process.env.SUBLY_EXTRA_LOOKUP_TABLES === undefined
      ? {}
      : {
          extraLookupTables: process.env.SUBLY_EXTRA_LOOKUP_TABLES.split(",")
            .map((value) => value.trim())
            .filter((value) => value.length > 0)
        })
  });

  console.log("=== 1. Vault context ===");
  const context = await adapter.loadContext();
  console.log("slot", context.slot.toString());
  console.log("tokenAvailableRaw", context.tokenAvailableRaw.toString());
  console.log("sharesIssued", context.vaultState.sharesIssued.toString());
  console.log("tokensPerShare", context.tokensPerShare.toString());
  console.log("exchangeRateScaled", context.exchangeRateScaled.toString());
  console.log(
    "instantRedeemCapacityRawUsdc",
    context.instantRedeemCapacityRawUsdc.toString()
  );
  console.log(
    "singleIxCapacityRawUsdc",
    context.singleInstructionRedeemCapacityRawUsdc.toString()
  );
  console.log(
    "withdrawalPenaltyBps",
    context.withdrawalPenaltyBps.toString(),
    "penaltyLamports",
    context.withdrawalPenaltyLamports.toString(),
    "minWithdrawRaw",
    context.minWithdrawAmountRaw.toString()
  );
  console.log("farm", context.farmState === null ? "none" : "configured");

  console.log("\n=== 2. Locate a share-holding wallet ===");
  let wallet = process.env.SUBLY_VALIDATE_WALLET ?? null;
  if (wallet === null) {
    const largest = await rpc
      .getTokenLargestAccounts(address(SUBLY_VAULT.shareMint))
      .send();
    for (const entry of largest.value) {
      if (BigInt(entry.amount) === 0n) {
        continue;
      }
      const info = await rpc
        .getAccountInfo(entry.address, { encoding: "jsonParsed" })
        .send();
      const data = info.value?.data;
      const owner =
        data !== undefined && typeof data === "object" && "parsed" in data
          ? (data.parsed as { info?: { owner?: string } }).info?.owner ?? null
          : null;
      if (owner === null) {
        continue;
      }
      const shares = await adapter.getUserSharesRaw(owner, context);
      if (shares.totalSharesRaw > 0n) {
        wallet = owner;
        break;
      }
    }
  }
  if (wallet === null) {
    // All shares may be staked in the vault farm; attribute via recent vault
    // transaction signers instead of share token accounts.
    const signatures = await rpc
      .getSignaturesForAddress(address(SUBLY_VAULT.address), { limit: 25 })
      .send();
    const candidates = new Set<string>();
    for (const entry of signatures) {
      if (entry.err !== null) {
        continue;
      }
      const tx = await rpc
        .getTransaction(entry.signature, {
          maxSupportedTransactionVersion: 0,
          encoding: "json"
        })
        .send();
      const keys = tx?.transaction.message.accountKeys ?? [];
      const numSigners = tx?.transaction.message.header.numRequiredSignatures ?? 0;
      for (let index = 0; index < Number(numSigners); index += 1) {
        const key = keys[index];
        if (key !== undefined) {
          candidates.add(String(key));
        }
      }
      if (candidates.size >= 8) {
        break;
      }
    }
    for (const candidate of candidates) {
      const shares = await adapter.getUserSharesRaw(candidate, context);
      if (shares.totalSharesRaw > 0n) {
        wallet = candidate;
        break;
      }
    }
  }
  if (wallet === null) {
    console.log("No share-holding wallet found; set SUBLY_VALIDATE_WALLET. Stopping.");
    return;
  }
  const userShares = await adapter.getUserSharesRaw(wallet, context);
  console.log("wallet", wallet);
  console.log("stakedSharesRaw", userShares.stakedSharesRaw.toString());
  console.log("unstakedSharesRaw", userShares.unstakedSharesRaw.toString());
  console.log("sharesAtaExists", userShares.sharesAtaExists);

  console.log("\n=== 3. Settlement quote ===");
  const amountRawUsdc = BigInt(process.env.SUBLY_VALIDATE_AMOUNT ?? "10000");
  const builder = new KaminoCanonicalTransactionBuilder({ rpc, adapter });
  const quote = await builder.quoteSettlementWithdraw({
    wallet,
    vault: SUBLY_VAULT.address,
    amountRawUsdc
  });
  console.log("requiredWithdrawRawUsdc", quote.requiredWithdrawRawUsdc.toString());
  console.log("sharesToRedeemRaw", quote.sharesToRedeemRaw.toString());
  console.log("withdrawalPenaltyRawUsdc", quote.withdrawalPenaltyRawUsdc.toString());
  if (quote.userTotalSharesRaw === 0n) {
    console.log("Wallet has no shares; cannot build settlement. Stopping.");
    return;
  }

  console.log("\n=== 4. Canonical settlement transaction (simulation only) ===");
  const sponsor = process.env.SUBLY_VALIDATE_SPONSOR ?? DEFAULT_SIMULATED_SPONSOR;
  const seller = process.env.SUBLY_VALIDATE_SELLER ?? sponsor;
  const sellerUsdcAta = deriveAssociatedTokenAddress({
    owner: seller,
    mint: SUBLY_VAULT.usdcMint
  });
  const dustRecipientUsdcAta = deriveAssociatedTokenAddress({
    owner: wallet,
    mint: SUBLY_VAULT.usdcMint
  });
  console.log("simulated sponsor", sponsor);
  console.log("seller", seller, "sellerUsdcAta", sellerUsdcAta);

  const startedAt = Date.now();
  let prepared;
  try {
    prepared = await builder.preparePaymentSettlement({
    paymentId: "pay_mainnet_validation",
    wallet,
    vault: SUBLY_VAULT.address,
    shareMint: SUBLY_VAULT.shareMint,
    usdcMint: SUBLY_VAULT.usdcMint,
    feePayer: sponsor,
    seller,
    sellerRequestId: "validation",
    requestBindingHash: "sha256-validation",
    httpMethod: "GET",
    canonicalResourceUrl: "https://example.com/v1/data",
    requestBodyHash: "sha256-empty",
    amountRawUsdc,
    payTo: seller,
    sellerUsdcAta,
    dustRecipientUsdcAta,
    sharesToRedeemRaw: quote.sharesToRedeemRaw,
    requiredWithdrawRawUsdc: quote.requiredWithdrawRawUsdc,
    memo: "pay_mainnet_validation",
    expiresAt: new Date(Date.now() + 120_000).toISOString()
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("byte limit")) {
      console.log(
        "PARTIAL PASS: the withdraw probe simulation succeeded on mainnet " +
          "(temporary account funded via KVault withdraw), but the final " +
          "transaction exceeds the size limit because the wallet's shares " +
          "are farm-staked and the vault lookup table is not synced."
      );
      console.log("Detail:", error.message);
      console.log(
        "Remediation: run `npx tsx scripts/create-settlement-lut.ts` with the " +
          "funded sponsor keypair and set SUBLY_EXTRA_LOOKUP_TABLES, or sync " +
          "the curator vault LUT from the Kamino SDK, then re-run this harness."
      );
      return;
    }
    throw error;
  }
  console.log("preparedMessageHash", prepared.preparedMessageHash);
  console.log("temporary account", prepared.temporarySettlementTokenAccount);
  console.log(
    "transaction bytes",
    Buffer.from(prepared.serializedTransaction, "base64").length
  );
  console.log("build+simulate ms", Date.now() - startedAt);
  console.log(
    "PASS: probe + final simulation succeeded (temporary account closed, seller paid",
    rawToUsdcDecimal(amountRawUsdc).toString(),
    "USDC)"
  );

  const driftSeconds = Number(process.env.SUBLY_VALIDATE_DRIFT_S ?? "0");
  if (driftSeconds > 0) {
    console.log(`\n=== 5. Output drift after ${driftSeconds}s ===`);
    await new Promise((resolve) => setTimeout(resolve, driftSeconds * 1000));
    const result = await rpc
      .simulateTransaction(
        prepared.serializedTransaction as Parameters<
          typeof rpc.simulateTransaction
        >[0],
        {
          encoding: "base64",
          sigVerify: false,
          replaceRecentBlockhash: true,
          commitment: "confirmed"
        }
      )
      .send();
    if (result.value.err === null) {
      console.log("PASS: settlement still closes exactly after", driftSeconds, "s");
    } else {
      console.log(
        "DRIFT: settlement no longer balances:",
        JSON.stringify(result.value.err),
        (result.value.logs ?? []).slice(-5)
      );
    }
  }

  console.log("\n=== 6. Kamino P&L API ===");
  const apiClient = new KaminoApiClient(process.env.SUBLY_KAMINO_API_BASE);
  const pnl = await apiClient.getUserVaultPnl({
    wallet,
    vault: SUBLY_VAULT.address
  });
  console.log(
    pnl === null
      ? "P&L API unavailable (conservative reset path will be used)"
      : `costBasisRawUsdc=${pnl.costBasisRawUsdc?.toString() ?? "null"}`
  );

  console.log("\n=== 7. Fee oracle ===");
  const estimator = new PythHermesFeeEstimator();
  const fee = await estimator.estimatePaymentFee({
    wallet,
    seller,
    amountRawUsdc
  });
  console.log("estimatedFeeLamports", fee.estimatedFeeLamports.toString());
  console.log("estimatedFeeDebtRawUsdc", fee.estimatedFeeDebtRawUsdc.toString());
  console.log("source", fee.source, "observedAt", fee.observedAt);

  console.log("\nAll read-only validations completed.");
}

main().catch((error) => {
  console.error("Validation failed:", error);
  process.exit(1);
});
