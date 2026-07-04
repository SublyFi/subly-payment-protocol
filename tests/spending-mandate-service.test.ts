import { describe, expect, it } from "vitest";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { SUBLY_VAULT } from "../src/config/constants.js";
import { InMemoryLedger } from "../src/domain/ledger.js";
import type {
  DepositIntent,
  PaymentBindingWire,
  WithdrawalIntent
} from "../src/domain/models.js";
import { SpendingMandateService } from "../src/domain/spending-mandate-service.js";
import {
  approvalSigningMessage,
  mandateHashOf,
  mandatePayloadOf,
  mandateSigningMessage,
  revokeSigningMessage,
  recoveryCancelSigningMessage
} from "../src/domain/spending-mandate.js";
import { SublyError } from "../src/domain/errors.js";
import {
  AGENT_PUB,
  buildDocument,
  NOW_MS,
  OWNER,
  sign
} from "./helpers/mandate-fixtures.js";

const VAULT = SUBLY_VAULT.address;
const DAY_MS = 24 * 60 * 60 * 1000;

function buildService(params?: {
  level?: "off" | "warn" | "on";
  ledger?: InMemoryLedger;
  warnings?: Array<{ message: string; detail: unknown }>;
}) {
  const ledger = params?.ledger ?? new InMemoryLedger();
  let now = NOW_MS;
  const service = new SpendingMandateService({
    ledger,
    config: {
      enforcementLevel: params?.level ?? "on",
      nowMs: () => now,
      onWarn: (message, detail) => params?.warnings?.push({ message, detail })
    }
  });
  return { service, ledger, advance: (ms: number) => (now += ms) };
}

function binding(amountRawUsdc: string): PaymentBindingWire {
  return {
    payTo: AGENT_PUB,
    amountRawUsdc,
    resourceUrlHash: "cd".repeat(32),
    method: "GET"
  };
}

async function saveConfirmedRealize(
  ledger: InMemoryLedger,
  input: { id: string; amountRawUsdc: bigint; terminalAtMs: number }
) {
  await ledger.saveWithdrawal(fakeWithdrawal(input));
}

function fakeWithdrawal(input: {
  id: string;
  amountRawUsdc: bigint;
  terminalAtMs: number;
  status?: WithdrawalIntent["status"];
  approvalId?: string;
}): WithdrawalIntent {
  return {
    withdrawalId: input.id,
    wallet: AGENT_PUB,
    vault: VAULT,
    purpose: "yield_realize",
    paymentBinding: binding(input.amountRawUsdc.toString()),
    policySource: "default",
    mandateHash: null,
    policyDecision: "auto_within_policy",
    approvalId: input.approvalId ?? null,
    paymentTxSignature: null,
    paymentVerification: "unreported",
    requestedWithdrawRawUsdc: input.amountRawUsdc,
    requestedSharesRaw: 0n,
    maxSharesToRedeemRaw: 0n,
    destinationUsdcAta: AGENT_PUB,
    preparedMessageHash: "hash",
    recentBlockhash: null,
    lastValidBlockHeight: null,
    serializedTransaction: "",
    txSignature: `tx_${input.id}`,
    submittedSerializedTransaction: null,
    actualSharesBurnedRaw: null,
    actualWithdrawRawUsdc: input.amountRawUsdc,
    principalBasisBeforeRawUsdc: 0n,
    principalBasisAfterRawUsdc: null,
    status: input.status ?? "confirmed",
    expiresAt: new Date(input.terminalAtMs + 120_000).toISOString(),
    submittedAt: null,
    terminalAt: new Date(input.terminalAtMs).toISOString(),
    errorCode: null,
    liquidityRejectionReason: null
  };
}

async function saveConfirmedDeposit(
  ledger: InMemoryLedger,
  input: { id: string; amountRawUsdc: bigint; terminalAtMs: number }
) {
  const intent: DepositIntent = {
    depositId: input.id,
    wallet: AGENT_PUB,
    vault: VAULT,
    amountRawUsdc: input.amountRawUsdc,
    policySource: null,
    mandateHash: null,
    policyDecision: null,
    approvalId: null,
    preparedMessageHash: "hash",
    recentBlockhash: null,
    lastValidBlockHeight: null,
    serializedTransaction: "",
    txSignature: `tx_${input.id}`,
    submittedSerializedTransaction: null,
    actualDepositRawUsdc: input.amountRawUsdc,
    sharesMintedRaw: null,
    principalBasisBeforeRawUsdc: 0n,
    principalBasisAfterRawUsdc: null,
    status: "confirmed",
    expiresAt: new Date(input.terminalAtMs + 120_000).toISOString(),
    submittedAt: null,
    terminalAt: new Date(input.terminalAtMs).toISOString(),
    errorCode: null
  };
  await ledger.saveDeposit(intent);
}

