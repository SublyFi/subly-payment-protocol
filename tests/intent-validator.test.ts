import { describe, expect, it } from "vitest";
import {
  getEventAuthorityPda,
  getKvaultGlobalConfigPda,
  kaminoVaultId,
  PROGRAM_ID as KLEND_PROGRAM_ID,
  withdrawFromAvailable as kvaultWithdrawFromAvailable
} from "@kamino-finance/klend-sdk";
import BN from "bn.js";
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction
} from "@solana-program/compute-budget";
import { getAddMemoInstruction } from "@solana-program/memo";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  getCloseAccountInstruction,
  getInitializeAccount3Instruction,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS
} from "@solana-program/token";
import {
  address,
  blockhash,
  createNoopSigner,
  generateKeyPairSigner,
  lamports,
  type Address,
  type Instruction,
  type KeyPairSigner
} from "@solana/kit";
import {
  PAYMENT_SCHEME,
  SOLANA_MAINNET_NETWORK,
  SUBLY_VAULT,
  USDC_DECIMALS
} from "../src/config/constants.js";
import {
  IntentValidationError,
  validatePaymentIntentTransaction,
  type PaymentSigningIntent
} from "../src/client/transaction-intent-validator.js";
import { computeRequestBindingHash } from "../src/domain/request-binding.js";
import { deriveAssociatedTokenAddress } from "../src/lib/associated-token-account.js";
import { buildVersionedTransaction } from "../src/solana/tx.js";

interface Actors {
  sponsor: KeyPairSigner;
  agent: KeyPairSigner;
  temp: KeyPairSigner;
  seller: KeyPairSigner;
  attacker: KeyPairSigner;
  tokenVault: Address;
  baseVaultAuthority: Address;
}

let cachedActors: Actors | null = null;
async function actors(): Promise<Actors> {
  cachedActors ??= {
    sponsor: await generateKeyPairSigner(),
    agent: await generateKeyPairSigner(),
    temp: await generateKeyPairSigner(),
    seller: await generateKeyPairSigner(),
    attacker: await generateKeyPairSigner(),
    tokenVault: (await generateKeyPairSigner()).address,
    baseVaultAuthority: (await generateKeyPairSigner()).address
  };
  return cachedActors;
}

interface BuildOverrides {
  sellerTransferDestination?: string;
  sellerTransferAmount?: bigint;
  sharesAmount?: bigint;
  closeDestination?: string;
  initOwner?: string;
  memo?: string;
  dustDestination?: string;
  dustAmount?: bigint;
  extraInstruction?: boolean;
  feePayerOverride?: string;
  computeUnitLimit?: number;
  computeUnitPriceMicroLamports?: bigint;
}

