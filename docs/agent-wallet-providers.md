# Agent wallet providers

Subly's CLI and MCP client support three signing backends: `local`, `circle`
and `privy`. Select one with `SUBLY_SIGNER_PROVIDER`; an unset or blank value
uses `local`. Other values are rejected. All payment flows use Solana mainnet.

Follow the [client guide](../packages/pay/README.md) for the relayer, RPC, vault,
owner setup and payment configuration. Changing the signer does not remove
owner approval, transaction validation or spendable-yield requirements.

## Supported backends

| Setting | Wallet | Signing location |
| --- | --- | --- |
| `local` | Dedicated 64-byte Solana keypair | The client process loads and uses the wallet key. |
| `circle` | Circle developer-controlled Solana wallet | Circle signs through its wallet API. |
| `privy` | Privy Solana server wallet, including authorization-key-owned wallets | Privy signs through its wallet API. |

The agent address must be the ed25519 public key that signs Subly's messages
and transactions. Program-controlled smart accounts are not supported by these
backends. A browser wallet used for human owner approval is separate from the
non-interactive agent signer described here.

## Local keypair

Set `SUBLY_DEMO_AGENT_KEYPAIR_PATH` to the absolute path of a Solana JSON
keypair containing 64 bytes. Alternatively, `SUBLY_DEMO_AGENT_KEYPAIR` accepts
the same 64-byte keypair encoded as base58; a nonempty value takes precedence
over the file path.

Use a dedicated wallet and restrict access to its keypair file. Create and back
up keys privately using the [wallet setup guide](../packages/pay/README.md#2-prepare-the-agent-wallet).
Do not paste keypair contents or recovery phrases into chat, logs or issues.

## Circle

Set `SUBLY_SIGNER_PROVIDER=circle` and provide:

| Variable | Value |
| --- | --- |
| `CIRCLE_API_KEY` | API key authorized for the developer-controlled wallet. |
| `CIRCLE_ENTITY_SECRET` | Registered 32-byte entity secret, encoded as 64 hexadecimal characters. |
| `CIRCLE_WALLET_ID` | ID of the agent's Solana mainnet wallet. |

The implemented transport uses `https://api.circle.com`. At initialization it
fetches the wallet and requires `blockchain: "SOL"`; other chains, including
`SOL-DEVNET`, are rejected. It encrypts the entity secret with Circle's entity
public key for signing requests and uses the developer `sign/message` and
`sign/transaction` endpoints. This configuration targets developer-controlled
wallets; it does not add support for other Circle wallet products.

## Privy

Set `SUBLY_SIGNER_PROVIDER=privy` and provide:

| Variable | Value |
| --- | --- |
| `PRIVY_APP_ID` | App ID associated with the wallet. |
| `PRIVY_APP_SECRET` | App secret authorized to access the wallet. |
| `PRIVY_WALLET_ID` | ID of the agent's Solana wallet. |
| `PRIVY_AUTHORIZATION_KEY` | Required when the wallet's ownership policy requires an authorization key; otherwise omit. |

The implemented transport uses `https://api.privy.io`. At initialization it
fetches the wallet and requires `chain_type: "solana"`. Subly's RPC and payment
configuration must still target mainnet. The transport calls the wallet RPC
`signMessage` and `signTransaction` methods with base64 payloads.

The authorization key is a base64 PKCS#8 P-256 private key; the `wallet-auth:`
prefix is accepted. When configured, the client signs non-GET wallet requests
and supplies `privy-authorization-signature`. The app secret alone does not
replace an authorization key required by the wallet's policy.

## Credentials and trust

Circle and Privy variables also accept a `SUBLY_` prefix, such as
`SUBLY_PRIVY_APP_SECRET`. A nonempty prefixed value takes precedence over the
unprefixed one. These credentials belong in the CLI or MCP client environment,
not the relayer. A remote provider does not require a local agent keypair.

Leave `CIRCLE_BASE_URL` and `PRIVY_BASE_URL` unset for the default endpoints.
These overrides, including their `SUBLY_` forms, change where credentials are
sent. Use an override only for a trusted HTTPS endpoint you control or have
verified; never take it from a seller response or unreviewed configuration.

For remote signing, the agent wallet's private key stays with the provider.
API credentials and any Privy authorization private key remain available to
the client process and must be protected. Provider permissions must allow raw
Subly authentication messages and transactions with a separate fee payer.
Provider denials or unavailable signing services prevent the operation from
completing; do not bypass Subly validation to work around them.

The client validates vault transaction intent before requesting a signature.
It verifies returned signatures against the pinned wallet address and the
original message bytes, then attaches only the verified agent signature to its
own transaction. Provider changes to signed message bytes, including a changed
blockhash, fail verification. The standard x402 adapter uses the same remote
transaction-signature verifier.

These checks do not prevent someone with the agent key or equivalent provider
permissions from transacting outside Subly. Owner mandates and principal
accounting are enforced off chain by the relayer. Read the
[security model](security-model.md).

## Implementation and verification

The shipped implementation is in [signer selection](../src/client/signer-env.ts),
[Circle transport](../src/client/signer-transports/circle.ts),
[Privy transport](../src/client/signer-transports/privy.ts), and the shared
[remote-signature verifier](../src/client/remote-signer-transport.ts).

Automated [remote signer tests](../tests/remote-agent-wallet-signer.test.ts)
exercise intent validation, signature verification and environment selection
with generated keys and stub transports. [Privy tests](../tests/privy-transport.test.ts)
verify authorization signatures and message signing with a stubbed API. These
checks do not establish live account permissions or compatibility with every
provider policy. The published [validation evidence](validation.md) does not
establish a live Circle or Privy mainnet payment. Verify the chosen provider
and wallet configuration before relying on it for funded operation.
