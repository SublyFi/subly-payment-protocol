import type { ConfiguredVault } from "../config/vault-catalog.js";
import type { SublyService } from "./payment-service.js";
import type { VaultFlowService } from "./vault-flow-service.js";
import type { ChainWalletSyncService } from "./chain-wallet-sync.js";

/** One immutable set of chain services per vault, sharing the same ledger. */
export interface VaultServices {
  vault: Readonly<ConfiguredVault>;
  service: SublyService;
  vaultFlowService: VaultFlowService | null;
  chainWalletSync: ChainWalletSyncService | null;
}
