# Agent Wallet Providers — Support Status and Integration Designs

Created: 2026-07-06 JST. **Historical implementation record and design notes;
Turnkey and the providers listed after it have not been implemented.**
The implemented signer choices are local keypairs, Circle and Privy; their
entry point is `src/client/signer-env.ts`. See the [client guide](../packages/pay/README.md)
for configuration and [validation status](validation.md) for current verification
scope. The former custody-wallet smoke-test document is available in Git history;
it is not a current onboarding guide.

The provider descriptions, API assumptions and priorities below record the
July 2026 design review. Verify them against each provider's current official
API documentation before implementing a proposed transport. They do not add
supported signer choices to the released client.

> Background: in addition to local keys whose private material can be exported,
> Subly accepts custody/MPC agent wallets through `RemoteSignerTransport`, a
> narrow interface with four members. The July 2026 design assessment focused
> on Turnkey, Privy, Coinbase CDP and Crossmint, among others, using the pattern
> “MPC/TEE-held ed25519 EOA + REST signing API + policy engine.” Products that
> meet those requirements can follow the same integration pattern.

## 1. Support matrix recorded on 2026-07-06

| Provider | Model | Status | Notes |
| --- | --- | --- | --- |
| Local keypair | Self-managed ed25519 | Implemented | Default; a self-hosted TEE exposing a local key uses this path too. |
| Privy server wallets, including agentic/owner-key wallets | MPC EOA + authorization key | Implemented | Supports `privy-authorization-signature` (RFC8785 → SHA-256 → P-256 DER); unit tests verify signatures with actual keys. |
| Circle developer-controlled wallets | MPC EOA | Implemented | Circle's Solana developer-controlled wallet integration. |
| **Turnkey** | ed25519 in Nitro Enclave + policy engine | Proposed in section 3 | First candidate in the historical plan; identified as Solana Agent Kit's standard signing layer. |
| **Coinbase CDP / Agentic Wallets** | Server Wallet v2 (MPC + Nitro) + policy | Proposed in section 4 | AgentKit and x402 integration; the design record dates its launch to 2026-02. |
| Crossmint agent wallets | Full stack with pluggable signers such as Turnkey/Privy | Proposed in section 5; configuration-dependent | EOA signer configurations fit the model; smart-wallet configurations require separate consideration. |
| Dfns | MPC custody + User Action Signing | Proposed in section 6 | Institutional use; two-stage challenge-response authentication. |
| Fireblocks | MPC custody with RAW signing | Proposed in section 7 | Institutional use; asynchronous signing/polling and prior RAW-signing enablement. |
| Para, formerly Capsule | MPC 2/2, primarily SDK-based | Proposed in section 8; substantial research remains | Limited REST surface; likely to require an SDK dependency. |
| Squads Grid / Smart Account | Program-based smart account | Out of scope | The wallet address is not the signing key. Both relayer wallet authentication and on-chain signing would need changes; see section 9. |
| Circle CLI “agent wallet” | **EVM SCA, such as Base** | Incompatible with this signer model | The EVM product assessed here has no Solana ed25519 key or signing API. It cannot be used as this Solana signer. |
| Browser wallets, such as Phantom | Interactive | Outside the non-interactive agent signer path | An exported compatible key can use the local provider. This does not exclude browser wallets from human owner approval. |

Frameworks such as SendAI Solana Agent Kit, ElizaOS and Coinbase AgentKit are
integration layers rather than wallets; their underlying signer determines
compatibility. The historical plan estimated that Turnkey and CDP would cover
nearly 100% of its targeted framework integrations. That was a planning
assumption, not a measured compatibility result.

## 2. Shared pattern for adding a provider

Each new provider needs five pieces, using Privy/Circle as reference
implementations. Preserve the validation boundary: validate the transaction
intent, request a signature, then verify the returned signature against Subly's
own bytes and the pinned public key.

