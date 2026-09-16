import { SPL_TOKEN_PROGRAM_ID, SUBLY_VAULT } from "../../src/config/constants.js";
import { deriveAssociatedTokenAddress } from "../../src/lib/associated-token-account.js";
import type { SolanaRpc } from "../../src/solana/rpc.js";

export function previewRpc(wallet: string, amount: bigint): SolanaRpc {
  return {
    simulateTransaction: () => ({ send: async () => ({ value: {
      err: null,
      innerInstructions: [{ index: 0, instructions: [{
        programId: SPL_TOKEN_PROGRAM_ID,
        parsed: { type: "transfer", info: {
          destination: deriveAssociatedTokenAddress({ owner: wallet, mint: SUBLY_VAULT.usdcMint }),
          source: SUBLY_VAULT.address, amount: amount.toString()
        } }
      }] }]
    } }) })
  } as unknown as SolanaRpc;
}