async function expectCode(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    expect.fail(`expected SublyError ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(SublyError);
    expect((error as SublyError).code).toBe(code);
    return error as SublyError;
  }
}

async function registerDefaultMandate(
  service: SpendingMandateService,
  overrides?: Parameters<typeof buildDocument>[0]
) {
  const document = buildDocument(overrides);
  const result = await service.registerMandate({
    wallet: AGENT_PUB,
    vault: VAULT,
    document
  });
  return { document, result };
}

describe("mandate registration lifecycle", () => {
  it("registers, exposes usage, and enforces issuedAtMs monotonicity", async () => {
    const { service } = buildService();
    const { document, result } = await registerDefaultMandate(service);
    expect(result.status).toBe("active");
    expect(result.policySource).toBe(`mandate:${result.mandateHash}`);

    const fetched = await service.getMandate(AGENT_PUB, VAULT);
    expect(fetched.mandateHash).toBe(result.mandateHash);
    expect(fetched.effectiveStatus).toBe("active");

    // Replaying the same issuedAtMs (or older) is rejected.
    await expectCode(
      service.registerMandate({ wallet: AGENT_PUB, vault: VAULT, document }),
      "mandate_replay_rejected"
    );

    const replacement = buildDocument({
      payload: { issuedAtMs: document.issuedAtMs + 1 }
    });
    const replaced = await service.registerMandate({
      wallet: AGENT_PUB,
      vault: VAULT,
      document: replacement
    });
    expect(replaced.mandateHash).not.toBe(result.mandateHash);
  });

  it("requires the current owner to co-sign an owner rotation", async () => {
    const { service } = buildService();
    const { document } = await registerDefaultMandate(service);

    const newOwner = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(99));
    const rotated = buildDocument({
      ownerKeys: newOwner,
      payload: { issuedAtMs: document.issuedAtMs + 1 }
    });
    await expectCode(
      service.registerMandate({ wallet: AGENT_PUB, vault: VAULT, document: rotated }),
      "owner_rotation_requires_current_owner"
    );

    const newHash = mandateHashOf(mandatePayloadOf(rotated));
    const authorized = {
      ...rotated,
      currentOwnerSignature: sign(mandateSigningMessage(newHash), OWNER.secretKey)
    };
    const replaced = await service.registerMandate({
      wallet: AGENT_PUB,
      vault: VAULT,
      document: authorized
    });
    expect(replaced.mandateHash).toBe(newHash);
  });

  it("issues the initialDeposit approval only on first registration", async () => {
    const { service } = buildService();
    const { document, result } = await registerDefaultMandate(service, {
      payload: { initialDeposit: { amountRawUsdc: "500000000" } }
    });
    expect(result.initialDepositApproval).not.toBeNull();

    const approvals = await service.listApprovals(AGENT_PUB, "approved");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.binding).toEqual({
      kind: "deposit",
      amountRawUsdc: "500000000"
    });

    // A replace carrying initialDeposit again does NOT re-issue.
    const replacement = buildDocument({
      payload: {
        issuedAtMs: document.issuedAtMs + 1,
        initialDeposit: { amountRawUsdc: "500000000" }
      }
    });
    const replaced = await service.registerMandate({
      wallet: AGENT_PUB,
      vault: VAULT,
      document: replacement
    });
    expect(replaced.initialDepositApproval).toBeNull();
    expect(await service.listApprovals(AGENT_PUB, "approved")).toHaveLength(1);
  });
});

describe("kill switch and recovery", () => {
  it("revoke blocks payments and deposits until the same owner re-registers", async () => {
    const { service } = buildService();
    const { result } = await registerDefaultMandate(service);

    const signedAtMs = NOW_MS + 1;
    await service.revokeMandate({
      wallet: AGENT_PUB,
      mandateHash: result.mandateHash,
      signedAtMs,
      signature: sign(
        revokeSigningMessage(result.mandateHash, signedAtMs),
        OWNER.secretKey
      )
    });

    await expectCode(
      service.authorizeRealize({
        wallet: AGENT_PUB,
        vault: VAULT,
        amountRawUsdc: 58_000n,
        payment: binding("58000"),
        approvalId: null
      }),
      "mandate_revoked"
    );
    await expectCode(
      service.authorizeDeposit({
        wallet: AGENT_PUB,
        vault: VAULT,
        amountRawUsdc: 1_000_000n,
        approvalId: null
      }),
      "mandate_revoked"
    );

    // A different owner cannot take over a revoked wallet.
    const stranger = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(50));
    await expectCode(
      service.registerMandate({
        wallet: AGENT_PUB,
        vault: VAULT,
        document: buildDocument({
          ownerKeys: stranger,
          payload: { issuedAtMs: NOW_MS + 10 }
        })
      }),
      "mandate_revoked"
    );

    // The same owner can come back.
    const restored = await service.registerMandate({
      wallet: AGENT_PUB,
      vault: VAULT,
      document: buildDocument({ payload: { issuedAtMs: NOW_MS + 10 } })
    });
    expect(restored.status).toBe("active");
  });

  it("rejects a bad revoke signature", async () => {
    const { service } = buildService();
    const { result } = await registerDefaultMandate(service);
    const signedAtMs = NOW_MS + 1;
    await expectCode(
      service.revokeMandate({
        wallet: AGENT_PUB,
        mandateHash: result.mandateHash,
        signedAtMs,
        signature: sign(
          revokeSigningMessage(result.mandateHash, signedAtMs),
          nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(60)).secretKey
        )
      }),
      "revoke_signature_invalid"
    );
  });

  it("recovery-revoke waits out the grace window and the owner can veto", async () => {
    const { service, advance } = buildService();
    const { result } = await registerDefaultMandate(service);

    const scheduled = await service.scheduleRecoveryRevoke(AGENT_PUB);
    expect(scheduled.status).toBe("recovery_pending");
    expect(scheduled.recoveryAtMs).toBe(NOW_MS + 72 * 60 * 60 * 1000);

    // Mandate stays enforceable during the grace window.
    const auth = await service.authorizeRealize({
      wallet: AGENT_PUB,
      vault: VAULT,
      amountRawUsdc: 58_000n,
      payment: binding("58000"),
      approvalId: null
    });
    expect(auth.policySource).toBe(`mandate:${result.mandateHash}`);

    // Owner vetoes within the window.
    const signedAtMs = NOW_MS + 2;
    const cancelled = await service.cancelRecoveryRevoke({
      wallet: AGENT_PUB,
      mandateHash: result.mandateHash,
      signedAtMs,
      signature: sign(
        recoveryCancelSigningMessage(result.mandateHash, signedAtMs),
        OWNER.secretKey
      )
    });
    expect(cancelled.status).toBe("active");

    // Schedule again and let the grace elapse: back to the default policy.
    await service.scheduleRecoveryRevoke(AGENT_PUB);
    advance(72 * 60 * 60 * 1000 + 1);
    const afterElapsed = await service.authorizeRealize({
      wallet: AGENT_PUB,
      vault: VAULT,
      amountRawUsdc: 58_000n,
      payment: binding("58000"),
      approvalId: null
    });
    expect(afterElapsed.policySource).toBe("default");
  });

  it("mandate expiry still applies while a recovery-revoke is pending", async () => {
    const { service, advance } = buildService();
    const { result } = await registerDefaultMandate(service, {
      payload: { expiresAtMs: NOW_MS + 60 * 60 * 1000 } // 1h mandate
    });

    await service.scheduleRecoveryRevoke(AGENT_PUB);
    // Past the mandate expiry but well inside the 72h recovery grace.
    advance(60 * 60 * 1000 + 1);

    const auth = await service.authorizeRealize({
      wallet: AGENT_PUB,
      vault: VAULT,
      amountRawUsdc: 58_000n,
      payment: binding("58000"),
      approvalId: null
    });
    expect(auth.policySource).toBe("default");
    expect(auth.mandateHash).toBeNull();

    // Neither side can act on the expired mandate: no new dead-man switch...
    await expectCode(
      service.scheduleRecoveryRevoke(AGENT_PUB),
      "mandate_expired"
    );

    // ...and the expired owner credential cannot veto its way back to "active".
    const signedAtMs = NOW_MS + 60 * 60 * 1000 + 2;
    await expectCode(
      service.cancelRecoveryRevoke({
        wallet: AGENT_PUB,
        mandateHash: result.mandateHash,
        signedAtMs,
        signature: sign(
          recoveryCancelSigningMessage(result.mandateHash, signedAtMs),
          OWNER.secretKey
        )
      }),
      "mandate_expired"
    );
  });
});

describe("realize enforcement — default policy (no mandate)", () => {
  it("allows small payments, requires a binding, refuses large ones", async () => {
    const { service } = buildService();

    const auth = await service.authorizeRealize({
      wallet: AGENT_PUB,
      vault: VAULT,
      amountRawUsdc: 58_000n,
      payment: binding("58000"),
      approvalId: null
    });
    expect(auth).toEqual({
      policySource: "default",
      mandateHash: null,
      policyDecision: "auto_within_policy",
      approvalId: null
    });

    await expectCode(
      service.authorizeRealize({
        wallet: AGENT_PUB,
        vault: VAULT,
        amountRawUsdc: 58_000n,
        payment: null,
        approvalId: null
      }),
      "payment_binding_required"
    );
    await expectCode(
      service.authorizeRealize({
        wallet: AGENT_PUB,
        vault: VAULT,
        amountRawUsdc: 58_000n,
        payment: binding("58001"),
        approvalId: null
      }),
      "payment_binding_mismatch"
    );

    // Above the default threshold (1 USDC) there is no owner to ask.
    await expectCode(
      service.authorizeRealize({
        wallet: AGENT_PUB,
        vault: VAULT,
        amountRawUsdc: 1_000_001n,
        payment: binding("1000001"),
        approvalId: null
      }),
      "mandate_required_for_larger_payments"
    );

    // Above the absolute cap (10 USDC) refusal wins over escalation.
    await expectCode(
      service.authorizeRealize({
        wallet: AGENT_PUB,
        vault: VAULT,
        amountRawUsdc: 10_000_001n,
        payment: binding("10000001"),
        approvalId: null
      }),
      "per_payment_cap_exceeded"
    );
  });

  it("threshold boundary: exactly 1 USDC is automatic, 1 USDC + 1 raw is not", async () => {
    const { service } = buildService();
    const auth = await service.authorizeRealize({
      wallet: AGENT_PUB,
      vault: VAULT,
      amountRawUsdc: 1_000_000n,
      payment: binding("1000000"),
      approvalId: null
    });
    expect(auth.policyDecision).toBe("auto_within_policy");
    await expectCode(
      service.authorizeRealize({
        wallet: AGENT_PUB,
        vault: VAULT,
        amountRawUsdc: 1_000_001n,
        payment: binding("1000001"),
        approvalId: null
      }),
      "mandate_required_for_larger_payments"
    );
  });

  it("enforces the rolling 24h daily cap over confirmed realizes", async () => {
    const { service, ledger } = buildService();
    // 99.95 USDC already spent within the window; 0.04 more fits, 0.06 not.
    await saveConfirmedRealize(ledger, {
      id: "w1",
      amountRawUsdc: 99_950_000n,
      terminalAtMs: NOW_MS - DAY_MS + 60_000
    });
    // Outside the window: ignored.
    await saveConfirmedRealize(ledger, {
      id: "w0",
      amountRawUsdc: 50_000_000n,
      terminalAtMs: NOW_MS - DAY_MS - 60_000
    });

    const ok = await service.authorizeRealize({
      wallet: AGENT_PUB,
      vault: VAULT,
      amountRawUsdc: 40_000n,
      payment: binding("40000"),
      approvalId: null
    });
    expect(ok.policyDecision).toBe("auto_within_policy");

    await expectCode(
      service.authorizeRealize({
        wallet: AGENT_PUB,
        vault: VAULT,
        amountRawUsdc: 60_000n,
        payment: binding("60000"),
        approvalId: null
      }),
      "daily_cap_exceeded"
    );
  });
});

describe("realize enforcement — mandate with approvals", () => {
  it("runs the full approval_required -> approve -> retry -> consume cycle", async () => {
    const { service } = buildService();
    const { result } = await registerDefaultMandate(service);

    // 2 USDC: above the threshold, below the cap -> approval_required.
    const error = await expectCode(
      service.authorizeRealize({
        wallet: AGENT_PUB,
        vault: VAULT,
        amountRawUsdc: 2_000_000n,
        payment: binding("2000000"),
        approvalId: null
      }),
      "approval_required"
    );
    const details = error.details as {
      approvalId: string;
      approveUrl: string;
      expiresAtMs: number;
    };
    expect(details.approveUrl).toBe(
      `https://app.subly.fi/approve/${details.approvalId}`
    );

    // Retrying without a decision reuses the same pending approval.
    const again = await expectCode(
      service.authorizeRealize({
        wallet: AGENT_PUB,
        vault: VAULT,
        amountRawUsdc: 2_000_000n,
        payment: binding("2000000"),
        approvalId: null
      }),
      "approval_required"
    );
    expect((again.details as { approvalId: string }).approvalId).toBe(
      details.approvalId
    );

    // Owner signs the approve decision.
    const pending = (await service.listApprovals(AGENT_PUB, "pending"))[0]!;
    const signedAtMs = NOW_MS + 3;
    await service.decideApproval({
      approvalId: pending.approvalId,
      decision: "approve",
      signedAtMs,
      signature: sign(
        approvalSigningMessage({
          approvalId: pending.approvalId,
          decision: "approve",
          bindingHash: pending.bindingHash,
          signedAtMs
        }),
        OWNER.secretKey
      )
    });

    // Retry with approvalId now passes and is marked owner_approved.
    const auth = await service.authorizeRealize({
      wallet: AGENT_PUB,
      vault: VAULT,
      amountRawUsdc: 2_000_000n,
      payment: binding("2000000"),
      approvalId: pending.approvalId
    });
    expect(auth.policyDecision).toBe(`owner_approved:${pending.approvalId}`);
    expect(auth.mandateHash).toBe(result.mandateHash);

    // Consumed once the realize confirms; reuse demands a fresh approval.
    await service.consumeApproval(pending.approvalId, "wdr_done");
    const consumed = (await service.listApprovals(AGENT_PUB, "consumed"))[0]!;
    expect(consumed.consumedByWithdrawalId).toBe("wdr_done");
    const reuse = await expectCode(
      service.authorizeRealize({
        wallet: AGENT_PUB,
        vault: VAULT,
        amountRawUsdc: 2_000_000n,
        payment: binding("2000000"),
        approvalId: pending.approvalId
      }),
      "approval_required"
    );
    expect((reuse.details as { approvalId: string }).approvalId).not.toBe(
      pending.approvalId
    );
  });

  it("an approval is bound to its exact payment content", async () => {
    const { service } = buildService();
    await registerDefaultMandate(service);

    const error = await expectCode(
      service.authorizeRealize({
        wallet: AGENT_PUB,
        vault: VAULT,
        amountRawUsdc: 2_000_000n,
        payment: binding("2000000"),
        approvalId: null
      }),
      "approval_required"
    );
    const approvalId = (error.details as { approvalId: string }).approvalId;
    const pending = (await service.listApprovals(AGENT_PUB, "pending"))[0]!;
    const signedAtMs = NOW_MS + 3;
    await service.decideApproval({
      approvalId,
      decision: "approve",
      signedAtMs,
      signature: sign(
        approvalSigningMessage({
          approvalId,
          decision: "approve",
          bindingHash: pending.bindingHash,
          signedAtMs
        }),
        OWNER.secretKey
      )
    });

    // Same approvalId, different payTo -> new approval demanded.
    await expectCode(
      service.authorizeRealize({
        wallet: AGENT_PUB,
        vault: VAULT,
        amountRawUsdc: 2_000_000n,
        payment: { ...binding("2000000"), payTo: SUBLY_VAULT.address },
        approvalId
      }),
      "approval_required"
    );
  });

  it("expires approvals after the 15 minute TTL", async () => {
    const { service, advance } = buildService();
    await registerDefaultMandate(service);

    const error = await expectCode(
      service.authorizeRealize({
        wallet: AGENT_PUB,
        vault: VAULT,
        amountRawUsdc: 2_000_000n,
        payment: binding("2000000"),
        approvalId: null
      }),
      "approval_required"
    );
    const approvalId = (error.details as { approvalId: string }).approvalId;
    advance(15 * 60 * 1000 + 1);

    const pendingDecision = (await service.listApprovals(AGENT_PUB))[0]!;
    expect(pendingDecision.status).toBe("expired");
    const signedAtMs = NOW_MS + 15 * 60 * 1000 + 2;
    await expectCode(
      service.decideApproval({
        approvalId,
        decision: "approve",
        signedAtMs,
        signature: sign(
          approvalSigningMessage({
            approvalId,
            decision: "approve",
            bindingHash: pendingDecision.bindingHash,
            signedAtMs
          }),
          OWNER.secretKey
        )
      }),
      "approval_expired"
    );
  });

  it("a denial is final for that approval", async () => {
    const { service } = buildService();
    await registerDefaultMandate(service);

    const error = await expectCode(
      service.authorizeRealize({
        wallet: AGENT_PUB,
        vault: VAULT,
        amountRawUsdc: 2_000_000n,
        payment: binding("2000000"),
        approvalId: null
      }),
      "approval_required"
    );
    const approvalId = (error.details as { approvalId: string }).approvalId;
    const pending = (await service.listApprovals(AGENT_PUB, "pending"))[0]!;
    const signedAtMs = NOW_MS + 3;
    await service.decideApproval({
      approvalId,
      decision: "deny",
      signedAtMs,
      signature: sign(
        approvalSigningMessage({
          approvalId,
          decision: "deny",
          bindingHash: pending.bindingHash,
          signedAtMs
        }),
        OWNER.secretKey
      )
    });

    const retry = await expectCode(
      service.authorizeRealize({
        wallet: AGENT_PUB,
        vault: VAULT,
        amountRawUsdc: 2_000_000n,
        payment: binding("2000000"),
        approvalId
      }),
      "approval_required"
    );
    expect((retry.details as { approvalId: string }).approvalId).not.toBe(
      approvalId
    );
  });

  it("enforces the payee allowlist", async () => {
    const { service } = buildService();
    await registerDefaultMandate(service, {
      policy: { allowedPayToAddresses: [SUBLY_VAULT.address] }
    });
    await expectCode(
      service.authorizeRealize({
        wallet: AGENT_PUB,
        vault: VAULT,
        amountRawUsdc: 58_000n,
        payment: binding("58000"),
        approvalId: null
      }),
      "payee_not_allowed"
    );
  });
});

