import { describe, expect, it, vi } from "vitest";
import { FunctionProvider, InputValidationError, OneTool, OperationError, type ConfirmFn } from "../src/index.js";

function petstore(calls: string[] = []) {
  return new FunctionProvider(
    "petstore",
    [
      { name: "listPets", summary: "List pets", handler: () => {
          calls.push("listPets");
          return [{ id: 1, name: "Rex" }];
        } },
      {
        name: "getPet",
        summary: "Get one pet",
        inputSchema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"], additionalProperties: false },
        handler: ({ id }) => {
          calls.push("getPet");
          return { id, name: "Rex", apiKey: "should-not-leak" };
        },
      },
      {
        name: "createPet",
        summary: "Create a pet",
        inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
        handler: ({ name }) => {
          calls.push("createPet");
          return { id: 2, name };
        },
      },
      { name: "deletePet", summary: "Delete a pet", handler: () => {
          calls.push("deletePet");
          return null;
        } },
      { name: "rejectPet", summary: "Remote validation", handler: () => { throw new InputValidationError(["name must not be empty"]); } },
      { name: "failPet", summary: "Remote failure", handler: () => { throw new OperationError("HTTP 500", { detail: "boom" }); } },
      { name: "hugePet", summary: "Large result", handler: () => ({ blob: "x".repeat(5000) }) },
    ],
    "A tiny pet store",
  );
}

const approve: ConfirmFn = async () => "approved";
const decline: ConfirmFn = async () => "declined";

describe("OneTool catalog", () => {
  it("lists namespaces and operations with kind and verdict", async () => {
    const tool = new OneTool({ providers: [petstore()] });
    expect(await tool.services()).toEqual([{ name: "petstore", summary: "A tiny pet store" }]);
    const ops = await tool.operations(undefined, "pet");
    expect(ops.find((o) => o.name === "listPets")).toMatchObject({ kind: "read", verdict: "allow" });
    expect(ops.find((o) => o.name === "createPet")).toMatchObject({ kind: "write", verdict: "confirm" });
  });

  it("resolves snake_case and describes with the policy decision", async () => {
    const tool = new OneTool({ providers: [petstore()], policy: { deny: ["petstore:deletePet"] } });
    const d = await tool.describe("pet_store", "create_pet");
    expect(d.spec.name).toBe("createPet");
    expect(d.verdict).toBe("confirm");
    expect((await tool.describe(undefined, "delete_pet")).verdict).toBe("deny");
  });

  it("requires the namespace when several exist and suggests candidates", async () => {
    const tool = new OneTool({ providers: [petstore(), new FunctionProvider("vault", [{ name: "getSecret", handler: () => ({}) }])] });
    const result = await tool.call({ operation: "listPets" });
    expect(result).toMatchObject({ ok: false, stage: "resolve" });
    const unknown = await tool.call({ namespace: "petstore", operation: "listPet" });
    expect(unknown).toMatchObject({ ok: false, stage: "resolve", candidates: ["listPets"] });
  });
});

