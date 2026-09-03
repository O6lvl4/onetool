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
  return { calls, onetool: new OneTool({ providers: [provider], title: "the pet store", layout: "generic" }) };
}

type Elicitation = (message: string, schema: unknown) => { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> };

async function connect(onetool: OneTool, elicitation?: Elicitation) {
  const server = createOneToolServer(onetool);
  const client = new Client({ name: "test-client", version: "0.0.0" }, elicitation ? { capabilities: { elicitation: {} } } : {});
  const prompts: string[] = [];
  if (elicitation) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      prompts.push(request.params.message);
      return elicitation(request.params.message, "requestedSchema" in request.params ? request.params.requestedSchema : undefined);
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
    expect(tools[2]?.outputSchema).toMatchObject({ type: "object", required: expect.arrayContaining(["inputSchema", "verdict"]) });
    expect(tools[3]?.outputSchema).toBeUndefined();
  });

  it("returns structured content that the client validates against the declared output schema", async () => {
    const { onetool } = fixture();
    const { client } = await connect(onetool);
    await client.listTools(); // caches output schemas so callTool validates structuredContent
    const services = await client.callTool({ name: "api_services", arguments: {} });
    expect(services.structuredContent).toEqual({ result: [{ name: "petstore", summary: "2 operations" }] });
    const described = await client.callTool({ name: "api_describe", arguments: { operation: "listPets" } });
    expect(described.structuredContent).toMatchObject({ name: "listPets", verdict: "allow", inputSchema: { type: "object" } });
    const called = await client.callTool({ name: "api_call", arguments: { operation: "listPets" } });
    expect(called.structuredContent).toEqual({ result: [{ id: 1 }] });
    expect(JSON.parse(text(called))).toEqual([{ id: 1 }]);
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

  it("offers the scalar input fields for editing and runs with the corrected value", async () => {
    const { onetool, calls } = fixture();
    let schema: unknown;
    const { client } = await connect(onetool, (_message, requested) => {
      schema = requested;
      return { action: "accept", content: { approve: true, name: "Tim" } };
    });
    const created = await client.callTool({ name: "api_call", arguments: { operation: "createPet", input: { name: "Tom" } } });
    expect(JSON.parse(text(created))).toEqual({ id: 2, name: "Tim" });
    expect(schema).toMatchObject({ properties: { approve: { type: "boolean", default: true }, name: { type: "string", default: "Tom" } }, required: ["approve"] });
    expect(calls).toEqual(["createPet"]);
  });

  it("serves the flat layout for a small catalog when the layout is auto", async () => {
    const auto = new OneTool({
      providers: [new FunctionProvider("petstore", [{ name: "listPets", handler: () => [{ id: 1 }] }, { name: "createPet", handler: () => ({ id: 2 }) }])],
    });
    const { client } = await connect(auto);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["petstore__listPets", "petstore__createPet"]);
    expect(tools[0]?.annotations).toMatchObject({ readOnlyHint: true });
    expect(tools[1]?.annotations).toMatchObject({ destructiveHint: true });
    const listed = await client.callTool({ name: "petstore__listPets", arguments: {} });
    expect(JSON.parse(text(listed))).toEqual([{ id: 1 }]);
    const refused = await client.callTool({ name: "petstore__createPet", arguments: {} });
    expect(refused.isError).toBe(true);
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
