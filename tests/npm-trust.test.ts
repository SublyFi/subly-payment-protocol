import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../scripts/verify-npm-trust.mjs", import.meta.url));
const workflow = "SublyFi/subly-payment-protocol/.github/workflows/release-pay.yml@refs/heads/main";

function run(scenario: string, env: Record<string, string> = {}) {
  const mock = `
    import assert from 'node:assert/strict';
    let calls = 0;
    globalThis.fetch = async (url, options) => {
      calls++;
      assert.equal(options.redirect, 'error');
      if (calls === 1) {
        assert.equal(new URL(url).searchParams.get('audience'), 'npm:registry.npmjs.org');
        assert.equal(options.headers.Authorization, 'Bearer test-request-secret');
        if (${JSON.stringify(scenario)} === 'network') throw new Error('test-request-secret');
        return Response.json({ value: 'test-identity-secret' });
      }
      assert.equal(calls, 2, 'Only identity and token exchange requests are allowed');
      assert.equal(String(url), 'https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/%40subly_fi%2Fpay');
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.Authorization, 'Bearer test-identity-secret');
      if (${JSON.stringify(scenario)} === 'rejected') return Response.json({ error: 'test-identity-secret' }, {status: 403});
      if (${JSON.stringify(scenario)} === 'invalid-json') return new Response('test-publish-secret');
      return Response.json({
        token_type: 'oidc', token: 'test-publish-secret',
        expires: new Date(Date.now() + (${JSON.stringify(scenario)} === 'expired' ? -60_000 : 60_000)).toISOString()
      });
    };
    process.on('exit', () => {
      if (${JSON.stringify(scenario)} === 'success') assert.equal(calls, 2);
      if (${JSON.stringify(scenario)} === 'wrong-workflow') assert.equal(calls, 0);
    });
  `;
  return spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(mock)}`, script], {
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_WORKFLOW_REF: workflow,
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example.test/token?api-version=2.0",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "test-request-secret",
      ...env
    }
  });
}

describe("npm trust verification", () => {
  it("exchanges a package-scoped token without publishing or exposing credentials", () => {
    const result = run("success");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PASS: npm accepted");
    expect(result.stdout).toContain("No package was published");
    expect(result.stdout + result.stderr).not.toContain("secret");
  });

  it.each(["rejected", "expired", "invalid-json", "network"])("fails safely on %s", (scenario) => {
    const result = run(scenario);
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("PASS");
    expect(result.stdout + result.stderr).not.toContain("secret");
  });

  it("rejects other workflow refs before requesting any token", () => {
    const result = run("wrong-workflow", {
      GITHUB_WORKFLOW_REF: workflow.replace("refs/heads/main", "refs/heads/other")
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("workflow manually on main");
  });
});
