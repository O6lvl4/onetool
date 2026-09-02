import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InputValidationError, OneTool, OperationError } from "@o6lvl4/onetool-core";
import { OpenApiProvider, type OpenApiDocument } from "../src/index.js";

let server: Server;
let baseUrl: string;
const seen: { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: string }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      const url = new URL(req.url ?? "/", "http://x");
      if (req.method === "GET" && url.pathname === "/v1/pets") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify([{ id: 1, name: "Rex", limit: url.searchParams.get("limit"), tags: url.searchParams.getAll("tag") }]));
      } else if (req.method === "POST" && url.pathname === "/v1/pets") {
        const parsed = JSON.parse(body) as { name?: string };
        if (!parsed.name) {
          res.statusCode = 400;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ message: "name is required" }));
        } else {
          res.statusCode = 201;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ id: 2, name: parsed.name }));
        }
      } else if (req.method === "DELETE" && url.pathname === "/v1/pets/7") {
        res.statusCode = 204;
        res.end();
      } else if (req.method === "GET" && url.pathname === "/v1/pets/404") {
        res.statusCode = 404;
        res.setHeader("content-type", "text/plain");
        res.end("no such pet");
      } else {
        res.statusCode = 500;
        res.end("unexpected");
      }
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
