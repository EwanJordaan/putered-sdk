import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { ValidateFunction } from "ajv/dist/2020.js";
import { z } from "zod";
import { PuteredError } from "./errors.js";

export function toolValidator() {
  const ajv = new Ajv2020({ strictSchema: true, strictTypes: false, strictTuples: false, addUsedSchema: false });
  addFormats.default(ajv);
  for (const [format, schema] of Object.entries({
    jwt: z.jwt(), nanoid: z.nanoid(), cuid: z.cuid(), cuid2: z.cuid2(), ulid: z.ulid(),
    base64: z.base64(), base64url: z.base64url(), e164: z.e164(), emoji: z.emoji(), guid: z.guid(),
    cidrv4: z.cidrv4(), cidrv6: z.cidrv6(),
  })) ajv.addFormat(format, { type: "string", validate: (value: string) => schema.safeParse(value).success });
  for (const [keyword, compare] of [
    ["x-putered-minUtf16Length", (length: number, limit: number) => length >= limit],
    ["x-putered-maxUtf16Length", (length: number, limit: number) => length <= limit],
  ] as const) ajv.addKeyword({ keyword, type: "string", schemaType: "number",
    validate: (limit: number, value: string) => compare(value.length, limit) });
  ajv.addKeyword({ keyword: "x-putered-pattern", type: "string", schemaType: "string",
    compile: (pattern: string) => {
      const regex = new RegExp(pattern);
      return (value: string) => regex.test(value);
    } });
  return ajv;
}

export function compileToolSchema(ajv: ReturnType<typeof toolValidator>, schema: Record<string, unknown>): ValidateFunction {
  let validate: ValidateFunction;
  try { validate = ajv.compile(schema); }
  catch (error) { throw new PuteredError("Unsupported or invalid tool JSON schema.", "PACKAGE_INVALID", { cause: error }); }
  if (Object.hasOwn(validate, "$async"))
    throw new PuteredError("Async JSON Schema validators are not supported.", "PACKAGE_INVALID");
  return validate;
}
