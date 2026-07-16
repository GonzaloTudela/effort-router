import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';

const defaultSchemaDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'schemas'
);

export class ContractValidationError extends Error {
  constructor(contractName, errors) {
    super(`Invalid ${contractName}: ${JSON.stringify(errors)}`);
    this.name = 'ContractValidationError';
    this.contractName = contractName;
    this.validationErrors = errors;
  }
}

export async function createContractValidator(schemaDirectory = defaultSchemaDirectory) {
  const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
  const schemaNames = (await readdir(schemaDirectory))
    .filter((name) => name.endsWith('.schema.json'))
    .sort();
  for (const schemaName of schemaNames) {
    ajv.addSchema(JSON.parse(await readFile(path.join(schemaDirectory, schemaName), 'utf8')));
  }
  return {
    validate(contractName, value) {
      const schemaId = `https://effort-router.local/schemas/${contractName}.schema.json`;
      const validator = ajv.getSchema(schemaId);
      if (!validator) {
        throw new Error(`Unknown contract schema: ${contractName}`);
      }
      if (!validator(value)) {
        throw new ContractValidationError(contractName, structuredClone(validator.errors));
      }
      return value;
    }
  };
}