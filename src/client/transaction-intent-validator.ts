import bs58 from "bs58";
import { getCompiledTransactionMessageDecoder } from "@solana/kit";
import {
  PAYMENT_SCHEME,
  SOLANA_MAINNET_NETWORK,
  SPL_TOKEN_PROGRAM_ID,
  SUBLY_VAULT,
  USDC_DECIMALS
} from "../config/constants.js";
import { computeRequestBindingHash } from "../domain/request-binding.js";
import { deriveAssociatedTokenAddress } from "../lib/associated-token-account.js";
import { sha256TaggedHex } from "../lib/hash.js";

export const COMPUTE_BUDGET_PROGRAM_ID =
  "ComputeBudget111111111111111111111111111111";
export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
export const ASSOCIATED_TOKEN_PROGRAM_ID =
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
export const KVAULT_PROGRAM_ID = "KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd";
export const KAMINO_FARMS_PROGRAM_ID =
  "FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr";

const KVAULT_WITHDRAW_DISCRIMINATOR = Uint8Array.from([
  183, 18, 70, 156, 148, 109, 161, 34
]);
const KVAULT_WITHDRAW_FROM_AVAILABLE_DISCRIMINATOR = Uint8Array.from([
  19, 131, 112, 155, 170, 220, 34, 57
]);
const KVAULT_DEPOSIT_DISCRIMINATOR = Uint8Array.from([
  242, 35, 198, 137, 82, 225, 242, 182
]);
const U64_MAX = 18_446_744_073_709_551_615n;
/** Hard cap for the rent funded by the sponsor for the temporary account. */
const MAX_TEMP_ACCOUNT_LAMPORTS = 10_000_000n;
const DEFAULT_MAX_COMPUTE_UNIT_LIMIT = 1_400_000;
const DEFAULT_MAX_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS = 100_000n;

export class IntentValidationError extends Error {
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = "IntentValidationError";
    this.reason = reason;
  }
}

function reject(reason: string, message: string): never {
  throw new IntentValidationError(reason, message);
}

export interface PaymentSigningIntent {
  paymentId: string;
  sellerRequestId: string;
  wallet: string;
  network: string;
  scheme: string;
  httpMethod: string;
  canonicalResourceUrl: string;
  requestBodyHash: string;
  requestBindingHash: string;
  seller: string;
  vault: string;
  farm: string;
  shareMint: string;
  asset: string;
  amountRawUsdc: string;
  payTo: string;
  sellerUsdcAta: string;
  feePayer: string;
  temporarySettlementTokenAccount: string;
  dustRecipientUsdcAta: string;
  maxSharesToRedeemRaw: string;
  memo: string;
  expiresAt: string;
  preparedMessageHash: string;
}

export interface DepositSigningIntent {
  wallet: string;
  vault: string;
  farm: string;
  shareMint: string;
  asset: string;
  amountRawUsdc: string;
  feePayer: string;
  expiresAt: string;
  preparedMessageHash: string;
}

export interface WithdrawalSigningIntent {
  wallet: string;
  vault: string;
  farm: string;
  shareMint: string;
  asset: string;
  destinationUsdcAta: string;
  maxSharesToRedeemRaw: string;
  allowFullExit: boolean;
  feePayer: string;
  expiresAt: string;
  preparedMessageHash: string;
}

interface DecodedInstruction {
  programAddress: string;
  accounts: string[];
  data: Uint8Array;
}

export interface DecodedIntentTransaction {
  feePayer: string;
  requiredSigners: string[];
  instructions: DecodedInstruction[];
  messageHash: string;
}

export interface IntentValidationPolicy {
  maxComputeUnitLimit?: number | undefined;
  maxComputeUnitPriceMicroLamports?: bigint | undefined;
  maxTemporaryAccountLamports?: bigint | undefined;
}

interface ResolvedIntentValidationPolicy {
  maxComputeUnitLimit: number;
  maxComputeUnitPriceMicroLamports: bigint;
  maxTemporaryAccountLamports: bigint;
}

/**
 * Decodes the wire transaction into fully resolved instructions. Lookup-table
 * loaded addresses are resolved from the supplied table contents; validation
 * fails closed when a referenced table is not provided.
 */