async function buildSettlement(overrides: BuildOverrides = {}) {
  const a = await actors();
  const usdcMint = address(SUBLY_VAULT.usdcMint);
  const sellerUsdcAta = deriveAssociatedTokenAddress({
    owner: a.seller.address,
    mint: SUBLY_VAULT.usdcMint
  });
  const dustRecipientUsdcAta = deriveAssociatedTokenAddress({
    owner: a.agent.address,
    mint: SUBLY_VAULT.usdcMint
  });
  const userSharesAta = deriveAssociatedTokenAddress({
    owner: a.agent.address,
    mint: SUBLY_VAULT.shareMint
  });
  const amount = overrides.sellerTransferAmount ?? 10_000n;
  const shares = overrides.sharesAmount ?? 11_000n;
  const memoText = overrides.memo ?? "pay_test_intent";
  const agentNoop = createNoopSigner(a.agent.address);

  const withdrawIx = kvaultWithdrawFromAvailable(
    { sharesAmount: new BN(shares.toString()) },
    {
      user: agentNoop,
      vaultState: address(SUBLY_VAULT.address),
      globalConfig: await getKvaultGlobalConfigPda(kaminoVaultId),
      tokenVault: a.tokenVault,
      baseVaultAuthority: a.baseVaultAuthority,
      userTokenAta: a.temp.address,
      tokenMint: usdcMint,
      userSharesAta: address(userSharesAta),
      sharesMint: address(SUBLY_VAULT.shareMint),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      sharesTokenProgram: TOKEN_PROGRAM_ADDRESS,
      klendProgram: KLEND_PROGRAM_ID,
      eventAuthority: await getEventAuthorityPda(kaminoVaultId),
      program: kaminoVaultId
    },
    undefined,
    kaminoVaultId
  );

  const instructions: Instruction[] = [
    getSetComputeUnitLimitInstruction({
      units: overrides.computeUnitLimit ?? 1_000_000
    }),
    getSetComputeUnitPriceInstruction({
      microLamports: overrides.computeUnitPriceMicroLamports ?? 1n
    }),
    getCreateAccountInstruction({
      payer: createNoopSigner(a.sponsor.address),
      newAccount: a.temp,
      lamports: lamports(2_039_280n),
      space: 165n,
      programAddress: TOKEN_PROGRAM_ADDRESS
    }),
    getInitializeAccount3Instruction({
      account: a.temp.address,
      mint: usdcMint,
      owner: address(overrides.initOwner ?? a.agent.address)
    }),
    withdrawIx,
    getTransferCheckedInstruction({
      source: a.temp.address,
      mint: usdcMint,
      destination: address(
        overrides.sellerTransferDestination ?? sellerUsdcAta
      ),
      authority: agentNoop,
      amount,
      decimals: USDC_DECIMALS
    })
  ];
  if (overrides.dustDestination !== undefined || overrides.dustAmount !== undefined) {
    instructions.push(
      getTransferCheckedInstruction({
        source: a.temp.address,
        mint: usdcMint,
        destination: address(overrides.dustDestination ?? dustRecipientUsdcAta),
        authority: agentNoop,
        amount: overrides.dustAmount ?? 2n,
        decimals: USDC_DECIMALS
      })
    );
  }
  instructions.push(
    getCloseAccountInstruction({
      account: a.temp.address,
      destination: address(overrides.closeDestination ?? a.sponsor.address),
      owner: agentNoop
    }),
    getAddMemoInstruction({ memo: memoText })
  );
  if (overrides.extraInstruction === true) {
    instructions.push(
      getTransferCheckedInstruction({
        source: address(dustRecipientUsdcAta),
        mint: usdcMint,
        destination: address(sellerUsdcAta),
        authority: agentNoop,
        amount: 1n,
        decimals: USDC_DECIMALS
      })
    );
  }

  const built = await buildVersionedTransaction({
    feePayer: address(overrides.feePayerOverride ?? a.sponsor.address),
    blockhash: blockhash("GHtnjzoaqLgzJZ4XTQr5ChCAPGJmCEqVMG6gRGoiTLDv"),
    lastValidBlockHeight: 1_000n,
    instructions
  });

  const intent: PaymentSigningIntent = {
    paymentId: "pay_test_intent",
    sellerRequestId: "seller_req_1",
    wallet: a.agent.address,
    network: SOLANA_MAINNET_NETWORK,
    scheme: PAYMENT_SCHEME,
    httpMethod: "GET",
    canonicalResourceUrl: "https://api.example.com/v1/data",
    requestBodyHash: "sha256-empty",
    requestBindingHash: "",
    seller: a.seller.address,
    vault: SUBLY_VAULT.address,
    shareMint: SUBLY_VAULT.shareMint,
    asset: SUBLY_VAULT.usdcMint,
    amountRawUsdc: "10000",
    payTo: a.seller.address,
    sellerUsdcAta,
    feePayer: a.sponsor.address,
    temporarySettlementTokenAccount: a.temp.address,
    dustRecipientUsdcAta,
    maxSharesToRedeemRaw: "11004",
    memo: "pay_test_intent",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    preparedMessageHash: built.messageHash
  };
  intent.requestBindingHash = computeRequestBindingHash({
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

  return { intent, serializedTransaction: built.serializedBase64 };
}

function expectRejection(
  fn: () => void,
  reason: string
) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(IntentValidationError);
    expect((error as IntentValidationError).reason).toBe(reason);
    return;
  }
  throw new Error(`Expected rejection with reason ${reason}`);
}