describe("deposit enforcement", () => {
  async function approveDeposit(
    service: SpendingMandateService,
    approvalId: string,
    bindingHash: string,
    signedAtMs: number
  ) {
    await service.decideApproval({
      approvalId,
      decision: "approve",
      signedAtMs,
      signature: sign(
        approvalSigningMessage({
          approvalId,
          decision: "approve",
          bindingHash,
          signedAtMs
        }),
        OWNER.secretKey
      )
    });
  }

  it("enforces the rolling 24h deposit cap as an absolute ceiling", async () => {
    const { service, ledger } = buildService();
    await registerDefaultMandate(service, {
      policy: { depositPolicy: "agent_allowed" }
    });
    await saveConfirmedDeposit(ledger, {
      id: "d1",
      amountRawUsdc: 2_999_000_000n,
      terminalAtMs: NOW_MS - 60_000
    });

    const ok = await service.authorizeDeposit({
      wallet: AGENT_PUB,
      vault: VAULT,
      amountRawUsdc: 1_000_000n,
      approvalId: null
    });
    expect(ok.policyDecision).toBe("auto_within_policy");

    await expectCode(
      service.authorizeDeposit({
        wallet: AGENT_PUB,
        vault: VAULT,
        amountRawUsdc: 1_000_001n,
        approvalId: null
      }),
      "daily_deposit_cap_exceeded"
    );
  });

  it("refuses deposits for wallets with no registered owner", async () => {
    const { service } = buildService();
    await expectCode(
      service.authorizeDeposit({
        wallet: AGENT_PUB,
        vault: VAULT,
        amountRawUsdc: 1_000_000n,
        approvalId: null
      }),
      "mandate_required_for_deposit"
    );
  });

  it("escalates every deposit to the owner and honors the approval once", async () => {
    const { service } = buildService();
    await registerDefaultMandate(service);

    const required = await expectCode(
      service.authorizeDeposit({
        wallet: AGENT_PUB,
        vault: VAULT,
        amountRawUsdc: 5_000_000n,
        approvalId: null
      }),
      "deposit_approval_required"
    );
    const details = required.details as { approvalId: string; approveUrl: string };
    expect(details.approveUrl).toContain(details.approvalId);

    const pending = (await service.listApprovals(AGENT_PUB, "pending"))[0]!;
    expect(pending.binding).toEqual({
      kind: "deposit",
      amountRawUsdc: "5000000"
    });
    await approveDeposit(service, details.approvalId, pending.bindingHash, NOW_MS + 3);

    const authorized = await service.authorizeDeposit({
      wallet: AGENT_PUB,
      vault: VAULT,
      amountRawUsdc: 5_000_000n,
      approvalId: details.approvalId
    });
    expect(authorized.policyDecision).toBe(`owner_approved:${details.approvalId}`);
    expect(authorized.approvalId).toBe(details.approvalId);

    // Approvals bind to the exact amount: a different deposit needs a new one.
    await expectCode(
      service.authorizeDeposit({
        wallet: AGENT_PUB,
        vault: VAULT,
        amountRawUsdc: 6_000_000n,
        approvalId: details.approvalId
      }),
      "deposit_approval_required"
    );

    // Consumed (deposit confirmed) approvals cannot be replayed.
    await service.consumeApproval(details.approvalId, "dep_confirmed_1");
    await expectCode(
      service.authorizeDeposit({
        wallet: AGENT_PUB,
        vault: VAULT,
        amountRawUsdc: 5_000_000n,
        approvalId: details.approvalId
      }),
      "deposit_approval_required"
    );
  });

  it("the mandate initialDeposit approval authorizes the first deposit without extra Face ID", async () => {
    const { service } = buildService();
    const { result } = await registerDefaultMandate(service, {
      payload: { initialDeposit: { amountRawUsdc: "500000000" } }
    });
    const approvalId = result.initialDepositApproval!.approvalId;

    const authorized = await service.authorizeDeposit({
      wallet: AGENT_PUB,
      vault: VAULT,
      amountRawUsdc: 500_000_000n,
      approvalId
    });
    expect(authorized.policyDecision).toBe(`owner_approved:${approvalId}`);
  });

  it("warn mode stamps deposit violations without blocking", async () => {
    const warnings: Array<{ message: string; detail: unknown }> = [];
    const { service } = buildService({ level: "warn", warnings });

    const unregistered = await service.authorizeDeposit({
      wallet: AGENT_PUB,
      vault: VAULT,
      amountRawUsdc: 1_000_000n,
      approvalId: null
    });
    expect(unregistered.policyDecision).toBe(
      "warned:mandate_required_for_deposit"
    );

    await registerDefaultMandate(service);
    const registered = await service.authorizeDeposit({
      wallet: AGENT_PUB,
      vault: VAULT,
      amountRawUsdc: 1_000_000n,
      approvalId: null
    });
    expect(registered.policyDecision).toBe("warned:deposit_approval_required");
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe("withdrawal enforcement", () => {
  it("is agent-allowed by default — exit stays open with and without a mandate", async () => {
    const { service } = buildService();
    const unregistered = await service.authorizeWithdrawal({
      wallet: AGENT_PUB,
      vault: VAULT,
      amountRawUsdc: 5_000_000n,
      approvalId: null
    });
    expect(unregistered.policyDecision).toBe("auto_within_policy");
    expect(unregistered.policySource).toBe("default");

    await registerDefaultMandate(service);
    const registered = await service.authorizeWithdrawal({
      wallet: AGENT_PUB,
      vault: VAULT,
      amountRawUsdc: 5_000_000n,
      approvalId: null
    });
    expect(registered.policyDecision).toBe("auto_within_policy");
  });

  it("withdrawalPolicy owner_approval_required rides the same escalation", async () => {
    const { service } = buildService();
    await registerDefaultMandate(service, {
      policy: { withdrawalPolicy: "owner_approval_required" }
    });

    const required = await expectCode(
      service.authorizeWithdrawal({
        wallet: AGENT_PUB,
        vault: VAULT,
        amountRawUsdc: 7_000_000n,
        approvalId: null
      }),
      "withdrawal_approval_required"
    );
    const details = required.details as { approvalId: string; approveUrl: string };
    expect(details.approveUrl).toContain(details.approvalId);

    const pending = (await service.listApprovals(AGENT_PUB, "pending"))[0]!;
    expect(pending.binding).toEqual({
      kind: "withdrawal",
      amountRawUsdc: "7000000"
    });
    const signedAtMs = NOW_MS + 3;
    await service.decideApproval({
      approvalId: details.approvalId,
      decision: "approve",
      signedAtMs,
      signature: sign(
        approvalSigningMessage({
          approvalId: details.approvalId,
          decision: "approve",
          bindingHash: pending.bindingHash,
          signedAtMs
        }),
        OWNER.secretKey
      )
    });

    const authorized = await service.authorizeWithdrawal({
      wallet: AGENT_PUB,
      vault: VAULT,
      amountRawUsdc: 7_000_000n,
      approvalId: details.approvalId
    });
    expect(authorized.policyDecision).toBe(
      `owner_approved:${details.approvalId}`
    );

    // Bound to the exact amount — a different withdrawal escalates anew.
    await expectCode(
      service.authorizeWithdrawal({
        wallet: AGENT_PUB,
        vault: VAULT,
        amountRawUsdc: 8_000_000n,
        approvalId: details.approvalId
      }),
      "withdrawal_approval_required"
    );
  });

  it("warn mode stamps instead of blocking; the kill switch blocks anyway", async () => {
    const warnings: Array<{ message: string; detail: unknown }> = [];
    const { service } = buildService({ level: "warn", warnings });
    const { result } = await registerDefaultMandate(service, {
      policy: { withdrawalPolicy: "owner_approval_required" }
    });

    const warned = await service.authorizeWithdrawal({
      wallet: AGENT_PUB,
      vault: VAULT,
      amountRawUsdc: 1_000_000n,
      approvalId: null
    });
    expect(warned.policyDecision).toBe("warned:withdrawal_approval_required");
    expect(warnings.length).toBeGreaterThan(0);

    // Once revoked, even the exit path closes (the agent key can no longer
    // pull the principal out from under the human) — in warn mode too.
    const signedAtMs = NOW_MS + 5;
    await service.revokeMandate({
      wallet: AGENT_PUB,
      mandateHash: result.mandateHash,
      signedAtMs,
      signature: sign(
        revokeSigningMessage(result.mandateHash, signedAtMs),
        OWNER.secretKey
      )
    });
    await expectCode(
      service.authorizeWithdrawal({
        wallet: AGENT_PUB,
        vault: VAULT,
        amountRawUsdc: 1_000_000n,
        approvalId: null
      }),
      "mandate_revoked"
    );
  });
});

describe("enforcement levels", () => {
  it("warn mode logs violations without blocking and stamps the first code", async () => {
    const warnings: Array<{ message: string; detail: unknown }> = [];
    const { service } = buildService({ level: "warn", warnings });

    const auth = await service.authorizeRealize({
      wallet: AGENT_PUB,
      vault: VAULT,
      amountRawUsdc: 50_000_000n, // 50 USDC: over cap AND threshold
      payment: null,
      approvalId: null
    });
    // The audit stamp must not claim the payment was within policy.
    expect(auth.policyDecision).toBe("warned:payment_binding_required");
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("warn mode still stamps a clean payment as auto_within_policy", async () => {
    const { service } = buildService({ level: "warn" });
    const auth = await service.authorizeRealize({
      wallet: AGENT_PUB,
      vault: VAULT,
      amountRawUsdc: 58_000n,
      payment: binding("58000"),
      approvalId: null
    });
    expect(auth.policyDecision).toBe("auto_within_policy");
  });

  it("warn mode still enforces the kill switch", async () => {
    const { service } = buildService({ level: "warn" });
    const { result } = await registerDefaultMandate(service);

    const signedAtMs = NOW_MS + 1;
    await service.revokeMandate({
      wallet: AGENT_PUB,
      mandateHash: result.mandateHash,
      signedAtMs,
      signature: sign(
        revokeSigningMessage(result.mandateHash, signedAtMs),
        OWNER.secretKey
      )
    });

    await expectCode(
      service.authorizeRealize({
        wallet: AGENT_PUB,
        vault: VAULT,
        amountRawUsdc: 58_000n,
        payment: binding("58000"),
        approvalId: null
      }),
      "mandate_revoked"
    );
    await expectCode(
      service.authorizeDeposit({
        wallet: AGENT_PUB,
        vault: VAULT,
        amountRawUsdc: 1_000_000n,
        approvalId: null
      }),
      "mandate_revoked"
    );
  });

  it("off mode skips evaluation entirely", async () => {
    const { service } = buildService({ level: "off" });
    const auth = await service.authorizeRealize({
      wallet: AGENT_PUB,
      vault: VAULT,
      amountRawUsdc: 999_000_000n,
      payment: null,
      approvalId: null
    });
    expect(auth.policyDecision).toBe("unenforced");
  });
});

describe("spending log", () => {
  it("lists confirmed realizes newest-first with their policy decision", async () => {
    const { service, ledger } = buildService();
    await saveConfirmedRealize(ledger, {
      id: "w1",
      amountRawUsdc: 58_000n,
      terminalAtMs: NOW_MS - 2_000
    });
    await saveConfirmedRealize(ledger, {
      id: "w2",
      amountRawUsdc: 61_000n,
      terminalAtMs: NOW_MS - 1_000
    });
    // Normal withdrawals and unconfirmed realizes stay out of the log.
    await ledger.saveWithdrawal({
      ...fakeWithdrawal({
        id: "w3",
        amountRawUsdc: 1_000_000n,
        terminalAtMs: NOW_MS
      }),
      purpose: "normal"
    });
    await ledger.saveWithdrawal(
      fakeWithdrawal({
        id: "w4",
        amountRawUsdc: 70_000n,
        terminalAtMs: NOW_MS,
        status: "failed"
      })
    );

    const log = await service.spendingLog(AGENT_PUB, VAULT);
    expect(log.entries.map((entry) => entry.amountRawUsdc)).toEqual([
      "61000",
      "58000"
    ]);
    expect(log.entries[0]).toMatchObject({
      payTo: AGENT_PUB,
      method: "GET",
      realizeTxSignature: "tx_w2",
      paymentVerification: "unreported",
      decision: "auto_within_policy",
      policySource: "default"
    });
  });
});