export function decodeIntentTransaction(params: {
  serializedTransaction: string;
  lookupTables?: Record<string, readonly string[]> | undefined;
}): DecodedIntentTransaction {
  const wire = Buffer.from(params.serializedTransaction, "base64");
  const signatureCount = readShortVec(wire, 0);
  if (signatureCount === null) {
    reject("invalid_transaction_encoding", "Cannot parse signature count");
  }
  const messageOffset = signatureCount.nextOffset + signatureCount.value * 64;
  if (messageOffset >= wire.length) {
    reject("invalid_transaction_encoding", "Transaction has no message bytes");
  }
  const messageBytes = wire.subarray(messageOffset);

  const compiled = getCompiledTransactionMessageDecoder().decode(messageBytes);
  if (compiled.version !== 0) {
    reject("unsupported_transaction_version", "Only v0 transactions are supported");
  }

  const staticAccounts = compiled.staticAccounts.map(String);
  const loadedWritable: string[] = [];
  const loadedReadonly: string[] = [];
  const lookups =
    (compiled as { addressTableLookups?: readonly unknown[] })
      .addressTableLookups ?? [];
  for (const rawLookup of lookups) {
    const lookup = rawLookup as {
      lookupTableAddress: string;
      writableIndexes?: readonly number[];
      writableIndices?: readonly number[];
      readonlyIndexes?: readonly number[];
      readableIndices?: readonly number[];
    };
    const table = params.lookupTables?.[String(lookup.lookupTableAddress)];
    if (table === undefined) {
      reject(
        "lookup_table_unresolved",
        `Transaction references unknown lookup table ${lookup.lookupTableAddress}`
      );
    }
    const writableIndexes = lookup.writableIndexes ?? lookup.writableIndices ?? [];
    const readonlyIndexes = lookup.readonlyIndexes ?? lookup.readableIndices ?? [];
    for (const index of writableIndexes) {
      const resolved = table[index];
      if (resolved === undefined) {
        reject("lookup_table_unresolved", "Lookup table index out of range");
      }
      loadedWritable.push(String(resolved));
    }
    for (const index of readonlyIndexes) {
      const resolved = table[index];
      if (resolved === undefined) {
        reject("lookup_table_unresolved", "Lookup table index out of range");
      }
      loadedReadonly.push(String(resolved));
    }
  }

  const orderedAccounts = [...staticAccounts, ...loadedWritable, ...loadedReadonly];
  const instructions: DecodedInstruction[] = compiled.instructions.map(
    (instruction) => {
      const programAddress = orderedAccounts[instruction.programAddressIndex];
      if (programAddress === undefined) {
        reject("invalid_transaction_encoding", "Program index out of range");
      }
      const accounts = (instruction.accountIndices ?? []).map((index) => {
        const account = orderedAccounts[index];
        if (account === undefined) {
          reject("invalid_transaction_encoding", "Account index out of range");
        }
        return account;
      });
      return {
        programAddress,
        accounts,
        data:
          instruction.data === undefined
            ? new Uint8Array()
            : Uint8Array.from(instruction.data)
      };
    }
  );

  const feePayer = staticAccounts[0];
  if (feePayer === undefined) {
    reject("invalid_transaction_encoding", "Transaction has no fee payer");
  }

  return {
    feePayer,
    requiredSigners: staticAccounts.slice(0, compiled.header.numSignerAccounts),
    instructions,
    messageHash: sha256TaggedHex(Buffer.from(messageBytes))
  };
}

/**
 * Structured-intent validation for the canonical payment settlement
 * transaction. This is the provider-side pre-sign validation required by the
 * design: a signer that cannot perform these checks is not launch-ready.
 */
