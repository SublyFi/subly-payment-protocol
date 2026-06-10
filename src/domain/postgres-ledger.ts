import { AsyncLocalStorage } from "node:async_hooks";
import { Pool, type PoolClient, type PoolConfig } from "pg";
import type { Ledger } from "./ledger.js";
import type {
  DepositIntent,
  PaymentIntent,
  PaymentStatus,
  ProvenancedRawValue,
  SellerLiquidityPolicy,
  SyncEvent,
  WalletPosition,
  WithdrawalIntent
} from "./models.js";

type Queryable = Pool | PoolClient;

const POSITION_BIGINT_FIELDS = [
  "stakedSharesRaw",
  "unstakedSharesRaw",
  "totalSharesRaw",
  "exchangeRateScaled",
  "instantRedeemCapacityRawUsdc",
  "principalBasisRawUsdc",
  "reservedRawUsdc",
  "feeDebtRawUsdc",
  "safetyBufferRawUsdc"
] as const;

const PAYMENT_BIGINT_FIELDS = [
  "amountRawUsdc",
  "sharesToRedeemRaw",
  "requiredWithdrawRawUsdc",
  "estimatedFeeLamports",
  "estimatedFeeDebtRawUsdc",
  "principalBasisBeforeRawUsdc",
  "grossYieldBeforeRawUsdc",
  "spendableYieldBeforeRawUsdc",
  "postPositionValueRawUsdc",
  "reservationRawUsdc"
] as const;

export class PostgresLedger implements Ledger {
  private readonly pool: Pool;
  private readonly storage = new AsyncLocalStorage<PoolClient>();
  private schemaReady: Promise<void> | null = null;

  constructor(config: PoolConfig | string) {
    this.pool =
      typeof config === "string" ? new Pool({ connectionString: config }) : new Pool(config);
  }

  async withWalletVaultLock<T>(
    wallet: string,
    vault: string,
    callback: () => Promise<T>
  ): Promise<T> {
    return this.withTransactionLock("subly-position", `${wallet}:${vault}`, callback);
  }

  async withSellerRequestLock<T>(
    seller: string,
    sellerRequestId: string,
    callback: () => Promise<T>
  ): Promise<T> {
    return this.withTransactionLock(
      "subly-seller-request",
      `${seller}:${sellerRequestId}`,
      callback
    );
  }

  async getPosition(wallet: string, vault: string): Promise<WalletPosition | null> {
    await this.ensureSchema();
    const result = await this.query(
      "select data from wallet_positions where wallet = $1 and vault = $2",
      [wallet, vault]
    );

    return result.rows[0]?.data === undefined
      ? null
      : hydrateWalletPosition(result.rows[0].data);
  }

  async savePosition(position: WalletPosition): Promise<WalletPosition> {
    await this.ensureSchema();
    const data = dehydrate(position);
    const saved = await this.query(
      `insert into wallet_positions (wallet, vault, data, updated_at)
       values ($1, $2, $3::jsonb, now())
       on conflict (wallet, vault)
       do update set data = excluded.data, updated_at = now()
       returning data`,
      [position.wallet, position.vault, JSON.stringify(data)]
    );

    return hydrateWalletPosition(saved.rows[0].data);
  }

  async getPayment(paymentId: string): Promise<PaymentIntent | null> {
    await this.ensureSchema();
    const result = await this.query(
      "select data from payment_intents where payment_id = $1",
      [paymentId]
    );

    return result.rows[0]?.data === undefined
      ? null
      : hydratePaymentIntent(result.rows[0].data);
  }

  async listPaymentsForPosition(
    wallet: string,
    vault: string
  ): Promise<PaymentIntent[]> {
    await this.ensureSchema();
    const result = await this.query(
      `select data from payment_intents
       where wallet = $1 and vault = $2
       order by created_at asc`,
      [wallet, vault]
    );

    return result.rows.map((row) => hydratePaymentIntent(row.data));
  }

  async listPaymentsByStatus(
    statuses: PaymentStatus[],
    limit = 100
  ): Promise<PaymentIntent[]> {
    await this.ensureSchema();
    const result = await this.query(
      `select data from payment_intents
       where status = any($1::text[])
       order by updated_at asc
       limit $2`,
      [statuses, limit]
    );

    return result.rows.map((row) => hydratePaymentIntent(row.data));
  }

