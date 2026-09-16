// Exercise the same GitHub workflow -> npm OIDC exchange as a release, without
// uploading a package. Tokens stay in this process and are never logged/saved.
// API: https://api-docs.npmjs.com/ (OIDC token exchange)
const packageName = "@subly_fi/pay";
const workflow = "SublyFi/subly-payment-protocol/.github/workflows/release-pay.yml@refs/heads/main";

async function requestJson(url, options, label) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      redirect: "error",
      signal: AbortSignal.timeout(30_000)
    });
  } catch {
    // Fetch errors can include URLs/headers. Never print credential-bearing data.
    throw new Error(`${label}: network request failed`);
  }
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error(`${label}: invalid JSON response`);
  }
}

async function main() {
  if (process.env.GITHUB_ACTIONS !== "true" ||
      process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
      process.env.GITHUB_WORKFLOW_REF !== workflow) {
    throw new Error("Run the Release @subly_fi/pay workflow manually on main");
  }
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) throw new Error("GitHub id-token: write permission is required");
  let url;
  try { url = new URL(requestUrl); } catch { throw new Error("Invalid GitHub OIDC endpoint"); }
  if (url.protocol !== "https:") throw new Error("GitHub OIDC endpoint must use HTTPS");
  url.searchParams.set("audience", "npm:registry.npmjs.org");
  const identity = await requestJson(url, {
    headers: { Authorization: `Bearer ${requestToken}` }
  }, "GitHub OIDC");
  if (typeof identity?.value !== "string" || !identity.value) {
    throw new Error("GitHub OIDC response contains no identity token");
  }
  const exchange = await requestJson(
    `https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/${encodeURIComponent(packageName)}`,
    { method: "POST", headers: { Authorization: `Bearer ${identity.value}` } },
    "npm trusted publisher exchange"
  );
  if (exchange?.token_type !== "oidc" || typeof exchange.token !== "string" || !exchange.token ||
      !Number.isFinite(Date.parse(exchange.expires)) || Date.parse(exchange.expires) <= Date.now()) {
    throw new Error("npm did not return a valid, unexpired OIDC publishing token");
  }
  console.log(`PASS: npm accepted ${workflow} for ${packageName}.`);
  console.log("Package-scoped OIDC token issued and discarded. No package was published.");
  console.log("This verifies authentication; upload and provenance remain release-time checks.");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