export function validatePaymentIntentTransaction(params: {
  intent: PaymentSigningIntent;
  serializedTransaction: string;
  lookupTables?: Record<string, readonly string[]> | undefined;
  policy?: IntentValidationPolicy | undefined;
  nowMs?: number;
}): void {
  const { intent } = params;
  const now = params.nowMs ?? Date.now();
  const policy = resolveIntentValidationPolicy(params.policy);

  if (new Date(intent.expiresAt).getTime() <= now) {
    reject("expired", "Payment intent has expired");
  }
  if (intent.scheme !== PAYMENT_SCHEME) {
    reject("scheme_mismatch", `scheme must be ${PAYMENT_SCHEME}`);
  }
  if (intent.network !== SOLANA_MAINNET_NETWORK) {
    reject("network_mismatch", "Unsupported network");
  }
  if (intent.vault !== SUBLY_VAULT.address) {
    reject("vault_mismatch", "Unsupported vault");
  }
  if (intent.shareMint !== SUBLY_VAULT.shareMint) {
    reject("share_mint_mismatch", "Unsupported share mint");
  }
  if (intent.farm !== SUBLY_VAULT.farm) {
    reject("farm_mismatch", "Unsupported Kamino farm");
  }
  if (intent.asset !== SUBLY_VAULT.usdcMint) {
    reject("asset_mismatch", "Only USDC payments are supported");
  }
  if (intent.memo !== intent.paymentId) {
    reject("memo_mismatch", "Memo must equal the paymentId");
  }

  const expectedBinding = computeRequestBindingHash({
    sellerRequestId: intent.sellerRequestId,
    httpMethod: intent.httpMethod,
    canonicalResourceUrl: intent.canonicalResourceUrl,
    requestBodyHash: intent.requestBodyHash,
    seller: intent.seller,
    asset: intent.asset,
    amountRawUsdc: intent.amountRawUsdc,
    payTo: intent.payTo,
    sellerUsdcAta: intent.sellerUsdcAta
  });
  if (expectedBinding !== intent.requestBindingHash) {
    reject(
      "request_binding_mismatch",
      "requestBindingHash does not match the request fields"
    );
  }

  const expectedSellerAta = deriveAssociatedTokenAddress({
    owner: intent.payTo,
    mint: intent.asset
  });
  if (expectedSellerAta !== intent.sellerUsdcAta) {
    reject(
      "seller_ata_mismatch",
      "sellerUsdcAta must be the associated USDC account for payTo"
    );
  }
  const expectedDustAta = deriveAssociatedTokenAddress({
    owner: intent.wallet,
    mint: intent.asset
  });
  if (expectedDustAta !== intent.dustRecipientUsdcAta) {
    reject(
      "dust_recipient_mismatch",
      "dustRecipientUsdcAta must be the agent wallet's USDC ATA"
    );
  }

  const decoded = decodeIntentTransaction({
    serializedTransaction: params.serializedTransaction,
    ...(params.lookupTables === undefined
      ? {}
      : { lookupTables: params.lookupTables })
  });
  if (decoded.messageHash !== intent.preparedMessageHash) {
    reject("message_hash_mismatch", "Prepared message hash mismatch");
  }
  if (decoded.feePayer !== intent.feePayer) {
    reject("fee_payer_mismatch", "Transaction fee payer is not the Subly sponsor");
  }
  const expectedSigners = new Set([
    intent.feePayer,
    intent.wallet,
    intent.temporarySettlementTokenAccount
  ]);
  if (
    decoded.requiredSigners.length !== expectedSigners.size ||
    !decoded.requiredSigners.every((signer) => expectedSigners.has(signer))
  ) {
    reject(
      "unexpected_signers",
      "Transaction signers must be exactly the sponsor, the agent wallet, and the temporary settlement account"
    );
  }

  const ixs = [...decoded.instructions];
  expectComputeBudgetPair(ixs, policy);
  expectCreateTemporaryAccount(ixs, intent, policy);
  expectInitializeTemporaryAccount(ixs, intent);
  consumeFarmInstructions(ixs, intent);
  expectKvaultWithdraw(ixs, {
    wallet: intent.wallet,
    vault: intent.vault,
    shareMint: intent.shareMint,
    asset: intent.asset,
    userTokenAccount: intent.temporarySettlementTokenAccount,
    maxSharesToRedeemRaw: BigInt(intent.maxSharesToRedeemRaw),
    allowFullExit: false
  });
  expectTransferChecked(ixs, {
    source: intent.temporarySettlementTokenAccount,
    mint: intent.asset,
    destination: intent.sellerUsdcAta,
    authority: intent.wallet,
    amount: BigInt(intent.amountRawUsdc),
    label: "seller transfer"
  });
  if (
    ixs[0] !== undefined &&
    ixs[0].programAddress === SPL_TOKEN_PROGRAM_ID &&
    ixs[0].data[0] === 12
  ) {
    expectTransferChecked(ixs, {
      source: intent.temporarySettlementTokenAccount,
      mint: intent.asset,
      destination: intent.dustRecipientUsdcAta,
      authority: intent.wallet,
      amount: null,
      label: "dust sweep"
    });
  }
  expectCloseAccount(ixs, {
    account: intent.temporarySettlementTokenAccount,
    destination: intent.feePayer,
    owner: intent.wallet
  });
  expectMemo(ixs, intent.memo);
  if (ixs.length > 0) {
    reject(
      "unexpected_instruction",
      `Transaction contains ${ixs.length} unexpected trailing instruction(s)`
    );
  }
}

