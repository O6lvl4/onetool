import { describe, expect, it } from "vitest";
import { classify, kindFromName, words } from "../src/index.js";

describe("kindFromName", () => {
  it("matches read verbs on the first word only", () => {
    expect(kindFromName("listPets")).toBe("read");
    expect(kindFromName("DescribeAddresses")).toBe("read");
    expect(kindFromName("get_send_quota")).toBe("read");
    expect(kindFromName("batchGetItem")).toBe("read");
  });

  it("does not fall for substrings the way a contains-check would", () => {
    expect(kindFromName("addTags")).toBe("write");
    expect(kindFromName("tagResource")).toBe("write");
    expect(kindFromName("authorizeIngress")).toBe("write");
    expect(kindFromName("importCertificate")).toBe("write");
  });

  it("splits identifiers into words", () => {
    expect(words("batchGetItem")).toEqual(["batch", "get", "item"]);
    expect(words("DescribeDBInstances")).toEqual(["describe", "db", "instances"]);
    expect(words("list_pets")).toEqual(["list", "pets"]);
  });

  it("prefers a provider-declared kind", () => {
    expect(classify({ name: "listPets", kind: "write" })).toBe("write");
    expect(classify({ name: "resetEverything" })).toBe("write");
  });
});
