import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { OneTool, OperationError } from "@o6lvl4/onetool-core";
import { z } from "zod";
import { McpProvider } from "../src/index.js";

/** An upstream with a read tool, a write tool and a failing tool, connected in memory. */
async function upstream(): Promise<{ client: Client; notes: string[] }> {
  const notes: string[] = [];
  const server = new McpServer({ name: "notes-server", version: "1.2.3" }, { instructions: "Keeps short notes." });
  server.registerTool(
    "list_notes",
    { description: "List saved notes", inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => ({ content: [{ type: "text", text: JSON.stringify(notes) }] }),
  );
  server.registerTool(
    "add_note",
    { description: "Save a note", inputSchema: { text: z.string() }, outputSchema: { count: z.number() } },
    async ({ text }) => {
      notes.push(text);
      return { content: [{ type: "text", text: `${notes.length}` }], structuredContent: { count: notes.length } };
    },
  );
  server.registerTool("explode", { description: "Always fails", inputSchema: {} }, async () => ({ content: [{ type: "text", text: "kaboom" }], isError: true }));
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  return { client, notes };
}

describe("McpProvider", () => {
  it("exposes each upstream as a namespace and its tools as operations with kinds from annotations", async () => {
    const { client } = await upstream();
    const provider = new McpProvider([{ name: "notes", client }]);
    expect(await provider.namespaces()).toEqual([{ name: "notes", summary: "Keeps short notes." }]);
    const ops = await provider.operations("notes");
    expect(ops.map((o) => `${o.name}:${o.kind}`).sort()).toEqual(["add_note:write", "explode:write", "list_notes:read"]);
    const add = await provider.operation({ namespace: "notes", name: "add_note" });
    expect(add?.inputSchema).toMatchObject({ type: "object", properties: { text: { type: "string" } }, required: ["text"] });
    expect(add?.outputSchema).toMatchObject({ properties: { count: { type: "number" } } });
    expect(await provider.operation({ namespace: "notes", name: "nope" })).toBeUndefined();
    expect(await provider.operations("other")).toEqual([]);
  });

  it("executes tools, preferring structured content, parsing JSON text, and surfacing isError", async () => {
    const { client, notes } = await upstream();
    const provider = new McpProvider([{ name: "notes", client }]);
    const ctx = { meta: {} };
    expect(await provider.execute({ namespace: "notes", name: "add_note" }, { text: "hi" }, ctx)).toEqual({ count: 1 });
    expect(notes).toEqual(["hi"]);
    expect(await provider.execute({ namespace: "notes", name: "list_notes" }, {}, ctx)).toEqual(["hi"]);
    await expect(provider.execute({ namespace: "notes", name: "explode" }, {}, ctx)).rejects.toBeInstanceOf(OperationError);
    await expect(provider.execute({ namespace: "notes", name: "explode" }, {}, ctx)).rejects.toMatchObject({ message: "kaboom" });
  });

  it("puts the upstream behind onetool's policy: reads run, writes need consent", async () => {
    const { client, notes } = await upstream();
    const onetool = new OneTool({ providers: [new McpProvider([{ name: "notes", client }])] });
    expect(await onetool.call({ operation: "list_notes" })).toMatchObject({ ok: true, kind: "read", content: { json: [] } });
    expect(await onetool.call({ operation: "add_note", input: { text: "x" } })).toMatchObject({ ok: false, stage: "confirm" });
    expect(await onetool.call({ operation: "add_note", input: { text: "x" } }, { confirm: async () => "approved" })).toMatchObject({ ok: true, content: { json: { count: 1 } } });
    expect(await onetool.call({ operation: "add_note", input: { text: 1 } }, { confirm: async () => "approved" })).toMatchObject({ ok: false, stage: "validate" });
    expect(notes).toEqual(["x"]);
  });

  it("rejects duplicate upstream names and unknown namespaces", async () => {
    const { client } = await upstream();
    expect(() => new McpProvider([{ name: "a", client }, { name: "a", client }])).toThrow(/twice/);
    const provider = new McpProvider([{ name: "a", client }]);
    await expect(provider.execute({ namespace: "b", name: "x" }, {}, { meta: {} })).rejects.toThrow(/unknown upstream/);
  });
});