export function validateDepositIntentTransaction(params: {
  intent: DepositSigningIntent;
  serializedTransaction: string;
  lookupTables?: Record<string, readonly string[]> | undefined;
  policy?: IntentValidationPolicy | undefined;
  nowMs?: number;
}): void {
  const { intent } = params;
  const now = params.nowMs ?? Date.now();
  const policy = resolveIntentValidationPolicy(params.policy);
  if (new Date(intent.expiresAt).getTime() <= now) {
    reject("expired", "Deposit intent has expired");
  }
  assertVaultIntentTargets(intent);

  const decoded = decodeIntentTransaction({
    serializedTransaction: params.serializedTransaction,
    ...(params.lookupTables === undefined
      ? {}
      : { lookupTables: params.lookupTables })
  });
  if (decoded.messageHash !== intent.preparedMessageHash) {
    reject("message_hash_mismatch", "Prepared message hash mismatch");
  }
  if (decoded.feePayer !== intent.feePayer) {
    reject("fee_payer_mismatch", "Transaction fee payer is not the Subly sponsor");
  }

  let sawDeposit = false;
  for (const ix of decoded.instructions) {
    switch (ix.programAddress) {
      case COMPUTE_BUDGET_PROGRAM_ID:
        validateComputeBudgetInstruction(ix, policy);
        break;
      case ASSOCIATED_TOKEN_PROGRAM_ID:
        expectAtaCreateForOwner(ix, intent.wallet);
        break;
      case MEMO_PROGRAM_ID:
        break;
      case KVAULT_PROGRAM_ID: {
        if (!bytesStartWith(ix.data, KVAULT_DEPOSIT_DISCRIMINATOR)) {
          reject("unexpected_instruction", "Unexpected KVault instruction in deposit");
        }
        const maxAmount = readU64LE(ix.data, 8);
        if (maxAmount !== BigInt(intent.amountRawUsdc)) {
          reject("amount_mismatch", "Deposit amount does not match the intent");
        }
        if (ix.accounts[0] !== intent.wallet) {
          reject("wallet_mismatch", "Deposit user is not the agent wallet");
        }
        if (ix.accounts[1] !== intent.vault) {
          reject("vault_mismatch", "Deposit vault mismatch");
        }
        if (ix.accounts[3] !== intent.asset) {
          reject("asset_mismatch", "Deposit token mint mismatch");
        }
        if (ix.accounts[5] !== intent.shareMint) {
          reject("share_mint_mismatch", "Deposit share mint mismatch");
        }
        const expectedSourceAta = deriveAssociatedTokenAddress({
          owner: intent.wallet,
          mint: intent.asset
        });
        if (ix.accounts[6] !== expectedSourceAta) {
          reject(
            "source_ata_mismatch",
            "Deposit source must be the agent wallet's USDC ATA"
          );
        }
        sawDeposit = true;
        break;
      }
      default:
        reject(
          "unexpected_instruction",
          `Unexpected program ${ix.programAddress} in deposit transaction`
        );
    }
  }
  if (!sawDeposit) {
    reject("missing_instruction", "Deposit transaction has no KVault deposit");
  }
}

export function validateWithdrawalIntentTransaction(params: {
  intent: WithdrawalSigningIntent;
  serializedTransaction: string;
  lookupTables?: Record<string, readonly string[]> | undefined;
  policy?: IntentValidationPolicy | undefined;
  nowMs?: number;
}): void {
  const { intent } = params;
  const now = params.nowMs ?? Date.now();
  const policy = resolveIntentValidationPolicy(params.policy);
  if (new Date(intent.expiresAt).getTime() <= now) {
    reject("expired", "Withdrawal intent has expired");
  }
  assertVaultIntentTargets(intent);
  const expectedDestination = deriveAssociatedTokenAddress({
    owner: intent.wallet,
    mint: intent.asset
  });
  if (expectedDestination !== intent.destinationUsdcAta) {
    reject(
      "destination_mismatch",
      "Withdrawal destination must be the agent wallet's USDC ATA"
    );
  }

  const decoded = decodeIntentTransaction({
    serializedTransaction: params.serializedTransaction,
    ...(params.lookupTables === undefined
      ? {}
      : { lookupTables: params.lookupTables })
  });
  if (decoded.messageHash !== intent.preparedMessageHash) {
    reject("message_hash_mismatch", "Prepared message hash mismatch");
  }
  if (decoded.feePayer !== intent.feePayer) {
    reject("fee_payer_mismatch", "Transaction fee payer is not the Subly sponsor");
  }

  let sawWithdraw = false;
  let farmUserState: string | null = null;
  let farmInstructionCount = 0;
  for (const ix of decoded.instructions) {
    switch (ix.programAddress) {
      case COMPUTE_BUDGET_PROGRAM_ID:
        validateComputeBudgetInstruction(ix, policy);
        break;
      case MEMO_PROGRAM_ID:
        break;
      case KAMINO_FARMS_PROGRAM_ID:
        farmInstructionCount += 1;
        if (farmInstructionCount === 1) {
          farmUserState = validateFarmUnstakeInstruction(ix, intent);
        } else if (farmInstructionCount === 2) {
          validateFarmWithdrawInstruction(ix, intent, farmUserState);
        } else {
          reject(
            "farm_instruction_mismatch",
            "Withdrawal may contain only one farm unstake and one farm withdrawal"
          );
        }
        break;
      case ASSOCIATED_TOKEN_PROGRAM_ID:
        expectAtaCreateForOwner(ix, intent.wallet);
        break;
      case SPL_TOKEN_PROGRAM_ID: {
        // The SDK closes the share ATA back to the wallet on full exits.
        if (ix.data[0] !== 9) {
          reject(
            "unexpected_instruction",
            "Only CloseAccount token instructions are allowed in withdrawals"
          );
        }
        if (ix.accounts[1] !== intent.wallet || ix.accounts[2] !== intent.wallet) {
          reject(
            "unexpected_instruction",
            "Withdrawal CloseAccount must pay out to the agent wallet"
          );
        }
        break;
      }
      case KVAULT_PROGRAM_ID: {
        if (sawWithdraw) {
          reject(
            "withdraw_mismatch",
            "Withdrawal may contain only one KVault withdraw instruction"
          );
        }
        validateKvaultWithdrawInstruction(ix, {
          wallet: intent.wallet,
          vault: intent.vault,
          shareMint: intent.shareMint,
          asset: intent.asset,
          userTokenAccount: intent.destinationUsdcAta,
          maxSharesToRedeemRaw: BigInt(intent.maxSharesToRedeemRaw),
          allowFullExit: intent.allowFullExit
        });
        sawWithdraw = true;
        break;
      }
      default:
        reject(
          "unexpected_instruction",
          `Unexpected program ${ix.programAddress} in withdrawal transaction`
        );
    }
  }
  if (!sawWithdraw) {
    reject("missing_instruction", "Withdrawal transaction has no KVault withdraw");
  }
  if (farmInstructionCount === 1) {
    reject(
      "farm_instruction_mismatch",
      "A farm unstake must be followed by a farm withdrawal"
    );
  }
}

