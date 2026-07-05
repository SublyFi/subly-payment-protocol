import { describe, expect, it, vi } from "vitest";
import { getAddMemoInstruction } from "@solana-program/memo";
import {
  blockhash,
  generateKeyPairSigner,
  signBytes,
  type KeyPairSigner
} from "@solana/kit";
import bs58 from "bs58";
import nacl from "tweetnacl";
import {
  RemoteAgentWalletSigner
} from "../src/client/agent-wallet-signer.js";
import {
  externallySignedAgentTransaction,
  RemoteSigningError,
  verifiedEd25519Signature,
  type RemoteSignerTransport
} from "../src/client/remote-signer-transport.js";
import { agentWalletSignerFromEnv } from "../src/client/signer-env.js";
import type { PaymentSigningIntent } from "../src/client/transaction-intent-validator.js";
import {
  addSignaturesToSerializedTransaction,
  buildVersionedTransaction,
  decodeSerializedTransaction
} from "../src/solana/tx.js";

async function memoTransaction(
  feePayer: KeyPairSigner,
  memo: string
): Promise<string> {
  const built = await buildVersionedTransaction({
    feePayer: feePayer.address,
    blockhash: blockhash("GfVcyD4kkTrj4bKc7WA9sZCty9hCJ4A57xVpb5bqsiPi"),
    lastValidBlockHeight: 100n,
    instructions: [getAddMemoInstruction({ memo })]
  });
  return built.serializedBase64;
}

/** Transport that signs correctly with the agent's real local key. */
function honestTransport(agent: KeyPairSigner): RemoteSignerTransport {
  return {
    provider: "fake",
    walletAddress: agent.address,
    async signMessage(message) {
      return await signBytes(agent.keyPair.privateKey, message);
    },
    async signTransaction(serializedBase64) {
      const signed = await addSignaturesToSerializedTransaction({
        serializedBase64,
        signers: [agent.keyPair]
      });
      return signed.serializedBase64;
    }
  };
}

describe("externallySignedAgentTransaction", () => {
  it("attaches a verified provider signature to the original transaction", async () => {
    const agent = await generateKeyPairSigner();
    const serialized = await memoTransaction(agent, "hello");

    const result = await externallySignedAgentTransaction({
      transport: honestTransport(agent),
      serializedTransaction: serialized
    });

    const decoded = decodeSerializedTransaction(result.serializedTransaction);
    const signature = decoded.signatures[agent.address];
    expect(signature).not.toBeNull();
    expect(bs58.encode(signature!)).toBe(result.agentSignature);
    expect(
      nacl.sign.detached.verify(
        decoded.messageBytes as unknown as Uint8Array,
        signature!,
        bs58.decode(agent.address)
      )
    ).toBe(true);
  });

  it("rejects a signature made over different transaction bytes", async () => {
    const agent = await generateKeyPairSigner();
    const requested = await memoTransaction(agent, "requested");
    const other = await memoTransaction(agent, "swapped-by-provider");

    const transport: RemoteSignerTransport = {
      ...honestTransport(agent),
      async signTransaction() {
        const signed = await addSignaturesToSerializedTransaction({
          serializedBase64: other,
          signers: [agent.keyPair]
        });
        return signed.serializedBase64;
      }
    };

    await expect(
      externallySignedAgentTransaction({
        transport,
        serializedTransaction: requested
      })
    ).rejects.toThrow(RemoteSigningError);
  });

  it("rejects a response that is missing the wallet signature", async () => {
    const agent = await generateKeyPairSigner();
    const serialized = await memoTransaction(agent, "unsigned");
    const transport: RemoteSignerTransport = {
      ...honestTransport(agent),
      async signTransaction(input) {
        return input; // echoes the unsigned transaction back
      }
    };

    await expect(
      externallySignedAgentTransaction({
        transport,
        serializedTransaction: serialized
      })
    ).rejects.toThrow(/missing the signature/);
  });
});

