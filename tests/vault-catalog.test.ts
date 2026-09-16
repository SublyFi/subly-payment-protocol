import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_VAULT_CONFIG } from "../src/config/vault.js";
import { parseVaultCatalog, vaultCatalogFromEnv } from "../src/config/vault-catalog.js";

const A = DEFAULT_VAULT_CONFIG;
const B = { ...A, address: "HDsayqAsDWy3QvANGqh2yNraqcD8Fnjgh73Mhb3WRS5E", depositsEnabled: false };
const catalog = () => ({ version: 1, defaultVault: A.address, vaults: [A, B] });

describe("vault catalogue", () => {
  it("supports retired vaults, while retaining the existing single-vault fallback", () => {
    expect(parseVaultCatalog(catalog()).vaults[1]?.depositsEnabled).toBe(false);
    expect(vaultCatalogFromEnv({}).vaults).toEqual([A]);
  });
  it.each(["usdcMint", "programId", "shareMint", "farm"])("rejects invalid %s", (field) => {
    const data = catalog();
    data.vaults = [{ ...A, [field]: "invalid" }];
    expect(() => parseVaultCatalog(data)).toThrow();
  });
  it("rejects unknown defaults, duplicate vaults, and unrecognized fields", () => {
    expect(() => parseVaultCatalog({ ...catalog(), defaultVault: A.shareMint })).toThrow();
    expect(() => parseVaultCatalog({ ...catalog(), vaults: [A, A] })).toThrow();
    expect(() => parseVaultCatalog({ ...catalog(), vaults: [{ ...A, sharesMint: A.shareMint }] })).toThrow();
  });
  it("loads reviewed metadata from file, selects only a listed default, and fails closed on malformed files", () => {
    const dir = mkdtempSync(join(tmpdir(), "subly-catalog-test-"));
    const file = join(dir, "vaults.json");
    try {
      writeFileSync(file, JSON.stringify(catalog()));
      expect(vaultCatalogFromEnv({ SUBLY_VAULTS_FILE: file, SUBLY_VAULT_ADDRESS: B.address }).defaultVault).toBe(B.address);
      expect(() => vaultCatalogFromEnv({ SUBLY_VAULTS_FILE: file, SUBLY_VAULT_ADDRESS: A.shareMint })).toThrow();
      writeFileSync(file, "{");
      expect(() => vaultCatalogFromEnv({ SUBLY_VAULTS_FILE: file })).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
