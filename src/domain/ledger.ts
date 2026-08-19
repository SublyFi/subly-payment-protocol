import type {
  DepositIntent,
  PaymentIntent,
  PaymentStatus,
  SellerLiquidityPolicy,
  SetupSession,
  SpendingApproval,
  SpendingMandateEvent,
  SpendingMandateRecord,
  SyncEvent,
  WalletPosition,
  WithdrawalIntent
} from "./models.js";

export type Awaitable<T> = T | Promise<T>;

export interface Ledger {
  withSpendingMandateLock<T>(
    wallet: string,
    callback: () => Promise<T>
  ): Promise<T>;
  withWalletVaultLock<T>(
    wallet: string,
    vault: string,
    callback: () => Promise<T>
  ): Promise<T>;
  withSellerRequestLock<T>(
    seller: string,
    sellerRequestId: string,
    callback: () => Promise<T>
  ): Promise<T>;
  getPosition(wallet: string, vault: string): Awaitable<WalletPosition | null>;
  savePosition(position: WalletPosition): Awaitable<WalletPosition>;
  getPayment(paymentId: string): Awaitable<PaymentIntent | null>;
  listPaymentsForPosition(
    wallet: string,
    vault: string
  ): Awaitable<PaymentIntent[]>;
  listPaymentsByStatus(
    statuses: PaymentStatus[],
    limit?: number
  ): Awaitable<PaymentIntent[]>;
  findPaymentBySellerRequest(
    seller: string,
    sellerRequestId: string
  ): Awaitable<PaymentIntent | null>;
  savePayment(intent: PaymentIntent): Awaitable<PaymentIntent>;
  getDeposit(depositId: string): Awaitable<DepositIntent | null>;
  saveDeposit(intent: DepositIntent): Awaitable<DepositIntent>;
  listDepositsForPosition(
    wallet: string,
    vault: string
  ): Awaitable<DepositIntent[]>;
  getWithdrawal(withdrawalId: string): Awaitable<WithdrawalIntent | null>;
  saveWithdrawal(intent: WithdrawalIntent): Awaitable<WithdrawalIntent>;
  listWithdrawalsForPosition(
    wallet: string,
    vault: string
  ): Awaitable<WithdrawalIntent[]>;
  getLiquidityPolicy(
    sellerClass: string,
    vault: string
  ): Awaitable<SellerLiquidityPolicy | null>;
  saveLiquidityPolicy(
    policy: SellerLiquidityPolicy
  ): Awaitable<SellerLiquidityPolicy>;
  listLiquidityPolicies(): Awaitable<SellerLiquidityPolicy[]>;
  saveSyncEvent(event: SyncEvent): Awaitable<SyncEvent>;
  listSyncEvents(
    wallet: string,
    vault: string,
    limit?: number
  ): Awaitable<SyncEvent[]>;
  getSpendingMandate(wallet: string): Awaitable<SpendingMandateRecord | null>;
  saveSpendingMandate(
    record: SpendingMandateRecord
  ): Awaitable<SpendingMandateRecord>;
  saveSpendingMandateEvent(
    event: SpendingMandateEvent
  ): Awaitable<SpendingMandateEvent>;
  getSpendingApproval(approvalId: string): Awaitable<SpendingApproval | null>;
  saveSpendingApproval(
    approval: SpendingApproval
  ): Awaitable<SpendingApproval>;
  listSpendingApprovalsForWallet(
    wallet: string
  ): Awaitable<SpendingApproval[]>;
  pruneSpendingApprovals(
    wallet: string,
    beforeMs: number
  ): Awaitable<number>;
  getSetupSession(sessionId: string): Awaitable<SetupSession | null>;
  saveSetupSession(session: SetupSession): Awaitable<SetupSession>;
}

export class InMemoryLedger implements Ledger {
  private readonly positions = new Map<string, WalletPosition>();
  private readonly payments = new Map<string, PaymentIntent>();
  private readonly deposits = new Map<string, DepositIntent>();
  private readonly withdrawals = new Map<string, WithdrawalIntent>();
  private readonly liquidityPolicies = new Map<string, SellerLiquidityPolicy>();
  private readonly syncEvents: SyncEvent[] = [];
  private readonly spendingMandates = new Map<string, SpendingMandateRecord>();
  private readonly spendingMandateEvents: SpendingMandateEvent[] = [];
  private readonly spendingApprovals = new Map<string, SpendingApproval>();
  private readonly setupSessions = new Map<string, SetupSession>();
  private readonly lockTails = new Map<string, Promise<void>>();

