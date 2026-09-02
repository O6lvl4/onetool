// onetool-mcp examples/petstore/onetool.config.mjs
// An in-memory pet store fronted by four MCP tools. No network, no credentials.
import { FunctionProvider } from "@o6lvl4/onetool-core";

const pets = new Map([
  [1, { id: 1, name: "Rex", status: "available" }],
  [2, { id: 2, name: "Mia", status: "sold" }],
]);

const petstore = new FunctionProvider(
  "petstore",
  [
    {
      name: "listPets",
      summary: "List pets, optionally filtered by status",
      inputSchema: { type: "object", properties: { status: { type: "string", enum: ["available", "sold"] } }, additionalProperties: false },
      handler: ({ status }) => [...pets.values()].filter((p) => !status || p.status === status),
    },
    {
      name: "getPet",
      summary: "Get one pet by id",
      inputSchema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"], additionalProperties: false },
      handler: ({ id }) => pets.get(id) ?? { error: `no pet ${id}` },
    },
    {
      name: "createPet",
      summary: "Add a pet (asks for confirmation)",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
      handler: ({ name }) => {
        const id = Math.max(...pets.keys()) + 1;
        pets.set(id, { id, name, status: "available" });
        return pets.get(id);
      },
    },
    {
      name: "deletePet",
      summary: "Remove a pet (denied by policy below)",
      inputSchema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"], additionalProperties: false },
      handler: ({ id }) => ({ deleted: pets.delete(id) }),
    },
  ],
  "In-memory pet store",
);

export default {
  providers: [petstore],
  title: "the demo pet store",
  prefix: "petstore",
  policy: { deny: ["petstore:delete*"] },
};