function assertVaultIntentTargets(intent: {
  vault: string;
  farm: string;
  shareMint: string;
  asset: string;
}): void {
  if (intent.vault !== SUBLY_VAULT.address) {
    reject("vault_mismatch", "Unsupported vault");
  }
  if (intent.shareMint !== SUBLY_VAULT.shareMint) {
    reject("share_mint_mismatch", "Unsupported share mint");
  }
  if (intent.farm !== SUBLY_VAULT.farm) {
    reject("farm_mismatch", "Unsupported Kamino farm");
  }
  if (intent.asset !== SUBLY_VAULT.usdcMint) {
    reject("asset_mismatch", "Only USDC is supported");
  }
}

function resolveIntentValidationPolicy(
  policy: IntentValidationPolicy | undefined
): ResolvedIntentValidationPolicy {
  const resolved = {
    maxComputeUnitLimit:
      policy?.maxComputeUnitLimit ?? DEFAULT_MAX_COMPUTE_UNIT_LIMIT,
    maxComputeUnitPriceMicroLamports:
      policy?.maxComputeUnitPriceMicroLamports ??
      DEFAULT_MAX_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS,
    maxTemporaryAccountLamports:
      policy?.maxTemporaryAccountLamports ?? MAX_TEMP_ACCOUNT_LAMPORTS
  };

  if (
    !Number.isSafeInteger(resolved.maxComputeUnitLimit) ||
    resolved.maxComputeUnitLimit <= 0
  ) {
    reject("invalid_policy", "maxComputeUnitLimit must be a positive safe integer");
  }
  if (resolved.maxComputeUnitPriceMicroLamports < 0n) {
    reject(
      "invalid_policy",
      "maxComputeUnitPriceMicroLamports must be non-negative"
    );
  }
  if (resolved.maxTemporaryAccountLamports <= 0n) {
    reject("invalid_policy", "maxTemporaryAccountLamports must be positive");
  }

  return resolved;
}

function expectComputeBudgetPair(
  ixs: DecodedInstruction[],
  policy: ResolvedIntentValidationPolicy
): void {
  for (const discriminator of [2, 3]) {
    const ix = ixs.shift();
    if (
      ix === undefined ||
      ix.programAddress !== COMPUTE_BUDGET_PROGRAM_ID ||
      ix.data[0] !== discriminator
    ) {
      reject(
        "compute_budget_mismatch",
        "Transaction must start with ComputeBudget limit and price instructions"
      );
    }
    validateComputeBudgetInstruction(ix, policy);
  }
}

function validateComputeBudgetInstruction(
  ix: DecodedInstruction,
  policy: ResolvedIntentValidationPolicy
): void {
  switch (ix.data[0]) {
    case 2: {
      const units = readU32LE(ix.data, 1);
      if (units <= 0 || units > policy.maxComputeUnitLimit) {
        reject(
          "compute_budget_mismatch",
          `Compute unit limit ${units} exceeds policy maximum ${policy.maxComputeUnitLimit}`
        );
      }
      break;
    }
    case 3: {
      const microLamports = readU64LE(ix.data, 1);
      if (microLamports > policy.maxComputeUnitPriceMicroLamports) {
        reject(
          "compute_budget_mismatch",
          `Compute unit price ${microLamports} exceeds policy maximum ${policy.maxComputeUnitPriceMicroLamports}`
        );
      }
      break;
    }
    default:
      reject("compute_budget_mismatch", "Unexpected ComputeBudget instruction");
  }
}

