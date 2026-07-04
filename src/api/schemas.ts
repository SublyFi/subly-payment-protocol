import { z } from "zod";

export const rawIntegerString = z.string().regex(/^(0|[1-9]\d*)$/);
export const positiveRawIntegerString = z.string().regex(/^[1-9]\d*$/);
export const solanaAddressString = z.string().min(32).max(44);

export const registerAgentWalletSchema = z.object({
  wallet: solanaAddressString,
  signingPolicyId: z.string().min(1),
  signingMode: z.enum(["non_interactive", "observed_only"]).optional(),
  signerValidationMode: z
    .enum(["unverified", "structured_intent_transaction"])
    .optional(),
  signerProvider: z.string().min(1).optional(),
  safetyBufferRawUsdc: rawIntegerString.optional(),
  activateForPayments: z.boolean().optional()
});

export const syncWalletPositionSchema = z.object({
  vault: solanaAddressString.optional(),
  stakedSharesRaw: rawIntegerString.optional(),
  unstakedSharesRaw: rawIntegerString.optional(),
  totalSharesRaw: rawIntegerString,
  exchangeRateScaled: positiveRawIntegerString,
  instantRedeemCapacityRawUsdc: rawIntegerString,
  principalBasisRawUsdc: rawIntegerString.optional(),
  principalBasisSource: z
    .enum([
      "empty",
      "kamino_pnl_current",
      "subly_receipts",
      "conservative_activation_reset",
      "manual_trusted_seed"
    ])
    .optional(),
  observedSlot: z.number().int().nonnegative().optional(),
  forceConservativeReset: z.boolean().optional()
});

export const chainSyncWalletPositionSchema = z.object({
  source: z.literal("chain"),
  forceConservativeReset: z.boolean().optional()
});

export const prepareDepositSchema = z.object({
  wallet: solanaAddressString,
  amountRawUsdc: positiveRawIntegerString
});

export const submitDepositSchema = z.object({
  depositId: z.string().min(1),
  serializedTransaction: z.string().min(1).max(4096),
  agentSignature: z.string().min(1).max(128)
});

export const sha256HexString = z.string().regex(/^[0-9a-f]{64}$/);

export const paymentBindingSchema = z
  .object({
    payTo: solanaAddressString,
    amountRawUsdc: positiveRawIntegerString,
    resourceUrlHash: sha256HexString,
    method: z.string().min(1).max(16)
  })
  .strict();

export const prepareWithdrawalSchema = z.object({
  wallet: solanaAddressString,
  amountRawUsdc: positiveRawIntegerString,
  /**
   * "yield_realize" marks a withdrawal that funds an x402 payment; the server
   * then refuses any amount the spendable yield cannot cover, so the deposited
   * principal is protected server-side, not just by the client's precheck.
   */
  purpose: z.enum(["yield_realize"]).optional(),
  /** The x402 payment this realize funds (spending-mandate audit binding). */
  payment: paymentBindingSchema.optional(),
  /** Owner approval id for payments above the mandate threshold. */
  approvalId: z.string().min(1).max(64).optional()
});

export const submitWithdrawalSchema = z.object({
  withdrawalId: z.string().min(1),
  serializedTransaction: z.string().min(1).max(4096),
  agentSignature: z.string().min(1).max(128)
});

export const liquidityPolicySchema = z.object({
  sellerClass: z.string().min(1),
  vault: solanaAddressString.optional(),
  expectedPaymentSizeRawUsdc: positiveRawIntegerString,
  minInstantLiquidityRawUsdc: rawIntegerString,
  targetBudgetIlliquidRate: z.number().min(0).max(1),
  status: z.enum(["active", "disabled"]).optional()
});

export const preparePaymentSchema = z.object({
  wallet: solanaAddressString,
  scheme: z.string().optional(),
  network: z.string().optional(),
  vault: solanaAddressString.optional(),
  shareMint: solanaAddressString.optional(),
  asset: solanaAddressString,
  seller: solanaAddressString,
  sellerRequestId: z.string().min(1),
  httpMethod: z.string().min(1),
  canonicalResourceUrl: z.string().url(),
  requestBodyHash: z.string().optional(),
  amountRawUsdc: positiveRawIntegerString,
  payTo: solanaAddressString,
  sellerUsdcAta: solanaAddressString,
  dustRecipientUsdcAta: solanaAddressString
});

export const verifyPaymentPayloadSchema = z.object({
  paymentId: z.string().min(1),
  requestBindingHash: z.string().min(1),
  preparedMessageHash: z.string().min(1),
  serializedTransaction: z.string().min(1).max(4096),
  agentSignature: z.string().min(1).max(128),
  temporarySettlementSignature: z.string().min(1).max(128)
});

export const recoverSettlementsSchema = z.object({
  limit: z.number().int().positive().max(1000).optional()
});

// ---------------------------------------------------------- spending mandate

const nullablePositiveRaw = positiveRawIntegerString.nullable();

export const mandatePolicySchema = z
  .object({
    perPaymentCapRawUsdc: positiveRawIntegerString,
    dailyApiSpendCapRawUsdc: nullablePositiveRaw,
    monthlyApiSpendCapRawUsdc: nullablePositiveRaw,
    dailyDepositCapRawUsdc: nullablePositiveRaw,
    // "0" = every payment needs approval (full HITL); null = no escalation.
    approvalThresholdRawUsdc: rawIntegerString.nullable(),
    allowedPayToAddresses: z.array(solanaAddressString).min(1).nullable(),
    depositPolicy: z.enum(["owner_approval_required", "agent_allowed"]),
    withdrawalPolicy: z.enum(["agent_allowed", "owner_approval_required"])
  })
  .strict();

/**
 * Strict: unknown fields are rejected rather than silently dropped, because
 * the mandate hash covers exactly these fields and a dropped field would
 * mean owner and relayer disagree about what was signed.
 */
export const registerMandateSchema = z
  .object({
    version: z.literal(1),
    ownerAuth: z.enum(["ed25519", "passkey"]),
    ownerCredential: z
      .object({
        publicKey: z.string().min(1).max(256),
        credentialId: z.string().min(1).max(512).optional()
      })
      .strict(),
    enforcementMode: z.enum(["subly", "wallet_infra"]),
    agentWallet: solanaAddressString,
    vault: solanaAddressString,
    issuedAtMs: z.number().int().positive(),
    expiresAtMs: z.number().int().positive(),
    policy: mandatePolicySchema,
    initialDeposit: z
      .object({ amountRawUsdc: positiveRawIntegerString })
      .strict()
      .optional(),
    ownerSignature: z.string().min(1).max(128),
    agentWalletSignature: z.string().min(1).max(128),
    currentOwnerSignature: z.string().min(1).max(128).optional()
  })
  .strict();

export const ownerSignedActionSchema = z.object({
  mandateHash: sha256HexString,
  signedAtMs: z.number().int().positive(),
  signature: z.string().min(1).max(128)
});

export const approvalDecisionSchema = z.object({
  decision: z.enum(["approve", "deny"]),
  signedAtMs: z.number().int().positive(),
  signature: z.string().min(1).max(128)
});

export const reportPaymentSchema = z.object({
  wallet: solanaAddressString,
  withdrawalId: z.string().min(1).max(64),
  paymentTxSignature: z.string().min(32).max(128)
});
