import BN from "bn.js";
import { Decimal } from "decimal.js";
import {
  DEFAULT_RECENT_SLOT_DURATION_MS,
  getAssociatedTokenAddress,
  getCTokenVaultPda,
  getEventAuthorityPda,
  getKvaultGlobalConfigPda,
  KaminoVault,
  KaminoVaultClient,
  kaminoVaultId,
  lendingMarketAuthPda,
  PROGRAM_ID as KLEND_PROGRAM_ID,
  withdraw as kvaultWithdraw,
  withdrawFromAvailable as kvaultWithdrawFromAvailable,
  type KaminoReserve,
  type KVaultGlobalConfig,
  type VaultState
} from "@kamino-finance/klend-sdk";
import type { FarmState } from "@kamino-finance/farms-sdk/dist/index.js";
import { fetchMaybeAddressLookupTable } from "@solana-program/address-lookup-table";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import {
  address,
  createNoopSigner,
  type Address,
  type Blockhash,
  type Instruction,
  type Slot
} from "@solana/kit";
import { RATE_SCALE, SHARE_DECIMALS, USDC_DECIMALS } from "../config/constants.js";
import { ceilDiv } from "../lib/raw-units.js";
import type { SolanaRpc } from "../solana/rpc.js";

const SYSVAR_INSTRUCTIONS_ADDRESS = address(
  "Sysvar1nstructions1111111111111111111111111"
);
const FULL_BPS = 10_000n;
/**
 * Vault withdraw rounds cTokens up before the KLend redeem CPI, so planning
 * exactly at reserve free-liquidity capacity can fail by one lamport.
 */
const RESERVE_LIQUIDITY_ROUNDING_BUFFER = 1n;

export interface VaultContext {
  slot: Slot;
  vaultState: VaultState;
  reservesMap: Map<Address, KaminoReserve>;
  globalConfig: KVaultGlobalConfig;
  farmState: FarmState | null;
  /** tokens per share as a Decimal in token units. */
  tokensPerShare: Decimal;
  /** floor(tokensPerShare * RATE_SCALE) as raw fixed-point integer. */
  exchangeRateScaled: bigint;
  tokenAvailableRaw: bigint;
  /** Unallocated buffer + every reserve's executable liquidity. */
  instantRedeemCapacityRawUsdc: bigint;
  /** Unallocated buffer + the single best reserve (one withdraw instruction). */
  singleInstructionRedeemCapacityRawUsdc: bigint;
  bestReserve: Address | null;
  reserveExecutableLiquidity: Map<Address, bigint>;
  withdrawalPenaltyBps: bigint;
  withdrawalPenaltyLamports: bigint;
  minWithdrawAmountRaw: bigint;
  minDepositAmountRaw: bigint;
  blockhash: Blockhash;
  lastValidBlockHeight: bigint;
}

export interface UserSharesRaw {
  stakedSharesRaw: bigint;
  unstakedSharesRaw: bigint;
  totalSharesRaw: bigint;
  sharesAtaAddress: Address;
  sharesAtaExists: boolean;
}

export interface SettlementWithdrawQuote {
  /** Gross withdraw needed so that net output covers the target after penalty. */
  requiredWithdrawRawUsdc: bigint;
  sharesToRedeemRaw: bigint;
  withdrawalPenaltyRawUsdc: bigint;
  /** Expected net token output for the quoted shares at the current rate. */
  expectedNetOutputRawUsdc: bigint;
}

export class VaultLiquidityError extends Error {
  readonly code = "budget_illiquid";

  constructor(message: string) {
    super(message);
    this.name = "VaultLiquidityError";
  }
}

export class KaminoVaultAdapter {
  readonly vaultAddress: Address;
  private readonly rpc: SolanaRpc;
  private readonly client: KaminoVaultClient;
  private readonly extraLookupTables: Address[];

  constructor(params: {
    rpc: SolanaRpc;
    vaultAddress: string;
    /**
     * Additional lookup tables (e.g. a Subly-managed table with the vault
     * reserves and farm accounts) used to keep the settlement transaction
     * within the size limit when the curator's vault LUT is not synced.
     */
    extraLookupTables?: string[];
  }) {
    this.rpc = params.rpc;
    this.vaultAddress = address(params.vaultAddress);
    this.extraLookupTables = (params.extraLookupTables ?? []).map((value) =>
      address(value)
    );
    this.client = new KaminoVaultClient(
      params.rpc,
      DEFAULT_RECENT_SLOT_DURATION_MS,
      kaminoVaultId,
      KLEND_PROGRAM_ID
    );
  }

