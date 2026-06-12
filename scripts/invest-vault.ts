/**
 * Invest crank: moves the vault's idle (available) USDC into its allocated
 * Kamino lending reserves so the vault starts accruing yield.
 *
 * The kVault invest instruction is a permissionless crank; the sponsor only
 * pays transaction fees (and a one-time USDC ATA rent). One transaction is
 * sent per reserve to stay within size limits.
 *
 * Usage:
 *   SOLANA_RPC_URL=... SUBLY_SPONSOR_KEYPAIR_PATH=... npx tsx scripts/invest-vault.ts
 */
import {
  DEFAULT_RECENT_SLOT_DURATION_MS,
  KaminoVaultClient,
  kaminoVaultId,
  PROGRAM_ID as KLEND_PROGRAM_ID
} from "@kamino-finance/klend-sdk";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";
import {
  appendTransactionMessageInstructions,
  assertIsFullySignedTransaction,
  assertIsTransactionWithinSizeLimit,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Signature
} from "@solana/kit";
import { SUBLY_VAULT } from "../src/config/constants.js";
import { KaminoVaultAdapter } from "../src/kamino/vault-adapter.js";
import { loadKeyPairSigner } from "../src/solana/keys.js";
import { createRpcFromEnv } from "../src/solana/rpc.js";

async function main() {
  const sponsor = await loadKeyPairSigner({
    base58Secret: process.env.SUBLY_SPONSOR_KEYPAIR,
    jsonFilePath: process.env.SUBLY_SPONSOR_KEYPAIR_PATH,
    label: "SUBLY_SPONSOR_KEYPAIR"
  });
  const rpc = createRpcFromEnv();
  const adapter = new KaminoVaultAdapter({
    rpc,
    vaultAddress: SUBLY_VAULT.address
  });
  const client = new KaminoVaultClient(
    rpc,
    DEFAULT_RECENT_SLOT_DURATION_MS,
    kaminoVaultId,
    KLEND_PROGRAM_ID
  );

  const context = await adapter.loadContext();
  console.log("vault tokenAvailableRaw:", context.tokenAvailableRaw.toString());
  const vault = adapter.vaultHandle(context.vaultState);

  for (const [reserveAddress, reserve] of context.reservesMap) {
    console.log(`\ninvest into reserve ${reserveAddress}`);
    let investIxs;
    try {
      investIxs = await client.investSingleReserveIxs(
        sponsor,
        vault,
        { address: reserveAddress, state: reserve.state },
        context.reservesMap,
        true
      );
    } catch (error) {
      console.log(
        `  skipped (could not build invest instructions): ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      continue;
    }

    const latest = await rpc
      .getLatestBlockhash({ commitment: "finalized" })
      .send();
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(sponsor, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(latest.value, m),
      (m) =>
        appendTransactionMessageInstructions(
          [getSetComputeUnitLimitInstruction({ units: 600_000 }), ...investIxs],
          m
        )
    );
    const signed = await signTransactionMessageWithSigners(message);
    assertIsFullySignedTransaction(signed);
    assertIsTransactionWithinSizeLimit(signed);
    const signature = getSignatureFromTransaction(signed);
    try {
      await rpc
        .sendTransaction(getBase64EncodedWireTransaction(signed), {
          encoding: "base64",
          skipPreflight: false,
          preflightCommitment: "confirmed"
        })
        .send();
      console.log("  sent", signature);
      await waitForConfirmation(rpc, signature);
      console.log("  confirmed", signature);
    } catch (error) {
      // A reserve whose target delta is below the vault's minimum invest
      // amount fails preflight; report it and keep cranking the others.
      console.log(
        `  failed (likely below minimum invest amount): ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  const after = await adapter.loadContext();
  console.log("\nvault tokenAvailableRaw after:", after.tokenAvailableRaw.toString());
  console.log("exchangeRateScaled:", after.exchangeRateScaled.toString());
}

async function waitForConfirmation(
  rpc: ReturnType<typeof createRpcFromEnv>,
  signature: Signature,
  timeoutMs = 60_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const statuses = await rpc
      .getSignatureStatuses([signature], { searchTransactionHistory: false })
      .send();
    const status = statuses.value[0];
    if (status?.err != null) {
      throw new Error(
        `Transaction ${signature} failed: ${JSON.stringify(status.err)}`
      );
    }
    if (
      status?.confirmationStatus === "confirmed" ||
      status?.confirmationStatus === "finalized"
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  throw new Error(`Timed out waiting for confirmation of ${signature}`);
}

await main();
