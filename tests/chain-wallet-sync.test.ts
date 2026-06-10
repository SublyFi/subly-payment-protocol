import bs58 from "bs58";
import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";
import { SUBLY_VAULT } from "../src/config/constants.js";
import { ChainWalletSyncService } from "../src/domain/chain-wallet-sync.js";
import { SublyService } from "../src/domain/payment-service.js";
import type { KaminoApiClient } from "../src/kamino/api-client.js";
import type {
  KaminoVaultAdapter,
  UserSharesRaw,
  VaultContext
} from "../src/kamino/vault-adapter.js";

const WALLET = bs58.encode(
  nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9)).publicKey
);

function fakeAdapter(params: {
  totalSharesRaw: bigint;
  exchangeRateScaled: bigint;
}) {
  return {
    vaultAddress: SUBLY_VAULT.address,
    async loadContext(): Promise<VaultContext> {
      return {
        slot: 1000n,
        exchangeRateScaled: params.exchangeRateScaled,
        instantRedeemCapacityRawUsdc: 10_000_000n
      } as unknown as VaultContext;
    },
    async getUserSharesRaw(): Promise<UserSharesRaw> {
      return {
        stakedSharesRaw: params.totalSharesRaw,
        unstakedSharesRaw: 0n,
        totalSharesRaw: params.totalSharesRaw,
        sharesAtaAddress: WALLET as never,
        sharesAtaExists: true
      };
    }
  } as unknown as KaminoVaultAdapter;
}

function fakePnlClient(costBasisRawUsdc: bigint | null) {
  return {
    async getUserVaultPnl() {
      return costBasisRawUsdc === null
        ? null
        : { costBasisRawUsdc, provenance: [] };
    }
  } as unknown as KaminoApiClient;
}

async function registeredService(initial: {
  totalSharesRaw: string;
  principalBasisRawUsdc: string;
}) {
  const service = new SublyService();
  await service.registerAgentWallet({
    wallet: WALLET,
    signingPolicyId: "policy_1",
    signerProvider: "local_test"
  });
  await service.syncWalletPosition({
    wallet: WALLET,
    totalSharesRaw: initial.totalSharesRaw,
    exchangeRateScaled: "1000000000000",
    instantRedeemCapacityRawUsdc: "10000000",
    principalBasisRawUsdc: initial.principalBasisRawUsdc,
    principalBasisSource: "kamino_pnl_current"
  });
  return service;
}

describe("ChainWalletSyncService", () => {
  it("floors the basis at ledger basis plus new-share value when PnL under-reports", async () => {
    const service = await registeredService({
      totalSharesRaw: "100000000",
      principalBasisRawUsdc: "100000000"
    });
    // External UI deposit added 50 USDC worth of shares, but the PnL API
    // reports a stale cost basis of only 120 USDC.
    const sync = new ChainWalletSyncService({
      adapter: fakeAdapter({
        totalSharesRaw: 150_000_000n,
        exchangeRateScaled: 1_000_000_000_000n
      }),
      service,
      apiClient: fakePnlClient(120_000_000n)
    });

    const result = await sync.syncFromChain({ wallet: WALLET });

    // 100 (ledger basis) + 50 (new share value) = 150; the stale 120 from the
    // PnL API must not turn 30 USDC of new principal into spendable yield.
    expect(result.position.principalBasisRawUsdc).toBe("150000000");
    expect(result.budget.spendableYieldRawUsdc).toBe("0");
  });

  it("uses the PnL cost basis when it is at or above the conservative floor", async () => {
    const service = await registeredService({
      totalSharesRaw: "100000000",
      principalBasisRawUsdc: "100000000"
    });
    const sync = new ChainWalletSyncService({
      adapter: fakeAdapter({
        totalSharesRaw: 150_000_000n,
        exchangeRateScaled: 1_000_000_000_000n
      }),
      service,
      apiClient: fakePnlClient(155_000_000n)
    });

    const result = await sync.syncFromChain({ wallet: WALLET });

    expect(result.position.principalBasisRawUsdc).toBe("155000000");
  });

  it("runs a conservative reset when shares moved and no cost basis is available", async () => {
    const service = await registeredService({
      totalSharesRaw: "100000000",
      principalBasisRawUsdc: "100000000"
    });
    const sync = new ChainWalletSyncService({
      adapter: fakeAdapter({
        totalSharesRaw: 150_000_000n,
        exchangeRateScaled: 1_000_000_000_000n
      }),
      service,
      apiClient: fakePnlClient(null)
    });

    const result = await sync.syncFromChain({ wallet: WALLET });

    expect(result.position.principalBasisSource).toBe(
      "conservative_activation_reset"
    );
    expect(result.position.principalBasisRawUsdc).toBe("150000000");
    expect(result.budget.spendableYieldRawUsdc).toBe("0");
  });

  it("forces a conservative reset when shares decreased outside Subly", async () => {
    const service = await registeredService({
      totalSharesRaw: "100000000",
      principalBasisRawUsdc: "90000000"
    });
    const sync = new ChainWalletSyncService({
      adapter: fakeAdapter({
        totalSharesRaw: 80_000_000n,
        exchangeRateScaled: 1_000_000_000_000n
      }),
      service,
      apiClient: fakePnlClient(95_000_000n)
    });

    const result = await sync.syncFromChain({ wallet: WALLET });

    expect(result.position.principalBasisSource).toBe(
      "conservative_activation_reset"
    );
    expect(result.position.principalBasisRawUsdc).toBe("80000000");
  });
});