1. **One transport file:** `src/client/signer-transports/<provider>.ts`.
   Implement only the four `RemoteSignerTransport` members: `provider`,
   `walletAddress`, `signMessage(bytes)` returning a 64-byte signature, and
   `signTransaction(base64)` returning a signed wire transaction in base64.
   Reuse `providerJsonRequest` for HTTP/error handling,
   `verifiedEd25519Signature` for encoding normalization and verification of
   every candidate signature before acceptance, and `RemoteSigningError`.
   At factory initialization, GET the wallet to pin its address and strictly
   check the chain: reject anything other than Solana mainnet during setup.
2. **One environment-selection branch:** `src/client/signer-env.ts`.
   Add a member to the discriminated union. Read credentials through
   `requireVar`/`pickVar` to retain `SUBLY_`-prefixed overrides.
3. **Stubbed end-to-end tests:** `tests/<provider>-transport.test.ts`.
   Inject `fetchImpl` and use actual test keys to exercise request
   authentication and signature verification. Use
   `tests/privy-transport.test.ts` as a template.
4. **Documentation:** extend the environment table in `packages/pay/README.md`
   and record provider-specific verification in [validation status](validation.md).
   The former custody-wallet smoke-test plan is archived in Git history.
   Its three shared questions still apply: (1) signing when the wallet is not
   the fee payer, (2) signing raw message bytes, and (3) accepting complex
   transactions.
5. **A smoke test with real provider credentials:** the historical test plan
   budgeted approximately 1.02 USDC and no SOL in the agent wallet, relying on
   sponsorship. This is a planning figure, not a current fee quote or evidence
   that a provider has passed. Record the actual scope and result.

Historical effort estimate per provider: approximately 150 lines of transport,
150 lines of tests, and documentation; half a day plus the smoke test.

## 3. Turnkey proposal — priority 1

Historical rationale: its role as Solana Agent Kit v2's standard signing layer
and adoption among Solana agents. Its transaction limits, address allowlists
and approval policies could complement Subly's spending mandate.

- **Authentication:** an **X-Stamp header** for each API request. The stamp is
  base64url-encoded `{publicKey, scheme: "SIGNATURE_SCHEME_TK_API_P256", signature}`.
  The signature covers the **exact JSON request-body string using ECDSA P-256**,
  unlike Privy's RFC8785 normalization. Serialize once and sign exactly the
  bytes sent. The API key is a P-256 pair issued through the Turnkey dashboard.
- **Signing API:** activity requests under `POST /public/v1/submit/...`.
  - Message signing: `ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2`, with `signWith`
    (potentially a wallet address), hex `payload`,
    `encoding: PAYLOAD_ENCODING_HEXADECIMAL`, and
    `hashFunction: HASH_FUNCTION_NOT_APPLICABLE` for raw ed25519 signing.
    Explicit raw-byte signing would reduce uncertainty (2) above.
  - Transaction signing: `ACTIVITY_TYPE_SIGN_TRANSACTION_V2`, with
    `type: TRANSACTION_TYPE_SOLANA` and hex `unsignedTransaction`;
    the response contains `signedTransaction`.
  - Responses use an activity envelope (`activity.result....`). Consensus
    can make signing asynchronous. The proposed transport supports policies
    with immediate approval and returns a typed error unless the status is
    `ACTIVITY_STATUS_COMPLETED`.
- **Proposed environment:** `SUBLY_SIGNER_PROVIDER=turnkey`,
  `TURNKEY_API_PUBLIC_KEY`, `TURNKEY_API_PRIVATE_KEY` (P-256 hex),
  `TURNKEY_ORGANIZATION_ID`, and `TURNKEY_SIGN_WITH` (Solana address).
  The wire `signerProvider` would be `"turnkey"`.