  vaultHandle(state?: VaultState): KaminoVault {
    return new KaminoVault(this.rpc, this.vaultAddress, state, kaminoVaultId);
  }

  async loadContext(): Promise<VaultContext> {
    const vault = this.vaultHandle();
    const [vaultState, slot, latestBlockhash, globalConfig] = await Promise.all([
      vault.getState(),
      this.rpc.getSlot({ commitment: "confirmed" }).send(),
      this.rpc.getLatestBlockhash({ commitment: "confirmed" }).send(),
      this.client.loadKVaultGlobalConfig()
    ]);
    const [reservesMap, farmState] = await Promise.all([
      this.client.loadVaultReserves(vaultState),
      this.client.loadVaultFarmState(vaultState)
    ]);

    const tokensPerShare = await this.client.getTokensPerShareSingleVault(
      vaultState,
      slot,
      reservesMap,
      slot
    );
    const exchangeRateScaled = decimalToBigInt(
      tokensPerShare.mul(RATE_SCALE.toString())
    );

    const tokenAvailableRaw = BigInt(vaultState.tokenAvailable.toString());
    const reserveExecutableLiquidity = new Map<Address, bigint>();
    if (hasAllocatedReserves(vaultState)) {
      const availableToWithdraw =
        await this.client.getReserveAllocationAvailableLiquidityToWithdraw(
          vaultState,
          slot,
          reservesMap
        );
      for (const [reserve, liquidity] of availableToWithdraw) {
        const executable = decimalToBigInt(liquidity.floor());
        reserveExecutableLiquidity.set(
          reserve,
          executable > RESERVE_LIQUIDITY_ROUNDING_BUFFER
            ? executable - RESERVE_LIQUIDITY_ROUNDING_BUFFER
            : 0n
        );
      }
    }

    let totalReserveLiquidity = 0n;
    let bestReserve: Address | null = null;
    let bestReserveLiquidity = 0n;
    for (const [reserve, liquidity] of reserveExecutableLiquidity) {
      totalReserveLiquidity += liquidity;
      if (liquidity > bestReserveLiquidity) {
        bestReserveLiquidity = liquidity;
        bestReserve = reserve;
      }
    }

    const penalties = effectiveWithdrawalPenalty(vaultState, globalConfig);

    return {
      slot,
      vaultState,
      reservesMap,
      globalConfig,
      farmState,
      tokensPerShare,
      exchangeRateScaled,
      tokenAvailableRaw,
      instantRedeemCapacityRawUsdc: tokenAvailableRaw + totalReserveLiquidity,
      singleInstructionRedeemCapacityRawUsdc:
        tokenAvailableRaw + bestReserveLiquidity,
      bestReserve,
      reserveExecutableLiquidity,
      withdrawalPenaltyBps: penalties.bps,
      withdrawalPenaltyLamports: penalties.lamports,
      minWithdrawAmountRaw: BigInt(vaultState.minWithdrawAmount.toString()),
      minDepositAmountRaw: BigInt(vaultState.minDepositAmount.toString()),
      blockhash: latestBlockhash.value.blockhash,
      lastValidBlockHeight: latestBlockhash.value.lastValidBlockHeight
    };
  }

  async getUserSharesRaw(
    wallet: string,
    context: VaultContext
  ): Promise<UserSharesRaw> {
    const owner = address(wallet);
    const sharesState = await this.client.getUserSharesState(
      owner,
      context.vaultState,
      context.farmState === null ? undefined : context.vaultState.vaultFarm
    );
    const sharesAtaInfo = await this.rpc
      .getAccountInfo(sharesState.userSharesAta, { encoding: "base64" })
      .send();

    const stakedSharesRaw = sharesDecimalToRaw(sharesState.farmBalance);
    const unstakedSharesRaw = sharesDecimalToRaw(sharesState.ataBalance);

    return {
      stakedSharesRaw,
      unstakedSharesRaw,
      totalSharesRaw: stakedSharesRaw + unstakedSharesRaw,
      sharesAtaAddress: sharesState.userSharesAta,
      sharesAtaExists: sharesAtaInfo.value !== null
    };
  }

