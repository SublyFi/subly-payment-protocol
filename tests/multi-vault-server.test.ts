import { describe, expect, it, vi } from "vitest";
import { getAddMemoInstruction } from "@solana-program/memo";
import { blockhash } from "@solana/kit";
import { buildServer } from "../src/api/server.js";
import { DEFAULT_VAULT_CONFIG } from "../src/config/vault.js";
import { InMemoryLedger } from "../src/domain/ledger.js";
import { SublyService } from "../src/domain/payment-service.js";
import { VaultFlowService } from "../src/domain/vault-flow-service.js";
import type { VaultServices } from "../src/domain/vault-services.js";
import type { KaminoVaultAdapter } from "../src/kamino/vault-adapter.js";
import type { TransactionSubmissionEngine } from "../src/solana/submission.js";
import { AGENT_PUB } from "./helpers/mandate-fixtures.js";

const A = DEFAULT_VAULT_CONFIG;
const B = { ...A, address: "HDsayqAsDWy3QvANGqh2yNraqcD8Fnjgh73Mhb3WRS5E",
  shareMint: "7D8C5pDFxug58L9zkwK7bCiDg4kD4AygzbcZUmf5usHS", farm: "9FVjHqduhDPMVqvu3cXiEBjU6nvxvGdCCLRwd9WpVRZj" };
const headers = { authorization: "Bearer test-admin" };
async function setup() {
  const ledger = new InMemoryLedger();
  const registry = new Map<string, VaultServices>();
  for (const vault of [A, B]) {
    const service = new SublyService({ ledger, vault });
    await service.registerAgentWallet({ wallet: AGENT_PUB, signingPolicyId: "test",
      signingMode: "non_interactive", signerProvider: "local_test", signerValidationMode: "structured_intent_transaction", activateForPayments: true });
    const position = (await ledger.getPosition(AGENT_PUB, vault.address))!;
    await ledger.savePosition({ ...position, totalSharesRaw: 101_000_000n, unstakedSharesRaw: 101_000_000n,
      principalBasisRawUsdc: vault.address === A.address ? 100_000_000n : 90_000_000n,
      exchangeRateScaled: 1_000_000_000_000n, instantRedeemCapacityRawUsdc: 100_000_000n });
    const adapter = {
      vaultAddress: vault.address,
      loadContext: async () => ({ slot: 1n,
        blockhash: blockhash("GHtnjzoaqLgzJZ4XTQr5ChCAPGJmCEqVMG6gRGoiTLDv"), lastValidBlockHeight: 1000n,
        exchangeRateScaled: 1_000_000_000_000n, tokenAvailableRaw: 100_000_000n,
        instantRedeemCapacityRawUsdc: 100_000_000n, singleInstructionRedeemCapacityRawUsdc: 100_000_000n,
        withdrawalPenaltyBps: 0n, withdrawalPenaltyLamports: 0n, minWithdrawAmountRaw: 10n, minDepositAmountRaw: 1_000_000n }),
      getUserSharesRaw: async () => ({ stakedSharesRaw: 0n, unstakedSharesRaw: 101_000_000n, totalSharesRaw: 101_000_000n, sharesAtaAddress: AGENT_PUB, sharesAtaExists: true }),
      buildDepositInstructions: async () => [getAddMemoInstruction({ memo: "test deposit" })],
      buildNormalWithdrawInstructions: async () => [getAddMemoInstruction({ memo: "test withdraw" })],
      loadLookupTables: async () => ({})
    } as unknown as KaminoVaultAdapter;
    const vaultFlowService = new VaultFlowService({ ledger, vault, adapter,
      engine: {} as TransactionSubmissionEngine, sponsor: { address: AGENT_PUB, keyPair: {} } as never });
    registry.set(vault.address, { vault, service, vaultFlowService, chainWalletSync: null });
  }
  const server = buildServer(registry.get(A.address)!.service, { adminApiToken: "test-admin", vaultServices: registry });
  return { ledger, registry, server };
}

describe("multi-vault relayer", () => {
  it("lists configured vaults, isolates budgets, and refuses unknown vaults", async () => {
    const { server } = await setup();
    try {
      expect((await server.inject({ url: "/v1/vaults" })).json()).toEqual({ defaultVault: A.address, vaults: [A, B] });
      for (const [vault, basis] of [[A.address, "100000000"], [B.address, "90000000"]]) {
        const result = await server.inject({ url: `/v1/wallets/${AGENT_PUB}/budget?vault=${vault}`, headers });
        expect(result.statusCode).toBe(200);
        expect(result.json().position).toMatchObject({ vault, principalBasisRawUsdc: basis });
      }
      const result = await server.inject({ url: `/v1/wallets/${AGENT_PUB}/budget?vault=${A.shareMint}`, headers });
      expect(result.statusCode).toBe(400);
      expect(result.json().error.code).toBe("unsupported_vault");
    } finally { await server.close(); }
  });

  it("pins prepared intents and routes polling/submission to the original vault after retirement", async () => {
    const { server, registry } = await setup();
    try {
      const prepared = await server.inject({ method: "POST", url: "/v1/deposits/prepare", headers,
        payload: { wallet: AGENT_PUB, vault: B.address, amountRawUsdc: "2000000" } });
      expect(prepared.statusCode).toBe(200);
      const intent = prepared.json();
      expect(intent.signingIntent).toMatchObject({ vault: B.address, shareMint: B.shareMint, farm: B.farm });
      const a = registry.get(A.address)!; const b = registry.get(B.address)!;
      await expect(a.vaultFlowService!.getDeposit(intent.depositId)).rejects.toMatchObject({ code: "deposit_not_found" });
      registry.set(B.address, { ...b, vault: { ...B, depositsEnabled: false } });
      for (const suffix of ["", "&resubmit=false"]) {
        const polled = await server.inject({ url: `/v1/deposits/${intent.depositId}?vault=${A.address}${suffix}`, headers });
        expect(polled.statusCode).toBe(200);
        expect(polled.json().vault).toBe(B.address);
      }
      const submit = vi.spyOn(b.vaultFlowService!, "submitDeposit").mockResolvedValue({ status: "submitted" } as never);
      const submitted = await server.inject({ method: "POST", url: "/v1/deposits/submit", headers,
        payload: { depositId: intent.depositId, serializedTransaction: "test", agentSignature: "test", vault: A.address } });
      expect(submitted.statusCode).toBe(200);
      expect(submit).toHaveBeenCalledOnce();
    } finally { await server.close(); }
  });

  it("retirement blocks new deposits and realizations while retaining normal withdrawals", async () => {
    const { server, registry } = await setup();
    const entry = registry.get(B.address)!;
    registry.set(B.address, { ...entry, vault: { ...B, depositsEnabled: false } });
    try {
      for (const [url, extra] of [["/v1/deposits/prepare", {}], ["/v1/withdrawals/prepare", { purpose: "yield_realize" }]] as const) {
        const result = await server.inject({ method: "POST", url, headers,
          payload: { wallet: AGENT_PUB, vault: B.address, amountRawUsdc: "2000000", ...extra } });
        expect(result.json().error.code).toBe("vault_retired");
      }
      const withdrawal = await server.inject({ method: "POST", url: "/v1/withdrawals/prepare", headers,
        payload: { wallet: AGENT_PUB, vault: B.address, amountRawUsdc: "2000000" } });
      expect(withdrawal.statusCode).toBe(200);
      expect(withdrawal.json().signingIntent).toMatchObject({ vault: B.address, shareMint: B.shareMint });
    } finally { await server.close(); }
  });
});
