const assert = require('node:assert/strict');
const { test } = require('node:test');
const Ajv = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const { extractionSchema, validateContract } = require('../src/contracts.cjs');
const { requirementsFromExtraction, validateRequirements, validateItinerary } = require('../src/validation.cjs');
const complete = require('../examples/requirements-complete.json');
const priced = require('../examples/itinerary-priced.json');

function inputs() {
  const extraction = structuredClone(complete);
  const system = {};
  for (const key of ['inquiry_id', 'channel', 'raw_text', 'received_at']) {
    system[key] = extraction[key];
    delete extraction[key];
  }
  delete extraction.missing_required;
  delete extraction.status;
  return { extraction, system };
}

test('extraction schema compiles independently and excludes all system/derived fields', () => {
  const ajv = new Ajv({ strict: true, allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(extractionSchema);
  const { extraction } = inputs();
  assert.equal(validate(extraction), true, JSON.stringify(validate.errors));
  for (const key of ['inquiry_id', 'channel', 'raw_text', 'received_at', 'missing_required', 'status']) {
    assert.ok(!Object.hasOwn(extractionSchema.properties, key));
    assert.equal(validate({ ...extraction, [key]: complete[key] }), false);
    assert.ok(validate.errors.some(e => e.keyword === 'additionalProperties' && e.params.additionalProperty === key));
  }
});

test('entry point supplies completeness itself without invented placeholder failures', () => {
  const { extraction, system } = inputs();
  const before = structuredClone({ extraction, system });
  const result = requirementsFromExtraction(extraction, system);
  assert.deepEqual(result.value, complete);
  assert.equal(result.noFailures, true);
  assert.equal(result.complete, true);
  assert.ok(!result.flags.some(f => f.check === 'completeness_metadata'));
  assert.deepEqual({ extraction, system }, before);
});

test('entry point computes incomplete metadata without asking the model for it', () => {
  const { extraction, system } = inputs();
  extraction.destination = { value: null, source: null, confidence: null };
  const result = requirementsFromExtraction(extraction, system);
  assert.deepEqual(result.value.missing_required, ['destination']);
  assert.equal(result.complete, false);
  assert.equal(result.noFailures, false);
  assert.ok(!result.flags.some(f => f.check === 'completeness_metadata'));
});

for (const hint of ['May 2027', 'may 2027', '2027-05', '  May 2027  ', 'Sep 2027', 'Sept 2027', 'September 2027']) {
  test(`legacy named month normalizes at boundary: ${hint}`, () => {
    const { extraction, system } = inputs();
    const expected = /sep/i.test(hint) ? '2027-09' : '2027-05';
    extraction.dates.value = { start_date: null, end_date: null, flexible: true, month_hint: hint };
    const result = requirementsFromExtraction(extraction, system);
    assert.equal(result.value.dates.value.month_hint, expected);
    assert.equal(result.noFailures, true, JSON.stringify(result.flags));
    assert.equal(validateContract('requirements', result.value).valid, true);
  });
}

for (const hint of ['banana', 'May', 'Sept', 'May, 2027', 'late May 2027', 'May-June 2027', 'mid-May', '2027-13']) {
  test(`ambiguous/yearless hint produces follow-up, not duplicate date failure: ${hint}`, () => {
    const { extraction, system } = inputs();
    extraction.dates.value = { start_date: null, end_date: null, flexible: true, month_hint: hint };
    const result = requirementsFromExtraction(extraction, system);
    assert.equal(result.value.dates.value.month_hint, null);
    assert.deepEqual(result.value.missing_required, ['dates']);
    assert.deepEqual(result.flags.filter(f => f.status === 'fail').map(f => f.check), ['required_fields']);
    assert.ok(result.flags.some(f => f.check === 'month_hint_follow_up' && f.status === 'warn'));
  });
}

test('unrecognized hint alone becomes a null wrapper with follow-up, not empty-object failure', () => {
  const { extraction, system } = inputs();
  extraction.dates.value = { start_date: null, end_date: null, flexible: null, month_hint: 'banana' };
  const result = requirementsFromExtraction(extraction, system);
  assert.deepEqual(result.value.dates, { value: null, source: null, confidence: null });
  assert.ok(!result.flags.some(f => f.check === 'empty_object'));
});

test('exact date pair remains sufficient when an ambiguous hint is removed', () => {
  const { extraction, system } = inputs();
  extraction.dates.value.month_hint = 'late May 2027';
  const result = requirementsFromExtraction(extraction, system);
  assert.equal(result.complete, true);
  assert.equal(result.noFailures, true);
  assert.equal(result.value.dates.value.month_hint, null);
});

for (const hint of ['Sept 2027', 'May', 'banana', '2027-00', '2027-13']) {
  test(`canonical stored/model contract rejects noncanonical month: ${hint}`, () => {
    const { extraction } = inputs();
    extraction.dates.value.month_hint = hint;
    for (const [name, value] of [['extraction', extraction], ['requirements', { ...complete, dates: extraction.dates }]]) {
      const result = validateContract(name, value);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.keyword === 'pattern' && e.instancePath === '/dates/value/month_hint'));
    }
  });
}

test('legacy full records normalize before canonical storage validation', () => {
  const value = structuredClone(complete);
  value.dates.value = { start_date: null, end_date: null, flexible: true, month_hint: 'Sept 2027' };
  const result = validateRequirements(value);
  assert.equal(result.value.dates.value.month_hint, '2027-09');
  assert.equal(result.noFailures, true);
  assert.equal(value.dates.value.month_hint, 'Sept 2027');
});

test('system and extraction payloads cannot overwrite one another', () => {
  const { extraction, system } = inputs();
  assert.throws(() => requirementsFromExtraction({ ...extraction, status: 'complete' }, system), /Invalid extractionInput contract/);
  assert.throws(() => requirementsFromExtraction(extraction, { ...system, destination: extraction.destination }), /Invalid system contract/);
  delete system.received_at;
  assert.throws(() => requirementsFromExtraction(extraction, system), /Invalid system contract/);
  delete extraction.party;
  assert.throws(() => requirementsFromExtraction(extraction, inputs().system), /Invalid extractionInput contract/);
});

test('noFailures is never readiness, and unassessed checks are counted uniquely', () => {
  const { extraction, system } = inputs();
  const intake = requirementsFromExtraction(extraction, system);
  assert.equal(intake.valid, intake.noFailures);
  assert.equal(intake.readyToSend, false);
  const result = validateItinerary(priced, intake.value, {
    as_of: '2026-10-24T11:00:00+05:30',
    pricing_categories: ['hotels', 'transfers', 'other']
  });
  assert.equal(result.noFailures, true);
  assert.equal(result.valid, result.noFailures);
  assert.equal(result.readyToSend, false);
  assert.equal(result.unassessedCheckCount, 5);
  assert.deepEqual(result.unassessedChecks, ['travel_times', 'opening_days', 'visa_lead_time', 'valid_suppliers', 'constraint_coverage']);
});