  /**
   * Computes the gross withdraw and share burn needed for a target net USDC
   * output, accounting for the vault withdrawal penalty. Throws
   * VaultLiquidityError when the gross amount cannot be served by one
   * withdraw instruction (unallocated buffer + best reserve).
   */
  quoteSettlementWithdraw(
    targetNetRawUsdc: bigint,
    context: VaultContext
  ): SettlementWithdrawQuote {
    if (targetNetRawUsdc <= 0n) {
      throw new Error("targetNetRawUsdc must be positive");
    }
    if (context.exchangeRateScaled <= 0n) {
      throw new Error("Vault exchange rate is not positive");
    }

    const gross = grossWithdrawForNetTarget({
      targetNetRawUsdc,
      penaltyBps: context.withdrawalPenaltyBps,
      penaltyLamports: context.withdrawalPenaltyLamports
    });
    const penalty = withdrawalPenaltyFor(
      gross,
      context.withdrawalPenaltyBps,
      context.withdrawalPenaltyLamports
    );
    const net = gross - penalty;
    if (net <= context.minWithdrawAmountRaw) {
      throw new VaultLiquidityError(
        `Net withdraw ${net} does not exceed the vault minimum ${context.minWithdrawAmountRaw}`
      );
    }
    if (gross > context.singleInstructionRedeemCapacityRawUsdc) {
      throw new VaultLiquidityError(
        `Gross withdraw ${gross} exceeds single-instruction instant capacity ${context.singleInstructionRedeemCapacityRawUsdc}`
      );
    }

    return {
      requiredWithdrawRawUsdc: gross,
      sharesToRedeemRaw: ceilDiv(gross * RATE_SCALE, context.exchangeRateScaled),
      withdrawalPenaltyRawUsdc: penalty,
      expectedNetOutputRawUsdc: net
    };
  }

