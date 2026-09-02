import { describe, expect, it } from "vitest";
import { materialize, redact, shrink } from "../src/index.js";

describe("redact", () => {
  it("replaces known secret keys at any depth, case-insensitively", () => {
    const out = redact({ Password: "p", list: [{ apiKey: "k", NextToken: "keep" }], nested: { SecretString: "s", name: "n" } });
    expect(out).toEqual({
      Password: "**REDACTED**",
      list: [{ apiKey: "**REDACTED**", NextToken: "keep" }],
      nested: { SecretString: "**REDACTED**", name: "n" },
    });
  });
});

describe("shrink", () => {
  it("keeps small results as json and truncates large ones with a hint", () => {
    expect(shrink({ a: 1 }, 100)).toEqual({ content: { json: { a: 1 } }, truncated: false });
    const big = shrink({ items: "x".repeat(500) }, 100);
    expect(big.truncated).toBe(true);
    expect("text" in big.content && big.content.text).toContain("[truncated: ");
    expect("text" in big.content && big.content.text.length).toBeLessThan(250);
  });

  it("serializes bigint, Map and Set", () => {
    expect(shrink({ n: 10n, m: new Map([["k", 1]]), s: new Set([1]) }, 1000).content).toEqual({ json: { n: 10n, m: new Map([["k", 1]]), s: new Set([1]) } });
  });
});

describe("materialize", () => {
  it("decodes byte arrays and async iterables within the limit", async () => {
    const bytes = new TextEncoder().encode("hello");
    async function* stream(): AsyncIterable<Uint8Array> {
      yield new TextEncoder().encode("ab");
      yield new TextEncoder().encode("cd");
    }
    expect(await materialize({ body: bytes, other: 1 }, 100)).toEqual({ body: "hello", other: 1 });
    expect(await materialize(stream(), 100)).toBe("abcd");
  });

  it("omits payloads over the limit and flags binary", async () => {
    expect(await materialize(new Uint8Array(200), 100)).toMatch(/^<200 bytes; omitted/);
    expect(await materialize(new Uint8Array([0xff, 0xfe]), 100)).toMatch(/^<binary/);
  });
});
