import { RATE_SCALE } from "../config/constants.js";
import { KaminoVaultAdapter } from "../kamino/vault-adapter.js";
import type { KaminoApiClient } from "../kamino/api-client.js";
import { maxBigInt, mulDivCeil } from "../lib/raw-units.js";
import type {
  SublyService,
  SyncWalletPositionInput
} from "./payment-service.js";
import type { ProvenancedRawValue } from "./models.js";
import { notFound } from "./errors.js";

/**
 * Syncs a wallet position from on-chain state (total shares, exchange rate,
 * instant liquidity) plus the Kamino P&L API for cost basis. When reliable
 * cost-basis data is unavailable and shares moved outside Subly, runs the
 * conservative baseline reset so unknown value is never treated as yield.
 */
export class ChainWalletSyncService {
  private readonly adapter: KaminoVaultAdapter;
  private readonly apiClient: KaminoApiClient | null;
  private readonly service: SublyService;

  constructor(params: {
    adapter: KaminoVaultAdapter;
    service: SublyService;
    apiClient?: KaminoApiClient | undefined;
  }) {
    this.adapter = params.adapter;
    this.service = params.service;
    this.apiClient = params.apiClient ?? null;
  }

  async syncFromChain(input: {
    wallet: string;
    forceConservativeReset?: boolean | undefined;
  }) {
    const context = await this.adapter.loadContext();
    const userShares = await this.adapter.getUserSharesRaw(input.wallet, context);
    const vault = this.adapter.vaultAddress;

    const ledgerPosition = await this.service.ledger.getPosition(
      input.wallet,
      vault
    );
    if (ledgerPosition === null) {
      throw notFound(
        "wallet_not_registered",
        "Register the agent wallet before syncing its Kamino position"
      );
    }

    const sharesMoved =
      userShares.totalSharesRaw !== ledgerPosition.totalSharesRaw;
    const sharesDecreased =
      userShares.totalSharesRaw < ledgerPosition.totalSharesRaw;

    let principalBasisRawUsdc: bigint | null = null;
    let principalBasisSource: SyncWalletPositionInput["principalBasisSource"];
    let pnlSnapshot: ProvenancedRawValue[] | null = null;
    let forceConservativeReset = input.forceConservativeReset === true;

    if (!forceConservativeReset && sharesMoved) {
      if (sharesDecreased) {
        // Same-wallet UI withdraws or unknown outbound share movements cannot
        // be classified exactly here; force the conservative reset.
        forceConservativeReset = true;
      } else {
        const pnl =
          this.apiClient === null
            ? null
            : await this.apiClient.getUserVaultPnl({ wallet: input.wallet, vault });
        if (pnl?.costBasisRawUsdc != null) {
          // Trusted current cost basis may raise or confirm the baseline but
          // never lower it merely because history looks like yield. It is
          // also floored at the ledger baseline plus the current value of the
          // newly observed shares, so a partial or lagging cost-basis report
          // can never turn an external deposit into spendable yield.
          const deltaSharesRaw =
            userShares.totalSharesRaw - ledgerPosition.totalSharesRaw;
          const externalDepositFloorRawUsdc =
            ledgerPosition.principalBasisRawUsdc +
            mulDivCeil(deltaSharesRaw, context.exchangeRateScaled, RATE_SCALE);
          principalBasisRawUsdc = maxBigInt(
            pnl.costBasisRawUsdc,
            externalDepositFloorRawUsdc
          );
          principalBasisSource = "kamino_pnl_current";
          pnlSnapshot = pnl.provenance;
        } else {
          forceConservativeReset = true;
        }
      }
    }

    return this.service.syncWalletPosition({
      wallet: input.wallet,
      vault,
      stakedSharesRaw: userShares.stakedSharesRaw.toString(),
      unstakedSharesRaw: userShares.unstakedSharesRaw.toString(),
      totalSharesRaw: userShares.totalSharesRaw.toString(),
      exchangeRateScaled: context.exchangeRateScaled.toString(),
      instantRedeemCapacityRawUsdc:
        context.instantRedeemCapacityRawUsdc.toString(),
      ...(principalBasisRawUsdc === null
        ? {}
        : { principalBasisRawUsdc: principalBasisRawUsdc.toString() }),
      ...(principalBasisSource === undefined ? {} : { principalBasisSource }),
      ...(pnlSnapshot === null ? {} : { kaminoPnlSnapshot: pnlSnapshot }),
      observedSlot: Number(context.slot),
      sourceEndpoint: "chain_rpc+kamino_pnl_api",
      forceConservativeReset
    });
  }
}