function expectCreateTemporaryAccount(
  ixs: DecodedInstruction[],
  intent: PaymentSigningIntent,
  policy: ResolvedIntentValidationPolicy
): void {
  const ix = ixs.shift();
  if (ix === undefined || ix.programAddress !== SYSTEM_PROGRAM_ID) {
    reject("temp_account_mismatch", "Expected System createAccount instruction");
  }
  if (ix.data.length < 52 || readU32LE(ix.data, 0) !== 0) {
    reject("temp_account_mismatch", "Expected createAccount discriminator");
  }
  const lamports = readU64LE(ix.data, 4);
  const space = readU64LE(ix.data, 12);
  const owner = bs58.encode(ix.data.subarray(20, 52));
  if (space !== 165n) {
    reject("temp_account_mismatch", "Temporary account space must be 165 bytes");
  }
  if (owner !== SPL_TOKEN_PROGRAM_ID) {
    reject("temp_account_mismatch", "Temporary account owner must be the token program");
  }
  if (lamports > policy.maxTemporaryAccountLamports) {
    reject("temp_account_mismatch", "Temporary account rent exceeds the cap");
  }
  if (ix.accounts[0] !== intent.feePayer) {
    reject("temp_account_mismatch", "Temporary account must be funded by the sponsor");
  }
  if (ix.accounts[1] !== intent.temporarySettlementTokenAccount) {
    reject("temp_account_mismatch", "createAccount target is not the temporary account");
  }
}

function expectInitializeTemporaryAccount(
  ixs: DecodedInstruction[],
  intent: PaymentSigningIntent
): void {
  const ix = ixs.shift();
  if (
    ix === undefined ||
    ix.programAddress !== SPL_TOKEN_PROGRAM_ID ||
    ix.data[0] !== 18
  ) {
    reject("temp_account_mismatch", "Expected InitializeAccount3 instruction");
  }
  const owner = bs58.encode(ix.data.subarray(1, 33));
  if (owner !== intent.wallet) {
    reject(
      "temp_account_mismatch",
      "Temporary account token authority must be the agent wallet"
    );
  }
  if (ix.accounts[0] !== intent.temporarySettlementTokenAccount) {
    reject("temp_account_mismatch", "InitializeAccount3 target mismatch");
  }
  if (ix.accounts[1] !== intent.asset) {
    reject("temp_account_mismatch", "Temporary account mint must be USDC");
  }
}

function consumeFarmInstructions(
  ixs: DecodedInstruction[],
  intent: Pick<PaymentSigningIntent, "wallet" | "farm" | "shareMint">
): void {
  if (ixs[0]?.programAddress !== KAMINO_FARMS_PROGRAM_ID) {
    return;
  }
  const unstake = ixs.shift()!;
  const userState = validateFarmUnstakeInstruction(unstake, intent);
  if (ixs[0]?.programAddress !== KAMINO_FARMS_PROGRAM_ID) {
    reject(
      "farm_instruction_mismatch",
      "A farm unstake must be followed by a farm withdrawal"
    );
  }
  const withdraw = ixs.shift()!;
  validateFarmWithdrawInstruction(withdraw, intent, userState);
  if (ixs[0]?.programAddress === KAMINO_FARMS_PROGRAM_ID) {
    reject(
      "farm_instruction_mismatch",
      "Payment may contain only one farm unstake and one farm withdrawal"
    );
  }
}

const KAMINO_FARMS_UNSTAKE_DISCRIMINATOR = Uint8Array.from([
  90, 95, 107, 42, 205, 124, 50, 225
]);
const KAMINO_FARMS_WITHDRAW_UNSTAKED_DISCRIMINATOR = Uint8Array.from([
  36, 102, 187, 49, 220, 36, 132, 67
]);

function validateFarmUnstakeInstruction(
  ix: DecodedInstruction,
  intent: Pick<PaymentSigningIntent, "wallet" | "farm">
): string {
  if (
    ix.programAddress !== KAMINO_FARMS_PROGRAM_ID ||
    !bytesStartWith(ix.data, KAMINO_FARMS_UNSTAKE_DISCRIMINATOR) ||
    ix.data.length !== 24 ||
    readU128LE(ix.data, 8) <= 0n
  ) {
    reject(
      "farm_instruction_mismatch",
      "Expected a non-zero Kamino farm unstake instruction"
    );
  }
  if (ix.accounts.length !== 4) {
    reject(
      "farm_instruction_mismatch",
      "Farm unstake account list is not canonical"
    );
  }
  if (ix.accounts[0] !== intent.wallet) {
    reject("farm_instruction_mismatch", "Farm unstake owner must be the agent wallet");
  }
  if (ix.accounts[2] !== intent.farm) {
    reject("farm_instruction_mismatch", "Farm unstake target is not the approved farm");
  }
  return ix.accounts[1]!;
}

