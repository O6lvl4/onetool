import type { JsonSchema, Kind } from "@o6lvl4/onetool-core";

/** The parts of an OpenAPI 3.x document this provider reads. Anything else is ignored. */
export interface OpenApiDocument {
  openapi?: string;
  info?: { title?: string; description?: string; version?: string };
  servers?: { url: string }[];
  paths?: Record<string, PathItem>;
  components?: {
    schemas?: Record<string, JsonSchema>;
    parameters?: Record<string, Parameter>;
    requestBodies?: Record<string, RequestBody>;
    responses?: Record<string, ResponseObject>;
  };
}

export type Method = "get" | "put" | "post" | "delete" | "patch" | "head" | "options";
export const METHODS: readonly Method[] = ["get", "put", "post", "delete", "patch", "head", "options"];

export interface PathItem extends Partial<Record<Method, Operation>> {
  parameters?: (Parameter | Ref)[];
}

export interface Operation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  deprecated?: boolean;
  parameters?: (Parameter | Ref)[];
  requestBody?: RequestBody | Ref;
  responses?: Record<string, ResponseObject | Ref>;
  "x-onetool-kind"?: Kind;
}

export interface ResponseObject {
  description?: string;
  content?: Record<string, { schema?: JsonSchema }>;
}

export type ParameterLocation = "path" | "query" | "header" | "cookie";

export interface Parameter {
  name: string;
  in: ParameterLocation;
  description?: string;
  required?: boolean;
  schema?: JsonSchema;
}

export interface RequestBody {
  description?: string;
  required?: boolean;
  content?: Record<string, { schema?: JsonSchema }>;
}

export interface Ref {
  $ref: string;
}
