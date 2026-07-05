/**
 * Env-driven agent signer selection for the CLI/MCP entry points. One switch
 * picks where the agent wallet key lives:
 *
 *   SUBLY_SIGNER_PROVIDER=local   (default) raw keypair in
 *       SUBLY_DEMO_AGENT_KEYPAIR (base58) or SUBLY_DEMO_AGENT_KEYPAIR_PATH
 *   SUBLY_SIGNER_PROVIDER=circle  Circle developer-controlled wallet:
 *       CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, CIRCLE_WALLET_ID
 *   SUBLY_SIGNER_PROVIDER=privy   Privy server wallet:
 *       PRIVY_APP_ID, PRIVY_APP_SECRET, PRIVY_WALLET_ID
 *       PRIVY_AUTHORIZATION_KEY (optional; required for wallets owned by an
 *       authorization key — Privy's "agentic wallets")
 *
 * The circle/privy credential vars also accept a SUBLY_-prefixed form (e.g.
 * SUBLY_CIRCLE_API_KEY) which wins over the unprefixed one, so Subly can
 * point at a different credential than other tooling on the same machine.
 * (The local keypair vars are SUBLY_-named already and have no second form.)
 *
 * Provider naming: this env slug ("local") is user-facing; the wire value
 * registered at the relayer is AgentWalletSigner.provider ("local-keypair" —
 * the historical value existing wallets are registered with; "circle" and
 * "privy" match on both sides).
 */
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { loadSecretKeyBytes } from "../solana/keys.js";
import {
  LocalKeypairAgentWalletSigner,
  RemoteAgentWalletSigner,
  type AgentWalletSigner
} from "./agent-wallet-signer.js";
import type { RemoteSignerTransport } from "./remote-signer-transport.js";
import { createCircleSignerTransport } from "./signer-transports/circle.js";
import { createPrivySignerTransport } from "./signer-transports/privy.js";

export type AgentSignerBundle =
  | {
      provider: "local";
      signer: AgentWalletSigner;
      /**
       * The raw 64-byte secret, for adapting to standard x402 client
       * libraries that build their own kit signer.
       */
      localSecretKey: Uint8Array;
    }
  | {
      provider: "circle" | "privy";
      signer: AgentWalletSigner;
      /** Transport for building kit signer adapters; no key material. */
      transport: RemoteSignerTransport;
    };

export async function agentWalletSignerFromEnv(
  env: Record<string, string | undefined> = process.env
): Promise<AgentSignerBundle> {
  const nonEmpty = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim();
    return trimmed === undefined || trimmed === "" ? undefined : trimmed;
  };
  // Empty or whitespace-only values behave like "unset" everywhere here, so
  // an `.env` template with a blank SUBLY_SIGNER_PROVIDER= line stays local.
  const provider =
    nonEmpty(env.SUBLY_SIGNER_PROVIDER)?.toLowerCase() ?? "local";
  const pickVar = (name: string): string | undefined =>
    nonEmpty(env[`SUBLY_${name}`]) ?? nonEmpty(env[name]);
  const requireVar = (name: string): string => {
    const value = pickVar(name);
    if (value === undefined) {
      throw new Error(
        `${name} (or SUBLY_${name}) is required for SUBLY_SIGNER_PROVIDER=${provider}`
      );
    }
    return value;
  };

  if (provider === "local") {
    const localSecretKey = loadSecretKeyBytes({
      base58Secret: env.SUBLY_DEMO_AGENT_KEYPAIR,
      jsonFilePath: env.SUBLY_DEMO_AGENT_KEYPAIR_PATH,
      label: "SUBLY_DEMO_AGENT_KEYPAIR"
    });
    return {
      provider,
      signer: new LocalKeypairAgentWalletSigner(
        await createKeyPairSignerFromBytes(localSecretKey)
      ),
      localSecretKey
    };
  }

  if (provider === "circle") {
    const transport = await createCircleSignerTransport({
      apiKey: requireVar("CIRCLE_API_KEY"),
      entitySecret: requireVar("CIRCLE_ENTITY_SECRET"),
      walletId: requireVar("CIRCLE_WALLET_ID"),
      baseUrl: pickVar("CIRCLE_BASE_URL")
    });
    return { provider, signer: new RemoteAgentWalletSigner(transport), transport };
  }

  if (provider === "privy") {
    const transport = await createPrivySignerTransport({
      appId: requireVar("PRIVY_APP_ID"),
      appSecret: requireVar("PRIVY_APP_SECRET"),
      walletId: requireVar("PRIVY_WALLET_ID"),
      authorizationPrivateKey: pickVar("PRIVY_AUTHORIZATION_KEY"),
      baseUrl: pickVar("PRIVY_BASE_URL")
    });
    return { provider, signer: new RemoteAgentWalletSigner(transport), transport };
  }

  throw new Error(
    `unknown SUBLY_SIGNER_PROVIDER "${provider}" (expected local, circle, or privy)`
  );
}
