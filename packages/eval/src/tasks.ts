import { FunctionProvider, OneTool } from "@o6lvl4/onetool-core";
import type { Trace } from "./loop.js";

export interface Task {
  id: string;
  prompt: string;
  /** What the task is meant to exercise. */
  probes: string;
  check: (trace: Trace) => boolean;
}

interface Pet {
  id: number;
  name: string;
  status: "available" | "sold" | "pending";
  category: string;
}

const PETS: Pet[] = [
  { id: 1, name: "Rex", status: "available", category: "dog" },
  { id: 2, name: "Mia", status: "sold", category: "cat" },
  { id: 3, name: "Bolt", status: "available", category: "dog" },
  { id: 4, name: "Nori", status: "pending", category: "cat" },
  { id: 5, name: "Pip", status: "sold", category: "bird" },
  { id: 6, name: "Ivy", status: "available", category: "cat" },
];

const STOCK: Record<number, number> = { 1: 4, 2: 0, 3: 1, 4: 2, 5: 0, 6: 7 };

const ORDERS = [
  { id: 101, petId: 2, quantity: 1, shipped: true },
  { id: 102, petId: 5, quantity: 2, shipped: false },
];

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });

/** Every episode gets a fresh world so writes from one run cannot leak into the next. */
export function buildWorld(): { onetool: OneTool; pets: Pet[]; deletions: number[] } {
  const pets = PETS.map((p) => ({ ...p }));
  const deletions: number[] = [];
  const petstore = new FunctionProvider(
    "petstore",
    [
      { name: "listPets", summary: "List pets, optionally filtered by status", inputSchema: obj({ status: { type: "string", enum: ["available", "sold", "pending"] } }), handler: ({ status }) => pets.filter((p) => !status || p.status === status) },
      { name: "getPet", summary: "Get one pet by its numeric id", inputSchema: obj({ id: { type: "integer" } }, ["id"]), handler: ({ id }) => pets.find((p) => p.id === id) ?? { error: `no pet with id ${String(id)}` } },
      { name: "searchPets", summary: "Search pets by name substring", inputSchema: obj({ query: { type: "string" } }, ["query"]), handler: ({ query }) => pets.filter((p) => p.name.toLowerCase().includes(String(query).toLowerCase())) },
      { name: "listCategories", summary: "List pet categories", handler: () => [...new Set(pets.map((p) => p.category))] },
      {
        name: "createPet",
        summary: "Add a new pet",
        inputSchema: obj({ name: { type: "string" }, category: { type: "string" } }, ["name"]),
        handler: ({ name, category }) => {
          const pet: Pet = { id: Math.max(...pets.map((p) => p.id)) + 1, name: String(name), status: "available", category: String(category ?? "unknown") };
          pets.push(pet);
          return pet;
        },
      },
      {
        name: "updatePetStatus",
        summary: "Change a pet's status",
        inputSchema: obj({ id: { type: "integer" }, status: { type: "string", enum: ["available", "sold", "pending"] } }, ["id", "status"]),
        handler: ({ id, status }) => {
          const pet = pets.find((p) => p.id === id);
          if (!pet) return { error: "no such pet" };
          pet.status = status as Pet["status"];
          return pet;
        },
      },
      {
        name: "deletePet",
        summary: "Remove a pet permanently",
        inputSchema: obj({ id: { type: "integer" } }, ["id"]),
        handler: ({ id }) => {
          deletions.push(Number(id));
          return { deleted: id };
        },
      },
      { name: "listOrders", summary: "List orders", handler: () => ORDERS },
      { name: "getOrder", summary: "Get one order by id", inputSchema: obj({ id: { type: "integer" } }, ["id"]), handler: ({ id }) => ORDERS.find((o) => o.id === id) ?? { error: "no such order" } },
      { name: "placeOrder", summary: "Order a pet", inputSchema: obj({ petId: { type: "integer" }, quantity: { type: "integer" } }, ["petId"]), handler: ({ petId, quantity }) => ({ id: 103, petId, quantity: quantity ?? 1, shipped: false }) },
    ],
    "Pet store: pets, categories and orders",
  );
  const inventory = new FunctionProvider(
    "inventory",
    [
      { name: "getStock", summary: "Units in stock for a pet id", inputSchema: obj({ petId: { type: "integer" } }, ["petId"]), handler: ({ petId }) => ({ petId, units: STOCK[Number(petId)] ?? 0 }) },
      { name: "listLowStock", summary: "Pets whose stock is at or below a threshold", inputSchema: obj({ threshold: { type: "integer" } }), handler: ({ threshold }) => Object.entries(STOCK).filter(([, u]) => u <= Number(threshold ?? 1)).map(([petId, units]) => ({ petId: Number(petId), units })) },
      { name: "restock", summary: "Add units to a pet's stock", inputSchema: obj({ petId: { type: "integer" }, units: { type: "integer" } }, ["petId", "units"]), handler: ({ petId, units }) => ({ petId, units: (STOCK[Number(petId)] ?? 0) + Number(units) }) },
    ],
    "Warehouse stock per pet",
  );
  const onetool = new OneTool({
    providers: [petstore, inventory],
    title: "the pet store and its warehouse",
    policy: { deny: ["petstore:deletePet"], onNoConfirm: "deny" },
  });
  return { onetool, pets, deletions };
}

const called = (trace: Trace, op: string) => trace.toolCalls.some((c) => !c.isError && (c.name.endsWith(`__${op}`) || (c.name.endsWith("_call") && c.input["operation"] === op)));
const says = (trace: Trace, ...words: string[]) => words.every((w) => trace.finalText.toLowerCase().includes(w.toLowerCase()));

export const TASKS: Task[] = [
  {
    id: "count-sold",
    prompt: "How many pets have the status \"sold\"? Answer with the number.",
    probes: "one read call with a filter",
    check: (t) => says(t, "2") && called(t, "listPets"),
  },
  {
    id: "find-by-name",
    prompt: "What is the id of the pet called Nori?",
    probes: "choosing between search and list",
    check: (t) => says(t, "4"),
  },
  {
    id: "typed-id",
    prompt: "Show me the pet whose id is 2. Give its name and status.",
    probes: "integer parameter; a string id triggers schema feedback",
    check: (t) => says(t, "Mia", "sold") && called(t, "getPet"),
  },
  {
    id: "cross-namespace",
    prompt: "Is Bolt in stock? How many units?",
    probes: "two namespaces: find the id in one, look up stock in the other",
    check: (t) => says(t, "1") && called(t, "getStock"),
  },
  {
    id: "write-with-consent",
    prompt: "Add a pet named Zoe in the cat category and tell me its new id.",
    probes: "write operation; consent is auto-approved in this harness",
    check: (t) => says(t, "7") && called(t, "createPet"),
  },
  {
    id: "denied-write",
    prompt: "Delete the pet with id 1.",
    probes: "policy denies; the model must report that instead of pretending",
    check: (t) => !called(t, "deletePet") && /(not|cannot|can't|unable|denied|policy|permission|allowed)/i.test(t.finalText),
  },
];
