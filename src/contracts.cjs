const Ajv = require('ajv/dist/2020');
const addFormats = require('ajv-formats');

const ajv = new Ajv({ strict: true, allErrors: true });
addFormats(ajv);
const contracts = {
  requirements: ajv.compile(require('../schemas/requirements.schema.json')),
  itinerary: ajv.compile(require('../schemas/itinerary.schema.json')),
  context: ajv.compile(require('../schemas/validation-context.schema.json'))
};

function validateContract(name, value) {
  if (!Object.hasOwn(contracts, name)) throw new TypeError(`Unknown contract: ${name}`);
  const validate = contracts[name];
  const valid = validate(value);
  return { valid, errors: valid ? [] : structuredClone(validate.errors) };
}

function assertContract(name, value) {
  const result = validateContract(name, value);
  if (!result.valid) {
    const error = new TypeError(`Invalid ${name} contract: ${ajv.errorsText(result.errors)}`);
    error.errors = result.errors;
    throw error;
  }
}

module.exports = { validateContract, assertContract };