function validateFarmWithdrawInstruction(
  ix: DecodedInstruction,
  intent: Pick<PaymentSigningIntent, "wallet" | "farm" | "shareMint">,
  expectedUserState: string | null
): void {
  if (
    ix.programAddress !== KAMINO_FARMS_PROGRAM_ID ||
    !bytesStartWith(ix.data, KAMINO_FARMS_WITHDRAW_UNSTAKED_DISCRIMINATOR) ||
    ix.data.length !== 8
  ) {
    reject(
      "farm_instruction_mismatch",
      "Expected a canonical Kamino farm withdrawal instruction"
    );
  }
  if (ix.accounts.length !== 7) {
    reject(
      "farm_instruction_mismatch",
      "Farm withdrawal account list is not canonical"
    );
  }
  const expectedSharesAta = deriveAssociatedTokenAddress({
    owner: intent.wallet,
    mint: intent.shareMint
  });
  if (
    ix.accounts[0] !== intent.wallet ||
    ix.accounts[1] !== expectedUserState ||
    ix.accounts[2] !== intent.farm ||
    ix.accounts[3] !== expectedSharesAta ||
    ix.accounts[6] !== SPL_TOKEN_PROGRAM_ID
  ) {
    reject(
      "farm_instruction_mismatch",
      "Farm withdrawal must return the approved vault shares to the agent wallet"
    );
  }
}

interface KvaultWithdrawExpectation {
  wallet: string;
  vault: string;
  shareMint: string;
  asset: string;
  userTokenAccount: string;
  maxSharesToRedeemRaw: bigint;
  allowFullExit: boolean;
}

function expectKvaultWithdraw(
  ixs: DecodedInstruction[],
  expectation: KvaultWithdrawExpectation
): void {
  const ix = ixs.shift();
  if (ix === undefined || ix.programAddress !== KVAULT_PROGRAM_ID) {
    reject("withdraw_mismatch", "Expected KVault withdraw instruction");
  }
  validateKvaultWithdrawInstruction(ix, expectation);
}

function validateKvaultWithdrawInstruction(
  ix: DecodedInstruction,
  expectation: KvaultWithdrawExpectation
): void {
  const isWithdraw = bytesStartWith(ix.data, KVAULT_WITHDRAW_DISCRIMINATOR);
  const isWithdrawFromAvailable = bytesStartWith(
    ix.data,
    KVAULT_WITHDRAW_FROM_AVAILABLE_DISCRIMINATOR
  );
  if (!isWithdraw && !isWithdrawFromAvailable) {
    reject("withdraw_mismatch", "Unexpected KVault instruction");
  }

  const sharesAmount = readU64LE(ix.data, 8);
  const fullExit = sharesAmount === U64_MAX;
  if (fullExit && !expectation.allowFullExit) {
    reject("withdraw_mismatch", "Full-exit share burn is not allowed for this intent");
  }
  if (!fullExit && sharesAmount > expectation.maxSharesToRedeemRaw) {
    reject(
      "shares_exceed_max",
      `Withdraw burns ${sharesAmount} shares which exceeds the approved maximum ${expectation.maxSharesToRedeemRaw}`
    );
  }

  // Account order is fixed by the KVault program for both variants:
  // [user, vaultState, globalConfig, tokenVault, baseVaultAuthority,
  //  userTokenAta, tokenMint, userSharesAta, sharesMint, ...]
  if (ix.accounts[0] !== expectation.wallet) {
    reject("withdraw_mismatch", "Withdraw user is not the agent wallet");
  }
  if (ix.accounts[1] !== expectation.vault) {
    reject("withdraw_mismatch", "Withdraw vault mismatch");
  }
  if (ix.accounts[5] !== expectation.userTokenAccount) {
    reject(
      "withdraw_mismatch",
      "Withdraw token destination is not the approved account"
    );
  }
  if (ix.accounts[6] !== expectation.asset) {
    reject("withdraw_mismatch", "Withdraw token mint mismatch");
  }
  const expectedSharesAta = deriveAssociatedTokenAddress({
    owner: expectation.wallet,
    mint: expectation.shareMint
  });
  if (ix.accounts[7] !== expectedSharesAta) {
    reject("withdraw_mismatch", "Withdraw share source must be the agent share ATA");
  }
  if (ix.accounts[8] !== expectation.shareMint) {
    reject("withdraw_mismatch", "Withdraw share mint mismatch");
  }
}

