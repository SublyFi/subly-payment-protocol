import { signBytes, type KeyPairSigner } from "@solana/kit";
import bs58 from "bs58";
import {
  addSignaturesToSerializedTransaction,
  signatureBase58ForSigner
} from "../solana/tx.js";
import {
  IntentValidationError,
  validateDepositIntentTransaction,
  validatePaymentIntentTransaction,
  validateWithdrawalIntentTransaction,
  type DepositSigningIntent,
  type IntentValidationPolicy,
  type PaymentSigningIntent,
  type WithdrawalSigningIntent
} from "./transaction-intent-validator.js";

export interface SignedAgentTransaction {
  serializedTransaction: string;
  agentSignature: string;
}

/**
 * Non-interactive agent wallet signer abstraction. Implementations must
 * validate the structured intent against the decoded transaction before
 * signing; blind signing of prepared bytes is not launch-ready.
 */
export interface AgentWalletSigner {
  readonly walletAddress: string;
  readonly validationMode: "structured_intent_transaction";
  signPayment(params: {
    intent: PaymentSigningIntent;
    serializedTransaction: string;
    lookupTables?: Record<string, readonly string[]> | undefined;
  }): Promise<SignedAgentTransaction>;
  signDeposit(params: {
    intent: DepositSigningIntent;
    serializedTransaction: string;
    lookupTables?: Record<string, readonly string[]> | undefined;
  }): Promise<SignedAgentTransaction>;
  signWithdrawal(params: {
    intent: WithdrawalSigningIntent;
    serializedTransaction: string;
    lookupTables?: Record<string, readonly string[]> | undefined;
  }): Promise<SignedAgentTransaction>;
  /**
   * Signs a Subly relayer API auth message (wallet-signature request auth).
   * Unlike the transaction signers above this signs arbitrary bytes, so the
   * message MUST be the canonical wallet-auth string, never transaction
   * bytes (see src/api/wallet-auth.ts).
   */
  signApiMessage(message: Uint8Array): Promise<string>;
}

/**
 * Local keypair signer that performs the full structured-intent validation
 * before signing. Suitable for the controlled mainnet launch wallet; custody
 * providers (Privy, MPC/HSM/KMS) implement the same boundary.
 */
export class LocalKeypairAgentWalletSigner implements AgentWalletSigner {
  readonly validationMode = "structured_intent_transaction" as const;
  private readonly keyPairSigner: KeyPairSigner;
  private readonly validationPolicy: IntentValidationPolicy | undefined;

  constructor(
    keyPairSigner: KeyPairSigner,
    validationPolicy?: IntentValidationPolicy | undefined
  ) {
    this.keyPairSigner = keyPairSigner;
    this.validationPolicy = validationPolicy;
  }

  get walletAddress(): string {
    return this.keyPairSigner.address;
  }

  async signPayment(params: {
    intent: PaymentSigningIntent;
    serializedTransaction: string;
    lookupTables?: Record<string, readonly string[]> | undefined;
  }): Promise<SignedAgentTransaction> {
    this.assertIntentWallet(params.intent.wallet);
    validatePaymentIntentTransaction({
      ...params,
      ...(this.validationPolicy === undefined
        ? {}
        : { policy: this.validationPolicy })
    });
    return this.sign(params.serializedTransaction);
  }

  async signDeposit(params: {
    intent: DepositSigningIntent;
    serializedTransaction: string;
    lookupTables?: Record<string, readonly string[]> | undefined;
  }): Promise<SignedAgentTransaction> {
    this.assertIntentWallet(params.intent.wallet);
    validateDepositIntentTransaction({
      ...params,
      ...(this.validationPolicy === undefined
        ? {}
        : { policy: this.validationPolicy })
    });
    return this.sign(params.serializedTransaction);
  }

  async signWithdrawal(params: {
    intent: WithdrawalSigningIntent;
    serializedTransaction: string;
    lookupTables?: Record<string, readonly string[]> | undefined;
  }): Promise<SignedAgentTransaction> {
    this.assertIntentWallet(params.intent.wallet);
    validateWithdrawalIntentTransaction({
      ...params,
      ...(this.validationPolicy === undefined
        ? {}
        : { policy: this.validationPolicy })
    });
    return this.sign(params.serializedTransaction);
  }

  private assertIntentWallet(wallet: string): void {
    if (wallet !== this.keyPairSigner.address) {
      throw new IntentValidationError(
        "wallet_mismatch",
        "Intent wallet does not match this signer's wallet"
      );
    }
  }

  async signApiMessage(message: Uint8Array): Promise<string> {
    const signature = await signBytes(
      this.keyPairSigner.keyPair.privateKey,
      message
    );
    return bs58.encode(signature);
  }

  private async sign(
    serializedTransaction: string
  ): Promise<SignedAgentTransaction> {
    const { serializedBase64, transaction } =
      await addSignaturesToSerializedTransaction({
        serializedBase64: serializedTransaction,
        signers: [this.keyPairSigner.keyPair]
      });
    const agentSignature = signatureBase58ForSigner(
      transaction,
      this.keyPairSigner.address
    );
    if (agentSignature === null) {
      throw new IntentValidationError(
        "signing_failed",
        "Agent signature was not produced"
      );
    }

    return { serializedTransaction: serializedBase64, agentSignature };
  }
}
