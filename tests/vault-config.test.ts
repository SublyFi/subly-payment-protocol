import { afterEach, describe, expect, it, vi } from "vitest";
import BN from "bn.js";
import { address } from "@solana/kit";
import { VaultState } from "@kamino-finance/klend-sdk";
import {
  DEFAULT_VAULT_CONFIG,
  KAMINO_VAULT_PROGRAM_ID,
  MAINNET_USDC_MINT,
  NO_VAULT_FARM,
  vaultConfigFromEnv
} from "../src/config/vault.js";
import {
  assertVaultConfigMatchesState,
  formatVaultConfigEnv,
  readVaultConfig
} from "../src/kamino/vault-config.js";
import { KaminoVaultAdapter } from "../src/kamino/vault-adapter.js";
import type { SolanaRpc } from "../src/solana/rpc.js";

const CUSTOM_VAULT = "HDsayqAsDWy3QvANGqh2yNraqcD8Fnjgh73Mhb3WRS5E";
const CUSTOM_SHARES = "So11111111111111111111111111111111111111112";
const customEnv = {
  SUBLY_VAULT_ADDRESS: CUSTOM_VAULT,
  SUBLY_VAULT_SHARE_MINT: CUSTOM_SHARES,
  SUBLY_VAULT_FARM: NO_VAULT_FARM
};
const customConfig = vaultConfigFromEnv(customEnv);
const rpc = {} as SolanaRpc;

function state(overrides: Partial<VaultState> = {}): VaultState {
  return {
    tokenMint: address(MAINNET_USDC_MINT),
    sharesMint: address(CUSTOM_SHARES),
    vaultFarm: address(NO_VAULT_FARM),
    tokenProgram: address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
    tokenMintDecimals: new BN(6),
    sharesMintDecimals: new BN(6),
    ...overrides
  } as VaultState;
}

afterEach(() => vi.restoreAllMocks());

describe("local vault configuration", () => {
  it("preserves default settings, including blank template values", () => {
    expect(vaultConfigFromEnv({})).toEqual(DEFAULT_VAULT_CONFIG);
    expect(vaultConfigFromEnv({ SUBLY_VAULT_ADDRESS: "  " })).toEqual(DEFAULT_VAULT_CONFIG);
  });

  it("selects a custom vault with an explicit no-farm setting", () => {
    expect(customConfig).toMatchObject({
      address: CUSTOM_VAULT, shareMint: CUSTOM_SHARES,
      farm: NO_VAULT_FARM, usdcMint: MAINNET_USDC_MINT
    });
    expect(vaultConfigFromEnv({ ...customEnv, SUBLY_VAULT_ADDRESS: ` ${CUSTOM_VAULT} ` })).toEqual(customConfig);
  });

  it.each(["SUBLY_VAULT_SHARE_MINT", "SUBLY_VAULT_FARM"])(
    "rejects partial overrides instead of inheriting the default %s", (field) => {
      expect(() => vaultConfigFromEnv({ ...customEnv, [field]: " " })).toThrow(`${field} is required`);
    }
  );

  it.each(["SUBLY_VAULT_ADDRESS", "SUBLY_VAULT_SHARE_MINT", "SUBLY_VAULT_FARM"])(
    "rejects an invalid address in %s", (field) => {
      expect(() => vaultConfigFromEnv({ ...customEnv, [field]: "invalid" })).toThrow("valid Solana public key");
    }
  );

  it("refuses to reinterpret other assets as USDC", () => {
    expect(() => vaultConfigFromEnv({ ...customEnv, SUBLY_VAULT_USDC_MINT: CUSTOM_SHARES })).toThrow("mainnet USDC");
  });
});

describe("on-chain vault configuration", () => {
  it("resolves the selected address through the official program decoder and round-trips env settings", async () => {
    const fetchState = vi.spyOn(VaultState, "fetch").mockResolvedValue(state());
    const config = await readVaultConfig(rpc, CUSTOM_VAULT);
    expect(fetchState).toHaveBeenCalledWith(rpc, CUSTOM_VAULT, KAMINO_VAULT_PROGRAM_ID);
    expect(config).toEqual(customConfig);
    const env = Object.fromEntries(formatVaultConfigEnv(config).split("\n").map((line) => line.split("=")));
    expect(vaultConfigFromEnv(env)).toEqual(config);
  });

  it("handles a vault with a farm", async () => {
    vi.spyOn(VaultState, "fetch").mockResolvedValue(state({ vaultFarm: address(DEFAULT_VAULT_CONFIG.farm) }));
    expect((await readVaultConfig(rpc, CUSTOM_VAULT)).farm).toBe(DEFAULT_VAULT_CONFIG.farm);
  });

  it("rejects a missing vault", async () => {
    vi.spyOn(VaultState, "fetch").mockResolvedValue(null);
    await expect(readVaultConfig(rpc, CUSTOM_VAULT)).rejects.toThrow("does not exist");
  });

  it.each([
    { tokenMint: address(CUSTOM_SHARES) },
    { tokenProgram: address(NO_VAULT_FARM) },
    { tokenMintDecimals: new BN(9) },
    { sharesMintDecimals: new BN(9) }
  ])("rejects unsupported accounting units or assets: %j", async (overrides) => {
    vi.spyOn(VaultState, "fetch").mockResolvedValue(state(overrides));
    await expect(readVaultConfig(rpc, CUSTOM_VAULT)).rejects.toThrow();
  });

  it.each([
    ["SUBLY_VAULT_SHARE_MINT", { sharesMint: address(DEFAULT_VAULT_CONFIG.shareMint) }],
    ["SUBLY_VAULT_FARM", { vaultFarm: address(DEFAULT_VAULT_CONFIG.farm) }]
  ] as const)("detects an incorrect pinned %s", (field, overrides) => {
    expect(() => assertVaultConfigMatchesState(customConfig, state(overrides))).toThrow(field);
  });

  it("checks adapter metadata at startup and rejects an adapter pointing at another vault", async () => {
    const adapter = new KaminoVaultAdapter({ rpc, vaultAddress: CUSTOM_VAULT, vaultConfig: customConfig });
    vi.spyOn(VaultState, "fetch").mockResolvedValue(state());
    await expect(adapter.validateConfiguration()).resolves.toBeUndefined();
    vi.spyOn(VaultState, "fetch").mockResolvedValue(state({ vaultFarm: address(DEFAULT_VAULT_CONFIG.farm) }));
    await expect(adapter.validateConfiguration()).rejects.toThrow("SUBLY_VAULT_FARM");
    expect(() => new KaminoVaultAdapter({ rpc, vaultAddress: DEFAULT_VAULT_CONFIG.address, vaultConfig: customConfig })).toThrow("does not match");
  });
});
