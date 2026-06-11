/**
 * Creates (or extends) the Subly settlement address lookup table.
 *
 * The canonical settlement transaction references the vault reserves, farm
 * accounts, and auxiliary programs. When the curator's vault LUT does not
 * include them the transaction can exceed the 1232-byte limit, so Subly
 * maintains its own LUT funded by the sponsor wallet.
 *
 * Usage (sponsor needs SOL for rent + fees):
 *   SOLANA_RPC_URL=... SUBLY_SPONSOR_KEYPAIR=<base58> npx tsx scripts/create-settlement-lut.ts [agentWallet...]
 *
 * Prints the LUT address; set it as SUBLY_EXTRA_LOOKUP_TABLES.
 */
import {
  findAddressLookupTablePda,
  getCreateLookupTableInstructionAsync,
  getExtendLookupTableInstruction
} from "@solana-program/address-lookup-table";
import {
  getKvaultGlobalConfigPda,
  getEventAuthorityPda,
  getAssociatedTokenAddress,
  kaminoVaultId,
  lendingMarketAuthPda,
  PROGRAM_ID as KLEND_PROGRAM_ID
} from "@kamino-finance/klend-sdk";
import {
  address,
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
  type Address,
  type Signature
} from "@solana/kit";
import { SUBLY_VAULT } from "../src/config/constants.js";
import { KaminoVaultAdapter } from "../src/kamino/vault-adapter.js";
import { loadKeyPairSigner } from "../src/solana/keys.js";
import { createRpcFromEnv } from "../src/solana/rpc.js";

const MEMO_PROGRAM = address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const COMPUTE_BUDGET_PROGRAM = address(
  "ComputeBudget111111111111111111111111111111"
);
const FARMS_PROGRAM = address("FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr");
const SYSVAR_INSTRUCTIONS = address("Sysvar1nstructions1111111111111111111111111");

async function main() {
  const rpc = createRpcFromEnv();
  const sponsor = await loadKeyPairSigner({
    base58Secret: process.env.SUBLY_SPONSOR_KEYPAIR,
    jsonFilePath: process.env.SUBLY_SPONSOR_KEYPAIR_PATH,
    label: "SUBLY_SPONSOR_KEYPAIR"
  });
  const agentWallets = process.argv.slice(2);

  const adapter = new KaminoVaultAdapter({
    rpc,
    vaultAddress: SUBLY_VAULT.address
  });
  const context = await adapter.loadContext();

  const entries = new Set<Address>();
  entries.add(MEMO_PROGRAM);
  entries.add(COMPUTE_BUDGET_PROGRAM);
  entries.add(FARMS_PROGRAM);
  entries.add(SYSVAR_INSTRUCTIONS);
  entries.add(KLEND_PROGRAM_ID);
  entries.add(kaminoVaultId);
  entries.add(address(SUBLY_VAULT.address));
  entries.add(address(SUBLY_VAULT.usdcMint));
  entries.add(address(SUBLY_VAULT.shareMint));
  entries.add(context.vaultState.tokenVault);
  entries.add(context.vaultState.baseVaultAuthority);
  entries.add(await getKvaultGlobalConfigPda(kaminoVaultId));
  entries.add(await getEventAuthorityPda(kaminoVaultId));
  for (const [reserveAddress, reserve] of context.reservesMap) {
    entries.add(reserveAddress);
    entries.add(reserve.state.lendingMarket);
    entries.add(reserve.state.liquidity.supplyVault);
    entries.add(reserve.state.collateral.mintPubkey);
    const [marketAuthority] = await lendingMarketAuthPda(
      reserve.state.lendingMarket,
      KLEND_PROGRAM_ID
    );
    entries.add(marketAuthority);
  }
  if (context.farmState !== null) {
    entries.add(context.vaultState.vaultFarm);
    entries.add(context.farmState.farmVault);
    entries.add(context.farmState.farmVaultsAuthority);
    entries.add(context.farmState.scopePrices);
    entries.add(context.farmState.globalConfig);
  }
  for (const wallet of agentWallets) {
    entries.add(
      await getAssociatedTokenAddress(
        context.vaultState.sharesMint,
        address(wallet)
      )
    );
  }

  const recentSlot = await rpc.getSlot({ commitment: "finalized" }).send();
  const createInstruction = await getCreateLookupTableInstructionAsync({
    authority: sponsor,
    recentSlot
  });
  const [lutAddress] = await findAddressLookupTablePda({
    authority: sponsor.address,
    recentSlot
  });

  const allEntries = [...entries];
  console.log(`Creating LUT ${lutAddress} with ${allEntries.length} entries`);

  const instructions = [
    createInstruction,
    // Max ~25 addresses per extend instruction to stay within tx size.
    ...chunk(allEntries, 20).map((batch) =>
      getExtendLookupTableInstruction({
        address: lutAddress,
        authority: sponsor,
        payer: sponsor,
        addresses: batch
      })
    )
  ];

  // One create + first extend per transaction; remaining extends separately.
  // Each transaction must confirm before the next is sent: later extends
  // reference the table created/extended by the earlier ones and would fail
  // preflight against a bank that has not seen them yet.
  const first = instructions.slice(0, 2);
  const rest = instructions.slice(2);
  for (const batch of [first, ...rest.map((ix) => [ix])]) {
    // A fresh blockhash per transaction: each send waits for the previous
    // confirmation, so a single upfront blockhash could expire mid-sequence
    // and leave the LUT partially populated.
    const latest = await rpc
      .getLatestBlockhash({ commitment: "finalized" })
      .send();
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(sponsor, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(latest.value, m),
      (m) => appendTransactionMessageInstructions(batch, m)
    );
    const signed = await signTransactionMessageWithSigners(message);
    assertIsFullySignedTransaction(signed);
    assertIsTransactionWithinSizeLimit(signed);
    const signature = getSignatureFromTransaction(signed);
    await rpc
      .sendTransaction(getBase64EncodedWireTransaction(signed), {
        encoding: "base64",
        skipPreflight: false,
        preflightCommitment: "confirmed"
      })
      .send();
    console.log("sent", signature);
    await waitForConfirmation(rpc, signature);
    console.log("confirmed", signature);
  }

  console.log(`\nSet SUBLY_EXTRA_LOOKUP_TABLES=${lutAddress}`);
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

function chunk<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

main().catch((error) => {
  console.error("LUT creation failed:", error);
  process.exit(1);
});
