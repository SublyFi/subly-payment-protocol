import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const stakePoolRequire = createRequire(require.resolve("@solana/spl-stake-pool"));
const legacyTokenRequire = createRequire(stakePoolRequire.resolve("@solana/spl-token"));
const anchorRequire = createRequire(require.resolve("@coral-xyz/anchor"));
const { Connection, PublicKey } = require("@solana/web3.js") as typeof import("@solana/web3.js");

type BigIntLayout = {
  encode(value: bigint, buffer: Uint8Array, offset?: number): number;
  decode(buffer: Uint8Array, offset?: number): bigint;
};
type LayoutUtils = Record<string, () => BigIntLayout>;

describe("pinned bigint-buffer replacement through Solana account layouts", () => {
  // Both versions remain in the Kamino SDK graph; exercise their actual resolver paths.
  for (const [version, load] of [["0.3", require], ["legacy 0.2", legacyTokenRequire]] as const) {
    const layouts = load("@solana/buffer-layout-utils") as LayoutUtils;
    for (const bits of [64, 128, 192, 256]) {
      for (const endian of ["LE", "BE"] as const) {
        it(`${version} encodes and decodes u${bits} ${endian} at nonzero offsets`, () => {
          const width = bits / 8;
          const goldenBE = Buffer.from(Array.from({ length: width }, (_, i) => i + 1));
          const cases = [
            { value: 0n, bytes: Buffer.alloc(width) },
            { value: 1n, bytes: Buffer.concat([Buffer.alloc(width - 1), Buffer.from([1])]) },
            { value: (1n << BigInt(bits)) - 1n, bytes: Buffer.alloc(width, 0xff) },
            { value: BigInt(`0x${goldenBE.toString("hex")}`), bytes: goldenBE }
          ];
          const layout = layouts[`u${bits}${endian === "BE" ? "be" : ""}`]!();
          for (const { value, bytes } of cases) {
            const expected = endian === "LE" ? Buffer.from(bytes).reverse() : bytes;
            const account = Buffer.concat([Buffer.from([0xa5, 0xa5]), expected, Buffer.from([0x5a])]);
            const original = Buffer.from(account);
            expect(layout.decode(account, 2)).toBe(value);
            expect(account).toEqual(original);
            const encoded = Buffer.alloc(width + 3, 0xee);
            expect(layout.encode(value, encoded, 2)).toBe(width);
            expect(encoded.subarray(2, width + 2)).toEqual(expected);
            expect(encoded.subarray(0, 2)).toEqual(Buffer.from([0xee, 0xee]));
            expect(encoded[width + 2]).toBe(0xee);
          }
        });
      }
    }

    it(`${version} resolves the pure JavaScript fork and rejects malformed buffers`, () => {
      const layoutRequire = createRequire(load.resolve("@solana/buffer-layout-utils"));
      expect(layoutRequire("bigint-buffer/package.json").name).toBe("@exodus/bigint-buffer");
      const converter = layoutRequire("bigint-buffer") as {
        toBigIntLE(input: unknown): bigint;
        toBigIntBE(input: unknown): bigint;
      };
      expect(converter.toBigIntLE(Buffer.alloc(0))).toBe(0n);
      expect(converter.toBigIntBE(Buffer.alloc(0))).toBe(0n);
      expect(() => converter.toBigIntLE(null)).toThrow(TypeError);
      expect(() => converter.toBigIntBE(null)).toThrow(TypeError);
    });
  }
});

describe("patched TOML parser on Anchor's resolver path", () => {
  const toml = anchorRequire("toml") as { parse(input: string): unknown };

  it("preserves the Anchor workspace configuration shape", () => {
    expect(toml.parse(`
[features]
seeds = false
skip-lint = false
[programs.localnet]
subly = "11111111111111111111111111111111"
[provider]
cluster = "localnet"
wallet = "~/.config/solana/id.json"
[scripts]
test = "npm test"
[workspace]
members = ["programs/subly"]
`)).toEqual({
      features: { seeds: false, "skip-lint": false },
      programs: { localnet: { subly: "11111111111111111111111111111111" } },
      provider: { cluster: "localnet", wallet: "~/.config/solana/id.json" },
      scripts: { test: "npm test" },
      workspace: { members: ["programs/subly"] }
    });
  });

  it("rejects excessive recursion with a parser error before exhausting the stack", () => {
    const deeplyNested = `value = ${"[".repeat(3000)}1${"]".repeat(3000)}`;
    expect(() => toml.parse(deeplyNested)).toThrow("Maximum nesting depth");
    try {
      toml.parse(deeplyNested);
    } catch (error) {
      expect(error).not.toBeInstanceOf(RangeError);
    }
  });

  it.each([
    '[a.b]\ny = 1\n[a.b.y.__proto__.__proto__]\nsublyPrototypePolluted = "yes"',
    'aa = 1\n[[a]]\n[aa.__proto__.__proto__]\nsublyPrototypePolluted = "yes"'
  ])("rejects scalar/table prototype traversal", (payload) => {
    const prototype = Object.prototype as Record<string, unknown>;
    try {
      expect(() => toml.parse(payload)).toThrow();
      expect(prototype.sublyPrototypePolluted).toBeUndefined();
    } finally {
      delete prototype.sublyPrototypePolluted;
    }
  });
});

describe("Jayson 5 through the legacy Web3 HTTP connection", () => {
  it("preserves generated IDs, JSON-RPC account reads and public batch calls", async () => {
    const requests: Array<{ id: string; method: string; params: unknown[] }> = [];
    const connection = new Connection("http://rpc.invalid", {
      commitment: "confirmed",
      fetch: async (_url, options) => {
        const parsed = JSON.parse(String(options?.body));
        const batch = Array.isArray(parsed);
        const entries = batch ? parsed : [parsed];
        requests.push(...entries);
        const responses = entries.map((request: { id: string; method: string }) => ({
          jsonrpc: "2.0",
          id: request.id,
          result: request.method === "getBalance" ? { context: { slot: 123 }, value: 42 } : null
        }));
        return new Response(JSON.stringify(batch ? responses : responses[0]), { status: 200 });
      }
    });
    expect(await connection.getBalance(new PublicKey("11111111111111111111111111111111"))).toBe(42);
    expect(await connection.getParsedTransactions(["fixture-signature-1", "fixture-signature-2"])).toEqual([null, null]);
    expect(requests.map((request) => request.method)).toEqual(["getBalance", "getTransaction", "getTransaction"]);
    expect(requests[0]?.params).toEqual(["11111111111111111111111111111111", { commitment: "confirmed" }]);
    expect(new Set(requests.map((request) => request.id)).size).toBe(3);
    for (const request of requests) expect(request.id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("propagates RPC errors and malformed response failures", async () => {
    for (const response of [
      { jsonrpc: "2.0", error: { code: -32000, message: "fixture RPC unavailable" } },
      "{invalid-json"
    ]) {
      const connection = new Connection("http://rpc.invalid", {
        fetch: async (_url, options) => {
          const { id } = JSON.parse(String(options?.body));
          return new Response(typeof response === "string" ? response : JSON.stringify({ ...response, id }), { status: 200 });
        }
      });
      await expect(connection.getBalance(new PublicKey("11111111111111111111111111111111"))).rejects.toThrow();
    }
  });
});