  async findPaymentBySellerRequest(
    seller: string,
    sellerRequestId: string
  ): Promise<PaymentIntent | null> {
    await this.ensureSchema();
    const result = await this.query(
      `select data from payment_intents
       where seller = $1 and seller_request_id = $2
       order by
         case
           when status in ('prepared', 'submission_prepared', 'submitted', 'settled')
             then 0
           else 1
         end,
         updated_at desc
       limit 1`,
      [seller, sellerRequestId]
    );

    return result.rows[0]?.data === undefined
      ? null
      : hydratePaymentIntent(result.rows[0].data);
  }

  async savePayment(intent: PaymentIntent): Promise<PaymentIntent> {
    await this.ensureSchema();
    const data = dehydrate(intent);
    const saved = await this.query(
      `insert into payment_intents (
         payment_id, wallet, vault, seller, seller_request_id,
         request_binding_hash, status, data, updated_at
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, now())
       on conflict (payment_id)
       do update set
         status = excluded.status,
         data = excluded.data,
         updated_at = now()
       returning data`,
      [
        intent.paymentId,
        intent.wallet,
        intent.vault,
        intent.seller,
        intent.sellerRequestId,
        intent.requestBindingHash,
        intent.status,
        JSON.stringify(data)
      ]
    );

    return hydratePaymentIntent(saved.rows[0].data);
  }

  async getDeposit(depositId: string): Promise<DepositIntent | null> {
    await this.ensureSchema();
    const result = await this.query(
      "select data from deposit_intents where deposit_id = $1",
      [depositId]
    );

    return result.rows[0]?.data === undefined
      ? null
      : hydrateDepositIntent(result.rows[0].data);
  }

  async saveDeposit(intent: DepositIntent): Promise<DepositIntent> {
    await this.ensureSchema();
    const saved = await this.query(
      `insert into deposit_intents (deposit_id, wallet, vault, status, data, updated_at)
       values ($1, $2, $3, $4, $5::jsonb, now())
       on conflict (deposit_id)
       do update set status = excluded.status, data = excluded.data, updated_at = now()
       returning data`,
      [
        intent.depositId,
        intent.wallet,
        intent.vault,
        intent.status,
        JSON.stringify(dehydrate(intent))
      ]
    );

    return hydrateDepositIntent(saved.rows[0].data);
  }

  async listDepositsForPosition(
    wallet: string,
    vault: string
  ): Promise<DepositIntent[]> {
    await this.ensureSchema();
    const result = await this.query(
      `select data from deposit_intents
       where wallet = $1 and vault = $2
       order by created_at asc`,
      [wallet, vault]
    );

    return result.rows.map((row) => hydrateDepositIntent(row.data));
  }

  async getWithdrawal(withdrawalId: string): Promise<WithdrawalIntent | null> {
    await this.ensureSchema();
    const result = await this.query(
      "select data from withdrawal_intents where withdrawal_id = $1",
      [withdrawalId]
    );

    return result.rows[0]?.data === undefined
      ? null
      : hydrateWithdrawalIntent(result.rows[0].data);
  }

  async saveWithdrawal(intent: WithdrawalIntent): Promise<WithdrawalIntent> {
    await this.ensureSchema();
    const saved = await this.query(
      `insert into withdrawal_intents (withdrawal_id, wallet, vault, status, data, updated_at)
       values ($1, $2, $3, $4, $5::jsonb, now())
       on conflict (withdrawal_id)
       do update set status = excluded.status, data = excluded.data, updated_at = now()
       returning data`,
      [
        intent.withdrawalId,
        intent.wallet,
        intent.vault,
        intent.status,
        JSON.stringify(dehydrate(intent))
      ]
    );

    return hydrateWithdrawalIntent(saved.rows[0].data);
  }

  async listWithdrawalsForPosition(
    wallet: string,
    vault: string
  ): Promise<WithdrawalIntent[]> {
    await this.ensureSchema();
    const result = await this.query(
      `select data from withdrawal_intents
       where wallet = $1 and vault = $2
       order by created_at asc`,
      [wallet, vault]
    );

    return result.rows.map((row) => hydrateWithdrawalIntent(row.data));
  }

  async getLiquidityPolicy(
    sellerClass: string,
    vault: string
  ): Promise<SellerLiquidityPolicy | null> {
    await this.ensureSchema();
    const result = await this.query(
      `select data from seller_liquidity_policies
       where seller_class = $1 and vault = $2`,
      [sellerClass, vault]
    );

    return result.rows[0]?.data === undefined
      ? null
      : hydrateLiquidityPolicy(result.rows[0].data);
  }

