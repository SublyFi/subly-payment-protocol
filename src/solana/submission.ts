import type { Address, Base64EncodedWireTransaction, Signature } from "@solana/kit";
import type { SolanaRpc } from "./rpc.js";

export interface ConfirmedTransactionSummary {
  found: true;
  err: unknown;
  feeLamports: bigint;
  /** Raw token balance delta per account address for the transaction. */
  tokenBalanceDeltas: Map<string, bigint>;
  slot: bigint;
}

export type TransactionLookupResult =
  | ConfirmedTransactionSummary
  | { found: false };

export type ConfirmationOutcome =
  | { status: "confirmed" }
  | { status: "expired" }
  | { status: "timeout" };

export class TransactionSubmissionEngine {
  constructor(private readonly rpc: SolanaRpc) {}

  async simulateSignedTransaction(serializedBase64: string): Promise<{
    err: unknown;
    logs: readonly string[] | null;
  }> {
    const result = await this.rpc
      .simulateTransaction(serializedBase64 as Base64EncodedWireTransaction, {
        encoding: "base64",
        sigVerify: true,
        replaceRecentBlockhash: false,
        commitment: "confirmed"
      })
      .send();

    return { err: result.value.err, logs: result.value.logs };
  }

  async sendSignedTransaction(serializedBase64: string): Promise<string> {
    const signature = await this.rpc
      .sendTransaction(serializedBase64 as Base64EncodedWireTransaction, {
        encoding: "base64",
        skipPreflight: true,
        maxRetries: 3n
      })
      .send();

    return signature;
  }

  async waitForConfirmation(params: {
    txSignature: string;
    lastValidBlockHeight: number | null;
    timeoutMs?: number;
    pollIntervalMs?: number;
  }): Promise<ConfirmationOutcome> {
    const timeoutMs = params.timeoutMs ?? 45_000;
    const pollIntervalMs = params.pollIntervalMs ?? 1_500;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const statuses = await this.rpc
        .getSignatureStatuses([params.txSignature as Signature], {
          searchTransactionHistory: false
        })
        .send();
      const status = statuses.value[0];
      if (
        status !== null &&
        status !== undefined &&
        (status.confirmationStatus === "confirmed" ||
          status.confirmationStatus === "finalized")
      ) {
        return { status: "confirmed" };
      }

      if (params.lastValidBlockHeight !== null) {
        const blockHeight = await this.rpc
          .getBlockHeight({ commitment: "confirmed" })
          .send();
        // A small buffer protects against a status race where the transaction
        // landed in one of the last valid blocks but the node has not indexed
        // the signature yet.
        if (blockHeight > BigInt(params.lastValidBlockHeight) + 32n) {
          const lookup = await this.lookupTransaction(params.txSignature);
          return lookup.found ? { status: "confirmed" } : { status: "expired" };
        }
      }

      await sleep(pollIntervalMs);
    }

    return { status: "timeout" };
  }

  /**
   * True when the chain has moved past the transaction's last valid block
   * height (with an indexing buffer) and the signature is still not found.
   */
  async isBlockhashExpired(lastValidBlockHeight: number | null): Promise<boolean> {
    if (lastValidBlockHeight === null) {
      return false;
    }

    const blockHeight = await this.rpc
      .getBlockHeight({ commitment: "confirmed" })
      .send();
    return blockHeight > BigInt(lastValidBlockHeight) + 32n;
  }

  async lookupTransaction(txSignature: string): Promise<TransactionLookupResult> {
    const response = await this.rpc
      .getTransaction(txSignature as Signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
        encoding: "json"
      })
      .send();

    if (response === null) {
      return { found: false };
    }

    const meta = response.meta;
    if (meta === null || meta === undefined) {
      return { found: false };
    }

    const staticKeys = response.transaction.message.accountKeys.map(String);
    const loadedWritable = (meta.loadedAddresses?.writable ?? []).map(String);
    const loadedReadonly = (meta.loadedAddresses?.readonly ?? []).map(String);
    const orderedKeys = [...staticKeys, ...loadedWritable, ...loadedReadonly];

    const tokenBalanceDeltas = new Map<string, bigint>();
    for (const pre of meta.preTokenBalances ?? []) {
      const account = orderedKeys[pre.accountIndex];
      if (account !== undefined) {
        tokenBalanceDeltas.set(
          account,
          (tokenBalanceDeltas.get(account) ?? 0n) -
            BigInt(pre.uiTokenAmount.amount)
        );
      }
    }
    for (const post of meta.postTokenBalances ?? []) {
      const account = orderedKeys[post.accountIndex];
      if (account !== undefined) {
        tokenBalanceDeltas.set(
          account,
          (tokenBalanceDeltas.get(account) ?? 0n) +
            BigInt(post.uiTokenAmount.amount)
        );
      }
    }

    return {
      found: true,
      err: meta.err,
      feeLamports: BigInt(meta.fee),
      tokenBalanceDeltas,
      slot: BigInt(response.slot)
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
