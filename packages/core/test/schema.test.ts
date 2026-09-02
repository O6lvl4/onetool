import { describe, expect, it } from "vitest";
import { cleanText, validate } from "../src/index.js";

describe("validate", () => {
  const schema = {
    type: "object",
    properties: {
      name: { type: "string" },
      count: { type: "integer" },
      status: { type: "string", enum: ["open", "closed"] },
      tags: { type: "array", items: { type: "string" } },
      nested: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
    },
    required: ["name"],
    additionalProperties: false,
  };

  it("accepts a valid value", () => {
    expect(validate(schema, { name: "a", count: 1, status: "open", tags: ["x"], nested: { id: 1 } })).toEqual([]);
  });

  it("reports missing required, wrong types, unknown keys, enum and nested problems", () => {
    const problems = validate(schema, { count: 1.5, status: "weird", tags: [1], nested: {}, extra: true });
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('missing required property "name"'),
        expect.stringContaining("input.count: expected integer"),
        expect.stringContaining("input.status: must be one of"),
        expect.stringContaining("input.tags[0]: expected string"),
        expect.stringContaining('input.nested: missing required property "id"'),
        expect.stringContaining('unknown property "extra"'),
      ]),
    );
  });

  it("tolerates unknown keys unless additionalProperties is false", () => {
    expect(validate({ type: "object", properties: {} }, { anything: 1 })).toEqual([]);
  });

  it("returns nothing for an absent schema", () => {
    expect(validate(undefined, 42)).toEqual([]);
  });
});

describe("cleanText", () => {
  it("strips html, entities and whitespace, and caps length", () => {
    expect(cleanText("<p>Hello &amp;   <b>world</b></p>")).toBe("Hello & world");
    expect(cleanText("x".repeat(50), 10)).toHaveLength(10);
  });
});