  async saveLiquidityPolicy(
    policy: SellerLiquidityPolicy
  ): Promise<SellerLiquidityPolicy> {
    await this.ensureSchema();
    const saved = await this.query(
      `insert into seller_liquidity_policies (seller_class, vault, data, updated_at)
       values ($1, $2, $3::jsonb, now())
       on conflict (seller_class, vault)
       do update set data = excluded.data, updated_at = now()
       returning data`,
      [policy.sellerClass, policy.vault, JSON.stringify(dehydrate(policy))]
    );

    return hydrateLiquidityPolicy(saved.rows[0].data);
  }

  async listLiquidityPolicies(): Promise<SellerLiquidityPolicy[]> {
    await this.ensureSchema();
    const result = await this.query(
      "select data from seller_liquidity_policies order by seller_class asc",
      []
    );

    return result.rows.map((row) => hydrateLiquidityPolicy(row.data));
  }

  async saveSyncEvent(event: SyncEvent): Promise<SyncEvent> {
    await this.ensureSchema();
    const saved = await this.query(
      `insert into sync_events (event_id, wallet, vault, event_type, data)
       values ($1, $2, $3, $4, $5::jsonb)
       on conflict (event_id) do nothing
       returning data`,
      [
        event.eventId,
        event.wallet,
        event.vault,
        event.eventType,
        JSON.stringify(dehydrate(event))
      ]
    );

    return saved.rows[0]?.data === undefined
      ? { ...event }
      : hydrateSyncEvent(saved.rows[0].data);
  }

  async listSyncEvents(
    wallet: string,
    vault: string,
    limit = 100
  ): Promise<SyncEvent[]> {
    await this.ensureSchema();
    const result = await this.query(
      `select data from sync_events
       where wallet = $1 and vault = $2
       order by created_at desc
       limit $3`,
      [wallet, vault, limit]
    );

    return result.rows.map((row) => hydrateSyncEvent(row.data));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async ensureSchema(): Promise<void> {
    this.schemaReady ??= this.pool.query(POSTGRES_SCHEMA).then(() => undefined);
    await this.schemaReady;
  }

  private async withTransactionLock<T>(
    namespace: string,
    key: string,
    callback: () => Promise<T>
  ): Promise<T> {
    await this.ensureSchema();
    const existingClient = this.storage.getStore();
    if (existingClient !== undefined) {
      await existingClient.query(
        "select pg_advisory_xact_lock(hashtext($1), hashtext($2))",
        [namespace, key]
      );
      return callback();
    }

    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await this.storage.run(client, async () => {
        await client.query(
          "select pg_advisory_xact_lock(hashtext($1), hashtext($2))",
          [namespace, key]
        );
        return callback();
      });
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  private async query(sql: string, values: unknown[]) {
    const queryable: Queryable = this.storage.getStore() ?? this.pool;
    return queryable.query(sql, values);
  }
}

const POSTGRES_SCHEMA = `
create table if not exists wallet_positions (
  wallet text not null,
  vault text not null,
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (wallet, vault)
);

create table if not exists payment_intents (
  payment_id text primary key,
  wallet text not null,
  vault text not null,
  seller text not null,
  seller_request_id text not null,
  request_binding_hash text not null,
  status text not null,
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists payment_intents_wallet_vault_idx
  on payment_intents (wallet, vault);

-- One live-or-settled payment per seller request. Terminal failures
-- (expired, failed, failed_not_submitted) may be re-prepared with a new
-- paymentId for the same request binding.
alter table payment_intents
  drop constraint if exists payment_intents_seller_seller_request_id_key;

create unique index if not exists payment_intents_active_seller_request_key
  on payment_intents (seller, seller_request_id)
  where status in ('prepared', 'submission_prepared', 'submitted', 'settled');

create index if not exists payment_intents_seller_request_idx
  on payment_intents (seller, seller_request_id);

create table if not exists deposit_intents (
  deposit_id text primary key,
  wallet text not null,
  vault text not null,
  status text not null,
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists deposit_intents_wallet_vault_idx
  on deposit_intents (wallet, vault);

create table if not exists withdrawal_intents (
  withdrawal_id text primary key,
  wallet text not null,
  vault text not null,
  status text not null,
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists withdrawal_intents_wallet_vault_idx
  on withdrawal_intents (wallet, vault);

create table if not exists seller_liquidity_policies (
  seller_class text not null,
  vault text not null,
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (seller_class, vault)
);

create table if not exists sync_events (
  event_id text primary key,
  wallet text not null,
  vault text not null,
  event_type text not null,
  data jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists sync_events_wallet_vault_idx
  on sync_events (wallet, vault, created_at);
`;

function dehydrate<T>(value: T): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, entry) =>
      typeof entry === "bigint" ? entry.toString() : entry
    )
  );
}

