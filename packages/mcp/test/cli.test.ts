import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const root = fileURLToPath(new URL("../../..", import.meta.url));
const text = (result: { content: unknown }): string => (result.content as { text: string }[])[0]?.text ?? "";

async function spawn(args: string[]): Promise<Client> {
  const client = new Client({ name: "cli-test", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, ...args], cwd: root, stderr: "pipe" }));
  return client;
}

describe.skipIf(!existsSync(cli))("onetool-mcp CLI (needs `pnpm run build`)", () => {
  it("serves a config module over stdio and applies its policy", async () => {
    const client = await spawn(["examples/petstore/onetool.config.mjs"]);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(["petstore_services", "petstore_operations", "petstore_describe", "petstore_call"]);
      const pets = await client.callTool({ name: "petstore_call", arguments: { operation: "list_pets", input: { status: "sold" } } });
      expect(JSON.parse(text(pets))).toEqual([{ id: 2, name: "Mia", status: "sold" }]);
      const denied = await client.callTool({ name: "petstore_call", arguments: { operation: "deletePet", input: { id: 1 } } });
      expect(denied.isError).toBe(true);
      expect(JSON.parse(text(denied))).toMatchObject({ stage: "policy" });
      const closed = await client.callTool({ name: "petstore_call", arguments: { operation: "createPet", input: { name: "Zoe" } } });
      expect(JSON.parse(text(closed))).toMatchObject({ stage: "confirm" });
    } finally {
      await client.close();
    }
  });

  it("fronts an OpenAPI document without code", async () => {
    const client = await spawn(["--openapi", "packages/provider-openapi/test/fixtures/petstore.json", "--base-url", "http://127.0.0.1:9/v1", "--prefix", "shop", "--strict"]);
    try {
      const ops = await client.callTool({ name: "shop_operations", arguments: {} });
      const listed = JSON.parse(text(ops)) as { name: string; verdict: string }[];
      expect(listed.map((o) => o.name)).toContain("listPets");
      expect(new Set(listed.map((o) => o.verdict))).toEqual(new Set(["deny"]));
      const described = await client.callTool({ name: "shop_describe", arguments: { operation: "createPet" } });
      expect(JSON.parse(text(described))).toMatchObject({ kind: "write", inputSchema: { required: ["body"] } });
    } finally {
      await client.close();
    }
  });
});
