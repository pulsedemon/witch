import assert from 'node:assert/strict';

import { Ajv } from 'ajv';

import type { ValidateFunction } from 'ajv';

interface Schema {
  $schema?: string;
  $ref?: string;
  properties?: Record<string, Schema | boolean>;
  patternProperties?: Record<string, Schema | boolean>;
  additionalProperties?: Schema | boolean;
  oneOf?: Schema[];
  anyOf?: Schema[];
  allOf?: Schema[];
  items?: Schema | boolean;
  enum?: unknown[];
  [key: string]: unknown;
}

export class CodexSchema {
  private readonly ajv = new Ajv({
    strict: false,
    validateFormats: false,
    allErrors: true,
  });
  private readonly validators = new Map<Schema | boolean, ValidateFunction>();
  private readonly bundle: Schema;

  constructor(bundle: unknown) {
    this.bundle = bundle as Schema;
  }

  methods(): Set<string> {
    return new Set(
      ['ClientRequest', 'ClientNotification'].flatMap((name) =>
        this.reference(`#/definitions/${name}`).oneOf!.flatMap(
          (entry) => (entry.properties!.method as Schema).enum as string[],
        ),
      ),
    );
  }

  private reference(ref: string): Schema {
    assert.ok(ref.startsWith('#/'), `Unsupported schema reference: ${ref}`);

    return ref
      .slice(2)
      .split('/')
      .reduce<unknown>(
        (value, key) =>
          (value as Record<string, unknown>)[
            key.replaceAll('~1', '/').replaceAll('~0', '~')
          ],
        this.bundle,
      ) as Schema;
  }

  private validator(schema: Schema | boolean): ValidateFunction {
    let validate = this.validators.get(schema);

    if (!validate) {
      validate = this.ajv.compile(
        typeof schema === 'boolean'
          ? schema
          : {
              $schema: this.bundle.$schema,
              definitions: this.bundle.definitions,
              ...schema,
            },
      );

      this.validators.set(schema, validate);
    }

    return validate;
  }

  private variants(schema: Schema | boolean, value: unknown): Schema[] {
    if (schema === true) return [{ additionalProperties: true }];

    if (schema === false) return [];

    const parts = [schema];

    if (schema.$ref)
      parts.push(...this.variants(this.reference(schema.$ref), value));

    for (const child of [...(schema.oneOf ?? []), ...(schema.anyOf ?? [])])
      if (this.validator(child)(value))
        parts.push(...this.variants(child, value));

    for (const child of schema.allOf ?? [])
      parts.push(...this.variants(child, value));

    return parts;
  }

  private knownFields(
    schema: Schema | boolean,
    value: unknown,
    path: string,
  ): void {
    if (value === null || typeof value !== 'object') return;

    const parts = this.variants(schema, value);

    if (Array.isArray(value)) {
      for (const part of parts)
        if (part.items !== undefined)
          value.forEach((item, index) =>
            this.knownFields(part.items!, item, `${path}/${index}`),
          );

      return;
    }

    const objects = parts.filter(
      (part) =>
        part.properties ||
        part.patternProperties ||
        part.additionalProperties !== undefined,
    );

    if (!objects.length) return;

    for (const [key, child] of Object.entries(value)) {
      const declared = objects.flatMap((part) => [
        ...(part.properties?.[key] === undefined
          ? []
          : [part.properties[key]!]),
        ...Object.entries(part.patternProperties ?? {})
          .filter(([pattern]) => new RegExp(pattern).test(key))
          .map(([, item]) => item),
      ]);

      const allowed = declared.length
        ? declared
        : objects.flatMap((part) =>
            part.additionalProperties === undefined ||
            part.additionalProperties === false
              ? []
              : [part.additionalProperties],
          );

      assert.ok(allowed.length, `Unknown native field ${path}/${key}`);

      for (const item of allowed)
        this.knownFields(item, child, `${path}/${key}`);
    }
  }

  private method(definition: string, method: string): Schema {
    const schema = this.reference(`#/definitions/${definition}`);

    const branch = schema.oneOf?.find((entry) => {
      const field = entry.properties?.method;

      return typeof field === 'object' && field.enum?.includes(method);
    });

    assert.ok(branch, `Unknown native method ${method} (${definition})`);

    return branch;
  }

  private check(schema: Schema, value: unknown, label: string): void {
    const validate = this.validator(schema);

    assert.ok(
      validate(value),
      `${label}: ${this.ajv.errorsText(validate.errors, { dataVar: label })}`,
    );

    this.knownFields(schema, value, label);
  }

  client(message: unknown): void {
    const frame = message as { id?: unknown; method: string };

    this.check(
      this.method(
        frame.id === undefined ? 'ClientNotification' : 'ClientRequest',
        frame.method,
      ),
      message,
      frame.method,
    );
  }

  response(method: string, result: unknown): void {
    const params = this.method('ServerRequest', method).properties!
      .params as Schema;

    assert.ok(params.$ref && params.$ref.endsWith('Params'));

    this.check(
      this.reference(params.$ref.replace(/Params$/, 'Response')),
      result,
      method,
    );
  }
}
