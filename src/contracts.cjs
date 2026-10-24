const Ajv = require('ajv/dist/2020');
const addFormats = require('ajv-formats');

const ajv = new Ajv({ strict: true, allErrors: true });
addFormats(ajv);
const requirementsSchema = require('../schemas/requirements.schema.json');
const systemFields = ['inquiry_id', 'channel', 'raw_text', 'received_at'];
const derivedFields = ['missing_required', 'status'];
const extractionSchema = structuredClone(requirementsSchema);
delete extractionSchema.$id;
delete extractionSchema.allOf;
extractionSchema.title = 'Curatour extracted trip fields (system metadata excluded)';
for (const field of [...systemFields, ...derivedFields]) delete extractionSchema.properties[field];
extractionSchema.required = extractionSchema.required.filter(field => Object.hasOwn(extractionSchema.properties, field));
const systemSchema = {
  type: 'object',
  additionalProperties: false,
  required: systemFields,
  properties: Object.fromEntries(systemFields.map(field => [field, requirementsSchema.properties[field]])),
  $defs: requirementsSchema.$defs
};
const extractionInputSchema = structuredClone(extractionSchema);
extractionInputSchema.properties.dates.allOf[1].properties.value.properties.month_hint = {
  type: ['string', 'null']
};
const requirementsInputSchema = structuredClone(requirementsSchema);
delete requirementsInputSchema.$id;
requirementsInputSchema.properties.dates = extractionInputSchema.properties.dates;
const contracts = {
  requirements: ajv.compile(requirementsSchema),
  extraction: ajv.compile(extractionSchema),
  extractionInput: ajv.compile(extractionInputSchema),
  requirementsInput: ajv.compile(requirementsInputSchema),
  system: ajv.compile(systemSchema),
  itinerary: ajv.compile(require('../schemas/itinerary.schema.json')),
  context: ajv.compile(require('../schemas/validation-context.schema.json'))
};

function validateContract(name, value) {
  if (!Object.hasOwn(contracts, name)) throw new TypeError(`Unknown contract: ${name}`);
  const validate = contracts[name];
  const valid = validate(value);
  return { valid, errors: valid ? [] : structuredClone(validate.errors) };
}

function assertContract(name, value, label = name) {
  const result = validateContract(name, value);
  if (!result.valid) {
    const error = new TypeError(`Invalid ${label} contract: ${ajv.errorsText(result.errors)}`);
    error.errors = result.errors;
    throw error;
  }
}

module.exports = { validateContract, assertContract, extractionSchema };