describe("RemoteAgentWalletSigner", () => {
  it("signs api messages and returns a verifying base58 signature", async () => {
    const agent = await generateKeyPairSigner();
    const signer = new RemoteAgentWalletSigner(honestTransport(agent));
    const message = new TextEncoder().encode("subly-api:GET:/v1/x:abc:123");

    const signature = await signer.signApiMessage(message);
    expect(
      nacl.sign.detached.verify(
        message,
        bs58.decode(signature),
        bs58.decode(agent.address)
      )
    ).toBe(true);
  });

  it("refuses to emit an unverifiable message signature", async () => {
    const agent = await generateKeyPairSigner();
    const transport: RemoteSignerTransport = {
      ...honestTransport(agent),
      async signMessage() {
        return new Uint8Array(64); // garbage from the provider
      }
    };
    const signer = new RemoteAgentWalletSigner(transport);

    await expect(
      signer.signApiMessage(new TextEncoder().encode("msg"))
    ).rejects.toThrow(RemoteSigningError);
  });

  it("rejects intents for a different wallet before contacting the provider", async () => {
    const agent = await generateKeyPairSigner();
    const other = await generateKeyPairSigner();
    const transport = honestTransport(agent);
    const signTransaction = vi.spyOn(transport, "signTransaction");
    const signer = new RemoteAgentWalletSigner(transport);

    await expect(
      signer.signPayment({
        intent: { wallet: other.address } as unknown as PaymentSigningIntent,
        serializedTransaction: "AAAA"
      })
    ).rejects.toThrow(/does not match this signer's wallet/);
    expect(signTransaction).not.toHaveBeenCalled();
  });

  it("runs intent validation before contacting the provider", async () => {
    const agent = await generateKeyPairSigner();
    const transport = honestTransport(agent);
    const signTransaction = vi.spyOn(transport, "signTransaction");
    const signer = new RemoteAgentWalletSigner(transport);

    // A bare memo transaction is nowhere near a valid payment settlement, so
    // the structured-intent validator must throw before any remote call.
    await expect(
      signer.signPayment({
        intent: { wallet: agent.address } as unknown as PaymentSigningIntent,
        serializedTransaction: await memoTransaction(agent, "not-a-settlement")
      })
    ).rejects.toThrow();
    expect(signTransaction).not.toHaveBeenCalled();
  });
});

describe("verifiedEd25519Signature", () => {
  it("accepts base58, base64, and hex encodings of a valid signature", async () => {
    const agent = await generateKeyPairSigner();
    const message = new TextEncoder().encode("encoding-check");
    const signature = await signBytes(agent.keyPair.privateKey, message);

    for (const encoded of [
      bs58.encode(signature),
      Buffer.from(signature).toString("base64"),
      Buffer.from(signature).toString("hex"),
      `0x${Buffer.from(signature).toString("hex")}`,
      // Providers occasionally wrap responses in whitespace; must not reject.
      `  ${Buffer.from(signature).toString("base64")}\n`
    ]) {
      const verified = verifiedEd25519Signature({
        provider: "fake",
        encodedSignature: encoded,
        message,
        walletAddress: agent.address
      });
      expect(Buffer.from(verified)).toEqual(Buffer.from(signature));
    }
  });

  it("rejects signatures that do not verify for the wallet", async () => {
    const agent = await generateKeyPairSigner();
    const attacker = await generateKeyPairSigner();
    const message = new TextEncoder().encode("forged");
    const forged = await signBytes(attacker.keyPair.privateKey, message);

    expect(() =>
      verifiedEd25519Signature({
        provider: "fake",
        encodedSignature: bs58.encode(forged),
        message,
        walletAddress: agent.address
      })
    ).toThrow(RemoteSigningError);
  });
});

describe("agentWalletSignerFromEnv", () => {
  it("rejects unknown providers", async () => {
    await expect(
      agentWalletSignerFromEnv({ SUBLY_SIGNER_PROVIDER: "ledger" })
    ).rejects.toThrow(/unknown SUBLY_SIGNER_PROVIDER/);
  });

  it("treats empty or whitespace SUBLY_SIGNER_PROVIDER as local", async () => {
    const keyPair = nacl.sign.keyPair();
    for (const value of ["", "  ", " local ", "LOCAL"]) {
      const bundle = await agentWalletSignerFromEnv({
        SUBLY_SIGNER_PROVIDER: value,
        SUBLY_DEMO_AGENT_KEYPAIR: bs58.encode(keyPair.secretKey)
      });
      expect(bundle.provider).toBe("local");
    }
  });

  it("requires provider credentials before any network call", async () => {
    await expect(
      agentWalletSignerFromEnv({ SUBLY_SIGNER_PROVIDER: "circle" })
    ).rejects.toThrow(/CIRCLE_API_KEY/);
    await expect(
      agentWalletSignerFromEnv({ SUBLY_SIGNER_PROVIDER: "privy" })
    ).rejects.toThrow(/PRIVY_APP_ID/);
  });

  it("defaults to the local keypair provider", async () => {
    const keyPair = nacl.sign.keyPair();
    const bundle = await agentWalletSignerFromEnv({
      SUBLY_DEMO_AGENT_KEYPAIR: bs58.encode(keyPair.secretKey)
    });
    expect(bundle.provider).toBe("local");
    expect(bundle.signer.provider).toBe("local-keypair");
    expect(bundle.signer.walletAddress).toBe(bs58.encode(keyPair.publicKey));
    if (bundle.provider !== "local") {
      throw new Error("expected a local bundle");
    }
    expect(bundle.localSecretKey).toEqual(keyPair.secretKey);
  });
});
