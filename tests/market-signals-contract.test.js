import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));

test('OpenAPI 1.1 documents conditional GET and its example satisfies the public schema', () => {
  const openapi = readJson('../public/openapi.json');
  const schema = readJson('../public/schemas/market-signals-v1.schema.json');
  delete schema.$schema;
  const operation = openapi.paths['/api/v1/market-signals'].get;
  assert.equal(openapi.info.version, '1.1.0');
  assert.ok(operation.parameters.some((parameter) => parameter.in === 'header' && parameter.name === 'If-None-Match'));
  assert.ok(operation.responses['304']);
  assert.equal(openapi.paths['/api/v1/market-signals'].head, undefined);

  const validate = new Ajv({ allErrors: true, schemaId: 'auto' }).compile(schema);
  const example = operation.responses['200'].content['application/json'].examples.requestShape.value;
  assert.equal(validate(example), true, JSON.stringify(validate.errors, null, 2));
});