  /**
   * Builds the unstake (when required) and low-level KVault withdraw
   * instructions whose token destination is the provided settlement token
   * account instead of the agent's USDC ATA.
   */
  async buildSettlementWithdrawInstructions(params: {
    wallet: string;
    settlementTokenAccount: Address;
    sharesToRedeemRaw: bigint;
    grossWithdrawRawUsdc: bigint;
    userShares: UserSharesRaw;
    context: VaultContext;
  }): Promise<{ unstakeIxs: Instruction[]; withdrawIx: Instruction }> {
    const { context, userShares } = params;
    if (params.sharesToRedeemRaw <= 0n) {
      throw new Error("sharesToRedeemRaw must be positive");
    }
    if (params.sharesToRedeemRaw > userShares.totalSharesRaw) {
      throw new VaultLiquidityError(
        "sharesToRedeemRaw exceeds the wallet's total vault shares"
      );
    }
    if (!userShares.sharesAtaExists) {
      throw new Error("agent vault share ATA does not exist");
    }

    const agent = createNoopSigner(address(params.wallet));
    const unstakeIxs: Instruction[] = [];
    if (params.sharesToRedeemRaw > userShares.unstakedSharesRaw) {
      const sharesDecimal = rawToSharesDecimal(params.sharesToRedeemRaw);
      const withdrawPlan = await this.client.withdrawIxs(
        agent,
        this.vaultHandle(context.vaultState),
        sharesDecimal,
        context.slot,
        context.reservesMap,
        context.farmState,
        null
      );
      // Keep only the farm unstake instructions; the SDK plan also contains an
      // idempotent shares-ATA create and ATA-destined withdraw instructions
      // that the canonical settlement transaction must not include.
      unstakeIxs.push(
        ...withdrawPlan.unstakeFromFarmIfNeededIxs.filter(
          (ix) => ix.programAddress !== ASSOCIATED_TOKEN_PROGRAM
        )
      );
      if (unstakeIxs.length === 0) {
        throw new Error(
          "Vault farm unstake instructions are required but could not be built"
        );
      }
    }

    const sharesAmount = new BN(params.sharesToRedeemRaw.toString());
    const globalConfigPda = await getKvaultGlobalConfigPda(kaminoVaultId);
    const eventAuthority = await getEventAuthorityPda(kaminoVaultId);
    const userSharesAta = await getAssociatedTokenAddress(
      context.vaultState.sharesMint,
      agent.address
    );

    const withdrawFromAvailableAccounts = {
      user: agent,
      vaultState: this.vaultAddress,
      globalConfig: globalConfigPda,
      tokenVault: context.vaultState.tokenVault,
      baseVaultAuthority: context.vaultState.baseVaultAuthority,
      userTokenAta: params.settlementTokenAccount,
      tokenMint: context.vaultState.tokenMint,
      userSharesAta,
      sharesMint: context.vaultState.sharesMint,
      tokenProgram: context.vaultState.tokenProgram,
      sharesTokenProgram: TOKEN_PROGRAM_ADDRESS,
      klendProgram: KLEND_PROGRAM_ID,
      eventAuthority,
      program: kaminoVaultId
    };

    let withdrawIx: Instruction;
    if (
      params.grossWithdrawRawUsdc <= context.tokenAvailableRaw ||
      context.bestReserve === null
    ) {
      if (params.grossWithdrawRawUsdc > context.tokenAvailableRaw) {
        throw new VaultLiquidityError(
          "Vault has no allocated reserve to cover the withdraw beyond available liquidity"
        );
      }
      withdrawIx = kvaultWithdrawFromAvailable(
        { sharesAmount },
        withdrawFromAvailableAccounts,
        undefined,
        kaminoVaultId
      );
    } else {
      const reserveAddress = context.bestReserve;
      const reserve = context.reservesMap.get(reserveAddress);
      if (reserve === undefined) {
        throw new Error(`Reserve ${reserveAddress} missing from vault reserves map`);
      }
      const marketAddress = reserve.state.lendingMarket;
      const [lendingMarketAuthority] = await lendingMarketAuthPda(
        marketAddress,
        KLEND_PROGRAM_ID
      );
      withdrawIx = kvaultWithdraw(
        { sharesAmount },
        {
          withdrawFromAvailable: withdrawFromAvailableAccounts,
          withdrawFromReserveAccounts: {
            vaultState: this.vaultAddress,
            reserve: reserveAddress,
            ctokenVault: await getCTokenVaultPda(
              this.vaultAddress,
              reserveAddress,
              kaminoVaultId
            ),
            lendingMarket: marketAddress,
            lendingMarketAuthority,
            reserveLiquiditySupply: reserve.state.liquidity.supplyVault,
            reserveCollateralMint: reserve.state.collateral.mintPubkey,
            reserveCollateralTokenProgram: TOKEN_PROGRAM_ADDRESS,
            instructionSysvarAccount: SYSVAR_INSTRUCTIONS_ADDRESS
          },
          eventAuthority,
          program: kaminoVaultId
        },
        undefined,
        kaminoVaultId
      );
    }

    if (hasAllocatedReserves(context.vaultState)) {
      withdrawIx = this.client.appendRemainingAccountsForVaultReserves(
        withdrawIx,
        this.client.getVaultReserves(context.vaultState),
        context.reservesMap
      );
    }

    return { unstakeIxs, withdrawIx };
  }

  async buildDepositInstructions(params: {
    wallet: string;
    amountRawUsdc: bigint;
    context: VaultContext;
    rentPayer: Address;
  }): Promise<Instruction[]> {
    const agent = createNoopSigner(address(params.wallet));
    const rentPayer = createNoopSigner(params.rentPayer);
    const depositPlan = await this.client.depositIxs(
      agent,
      this.vaultHandle(params.context.vaultState),
      rawToUsdcDecimal(params.amountRawUsdc),
      params.context.reservesMap,
      null,
      null,
      rentPayer
    );

    return depositPlan.depositIxs;
  }

