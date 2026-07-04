/**
 * Owner-facing web pages (docs/spending-mandate-design.md, Phase 2): setup
 * (owner appointment + mandate signing), approve (threshold escalations),
 * and revoke (kill switch). Served by the relayer itself as fully
 * self-contained HTML — no external assets — because the pages open on the
 * HUMAN's phone/browser, the one place the owner credential lives.
 *
 * The pages read their ids from location.pathname and call the same-origin
 * /v1 API, so the HTML is a static string (nothing is interpolated
 * server-side — no injection surface). Signing paths:
 *   - passkey (default): WebAuthn create + assertion whose challenge is
 *     sha256 of the exact Subly message being authorized
 *   - Solana wallet (power users): Phantom-style message signing (ed25519)
 *
 * The page-side canonicalJson MUST byte-match src/lib/canonical-json.ts
 * (key-sorted JSON, no whitespace): the owner signs a hash the page
 * computes, and the server recomputes it from the submitted document.
 */

const SHARED_STYLE = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 16px; display: flex; justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #f4f5f7; color: #16181d;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #101216; color: #e8eaf0; }
    .card { background: #1a1d24 !important; box-shadow: none !important; }
    .row { border-color: #2a2e38 !important; }
    .mono { background: #12141a !important; }
    .note { color: #9aa1af !important; }
  }
  .card {
    width: 100%; max-width: 460px; background: #fff; border-radius: 14px;
    padding: 22px; box-shadow: 0 4px 20px rgba(0,0,0,.08);
  }
  h1 { font-size: 19px; margin: 0 0 4px; }
  .sub { font-size: 13px; color: #6b7280; margin: 0 0 18px; }
  .row {
    display: flex; justify-content: space-between; gap: 12px;
    padding: 9px 0; border-bottom: 1px solid #eceef2; font-size: 14px;
  }
  .row:last-of-type { border-bottom: none; }
  .row .k { color: #6b7280; flex-shrink: 0; }
  .row .v { text-align: right; word-break: break-all; font-weight: 600; }
  .mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px; background: #f1f2f5; border-radius: 6px;
    padding: 2px 6px; word-break: break-all; font-weight: 500;
  }
  button {
    width: 100%; margin-top: 10px; padding: 14px; border: none;
    border-radius: 10px; font-size: 15px; font-weight: 600; cursor: pointer;
  }
  button:disabled { opacity: .5; cursor: default; }
  .primary { background: #4457ff; color: #fff; }
  .secondary { background: transparent; color: #4457ff; border: 1.5px solid #4457ff; }
  .danger { background: #d92d20; color: #fff; }
  .note { font-size: 12px; color: #6b7280; margin-top: 14px; line-height: 1.5; }
  .status { margin-top: 14px; font-size: 14px; line-height: 1.5; word-break: break-word; }
  .ok { color: #067647; }
  .err { color: #d92d20; }
  .badge {
    display: inline-block; font-size: 12px; font-weight: 700;
    padding: 3px 10px; border-radius: 999px; background: #eef0ff; color: #4457ff;
  }
`;

/** Helpers shared by every page: base64url, sha256, canonical JSON, base58,
 *  API fetch, USDC formatting, and the two signing paths. Exported so tests
 *  can EXECUTE them and prove they byte-match the server implementations
 *  (canonical-json, WebAuthn challenge, base58) — the owner signs hashes
 *  this code computes. */
export const SHARED_JS = `
  const $ = (id) => document.getElementById(id);
  const enc = new TextEncoder();

  // Every dynamic value is escaped before touching innerHTML: this page is
  // the human's ONLY view of what they are authorizing, and some rendered
  // fields (e.g. a payment binding's method) originate from the agent.
  function esc(v) {
    return String(v).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[c]);
  }
  function row(k, v, mono) {
    return '<div class="row"><span class="k">' + esc(k) + '</span><span class="v' +
      (mono ? ' mono' : '') + '">' + esc(v) + "</span></div>";
  }

  function b64u(buf) {
    const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  }
  function b64uDecode(str) {
    const bin = atob(str.replaceAll("-", "+").replaceAll("_", "/"));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  async function sha256Bytes(text) {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text)));
  }
  async function sha256Hex(text) {
    return [...await sha256Bytes(text)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  // MUST match the relayer's canonical-json.ts: key-sorted, no whitespace,
  // undefined-valued keys dropped.
  function canonicalJson(v) {
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(v[k])).join(",") + "}";
  }
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  function base58(bytes) {
    let n = 0n;
    for (const b of bytes) n = n * 256n + BigInt(b);
    let s = "";
    while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
    for (const b of bytes) { if (b === 0) s = "1" + s; else break; }
    return s;
  }
  async function api(path, options) {
    const response = await fetch(path, options);
    let body = null;
    try { body = await response.json(); } catch {}
    if (!response.ok) {
      const err = body && body.error ? body.error : {};
      const e = new Error(err.message || ("request failed: " + response.status));
      e.code = err.code || null;
      throw e;
    }
    return body;
  }
  function postJson(path, payload) {
    return api(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
  }
  function usdc(raw) {
    if (raw === null || raw === undefined) return "—";
    const n = BigInt(raw);
    const whole = n / 1000000n;
    const frac = (n % 1000000n).toString().padStart(6, "0").replace(/0+$/, "");
    return whole.toString() + (frac ? "." + frac : "") + " USDC";
  }
  // Caps distinguish "not set" (no limit) from an amount.
  function capUsdc(raw) {
    return raw === null || raw === undefined ? "No limit" : usdc(raw);
  }
  function short(s, head = 6, tail = 6) {
    return s && s.length > head + tail + 3 ? s.slice(0, head) + "…" + s.slice(-tail) : (s || "—");
  }
  function setStatus(kind, text) {
    const el = $("status");
    el.className = "status " + kind;
    el.textContent = text;
  }
  function fail(error) {
    console.error(error);
    setStatus("err", (error && error.message) || String(error));
  }

  // WebAuthn assertion over a one-line Subly message: the challenge is
  // sha256(message), which is exactly what the relayer verifies against.
  async function passkeySign(message, credentialIdB64u) {
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge: await sha256Bytes(message),
        allowCredentials: credentialIdB64u
          ? [{ type: "public-key", id: b64uDecode(credentialIdB64u) }]
          : [],
        userVerification: "required",
        rpId: location.hostname
      }
    });
    return b64u(enc.encode(JSON.stringify({
      credentialId: b64u(assertion.rawId),
      authenticatorData: b64u(assertion.response.authenticatorData),
      clientDataJSON: b64u(assertion.response.clientDataJSON),
      signature: b64u(assertion.response.signature)
    })));
  }
  function phantomProvider() {
    const provider = (window.phantom && window.phantom.solana) || window.solana;
    if (!provider || !provider.signMessage) {
      throw new Error("No Solana wallet found. Open this page in a browser with Phantom (or use the passkey option).");
    }
    return provider;
  }
  async function phantomSign(message) {
    const provider = phantomProvider();
    await provider.connect();
    const { signature } = await provider.signMessage(enc.encode(message), "utf8");
    return {
      publicKey: provider.publicKey.toString(),
      signature: base58(signature instanceof Uint8Array ? signature : new Uint8Array(signature))
    };
  }
`;

function page(title: string, body: string, js: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'">
<title>${title}</title>
<style>${SHARED_STYLE}</style>
</head>
<body>
<div class="card">${body}</div>
<script>
${SHARED_JS}
${js}
</script>
</body>
</html>`;
}

/** /setup/:sessionId — owner appointment + mandate signing (confirm-only). */
export function setupPageHtml(): string {
  return page(
    "Subly — Approve agent spending mandate",
    `
    <span class="badge">Subly setup</span>
    <h1>Approve your agent's spending mandate</h1>
    <p class="sub">Review what your agent may spend, then confirm with Face ID
    or your Solana wallet. Values cannot be edited here — to change them, go
    back to the chat and ask for a new link.</p>
    <div id="details"></div>
    <button id="btn-passkey" class="primary" hidden>Approve with Face ID / passkey</button>
    <button id="btn-wallet" class="secondary" hidden>Sign with Solana wallet</button>
    <div id="status" class="status"></div>
    <p class="note" id="note" hidden>Your credential is created on THIS device
    and never leaves it. The agent cannot approve payments above the threshold,
    change these limits, or deposit funds without it.</p>
    `,
    `
    const sessionId = location.pathname.split("/").filter(Boolean).pop();
    let session = null;

    function render() {
      const p = session.policy;
      $("details").innerHTML =
        row("Agent wallet", short(session.wallet, 8, 8), true) +
        row("Auto-pay up to (per payment)", capUsdc(p.approvalThresholdRawUsdc)) +
        row("Absolute per-payment cap", usdc(p.perPaymentCapRawUsdc)) +
        row("Daily API spend cap", capUsdc(p.dailyApiSpendCapRawUsdc)) +
        row("Monthly API spend cap", capUsdc(p.monthlyApiSpendCapRawUsdc)) +
        row("Daily deposit cap", capUsdc(p.dailyDepositCapRawUsdc)) +
        (session.initialDepositRawUsdc
          ? row("First deposit (approved now)", usdc(session.initialDepositRawUsdc))
          : "") +
        row("Deposits", p.depositPolicy === "owner_approval_required"
          ? "always need your approval" : "agent may deposit within caps") +
        row("Allowed payees", p.allowedPayToAddresses === null
          ? "any seller (within the caps)"
          : p.allowedPayToAddresses.map((a) => short(a, 6, 6)).join(", ")) +
        row("Withdrawals", p.withdrawalPolicy === "agent_allowed"
          ? "agent may withdraw to its own wallet" : "always need your approval") +
        row("Mandate valid until",
          new Date(session.mandateExpiresAtMs).toLocaleDateString());
      // Replacing a live (or revoked) mandate is only possible for the SAME
      // owner credential — a fresh passkey can never satisfy that, and a
      // wallet only can when it IS the registered owner. Say so up front,
      // never after a Face ID that was doomed to be refused.
      const existing = session.existingMandate;
      const blocking = existing && existing.status !== "expired" &&
        existing.status !== "recovery_elapsed";
      if (blocking && existing.ownerAuth === "passkey") {
        setStatus("err",
          "This agent wallet already has a passkey owner (mandate " +
          existing.status + "). A new owner can only be appointed after the " +
          "mandate expires or via the agent's recovery flow.");
        return;
      }
      if (blocking) {
        setStatus("err",
          "This agent wallet already has a registered owner (mandate " +
          existing.status + "). Only that same owner wallet can re-sign — " +
          "use the Solana wallet option with the original owner wallet.");
      } else {
        $("btn-passkey").hidden = false;
      }
      $("btn-wallet").hidden = false;
      $("note").hidden = false;
    }

    function buildPayload(ownerAuth, ownerCredential) {
      const payload = {
        version: 1,
        ownerAuth,
        ownerCredential,
        enforcementMode: session.enforcementMode,
        agentWallet: session.wallet,
        vault: session.vault,
        issuedAtMs: Date.now(),
        expiresAtMs: session.mandateExpiresAtMs,
        policy: session.policy
      };
      if (session.initialDepositRawUsdc) {
        payload.initialDeposit = { amountRawUsdc: session.initialDepositRawUsdc };
      }
      return payload;
    }

    async function complete(payload, ownerSignature) {
      const result = await postJson(
        "/v1/setup-sessions/" + sessionId + "/complete",
        { document: Object.assign({}, payload, { ownerSignature }) }
      );
      $("btn-passkey").hidden = true;
      $("btn-wallet").hidden = true;
      setStatus("ok",
        "Done — the mandate is active" +
        (result.initialDepositApproval
          ? " and the first deposit is pre-approved (valid ~15 min)"
          : "") +
        ". You can return to the chat; your agent picks this up automatically.");
    }

    $("btn-passkey").addEventListener("click", async () => {
      try {
        $("btn-passkey").disabled = true;
        const created = await navigator.credentials.create({
          publicKey: {
            challenge: crypto.getRandomValues(new Uint8Array(32)),
            rp: { id: location.hostname, name: "Subly" },
            user: {
              id: crypto.getRandomValues(new Uint8Array(16)),
              name: "subly-owner-" + session.wallet.slice(0, 8),
              displayName: "Subly owner (" + short(session.wallet) + ")"
            },
            pubKeyCredParams: [
              { type: "public-key", alg: -7 },
              { type: "public-key", alg: -8 },
              { type: "public-key", alg: -257 }
            ],
            authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
            attestation: "none"
          }
        });
        const spki = typeof created.response.getPublicKey === "function"
          ? created.response.getPublicKey()
          : null;
        if (!spki) throw new Error("This browser cannot export the passkey public key; use the Solana wallet option.");
        const ownerCredential = {
          publicKey: b64u(spki),
          credentialId: b64u(created.rawId),
          algorithm: created.response.getPublicKeyAlgorithm()
        };
        const payload = buildPayload("passkey", ownerCredential);
        const message = "subly-mandate:v1:" + await sha256Hex(canonicalJson(payload));
        const ownerSignature = await passkeySign(message, ownerCredential.credentialId);
        await complete(payload, ownerSignature);
      } catch (error) { fail(error); }
      finally { $("btn-passkey").disabled = false; }
    });

    $("btn-wallet").addEventListener("click", async () => {
      try {
        $("btn-wallet").disabled = true;
        const provider = phantomProvider();
        await provider.connect();
        const ownerCredential = { publicKey: provider.publicKey.toString() };
        const payload = buildPayload("ed25519", ownerCredential);
        const message = "subly-mandate:v1:" + await sha256Hex(canonicalJson(payload));
        const { signature } = await provider.signMessage(enc.encode(message), "utf8");
        await complete(payload, base58(signature instanceof Uint8Array ? signature : new Uint8Array(signature)));
      } catch (error) { fail(error); }
      finally { $("btn-wallet").disabled = false; }
    });

    (async () => {
      try {
        session = await api("/v1/setup-sessions/" + sessionId);
        if (session.status === "completed") {
          setStatus("ok", "This setup was already completed. You can return to the chat.");
          return;
        }
        if (session.status === "expired") {
          setStatus("err", "This setup link has expired (links last 10 minutes). Ask your agent for a new one.");
          return;
        }
        render();
      } catch (error) { fail(error); }
    })();
    `
  );
}

/** /approve/:approvalId — one payment/deposit above the threshold. */
export function approvePageHtml(): string {
  return page(
    "Subly — Approve payment",
    `
    <span class="badge">Subly approval</span>
    <h1 id="title">Approve this operation?</h1>
    <p class="sub">Your agent needs your sign-off for this one operation.
    Approving does not change any limits.</p>
    <div id="details"></div>
    <button id="btn-approve" class="primary" hidden>Approve</button>
    <button id="btn-deny" class="secondary" hidden>Deny</button>
    <div id="status" class="status"></div>
    `,
    `
    const approvalId = location.pathname.split("/").filter(Boolean).pop();
    let view = null;

    function render() {
      const b = view.binding || {};
      let rows = "";
      if (b.kind === "payment") {
        $("title").textContent = "Approve this payment?";
        rows =
          row("Amount", usdc(b.amountRawUsdc)) +
          row("Pay to", short(b.payTo, 8, 8), true) +
          row("Method", b.method || "—") +
          row("Resource URL hash", short(b.resourceUrlHash, 10, 6), true);
      } else if (b.kind === "deposit") {
        $("title").textContent = "Approve this deposit?";
        rows = row("Deposit into vault", usdc(b.amountRawUsdc));
      } else if (b.kind === "withdrawal") {
        $("title").textContent = "Approve this withdrawal?";
        rows = row("Withdraw from vault (to the agent wallet)", usdc(b.amountRawUsdc));
      } else {
        rows = row("Amount", usdc(b.amountRawUsdc)) + row("Kind", b.kind || "—");
      }
      rows += row("Agent wallet", short(view.wallet, 8, 8), true) +
        row("Request expires", new Date(view.expiresAtMs).toLocaleTimeString());
      $("details").innerHTML = rows;
      $("btn-approve").hidden = false;
      $("btn-deny").hidden = false;
    }

    async function decide(decision) {
      try {
        $("btn-approve").disabled = true;
        $("btn-deny").disabled = true;
        const signedAtMs = Date.now();
        const message = "subly-approval:v1:" + approvalId + ":" + decision +
          ":" + view.bindingHash + ":" + signedAtMs;
        let signature;
        if (view.owner && view.owner.ownerAuth === "passkey") {
          signature = await passkeySign(message, view.owner.credentialId);
        } else {
          signature = (await phantomSign(message)).signature;
        }
        await postJson("/v1/approvals/" + approvalId + "/decision",
          { decision, signedAtMs, signature });
        $("btn-approve").hidden = true;
        $("btn-deny").hidden = true;
        setStatus("ok", decision === "approve"
          ? "Approved — your agent will retry the operation now. You can return to the chat."
          : "Denied — the operation will not run.");
      } catch (error) { fail(error); }
      finally {
        $("btn-approve").disabled = false;
        $("btn-deny").disabled = false;
      }
    }

    $("btn-approve").addEventListener("click", () => decide("approve"));
    $("btn-deny").addEventListener("click", () => decide("deny"));

    (async () => {
      try {
        view = await api("/v1/approvals/" + approvalId);
        if (view.status !== "pending") {
          setStatus(view.status === "approved" || view.status === "consumed" ? "ok" : "err",
            "This approval is already " + view.status + ".");
          return;
        }
        render();
      } catch (error) { fail(error); }
    })();
    `
  );
}

/** /revoke/:wallet — the kill switch. */
export function revokePageHtml(): string {
  return page(
    "Subly — Revoke mandate (kill switch)",
    `
    <span class="badge">Subly kill switch</span>
    <h1>Revoke your agent's spending mandate</h1>
    <p class="sub">This immediately blocks ALL payments, deposits and
    withdrawals by the agent wallet below. Only a new mandate signed by the
    same owner can re-enable them.</p>
    <div id="details"></div>
    <button id="btn-revoke" class="danger" hidden>Revoke now</button>
    <div id="status" class="status"></div>
    `,
    `
    const wallet = location.pathname.split("/").filter(Boolean).pop();
    let summary = null;

    (async () => {
      try {
        summary = await api("/v1/wallets/" + wallet + "/mandate/summary");
        $("details").innerHTML =
          row("Agent wallet", short(summary.wallet, 8, 8), true) +
          row("Mandate", short(summary.mandateHash, 10, 6), true) +
          row("Status", summary.status);
        if (summary.status === "revoked") {
          setStatus("ok", "This mandate is already revoked.");
          return;
        }
        $("btn-revoke").hidden = false;
      } catch (error) { fail(error); }
    })();

    $("btn-revoke").addEventListener("click", async () => {
      if (!confirm("Revoke the mandate and block all agent spending?")) return;
      try {
        $("btn-revoke").disabled = true;
        const signedAtMs = Date.now();
        const message = "subly-mandate-revoke:v1:" + summary.mandateHash + ":" + signedAtMs;
        let signature;
        if (summary.ownerAuth === "passkey") {
          signature = await passkeySign(message, summary.credentialId);
        } else {
          signature = (await phantomSign(message)).signature;
        }
        await postJson("/v1/wallets/" + wallet + "/mandate/revoke",
          { mandateHash: summary.mandateHash, signedAtMs, signature });
        $("btn-revoke").hidden = true;
        setStatus("ok", "Revoked. All agent payments, deposits and withdrawals are now blocked.");
      } catch (error) { fail(error); }
      finally { $("btn-revoke").disabled = false; }
    });
    `
  );
}