  async withSpendingMandateLock<T>(
    wallet: string,
    callback: () => Promise<T>
  ): Promise<T> {
    return this.withLock(`spending-mandate:${wallet}`, callback);
  }

  async withWalletVaultLock<T>(
    wallet: string,
    vault: string,
    callback: () => Promise<T>
  ): Promise<T> {
    return this.withLock(`position:${positionKey(wallet, vault)}`, callback);
  }

  async withSellerRequestLock<T>(
    seller: string,
    sellerRequestId: string,
    callback: () => Promise<T>
  ): Promise<T> {
    return this.withLock(
      `seller-request:${seller}:${sellerRequestId}`,
      callback
    );
  }

  private async withLock<T>(key: string, callback: () => Promise<T>): Promise<T> {
    const previous = this.lockTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    this.lockTails.set(key, tail);

    await previous.catch(() => undefined);

    try {
      return await callback();
    } finally {
      release();
      if (this.lockTails.get(key) === tail) {
        this.lockTails.delete(key);
      }
    }
  }

  getPosition(wallet: string, vault: string): WalletPosition | null {
    return clonePosition(this.positions.get(positionKey(wallet, vault)) ?? null);
  }

  savePosition(position: WalletPosition): WalletPosition {
    const next = clonePosition(position)!;
    this.positions.set(positionKey(position.wallet, position.vault), next);
    return clonePosition(next)!;
  }

  getPayment(paymentId: string): PaymentIntent | null {
    return clonePayment(this.payments.get(paymentId) ?? null);
  }

  listPaymentsForPosition(wallet: string, vault: string): PaymentIntent[] {
    return [...this.payments.values()]
      .filter((intent) => intent.wallet === wallet && intent.vault === vault)
      .map((intent) => clonePayment(intent)!);
  }

  listPaymentsByStatus(statuses: PaymentStatus[], limit = 100): PaymentIntent[] {
    const statusSet = new Set(statuses);
    return [...this.payments.values()]
      .filter((intent) => statusSet.has(intent.status))
      .slice(0, limit)
      .map((intent) => clonePayment(intent)!);
  }

  findPaymentBySellerRequest(
    seller: string,
    sellerRequestId: string
  ): PaymentIntent | null {
    const matches = [...this.payments.values()].filter(
      (candidate) =>
        candidate.seller === seller &&
        candidate.sellerRequestId === sellerRequestId
    );
    // Prefer the live-or-settled payment; otherwise return the latest
    // terminal-failed one so binding-hash reuse can still be checked.
    const live = matches.find((candidate) =>
      LIVE_OR_SETTLED_STATUSES.has(candidate.status)
    );

    return clonePayment(live ?? matches[matches.length - 1] ?? null);
  }

  savePayment(intent: PaymentIntent): PaymentIntent {
    const next = clonePayment(intent)!;
    this.payments.set(intent.paymentId, next);
    return clonePayment(next)!;
  }

  getDeposit(depositId: string): DepositIntent | null {
    const intent = this.deposits.get(depositId) ?? null;
    return intent === null ? null : { ...intent };
  }

  saveDeposit(intent: DepositIntent): DepositIntent {
    this.deposits.set(intent.depositId, { ...intent });
    return { ...intent };
  }

  listDepositsForPosition(wallet: string, vault: string): DepositIntent[] {
    return [...this.deposits.values()]
      .filter((intent) => intent.wallet === wallet && intent.vault === vault)
      .map((intent) => ({ ...intent }));
  }

  getWithdrawal(withdrawalId: string): WithdrawalIntent | null {
    const intent = this.withdrawals.get(withdrawalId) ?? null;
    return intent === null ? null : { ...intent };
  }

  saveWithdrawal(intent: WithdrawalIntent): WithdrawalIntent {
    this.withdrawals.set(intent.withdrawalId, { ...intent });
    return { ...intent };
  }

  listWithdrawalsForPosition(wallet: string, vault: string): WithdrawalIntent[] {
    return [...this.withdrawals.values()]
      .filter((intent) => intent.wallet === wallet && intent.vault === vault)
      .map((intent) => ({ ...intent }));
  }