function hydrateWalletPosition(data: Record<string, unknown>): WalletPosition {
  const next = { ...data } as unknown as WalletPosition;
  for (const field of POSITION_BIGINT_FIELDS) {
    next[field] = BigInt(String(data[field]));
  }
  next.signerValidationMode =
    data.signerValidationMode === "structured_intent_transaction"
      ? "structured_intent_transaction"
      : "unverified";
  next.kaminoPositionSnapshot = hydrateProvenanceList(
    data.kaminoPositionSnapshot
  );
  next.kaminoPnlSnapshot = hydrateProvenanceList(data.kaminoPnlSnapshot);
  return next;
}

function hydratePaymentIntent(data: Record<string, unknown>): PaymentIntent {
  const next = { ...data } as unknown as PaymentIntent;
  for (const field of PAYMENT_BIGINT_FIELDS) {
    next[field] = BigInt(String(data[field]));
  }
  next.submittedSerializedTransaction =
    typeof data.submittedSerializedTransaction === "string"
      ? data.submittedSerializedTransaction
      : null;
  return next;
}

const DEPOSIT_BIGINT_FIELDS = ["amountRawUsdc", "principalBasisBeforeRawUsdc"] as const;
const DEPOSIT_NULLABLE_BIGINT_FIELDS = [
  "actualDepositRawUsdc",
  "sharesMintedRaw",
  "principalBasisAfterRawUsdc"
] as const;
const WITHDRAWAL_BIGINT_FIELDS = [
  "requestedWithdrawRawUsdc",
  "requestedSharesRaw",
  "maxSharesToRedeemRaw",
  "principalBasisBeforeRawUsdc"
] as const;
const WITHDRAWAL_NULLABLE_BIGINT_FIELDS = [
  "actualSharesBurnedRaw",
  "actualWithdrawRawUsdc",
  "principalBasisAfterRawUsdc"
] as const;

function hydrateDepositIntent(data: Record<string, unknown>): DepositIntent {
  const next = { ...data } as unknown as DepositIntent;
  for (const field of DEPOSIT_BIGINT_FIELDS) {
    next[field] = BigInt(String(data[field]));
  }
  for (const field of DEPOSIT_NULLABLE_BIGINT_FIELDS) {
    next[field] =
      data[field] === null || data[field] === undefined
        ? null
        : BigInt(String(data[field]));
  }
  return next;
}

function hydrateWithdrawalIntent(data: Record<string, unknown>): WithdrawalIntent {
  const next = { ...data } as unknown as WithdrawalIntent;
  for (const field of WITHDRAWAL_BIGINT_FIELDS) {
    next[field] = BigInt(String(data[field]));
  }
  for (const field of WITHDRAWAL_NULLABLE_BIGINT_FIELDS) {
    next[field] =
      data[field] === null || data[field] === undefined
        ? null
        : BigInt(String(data[field]));
  }
  return next;
}

function hydrateLiquidityPolicy(
  data: Record<string, unknown>
): SellerLiquidityPolicy {
  const next = { ...data } as unknown as SellerLiquidityPolicy;
  next.expectedPaymentSizeRawUsdc = BigInt(String(data.expectedPaymentSizeRawUsdc));
  next.minInstantLiquidityRawUsdc = BigInt(String(data.minInstantLiquidityRawUsdc));
  next.targetBudgetIlliquidRate = Number(data.targetBudgetIlliquidRate);
  return next;
}

function hydrateSyncEvent(data: Record<string, unknown>): SyncEvent {
  const next = { ...data } as unknown as SyncEvent;
  next.deltaSharesRaw = BigInt(String(data.deltaSharesRaw));
  next.deltaPrincipalRawUsdc = BigInt(String(data.deltaPrincipalRawUsdc));
  return next;
}

function hydrateProvenanceList(value: unknown): ProvenancedRawValue[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((entry) => ({
    ...(entry as ProvenancedRawValue),
    normalizedRawUnits: BigInt(
      String((entry as ProvenancedRawValue).normalizedRawUnits)
    )
  }));
}