function expectTransferChecked(
  ixs: DecodedInstruction[],
  expectation: {
    source: string;
    mint: string;
    destination: string;
    authority: string;
    amount: bigint | null;
    label: string;
  }
): void {
  const ix = ixs.shift();
  if (
    ix === undefined ||
    ix.programAddress !== SPL_TOKEN_PROGRAM_ID ||
    ix.data[0] !== 12
  ) {
    reject("transfer_mismatch", `Expected TransferChecked for ${expectation.label}`);
  }
  const amount = readU64LE(ix.data, 1);
  const decimals = ix.data[9];
  if (expectation.amount !== null && amount !== expectation.amount) {
    reject(
      "amount_mismatch",
      `${expectation.label} amount ${amount} does not match ${expectation.amount}`
    );
  }
  if (decimals !== USDC_DECIMALS) {
    reject("transfer_mismatch", `${expectation.label} has unexpected decimals`);
  }
  if (ix.accounts[0] !== expectation.source) {
    reject("transfer_mismatch", `${expectation.label} source mismatch`);
  }
  if (ix.accounts[1] !== expectation.mint) {
    reject("transfer_mismatch", `${expectation.label} mint mismatch`);
  }
  if (ix.accounts[2] !== expectation.destination) {
    reject("transfer_mismatch", `${expectation.label} destination mismatch`);
  }
  if (ix.accounts[3] !== expectation.authority) {
    reject("transfer_mismatch", `${expectation.label} authority mismatch`);
  }
}

function expectCloseAccount(
  ixs: DecodedInstruction[],
  expectation: { account: string; destination: string; owner: string }
): void {
  const ix = ixs.shift();
  if (
    ix === undefined ||
    ix.programAddress !== SPL_TOKEN_PROGRAM_ID ||
    ix.data[0] !== 9
  ) {
    reject("close_mismatch", "Expected CloseAccount instruction");
  }
  if (ix.accounts[0] !== expectation.account) {
    reject("close_mismatch", "CloseAccount target is not the temporary account");
  }
  if (ix.accounts[1] !== expectation.destination) {
    reject("close_mismatch", "CloseAccount rent destination must be the sponsor");
  }
  if (ix.accounts[2] !== expectation.owner) {
    reject("close_mismatch", "CloseAccount authority must be the agent wallet");
  }
}

function expectMemo(ixs: DecodedInstruction[], memo: string): void {
  const ix = ixs.shift();
  if (ix === undefined || ix.programAddress !== MEMO_PROGRAM_ID) {
    reject("memo_mismatch", "Expected Memo instruction");
  }
  if (Buffer.from(ix.data).toString("utf8") !== memo) {
    reject("memo_mismatch", "Memo content does not match the paymentId");
  }
}

function expectAtaCreateForOwner(ix: DecodedInstruction, owner: string): void {
  // Associated token program create / createIdempotent:
  // accounts = [payer, ata, owner, mint, systemProgram, tokenProgram]
  if (ix.accounts[2] !== owner) {
    reject(
      "unexpected_instruction",
      "Associated token account creation for a foreign owner"
    );
  }
}

function bytesStartWith(data: Uint8Array, prefix: Uint8Array): boolean {
  if (data.length < prefix.length) {
    return false;
  }
  return prefix.every((byte, index) => data[index] === byte);
}

function readU64LE(data: Uint8Array, offset: number): bigint {
  if (data.length < offset + 8) {
    reject("invalid_transaction_encoding", "Instruction data too short for u64");
  }
  return Buffer.from(data.subarray(offset, offset + 8)).readBigUInt64LE(0);
}

function readU32LE(data: Uint8Array, offset: number): number {
  if (data.length < offset + 4) {
    reject("invalid_transaction_encoding", "Instruction data too short for u32");
  }
  return Buffer.from(data.subarray(offset, offset + 4)).readUInt32LE(0);
}

function readU128LE(data: Uint8Array, offset: number): bigint {
  if (data.length < offset + 16) {
    reject("invalid_transaction_encoding", "Instruction data too short for u128");
  }
  let value = 0n;
  for (let index = 0; index < 16; index += 1) {
    value |= BigInt(data[offset + index]!) << BigInt(index * 8);
  }
  return value;
}

function readShortVec(
  bytes: Uint8Array,
  startOffset: number
): { value: number; nextOffset: number } | null {
  let value = 0;
  let shift = 0;
  let offset = startOffset;

  while (offset < bytes.length) {
    const byte = bytes[offset]!;
    value |= (byte & 0x7f) << shift;
    offset += 1;
    if ((byte & 0x80) === 0) {
      return { value, nextOffset: offset };
    }
    shift += 7;
    if (shift > 28) {
      return null;
    }
  }

  return null;
}