describe("OneTool.call", () => {
  it("runs reads directly and redacts the result", async () => {
    const calls: string[] = [];
    const tool = new OneTool({ providers: [petstore(calls)] });
    const result = await tool.call({ operation: "getPet", input: { id: 1 } });
    expect(result).toMatchObject({ ok: true, kind: "read", verdict: "allow", content: { json: { id: 1, name: "Rex", apiKey: "**REDACTED**" } } });
    expect(calls).toEqual(["getPet"]);
  });

  it("returns the schema on invalid input without executing", async () => {
    const calls: string[] = [];
    const tool = new OneTool({ providers: [petstore(calls)] });
    const result = await tool.call({ operation: "getPet", input: { id: "1", extra: true } });
    expect(result).toMatchObject({ ok: false, stage: "validate" });
    expect(result.ok === false && result.schema).toMatchObject({ required: ["id"] });
    expect(result.ok === false && result.error).toContain("expected integer");
    expect(calls).toEqual([]);
  });

  it("asks for confirmation on writes and honours the answer", async () => {
    const calls: string[] = [];
    const tool = new OneTool({ providers: [petstore(calls)] });
    const confirm = vi.fn(approve);
    const yes = await tool.call({ operation: "createPet", input: { name: "Tom" } }, { confirm });
    expect(yes).toMatchObject({ ok: true, verdict: "confirm", content: { json: { id: 2, name: "Tom" } } });
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ ref: { namespace: "petstore", name: "createPet" }, kind: "write", input: { name: "Tom" } }));
    const no = await tool.call({ operation: "deletePet" }, { confirm: decline });
    expect(no).toMatchObject({ ok: false, stage: "confirm" });
    expect(calls).toEqual(["createPet"]);
  });

  it("fails closed when nobody can confirm, unless onNoConfirm is allow", async () => {
    const calls: string[] = [];
    const closed = new OneTool({ providers: [petstore(calls)] });
    expect(await closed.call({ operation: "deletePet" })).toMatchObject({ ok: false, stage: "confirm" });
    const open = new OneTool({ providers: [petstore(calls)], policy: { onNoConfirm: "allow" } });
    expect(await open.call({ operation: "deletePet" })).toMatchObject({ ok: true });
    expect(calls).toEqual(["deletePet"]);
  });

  it("denies by pattern and in strict mode", async () => {
    const calls: string[] = [];
    const denied = new OneTool({ providers: [petstore(calls)], policy: { deny: ["*:delete*"] } });
    expect(await denied.call({ operation: "deletePet" }, { confirm: approve })).toMatchObject({ ok: false, stage: "policy" });
    const strict = new OneTool({ providers: [petstore(calls)], policy: { mode: "strict", allow: ["petstore:listPets"] } });
    expect(await strict.call({ operation: "listPets" })).toMatchObject({ ok: true });
    expect(await strict.call({ operation: "getPet", input: { id: 1 } })).toMatchObject({ ok: false, stage: "policy" });
    expect(calls).toEqual(["listPets"]);
  });

  it("treats sensitive patterns as confirm even for reads", async () => {
    const tool = new OneTool({ providers: [petstore()], policy: { sensitive: ["petstore:getPet"] } });
    expect(await tool.call({ operation: "getPet", input: { id: 1 } })).toMatchObject({ ok: false, stage: "confirm", kind: "sensitive" });
  });

  it("maps provider errors to stages", async () => {
    const tool = new OneTool({ providers: [petstore()], policy: { onNoConfirm: "allow" } });
    const invalid = await tool.call({ operation: "rejectPet" });
    expect(invalid).toMatchObject({ ok: false, stage: "validate", error: "name must not be empty" });
    expect(invalid.ok === false && invalid.schema).toBeDefined();
    expect(await tool.call({ operation: "failPet" })).toMatchObject({ ok: false, stage: "execute", error: "HTTP 500", details: { json: { detail: "boom" } } });
  });

  it("truncates oversized results and emits events", async () => {
    const events: string[] = [];
    const tool = new OneTool({ providers: [petstore()], policy: { onNoConfirm: "allow" }, response: { resultLimit: 200 }, onEvent: (e) => events.push(`${e.ref.name}:${e.verdict}:${e.result.ok}`) });
    const result = await tool.call({ operation: "hugePet" });
    expect(result).toMatchObject({ ok: true, truncated: true });
    expect(events).toEqual(["hugePet:confirm:true"]);
  });
});

describe("OneTool inline catalog", () => {
  it("appends a bounded operation index to the call tool by default, and not when disabled", async () => {
    const plain = new OneTool({ providers: [petstore()], layout: "generic", inlineCatalog: false });
    expect((await plain.tools()).specs[3]?.description).not.toContain("Operations (");
    const inline = new OneTool({ providers: [petstore()], layout: "generic" });
    const call = (await inline.tools()).specs[3]?.description ?? "";
    expect(call).toContain("petstore: listPets — List pets; getPet — Get one pet;");
    expect(call).toContain("Call directly when you know the operation");
    expect((await inline.tools()).specs[2]?.description).not.toContain("Operations (");
    const tiny = new OneTool({ providers: [petstore()], inlineCatalog: { maxChars: 10 } });
    expect(await tiny.catalogText(10)).toBe("(7 more operations; use api_operations to list them)");
  });
});

