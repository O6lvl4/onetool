import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { FunctionProvider, OneTool } from "@o6lvl4/onetool-core";
import { createOneToolServer } from "../src/index.js";

function fixture() {
  const calls: string[] = [];
  const provider = new FunctionProvider("petstore", [
    {
      name: "listPets",
      summary: "List pets",
      handler: () => {
        calls.push("listPets");
        return [{ id: 1 }];
      },
    },
    {
      name: "createPet",
      summary: "Create a pet",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      handler: ({ name }) => {
        calls.push("createPet");
        return { id: 2, name };
      },
    },
  ]);
  return { calls, onetool: new OneTool({ providers: [provider], title: "the pet store" }) };
}

async function connect(onetool: OneTool, elicitation?: (message: string) => { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> }) {
  const server = createOneToolServer(onetool);
  const client = new Client({ name: "test-client", version: "0.0.0" }, elicitation ? { capabilities: { elicitation: {} } } : {});
  const prompts: string[] = [];
  if (elicitation) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      prompts.push(request.params.message);
      return elicitation(request.params.message);
    });
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, prompts };
}

const text = (result: { content: unknown }): string => (result.content as { text: string }[])[0]?.text ?? "";

describe("onetool MCP server", () => {
  it("lists four annotated tools with JSON Schema inputs", async () => {
    const { onetool } = fixture();
    const { client } = await connect(onetool);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["api_services", "api_operations", "api_describe", "api_call"]);
    expect(tools[3]?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
    expect(tools[2]?.inputSchema).toMatchObject({ type: "object", required: ["operation"] });
  });

  it("runs reads directly and returns describe output", async () => {
    const { onetool, calls } = fixture();
    const { client } = await connect(onetool);
    const listed = await client.callTool({ name: "api_call", arguments: { operation: "list_pets" } });
    expect(JSON.parse(text(listed))).toEqual([{ id: 1 }]);
    const described = await client.callTool({ name: "api_describe", arguments: { operation: "createPet" } });
    expect(JSON.parse(text(described))).toMatchObject({ name: "createPet", verdict: "confirm", inputSchema: { required: ["name"] } });
    expect(calls).toEqual(["listPets"]);
  });

  it("asks through elicitation before a write and obeys the answer", async () => {
    const { onetool, calls } = fixture();
    const { client, prompts } = await connect(onetool, () => ({ action: "accept", content: { approve: true } }));
    const created = await client.callTool({ name: "api_call", arguments: { operation: "createPet", input: { name: "Tom" } } });
    expect(created.isError).toBeFalsy();
    expect(JSON.parse(text(created))).toEqual({ id: 2, name: "Tom" });
    expect(prompts[0]).toContain("petstore:createPet");
    expect(calls).toEqual(["createPet"]);

    const declined = await connect(fixture().onetool, () => ({ action: "decline" }));
    const refused = await declined.client.callTool({ name: "api_call", arguments: { operation: "createPet", input: { name: "Tom" } } });
    expect(refused.isError).toBe(true);
    expect(JSON.parse(text(refused))).toMatchObject({ stage: "confirm" });
  });

  it("fails closed when the client cannot elicit", async () => {
    const { onetool, calls } = fixture();
    const { client } = await connect(onetool);
    const result = await client.callTool({ name: "api_call", arguments: { operation: "createPet", input: { name: "Tom" } } });
    expect(result.isError).toBe(true);
    expect(JSON.parse(text(result))).toMatchObject({ stage: "confirm" });
    expect(calls).toEqual([]);
  });
});