- **Verify before implementation:** the API assumptions above originally came
  from January 2026 reference material. Check the [official API documentation](https://docs.turnkey.com).
  - [ ] Exact stamp field names and base64url representation.
  - [ ] Current SIGN_RAW_PAYLOAD / SIGN_TRANSACTION activity versions.
  - [ ] Solana signTransaction input/output encoding: hex or base64.
  - [ ] Whether signWith accepts an address or requires a private-key ID.

## 4. Coinbase CDP / Agentic Wallets proposal — priority 2

Historical rationale: the February 2026 Agentic Wallets offering aligned with
AgentKit and x402. The proposed integration targets a Solana EOA in CDP Server
Wallet v2.

- **Authentication has two layers:**
  1. A short-lived Bearer JWT, approximately two minutes, signed with a CDP API
     key (Ed25519 or ES256). Its `uris` claims contain method, host and path.
  2. An additional account-operation JWT in `X-Wallet-Auth`, signed with the
     **Wallet Secret** and required for signing endpoints.
  Two implementation options remain: dynamically import the official
  `@coinbase/cdp-sdk` as an optional peer rather than a devDependency, or
  generate both JWTs directly with `node:crypto`. Direct generation keeps
  transport dependencies small but requires tracking changes to the claims
  specification. Decide when implementation starts.
- **Signing API:** `POST /platform/v2/solana/accounts/{address}/sign-message`
  and `/sign-transaction`, with a base64 transaction and base64
  `signedTransaction` result.
- **Proposed environment:** `SUBLY_SIGNER_PROVIDER=coinbase`, `CDP_API_KEY_ID`,
  `CDP_API_KEY_SECRET`, `CDP_WALLET_SECRET`, and `CDP_SOLANA_ADDRESS`.
  The wire `signerProvider` would be `"coinbase-cdp"`.
- **Verify before implementation:**
  - [ ] Exact JWT claims: `uris` format, expiry and nonce.
  - [ ] X-Wallet-Auth payload, including whether it contains a request hash.
  - [ ] Whether sign-message signs raw bytes: uncertainty (2).
  - [ ] Whether the policy engine permits transactions with another fee payer: uncertainty (1).
  - [ ] Sandbox/mainnet selection and rate limits.

## 5. Crossmint proposal — priority 3, configuration-dependent

Historical rationale: payments, on-ramping and compliance in a full-stack
product could make it an entry point for agent developers. The design identifies
**two Solana wallet configurations, only one of which fits the transport model**:

- **Configuration A: custody/MPC wallet with a server-side admin signer.**
  An ed25519 EOA can fit the transport pattern. **This is the proposed target.**
- **Configuration B: Solana embedded smart wallet with delegated signers.**
  This has the same wallet-address/signing-key mismatch as Squads and is out
  of scope; see section 9. A user could instead supply the compatible agent
  keypair registered as a delegated signer directly to Subly's local provider,
  without using the Crossmint API.

- **Authentication:** a server API key in `X-API-KEY`, with wallet scopes.
- **Signing API:** wallets API `2022-06-09`.
  - Message signing: `POST /api/2022-06-09/wallets/{walletLocator}/signatures`
    through Create Signature. The anticipated flow is create, automatically
    approve for a custodial wallet, then GET the signature. It may require
    **two asynchronous stages**.
  - Transaction signing: the main question is whether `POST .../transactions`
    accepts an **externally constructed base64 transaction**. A flow limited
    to approval of Crossmint-built transactions would not fit Subly's model
    of signing already-prepared bytes.
- **Proposed environment:** `SUBLY_SIGNER_PROVIDER=crossmint`,
  `CROSSMINT_API_KEY`, and `CROSSMINT_WALLET_LOCATOR`.
  The wire provider would be `"crossmint"`.
- **Verify before implementation:**
  - [ ] Whether the API can create Solana custodial EOAs or only smart wallets.
        If no EOA is available, defer the integration and document the local
        delegated-signer alternative for configuration B.
  - [ ] Exact Solana message parameters and returned signature encoding.
  - [ ] Support for externally constructed transactions.
  - [ ] Whether polling is required, and expected signing latency.

## 6. Dfns proposal — priority 4, institutional use

- **Two-stage authentication:** a service-account Bearer token plus **User
  Action Signing**. For each mutating request, obtain a challenge with
  `POST /auth/action/init`, sign it with a **key credential (P-256/EdDSA)**,
  obtain a signing token with `POST /auth/action`, then send the token in
  `X-DFNS-USERACTION`. Encapsulate those three authentication exchanges in
  the transport. One signature would require four HTTP round trips in total,
  which matters for latency.
- **Signing API:** `POST /wallets/{walletId}/signatures`
  (`wallets.generateSignature`). For Solana, `kind: "Transaction"` accepts an
  unsigned transaction. The design reference specifies a serialized transaction
  with **zero-filled placeholder signature slots**, matching Subly's prepared
  representation. Message signing uses `kind: "Message"` with raw bytes in hex.
  Verify that the returned signature object contains a 64-byte ed25519
  signature, rather than an r/s representation.
- **Proposed environment:** `SUBLY_SIGNER_PROVIDER=dfns`, `DFNS_API_TOKEN`,
  `DFNS_CREDENTIAL_ID`, `DFNS_CREDENTIAL_PRIVATE_KEY` for User Action Signing,
  and `DFNS_WALLET_ID`. The wire provider would be `"dfns"`.
- **Verify before implementation:**
  - [ ] User Action Signing challenge payload: clientData structure and base64url.
  - [ ] How to extract the 64-byte Solana signature from generateSignature:
        signed transaction or standalone signature.
  - [ ] Whether `kind: "Message"` performs raw-byte ed25519 signing for Solana: uncertainty (2).
  - [ ] Whether service-account policies permit another fee payer: uncertainty (1).

## 7. Fireblocks proposal — priority 4, institutional use

- **Authentication:** an API key plus a **JWT for each request**, signed with
  an RSA private key. Claims include uri, nonce and the **SHA-256 body hash**.
  Send `X-API-Key` and `Authorization: Bearer <jwt>`.
- **Signing API:** an asynchronous model that represents signing requests as
  Fireblocks transactions.
  - Create with `POST /v1/transactions`, `operation: "RAW"`, `assetId: "SOL"`,
    and `extraParameters.rawMessageData.messages[].content = <hex>`.
    Both message signing and transaction messageBytes signing use this path.
  - Poll `GET /v1/transactions/{txId}` until **COMPLETED**, then read the
    ed25519 signature from `signedMessages[].signature`.
  - Encapsulate polling with bounded backoff. Transaction Authorization Policy
    (TAP) approval can take seconds or remain pending indefinitely, so return
    a typed timeout error.
- **Prerequisite identified in the design:** **RAW signing is disabled by
  default** and must be enabled for the workspace through Fireblocks support,
  under the relevant institutional arrangement. Sign transaction messageBytes
  through RAW and attach the signature locally. Keep the validation boundary
  unchanged. Because the transport's `signTransaction` contract returns a
  signed wire transaction, attach the signature inside the transport with
  `attachExternalSignatureToTransaction` before returning it.
- **Proposed environment:** `SUBLY_SIGNER_PROVIDER=fireblocks`,
  `FIREBLOCKS_API_KEY`, `FIREBLOCKS_SECRET_KEY_PATH` (RSA PEM), and
  `FIREBLOCKS_VAULT_ACCOUNT_ID`. The wire provider would be `"fireblocks"`.
- **Verify before implementation:**
  - [ ] Exact JWT claims: uri, nonce, bodyHash and the 55-second exp limit.
  - [ ] Solana/ed25519 RAW input and returned signature formats.
  - [ ] TAP handling of another fee payer; uncertainty (1) depends on policy.
  - [ ] Polling intervals and rate limits.

## 8. Para, formerly Capsule — priority 5, further research required

- **Model:** MPC 2/2, with one user share and one Para share. The server SDK
  `@getpara/server-sdk` imports a session to sign. Availability of a **plain
  REST signing API is unverified**. Subly transports have favored direct REST
  without additional dependencies; Para may require a dynamic SDK import only
  when provider=para is selected. Accepting that change is the first decision.
- **Signing:** signMessage / signTransaction through a Solana SDK adapter,
  `@getpara/solana-web3.js-*`. Pregenerated server-side agent wallets may
  simplify session management.
- **Proposed environment:** `SUBLY_SIGNER_PROVIDER=para`, `PARA_API_KEY`, and
  `PARA_SESSION` or a pregenerated-wallet identifier.
  The wire provider would be `"para"`.
- **Verify before implementation:**
  - [ ] Availability of a direct REST signing API, avoiding an SDK dependency.
  - [ ] Session lifetime and renewal for a non-interactive agent.
  - [ ] Raw-byte message signing for pregenerated wallets: uncertainty (2).

## 9. Future smart-account work: Squads and related designs

This remains **out of scope**. A smart account breaks the current assumption
that the wallet address is an ed25519 signing key, so adding a transport is
insufficient. Supporting it would require:

1. Two-stage relayer wallet authentication for the smart account and its member
   signing key: `x-subly-wallet` would differ from the signer.
2. Separation of vault position ownership from transaction signing, following
   the smart account's authority structure.
3. Facilitator support for the x402 payment leg, because `@x402/svm` assumes
   an EOA signer. Subly cannot implement this independently.

The historical plan defers this work until a concrete need emerges, such as an
agent funded by a DAO treasury. Crossmint's smart-wallet configuration B belongs
in the same category.

## 10. Historical priority summary

| Priority | Provider | Rationale at the time | Main risk |
| --- | --- | --- | --- |
| 1 | Turnkey | Solana Agent Kit default and observed adoption | Asynchronous activities under consensus policies. |
| 2 | Coinbase CDP | Agentic Wallets and x402 fit | Maintaining two JWT authentication layers. |
| 3 | Crossmint | Full-stack entry point | EOA availability; defer if no compatible configuration exists. |
| 4 | Dfns / Fireblocks | Institutional demand, when present | Multi-stage authentication, asynchronous signing and commercial prerequisites. |
| 5 | Para | Demand-dependent | Changing dependency policy if there is no REST interface. |

## 11. Implementation history

- 2026-07-05: implemented local, Circle and Privy providers. An eight-area review
  was completed and its findings addressed; see Git history for details. The
  Circle CLI agent wallet assessed then was an EVM SCA and incompatible with
  the Solana signer model.
- 2026-07-05, later that day: added Privy authorization-key support for agentic
  wallets, with unit tests verifying header signatures using actual P-256 keys.
- 2026-07-06: recorded the six proposed transports for Turnkey, CDP, Crossmint,
  Dfns, Fireblocks and Para. None was implemented. Complete the verification
  checklist for a provider before starting its implementation.
- At the time of that record, provider smoke tests had not been run. The former
  custody-wallet smoke-test procedure is archived in Git history. For current
  evidence and its limits, use [validation status](validation.md); do not treat
  this historical note as a current test report.

Historical references: [Crossmint Create Signature](https://docs.crossmint.com/api-reference/wallets/create-signature),
[Crossmint Solana Embedded Smart Wallets](https://blog.crossmint.com/solana-embedded-smart-wallets/),
[Dfns Solana Generate Signature](https://docs.dfns.co/api-reference/sign/solana),
[Dfns User Action Signing](https://docs.dfns.co/d/api-docs/authentication/user-action-signing),
[Turnkey Docs](https://docs.turnkey.com), [Coinbase Agentic Wallets](https://www.coinbase.com/developer-platform/discover/launches/agentic-wallets),
[Agent Wallets Compared (Crossmint)](https://www.crossmint.com/learn/agent-wallets-compared)