  async buildNormalWithdrawInstructions(params: {
    wallet: string;
    sharesToRedeemRaw: bigint;
    context: VaultContext;
    rentPayer: Address;
  }): Promise<Instruction[]> {
    const agent = createNoopSigner(address(params.wallet));
    const rentPayer = createNoopSigner(params.rentPayer);
    const withdrawPlan = await this.client.withdrawIxs(
      agent,
      this.vaultHandle(params.context.vaultState),
      rawToSharesDecimal(params.sharesToRedeemRaw),
      params.context.slot,
      params.context.reservesMap,
      params.context.farmState,
      null,
      rentPayer
    );

    return [
      ...withdrawPlan.unstakeFromFarmIfNeededIxs,
      ...withdrawPlan.withdrawIxs,
      ...withdrawPlan.postWithdrawIxs
    ];
  }

  async loadLookupTables(
    context: VaultContext
  ): Promise<Record<string, Address[]>> {
    const addresses: Address[] = [...this.extraLookupTables];
    const vaultLut = context.vaultState.vaultLookupTable;
    if (vaultLut !== DEFAULT_PUBLIC_KEY && !addresses.includes(vaultLut)) {
      addresses.push(vaultLut);
    }

    const result: Record<string, Address[]> = {};
    for (const lutAddress of addresses) {
      const lut = await fetchMaybeAddressLookupTable(this.rpc, lutAddress);
      if (lut.exists) {
        result[lutAddress] = [...lut.data.addresses];
      }
    }

    return result;
  }
}

const ASSOCIATED_TOKEN_PROGRAM = address(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
);
const DEFAULT_PUBLIC_KEY = address("11111111111111111111111111111111");

export function hasAllocatedReserves(vaultState: VaultState): boolean {
  return vaultState.vaultAllocationStrategy.some(
    (allocation) => allocation.reserve !== DEFAULT_PUBLIC_KEY
  );
}

export function withdrawalPenaltyFor(
  grossRawUsdc: bigint,
  penaltyBps: bigint,
  penaltyLamports: bigint
): bigint {
  if (grossRawUsdc <= 0n) {
    return 0n;
  }
  const bpsPenalty = ceilDiv(grossRawUsdc * penaltyBps, FULL_BPS);
  return bpsPenalty > penaltyLamports ? bpsPenalty : penaltyLamports;
}

export function grossWithdrawForNetTarget(params: {
  targetNetRawUsdc: bigint;
  penaltyBps: bigint;
  penaltyLamports: bigint;
}): bigint {
  const { targetNetRawUsdc, penaltyBps, penaltyLamports } = params;
  if (penaltyBps >= FULL_BPS) {
    throw new VaultLiquidityError("Vault withdrawal penalty consumes the entire withdraw");
  }

  let gross = ceilDiv(targetNetRawUsdc * FULL_BPS, FULL_BPS - penaltyBps);
  if (gross < targetNetRawUsdc + penaltyLamports) {
    gross = targetNetRawUsdc + penaltyLamports;
  }
  while (
    gross - withdrawalPenaltyFor(gross, penaltyBps, penaltyLamports) <
    targetNetRawUsdc
  ) {
    gross += 1n;
  }

  return gross;
}

function effectiveWithdrawalPenalty(
  vaultState: VaultState,
  globalConfig: KVaultGlobalConfig
): { bps: bigint; lamports: bigint } {
  const vaultBps = BigInt(vaultState.withdrawalPenaltyBps.toString());
  const globalBps = BigInt(globalConfig.withdrawalPenaltyBps.toString());
  const vaultLamports = BigInt(vaultState.withdrawalPenaltyLamports.toString());
  const globalLamports = BigInt(globalConfig.withdrawalPenaltyLamports.toString());

  return {
    bps: vaultBps > globalBps ? vaultBps : globalBps,
    lamports: vaultLamports > globalLamports ? vaultLamports : globalLamports
  };
}

export function decimalToBigInt(value: Decimal): bigint {
  return BigInt(value.floor().toFixed(0));
}

export function sharesDecimalToRaw(value: Decimal): bigint {
  return decimalToBigInt(value.mul(new Decimal(10).pow(SHARE_DECIMALS)));
}

export function rawToSharesDecimal(raw: bigint): Decimal {
  return new Decimal(raw.toString()).div(new Decimal(10).pow(SHARE_DECIMALS));
}

export function rawToUsdcDecimal(raw: bigint): Decimal {
  return new Decimal(raw.toString()).div(new Decimal(10).pow(USDC_DECIMALS));
}
