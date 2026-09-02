import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InputValidationError, OneTool, OperationError } from "@o6lvl4/onetool-core";
import { OpenApiProvider, type OpenApiDocument } from "../src/index.js";

let server: Server;
let baseUrl: string;
const seen: { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: string }[] = [];

type Route = (url: URL, body: string) => { status: number; type?: string; body: string };
const routes: Record<string, Route> = {
  "GET /v1/pets": (url) => ({
    status: 200,
    type: "application/json",
    body: JSON.stringify([{ id: 1, name: "Rex", limit: url.searchParams.get("limit"), tags: url.searchParams.getAll("tag") }]),
  }),
  "POST /v1/pets": (_url, raw) => {
    const parsed = JSON.parse(raw) as { name?: string };
    if (!parsed.name) return { status: 400, type: "application/json", body: JSON.stringify({ message: "name is required" }) };
    return { status: 201, type: "application/json", body: JSON.stringify({ id: 2, name: parsed.name }) };
  },
  "DELETE /v1/pets/7": () => ({ status: 204, body: "" }),
  "GET /v1/pets/404": () => ({ status: 404, type: "text/plain", body: "no such pet" }),
};

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: raw });
      const url = new URL(req.url ?? "/", "http://x");
      const route = routes[`${req.method} ${url.pathname}`];
      const out = route ? route(url, raw) : { status: 500, body: "unexpected" };
      res.statusCode = out.status;
      if (out.type) res.setHeader("content-type", out.type);
      res.end(out.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  baseUrl = typeof address === "object" && address ? `http://127.0.0.1:${address.port}/v1` : "";
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function provider(): Promise<OpenApiProvider> {
  const document = JSON.parse(await readFile(new URL("./fixtures/petstore.json", import.meta.url), "utf8")) as OpenApiDocument;
  return new OpenApiProvider({ document, baseUrl, headers: { authorization: "Bearer t" } });
}

describe("OpenApiProvider catalog", () => {
  it("derives the namespace, skips deprecated operations and names the rest", async () => {
    const p = await provider();
    expect(await p.namespaces()).toEqual([{ name: "pet-store", summary: "A tiny pet store." }]);
    const names = (await p.operations("pet-store")).map((o) => o.name).sort();
    expect(names).toEqual(["createPet", "deletePet", "getPet", "get_health", "listPets", "searchPets"]);
  });

  it("resolves a relative servers[].url against the document URL, and refuses to guess", async () => {
    const document = { info: { title: "Rel" }, servers: [{ url: "/api/v3" }], paths: {} } as OpenApiDocument;
    const p = new OpenApiProvider({ document, documentUrl: "https://petstore.example/spec/openapi.json" });
    expect((p as unknown as { baseUrl: string }).baseUrl).toBe("https://petstore.example/api/v3");
    expect(() => new OpenApiProvider({ document })).toThrow(/relative/);
    expect(() => new OpenApiProvider({ document: { paths: {} } })).toThrow(/declares no servers/);
  });

  it("classifies by HTTP method unless x-onetool-kind says otherwise", async () => {
    const ops = await (await provider()).operations("pet-store");
    const kind = (name: string) => ops.find((o) => o.name === name)?.kind;
    expect(kind("listPets")).toBe("read");
    expect(kind("createPet")).toBe("write");
    expect(kind("searchPets")).toBe("read");
  });

  it("flattens parameters and the body into one schema, inlining $ref and cutting cycles", async () => {
    const p = await provider();
    const list = await p.operation({ namespace: "pet-store", name: "listPets" });
    expect(list?.inputSchema).toMatchObject({
      type: "object",
      properties: { limit: { type: "integer", description: "(query) How many" }, tag: { type: "array" }, "X-Trace": { type: "string" } },
      additionalProperties: false,
    });
    const create = await p.operation({ namespace: "pet-store", name: "createPet" });
    expect(create?.inputSchema["required"]).toEqual(["body"]);
    const body = (create?.inputSchema["properties"] as Record<string, Record<string, unknown>>)["body"];
    expect(body).toMatchObject({ type: "object", required: ["name"] });
    const parent = (body?.["properties"] as Record<string, Record<string, unknown>>)["parent"];
    const grand = (parent?.["properties"] as Record<string, Record<string, unknown>>)["parent"];
    expect(grand?.["description"]).toMatch(/recursive/);
    const get = await p.operation({ namespace: "pet-store", name: "getPet" });
    expect(get?.inputSchema["required"]).toEqual(["petId"]);
    expect(get?.description).toBe("GET /pets/{petId} — Get a pet");
  });

  it("derives the output schema from the first successful JSON response, as the { status, body } envelope", async () => {
    const p = await provider();
    const list = await p.operation({ namespace: "pet-store", name: "listPets" });
    expect(list?.outputSchema).toMatchObject({
      type: "object",
      required: ["status", "body"],
      properties: { status: { type: "integer" }, body: { type: "array", description: "Pets", items: { type: "object", properties: { id: { type: "integer" } } } } },
    });
    const del = await p.operation({ namespace: "pet-store", name: "deletePet" });
    expect(del?.outputSchema).toMatchObject({ properties: { body: { description: "Deleted" } } });
    expect((del?.outputSchema?.["properties"] as Record<string, Record<string, unknown>>)["body"]?.["type"]).toBeUndefined();
  });
});

describe("OpenApiProvider execution", () => {
  const ref = (name: string) => ({ namespace: "pet-store", name });
  const ctx = { meta: {} };

  it("sends query and header parameters and returns status and body", async () => {
    const p = await provider();
    const result = await p.execute(ref("listPets"), { limit: 5, tag: ["a", "b"], "X-Trace": "t1" }, ctx);
    expect(result).toEqual({ status: 200, body: [{ id: 1, name: "Rex", limit: "5", tags: ["a", "b"] }] });
    const last = seen.at(-1);
    expect(last?.url).toBe("/v1/pets?limit=5&tag=a&tag=b");
    expect(last?.headers["x-trace"]).toBe("t1");
    expect(last?.headers["authorization"]).toBe("Bearer t");
  });

  it("posts a JSON body and maps 400 to InputValidationError", async () => {
    const p = await provider();
    expect(await p.execute(ref("createPet"), { body: { name: "Tom" } }, ctx)).toEqual({ status: 201, body: { id: 2, name: "Tom" } });
    expect(seen.at(-1)?.headers["content-type"]).toBe("application/json");
    await expect(p.execute(ref("createPet"), { body: {} }, ctx)).rejects.toBeInstanceOf(InputValidationError);
  });

  it("substitutes path parameters, handles empty bodies and surfaces other failures", async () => {
    const p = await provider();
    expect(await p.execute(ref("deletePet"), { petId: 7 }, ctx)).toEqual({ status: 204, body: null });
    await expect(p.execute(ref("getPet"), { petId: 404 }, ctx)).rejects.toMatchObject({ name: "OperationError", details: "no such pet" });
    await expect(p.execute(ref("getPet"), { petId: 404 }, ctx)).rejects.toBeInstanceOf(OperationError);
  });

  it("works end to end through OneTool with schema feedback from the remote side", async () => {
    const tool = new OneTool({ providers: [await provider()] });
    const listed = await tool.call({ operation: "list_pets", input: { limit: 1 } });
    expect(listed).toMatchObject({ ok: true, kind: "read" });
    const approve = { confirm: async () => "approved" as const };
    const localInvalid = await tool.call({ operation: "createPet", input: { body: {} } }, approve);
    expect(localInvalid).toMatchObject({ ok: false, stage: "validate", error: 'input.body: missing required property "name"' });
    const remoteInvalid = await tool.call({ operation: "createPet", input: { body: { name: "" } } }, approve);
    expect(remoteInvalid).toMatchObject({ ok: false, stage: "validate" });
    expect(remoteInvalid.ok === false && remoteInvalid.error).toContain("HTTP 400");
    expect(remoteInvalid.ok === false && remoteInvalid.schema).toMatchObject({ required: ["body"] });
  });
});
