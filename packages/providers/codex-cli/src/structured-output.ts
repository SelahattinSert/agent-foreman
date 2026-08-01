import {z} from 'zod';

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const allowsNull = (schema: unknown): boolean => {
  if (!isRecord(schema)) return false;
  if (schema.type === 'null') return true;
  if (Array.isArray(schema.type) && schema.type.includes('null')) return true;
  return Array.isArray(schema.anyOf) && schema.anyOf.some((entry) => allowsNull(entry));
};

const nullable = (schema: unknown): unknown =>
  allowsNull(schema) ? schema : {anyOf: [schema, {type: 'null'}]};

const strictifyObjects = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(strictifyObjects);
  if (!isRecord(value)) return value;
  const transformed = Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, strictifyObjects(entry)]),
  );
  if (value.type !== 'object' || !isRecord(value.properties)) return transformed;
  const originallyRequired = new Set(
    Array.isArray(value.required)
      ? value.required.filter((entry): entry is string => typeof entry === 'string')
      : [],
  );
  const properties = Object.fromEntries(
    Object.entries(value.properties).map(([key, property]) => {
      const strictProperty = strictifyObjects(property);
      return [key, originallyRequired.has(key) ? strictProperty : nullable(strictProperty)];
    }),
  );
  return {...transformed, properties, required: Object.keys(properties)};
};

const decodeOptionalNulls = (value: unknown, schema: unknown): unknown => {
  if (Array.isArray(value)) {
    const itemSchema = isRecord(schema) ? schema.items : undefined;
    return value.map((entry) => decodeOptionalNulls(entry, itemSchema));
  }
  if (!isRecord(value) || !isRecord(schema)) return value;
  if (schema.type !== 'object' || !isRecord(schema.properties)) return value;
  const properties = schema.properties;
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((entry): entry is string => typeof entry === 'string')
      : [],
  );
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, entry]) => entry !== null || required.has(key))
      .map(([key, entry]) => [key, decodeOptionalNulls(entry, properties[key])]),
  );
};

export const createCodexOutputSchema = (schema: z.ZodType): unknown =>
  strictifyObjects(z.toJSONSchema(schema));

export const decodeCodexOutput = (value: unknown, schema: z.ZodType): unknown =>
  decodeOptionalNulls(value, z.toJSONSchema(schema));
