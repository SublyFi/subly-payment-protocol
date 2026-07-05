import { signBytes, type KeyPairSigner } from "@solana/kit";
import bs58 from "bs58";
import nacl from "tweetnacl";
import {
  addSignaturesToSerializedTransaction,
  signatureBase58ForSigner
} from "../solana/tx.js";
import {
  ed25519PublicKeyBytes,
  externallySignedAgentTransaction,
  RemoteSigningError,
  type RemoteSignerTransport
} from "./remote-signer-transport.js";
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
  /**
   * Provider slug reported to the relayer at registration (e.g.
   * "local-keypair", "circle", "privy"). Optional for backwards
   * compatibility; treated as "local-keypair" when absent.
   */
  readonly provider?: string;
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
 * The validate-then-sign skeleton every Subly signer must follow. It exists
 * exactly once so a signing backend can never skip a structured-intent check
 * the other backends enforce: subclasses only supply the signing primitive
 * (`sign`) and the api-message signer.
 */
abstract class IntentValidatingAgentWalletSigner implements AgentWalletSigner {
  readonly validationMode = "structured_intent_transaction" as const;
  private readonly validationPolicy: IntentValidationPolicy | undefined;

  protected constructor(validationPolicy: IntentValidationPolicy | undefined) {
    this.validationPolicy = validationPolicy;
  }

  abstract readonly walletAddress: string;
  abstract readonly provider: string;
  abstract signApiMessage(message: Uint8Array): Promise<string>;
  protected abstract sign(
    serializedTransaction: string
  ): Promise<SignedAgentTransaction>;

  async signPayment(params: {
    intent: PaymentSigningIntent;
    serializedTransaction: string;
    lookupTables?: Record<string, readonly string[]> | undefined;
  }): Promise<SignedAgentTransaction> {
    this.assertIntentWallet(params.intent.wallet);
    validatePaymentIntentTransaction({ ...params, ...this.policySpread() });
    return this.sign(params.serializedTransaction);
  }

  async signDeposit(params: {
    intent: DepositSigningIntent;
    serializedTransaction: string;
    lookupTables?: Record<string, readonly string[]> | undefined;
  }): Promise<SignedAgentTransaction> {
    this.assertIntentWallet(params.intent.wallet);
    validateDepositIntentTransaction({ ...params, ...this.policySpread() });
    return this.sign(params.serializedTransaction);
  }

  async signWithdrawal(params: {
    intent: WithdrawalSigningIntent;
    serializedTransaction: string;
    lookupTables?: Record<string, readonly string[]> | undefined;
  }): Promise<SignedAgentTransaction> {
    this.assertIntentWallet(params.intent.wallet);
    validateWithdrawalIntentTransaction({ ...params, ...this.policySpread() });
    return this.sign(params.serializedTransaction);
  }

  private policySpread(): { policy?: IntentValidationPolicy } {
    return this.validationPolicy === undefined
      ? {}
      : { policy: this.validationPolicy };
  }

  private assertIntentWallet(wallet: string): void {
    if (wallet !== this.walletAddress) {
      throw new IntentValidationError(
        "wallet_mismatch",
        "Intent wallet does not match this signer's wallet"
      );
    }
  }
}

/**
 * Local keypair signer that performs the full structured-intent validation
 * before signing. Suitable for the controlled mainnet launch wallet; custody
 * providers implement the same boundary via RemoteAgentWalletSigner.
 */
export class LocalKeypairAgentWalletSigner extends IntentValidatingAgentWalletSigner {
  readonly provider = "local-keypair";
  private readonly keyPairSigner: KeyPairSigner;

  constructor(
    keyPairSigner: KeyPairSigner,
    validationPolicy?: IntentValidationPolicy | undefined
  ) {
    super(validationPolicy);
    this.keyPairSigner = keyPairSigner;
  }

  get walletAddress(): string {
    return this.keyPairSigner.address;
  }

  async signApiMessage(message: Uint8Array): Promise<string> {
    const signature = await signBytes(
      this.keyPairSigner.keyPair.privateKey,
      message
    );
    return bs58.encode(signature);
  }

  protected async sign(
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

/**
 * Custody-backed signer (Circle developer-controlled wallets, Privy server
 * wallets, ...): the key never enters this process. Same validation boundary
 * as the local signer; every returned signature is verified against the
 * wallet's public key and the requested bytes before use.
 */
export class RemoteAgentWalletSigner extends IntentValidatingAgentWalletSigner {
  private readonly transport: RemoteSignerTransport;
  private readonly publicKey: Uint8Array;

  constructor(
    transport: RemoteSignerTransport,
    validationPolicy?: IntentValidationPolicy | undefined
  ) {
    super(validationPolicy);
    this.transport = transport;
    this.publicKey = ed25519PublicKeyBytes(
      transport.provider,
      transport.walletAddress
    );
  }

  get walletAddress(): string {
    return this.transport.walletAddress;
  }

  get provider(): string {
    return this.transport.provider;
  }

  async signApiMessage(message: Uint8Array): Promise<string> {
    const signature = await this.transport.signMessage(message);
    // Transports normalize encodings, but the trust boundary is here: never
    // emit a signature this process has not verified for this wallet.
    if (!nacl.sign.detached.verify(message, signature, this.publicKey)) {
      throw new RemoteSigningError(
        this.transport.provider,
        "message signature did not verify for the agent wallet"
      );
    }
    return bs58.encode(signature);
  }

  protected sign(
    serializedTransaction: string
  ): Promise<SignedAgentTransaction> {
    return externallySignedAgentTransaction({
      transport: this.transport,
      serializedTransaction
    });
  }
}