describe("validatePaymentIntentTransaction", () => {
  it("accepts the canonical settlement transaction", async () => {
    const { intent, serializedTransaction } = await buildSettlement();
    expect(() =>
      validatePaymentIntentTransaction({ intent, serializedTransaction })
    ).not.toThrow();
  });

  it("accepts a transaction with a dust sweep to the agent ATA", async () => {
    const { intent, serializedTransaction } = await buildSettlement({
      dustAmount: 2n
    });
    expect(() =>
      validatePaymentIntentTransaction({ intent, serializedTransaction })
    ).not.toThrow();
  });

  it("rejects a seller transfer to a different destination", async () => {
    const a = await actors();
    const attackerAta = deriveAssociatedTokenAddress({
      owner: a.attacker.address,
      mint: SUBLY_VAULT.usdcMint
    });
    const { intent, serializedTransaction } = await buildSettlement({
      sellerTransferDestination: attackerAta
    });
    expectRejection(
      () => validatePaymentIntentTransaction({ intent, serializedTransaction }),
      "transfer_mismatch"
    );
  });

  it("rejects a seller transfer with a different amount", async () => {
    const { intent, serializedTransaction } = await buildSettlement({
      sellerTransferAmount: 20_000n
    });
    expectRejection(
      () => validatePaymentIntentTransaction({ intent, serializedTransaction }),
      "amount_mismatch"
    );
  });

  it("rejects share burns above the approved maximum", async () => {
    const { intent, serializedTransaction } = await buildSettlement({
      sharesAmount: 50_000n
    });
    expectRejection(
      () => validatePaymentIntentTransaction({ intent, serializedTransaction }),
      "shares_exceed_max"
    );
  });

  it("rejects a close instruction paying rent to a non-sponsor", async () => {
    const a = await actors();
    const { intent, serializedTransaction } = await buildSettlement({
      closeDestination: a.attacker.address
    });
    expectRejection(
      () => validatePaymentIntentTransaction({ intent, serializedTransaction }),
      "close_mismatch"
    );
  });

  it("rejects a temporary account owned by someone else", async () => {
    const a = await actors();
    const { intent, serializedTransaction } = await buildSettlement({
      initOwner: a.attacker.address
    });
    expectRejection(
      () => validatePaymentIntentTransaction({ intent, serializedTransaction }),
      "temp_account_mismatch"
    );
  });

  it("rejects a dust sweep to a foreign account", async () => {
    const a = await actors();
    const attackerAta = deriveAssociatedTokenAddress({
      owner: a.attacker.address,
      mint: SUBLY_VAULT.usdcMint
    });
    const { intent, serializedTransaction } = await buildSettlement({
      dustDestination: attackerAta,
      dustAmount: 1_000n
    });
    expectRejection(
      () => validatePaymentIntentTransaction({ intent, serializedTransaction }),
      "transfer_mismatch"
    );
  });

  it("rejects unexpected trailing instructions", async () => {
    const { intent, serializedTransaction } = await buildSettlement({
      extraInstruction: true
    });
    expectRejection(
      () => validatePaymentIntentTransaction({ intent, serializedTransaction }),
      "unexpected_instruction"
    );
  });

  it("rejects a memo that does not match the paymentId", async () => {
    const { intent, serializedTransaction } = await buildSettlement({
      memo: "pay_other_payment"
    });
    expectRejection(
      () => validatePaymentIntentTransaction({ intent, serializedTransaction }),
      "memo_mismatch"
    );
  });

  it("rejects compute budget values above the signer policy", async () => {
    const highLimit = await buildSettlement({
      computeUnitLimit: 1_400_001
    });
    expectRejection(
      () =>
        validatePaymentIntentTransaction({
          intent: highLimit.intent,
          serializedTransaction: highLimit.serializedTransaction
        }),
      "compute_budget_mismatch"
    );

    const highPrice = await buildSettlement({
      computeUnitPriceMicroLamports: 100_001n
    });
    expectRejection(
      () =>
        validatePaymentIntentTransaction({
          intent: highPrice.intent,
          serializedTransaction: highPrice.serializedTransaction
        }),
      "compute_budget_mismatch"
    );
  });

  it("rejects an expired intent", async () => {
    const { intent, serializedTransaction } = await buildSettlement();
    intent.expiresAt = new Date(Date.now() - 1_000).toISOString();
    expectRejection(
      () => validatePaymentIntentTransaction({ intent, serializedTransaction }),
      "expired"
    );
  });

  it("rejects when the intent fields do not reproduce the binding hash", async () => {
    const { intent, serializedTransaction } = await buildSettlement();
    intent.requestBindingHash = "sha256-tampered";
    expectRejection(
      () => validatePaymentIntentTransaction({ intent, serializedTransaction }),
      "request_binding_mismatch"
    );
  });

  it("rejects when the prepared message hash differs", async () => {
    const { intent, serializedTransaction } = await buildSettlement();
    intent.preparedMessageHash = "sha256-other";
    expectRejection(
      () => validatePaymentIntentTransaction({ intent, serializedTransaction }),
      "message_hash_mismatch"
    );
  });
});