describe("OneTool layouts", () => {
  it("chooses flat for small catalogs and generic above the threshold", async () => {
    const auto = new OneTool({ providers: [petstore()] });
    const flat = await auto.tools();
    expect(flat.layout).toBe("flat");
    expect(flat.specs.map((t) => t.name)).toEqual(["petstore__listPets", "petstore__getPet", "petstore__createPet", "petstore__deletePet", "petstore__rejectPet", "petstore__failPet", "petstore__hugePet"]);
    expect(flat.specs[1]).toMatchObject({ description: "Get one pet", inputSchema: { required: ["id"] }, annotations: { readOnly: true, destructive: false } });
    expect(flat.specs[2]?.annotations).toMatchObject({ readOnly: false, destructive: true });
    const generic = await new OneTool({ providers: [petstore()], autoThreshold: 3 }).tools();
    expect(generic.layout).toBe("generic");
    expect(generic.specs.map((t) => t.name)).toEqual(["api_services", "api_operations", "api_describe", "api_call"]);
  });

  it("routes flat tool names through the same policy and consent", async () => {
    const calls: string[] = [];
    const tool = new OneTool({ providers: [petstore(calls)], layout: "flat" });
    expect(await tool.handleTool("petstore__getPet", { id: 1 })).toMatchObject({ isError: false, content: { json: { name: "Rex" } } });
    expect(await tool.handleTool("petstore__createPet", { name: "Tom" })).toMatchObject({ isError: true, content: { json: { stage: "confirm" } } });
    expect(await tool.handleTool("petstore__createPet", { name: "Tom" }, { confirm: approve })).toMatchObject({ isError: false });
    expect(await tool.handleTool("petstore__getPet", { id: "x" })).toMatchObject({ isError: true, content: { json: { stage: "validate" } } });
    expect(await tool.handleTool("api_services", {})).toMatchObject({ isError: false });
    expect(calls).toEqual(["getPet", "createPet"]);
  });
});

describe("OneTool consent with edited input", () => {
  it("runs with the edited input when it validates, and rejects it otherwise", async () => {
    const calls: string[] = [];
    const tool = new OneTool({ providers: [petstore(calls)] });
    const edited = await tool.call({ operation: "createPet", input: { name: "Tom" } }, { confirm: async (req) => ({ approved: true, input: { ...req.input, name: "Tim" } }) });
    expect(edited).toMatchObject({ ok: true, content: { json: { id: 2, name: "Tim" } } });
    const bad = await tool.call({ operation: "createPet", input: { name: "Tom" } }, { confirm: async () => ({ approved: true, input: { name: 3 } }) });
    expect(bad).toMatchObject({ ok: false, stage: "validate" });
    expect(bad.ok === false && bad.error).toContain("edited input rejected");
    expect(calls).toEqual(["createPet"]);
  });

  it("hands the consent port the input schema", async () => {
    const tool = new OneTool({ providers: [petstore()] });
    let seen: unknown;
    await tool.call(
      { operation: "createPet", input: { name: "Tom" } },
      {
        confirm: async (req) => {
          seen = req.inputSchema;
          return "declined";
        },
      },
    );
    expect(seen).toMatchObject({ required: ["name"] });
  });
});

describe("OneTool tool surface", () => {
  it("names tools by prefix and routes handleTool", async () => {
    const tool = new OneTool({ providers: [petstore()], prefix: "shop", layout: "generic" });
    expect(tool.toolSpecs().map((t) => t.name)).toEqual(["shop_services", "shop_operations", "shop_describe", "shop_call"]);
    expect(tool.toolSpecs()[3]?.annotations).toEqual({ readOnly: false, destructive: true, idempotent: false, openWorld: true });
    expect(tool.toolSpecs().map((t) => t.outputSchema !== undefined)).toEqual([true, true, true, false]);
    expect(await tool.handleTool("shop_services", {})).toMatchObject({ isError: false, content: { json: [{ name: "petstore" }] } });
    expect(await tool.handleTool("shop_describe", { operation: "getPet" })).toMatchObject({ isError: false, content: { json: { name: "getPet", kind: "read", verdict: "allow" } } });
    expect(await tool.handleTool("shop_call", { operation: "listPets" })).toMatchObject({ isError: false, content: { json: [{ id: 1, name: "Rex" }] } });
    expect(await tool.handleTool("shop_call", { operation: "deletePet" }, { confirm: decline })).toMatchObject({ isError: true, content: { json: { stage: "confirm" } } });
    expect(await tool.handleTool("shop_call", { operation: "nope" })).toMatchObject({ isError: true, content: { json: { stage: "resolve" } } });
    expect(await tool.handleTool("other", {})).toMatchObject({ isError: true });
  });
});
