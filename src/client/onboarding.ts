/**
 * Self-serve wallet onboarding: registers (and activates) the agent wallet
 * at the Subly relayer and syncs its position from chain. Requests are
 * wallet-signature authenticated, so no operator involvement or shared token
 * is needed — the wallet key itself is the credential. Idempotent: safe to
 * call before every flow.
 */
import type { AgentWalletSigner } from "./agent-wallet-signer.js";
import { walletAuthHeaders } from "./wallet-auth-headers.js";

const SELF_SERVE_POLICY_ID = "self-serve";

export class OnboardingError extends Error {
  constructor(
    readonly step: "register" | "sync",
    message: string,
    readonly detail: unknown = null
  ) {
    super(message);
    this.name = "OnboardingError";
  }
}

export async function ensureWalletOnboarded(params: {
  /** Subly relayer API base URL; `SUBLY_FACILITATOR_URL` remains a legacy env fallback. */
  relayerBaseUrl: string;
  signer: AgentWalletSigner;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const baseUrl = params.relayerBaseUrl.replace(/\/$/, "");

  const post = async (
    step: "register" | "sync",
    path: string,
    body: Record<string, unknown>
  ): Promise<void> => {
    const url = `${baseUrl}${path}`;
    const serialized = JSON.stringify(body);
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        ...(await walletAuthHeaders({
          signer: params.signer,
          method: "POST",
          url,
          body: serialized
        })),
        "content-type": "application/json"
      },
      body: serialized
    });
    if (response.status !== 200) {
      let detail: unknown = null;
      try {
        detail = await response.json();
      } catch {
        detail = null;
      }
      throw new OnboardingError(
        step,
        `wallet onboarding ${step} failed with ${response.status}`,
        detail
      );
    }
  };

  const wallet = params.signer.walletAddress;
  await post("register", "/v1/wallets/agent", {
    wallet,
    signingPolicyId: SELF_SERVE_POLICY_ID,
    signingMode: "non_interactive",
    signerValidationMode: params.signer.validationMode,
    signerProvider: "local-keypair",
    activateForPayments: true
  });
  await post("sync", `/v1/wallets/${wallet}/sync`, { source: "chain" });
}