  getLiquidityPolicy(
    sellerClass: string,
    vault: string
  ): SellerLiquidityPolicy | null {
    const policy =
      this.liquidityPolicies.get(`${sellerClass}:${vault}`) ?? null;
    return policy === null ? null : { ...policy };
  }

  saveLiquidityPolicy(policy: SellerLiquidityPolicy): SellerLiquidityPolicy {
    this.liquidityPolicies.set(`${policy.sellerClass}:${policy.vault}`, {
      ...policy
    });
    return { ...policy };
  }

  listLiquidityPolicies(): SellerLiquidityPolicy[] {
    return [...this.liquidityPolicies.values()].map((policy) => ({ ...policy }));
  }

  saveSyncEvent(event: SyncEvent): SyncEvent {
    this.syncEvents.push({ ...event });
    return { ...event };
  }

  listSyncEvents(wallet: string, vault: string, limit = 100): SyncEvent[] {
    // Newest first, matching the PostgreSQL implementation.
    return this.syncEvents
      .filter((event) => event.wallet === wallet && event.vault === vault)
      .slice(-limit)
      .reverse()
      .map((event) => ({ ...event }));
  }

  async getSpendingMandate(wallet: string): Promise<SpendingMandateRecord | null> {
    const record = this.spendingMandates.get(wallet) ?? null;
    return record === null ? null : structuredClone(record);
  }

  saveSpendingMandate(record: SpendingMandateRecord): SpendingMandateRecord {
    this.spendingMandates.set(record.wallet, structuredClone(record));
    return structuredClone(record);
  }

  saveSpendingMandateEvent(event: SpendingMandateEvent): SpendingMandateEvent {
    this.spendingMandateEvents.push(structuredClone(event));
    return structuredClone(event);
  }

  getSpendingApproval(approvalId: string): SpendingApproval | null {
    const approval = this.spendingApprovals.get(approvalId) ?? null;
    return approval === null ? null : structuredClone(approval);
  }

  saveSpendingApproval(approval: SpendingApproval): SpendingApproval {
    this.spendingApprovals.set(approval.approvalId, structuredClone(approval));
    return structuredClone(approval);
  }

  listSpendingApprovalsForWallet(wallet: string): SpendingApproval[] {
    return [...this.spendingApprovals.values()]
      .filter((approval) => approval.wallet === wallet)
      .sort((a, b) => b.requestedAtMs - a.requestedAtMs)
      .map((approval) => structuredClone(approval));
  }

  pruneSpendingApprovals(wallet: string, beforeMs: number): number {
    let removed = 0;
    for (const [approvalId, approval] of this.spendingApprovals) {
      const old = approval.expiresAtMs < beforeMs;
      const terminal =
        approval.status === "consumed" ||
        approval.status === "denied" ||
        approval.status === "expired";
      if (approval.wallet === wallet && (old || terminal)) {
        this.spendingApprovals.delete(approvalId);
        removed += 1;
      }
    }
    return removed;
  }

  getSetupSession(sessionId: string): SetupSession | null {
    const session = this.setupSessions.get(sessionId) ?? null;
    return session === null ? null : structuredClone(session);
  }

  saveSetupSession(session: SetupSession): SetupSession {
    this.setupSessions.set(session.sessionId, structuredClone(session));
    return structuredClone(session);
  }
}

const LIVE_OR_SETTLED_STATUSES: ReadonlySet<PaymentIntent["status"]> = new Set([
  "prepared",
  "submission_prepared",
  "submitted",
  "settled"
]);

export function positionKey(wallet: string, vault: string): string {
  return `${wallet}:${vault}`;
}

function clonePosition(position: WalletPosition | null): WalletPosition | null {
  if (position === null) {
    return null;
  }

  return {
    ...position,
    kaminoPositionSnapshot: position.kaminoPositionSnapshot.map((entry) => ({
      ...entry
    })),
    kaminoPnlSnapshot: position.kaminoPnlSnapshot.map((entry) => ({ ...entry }))
  };
}

function clonePayment(intent: PaymentIntent | null): PaymentIntent | null {
  if (intent === null) {
    return null;
  }

  return { ...intent };
}
