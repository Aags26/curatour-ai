const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { validateContract } = require('../src/contracts.cjs');

const root = path.resolve(__dirname, '..');
const requirements = JSON.parse(fs.readFileSync(path.join(root, 'examples/requirements.json'), 'utf8'));
const itinerary = JSON.parse(fs.readFileSync(path.join(root, 'examples/itinerary.json'), 'utf8'));
const cases = [];

function add(schema, valid, name, edit = () => {}) {
  const value = structuredClone(schema === 'requirements' ? requirements : itinerary);
  edit(value);
  cases.push({ schema, valid, name, value });
}

add('requirements', true, 'reference-example');
add('requirements', true, 'explicit-none', x => {
  x.interests = { value: [], source: 'client', confidence: 1 };
});
add('requirements', true, 'all-trip-fields-unknown', x => {
  for (const value of Object.values(x)) {
    if (value && Object.hasOwn(value, 'value')) Object.assign(value, { value: null, source: null, confidence: null });
  }
  x.missing_required = ['destination', 'dates', 'duration_days', 'party', 'budget', 'departure_city', 'passport_nationality', 'trip_type'];
});
add('requirements', true, 'complete-with-exact-dates', x => {
  x.passport_nationality = { value: 'Indian', source: 'client', confidence: 1 };
  x.dates.value = { start_date: '2027-05-01', end_date: '2027-05-07', flexible: false, month_hint: null };
  x.missing_required = [];
  x.status = 'complete';
});
add('requirements', true, 'partial-nested-object', x => { x.party.value.seniors = null; });
add('requirements', true, 'inferred-value', x => { x.trip_type.source = 'inferred'; });
add('requirements', false, 'bare-trip-field', x => { x.destination = ['Japan']; });
add('requirements', false, 'wrapped-metadata', x => { x.channel = { value: 'whatsapp', source: 'client', confidence: 1 }; });
add('requirements', false, 'nested-wrappers', x => { x.party.value.adults = { value: 2, source: 'client', confidence: 1 }; });
add('requirements', false, 'unknown-with-source', x => { x.interests = { value: null, source: 'default', confidence: null }; });
add('requirements', false, 'unknown-with-confidence', x => { x.interests = { value: null, source: null, confidence: 0 }; });
add('requirements', false, 'known-without-source', x => { x.destination.source = null; });
add('requirements', false, 'known-without-confidence', x => { x.destination.confidence = null; });
add('requirements', false, 'confidence-over-one', x => { x.destination.confidence = 1.01; });
add('requirements', false, 'confidence-negative', x => { x.destination.confidence = -0.01; });
add('requirements', false, 'empty-destination', x => { x.destination.value = []; });
add('requirements', false, 'empty-text', x => { x.departure_city.value = ''; });
add('requirements', false, 'whitespace-text', x => { x.departure_city.value = ' '; });
add('requirements', false, 'invalid-date', x => { x.dates.value.start_date = '2027-02-30'; });
add('requirements', false, 'invalid-timestamp', x => { x.received_at = '2026-10-24'; });
add('requirements', false, 'unknown-required-name', x => { x.missing_required = ['pace']; });
add('requirements', false, 'duplicate-missing-name', x => { x.missing_required.push('passport_nationality'); });
add('requirements', false, 'complete-with-missing-fields', x => { x.status = 'complete'; });
add('requirements', false, 'incomplete-with-empty-missing-fields', x => { x.missing_required = []; });
add('requirements', false, 'missing-wrapper-member', x => { delete x.pace.source; });
add('requirements', false, 'extra-wrapper-member', x => { x.pace.note = 'extra'; });
add('requirements', false, 'old-contract-field', x => { x.schema_version = '1.0'; });
add('requirements', false, 'negative-party', x => { x.party.value.adults = -1; });
add('requirements', false, 'zero-duration', x => { x.duration_days.value = 0; });
add('requirements', false, 'negative-budget', x => { x.budget.value.amount = -1; });
add('requirements', false, 'invalid-currency', x => { x.budget.value.currency = 'rupees'; });
add('itinerary', true, 'reference-example');
add('itinerary', true, 'revision', x => { x.version = 2; x.parent_version = 1; x.created_by = 'planner'; });
for (const source of ['estimate', 'quoted', 'confirmed']) {
  add('itinerary', true, `${source}-cost`, x => { Object.assign(x.days[0].items[0].cost, { amount: 12000, source }); });
}
add('itinerary', true, 'free-time', x => {
  Object.assign(x.days[0].items[0], { type: 'free_time', status: 'planner_edited' });
  Object.assign(x.days[0].items[0].cost, { amount: 0, source: 'estimate' });
});
add('itinerary', false, 'initial-parent', x => { x.parent_version = 1; });
add('itinerary', false, 'revision-without-parent', x => { x.version = 2; });
add('itinerary', false, 'invalid-creator', x => { x.created_by = 'client'; });
add('itinerary', false, 'invalid-time', x => { x.days[0].items[0].end_time = '24:00'; });
add('itinerary', false, 'invalid-day-date', x => { x.days[0].date = '2027-02-30'; });
add('itinerary', false, 'unknown-cost-with-source', x => { x.days[0].items[0].cost.source = 'quoted'; });
add('itinerary', false, 'known-cost-without-source', x => { x.days[0].items[0].cost.amount = 12000; });
add('itinerary', false, 'negative-cost', x => { Object.assign(x.days[0].items[0].cost, { amount: -1, source: 'estimate' }); });
add('itinerary', false, 'negative-summary', x => { x.cost_summary.total_estimate = -1; });
add('itinerary', false, 'old-item-shape', x => { x.days[0].items[0].kind = 'transfer'; });
add('itinerary', false, 'duplicate-dependency', x => { x.days[0].items[0].depends_on.push('hotel_stay'); });
add('itinerary', false, 'invalid-flag-status', x => { x.validation_flags[0].status = 'unknown'; });
add('itinerary', false, 'invalid-item-status', x => { x.days[0].items[0].status = 'booked'; });
add('itinerary', false, 'empty-days', x => { x.days = []; });
add('requirements', false, 'empty-raw-text', x => { x.raw_text = ''; });
add('itinerary', true, 'nullable-description', x => { x.days[0].items[0].description = null; });
add('itinerary', false, 'unpadded-time', x => { x.days[0].items[0].start_time = '9:30'; });

const expectedErrors = {
  'bare-trip-field': ['type', '/destination'],
  'wrapped-metadata': ['enum', '/channel'],
  'nested-wrappers': ['type', '/party/value/adults'],
  'unknown-with-source': ['type', '/interests/source'],
  'unknown-with-confidence': ['type', '/interests/confidence'],
  'known-without-source': ['enum', '/destination/source'],
  'known-without-confidence': ['type', '/destination/confidence'],
  'confidence-over-one': ['maximum', '/destination/confidence'],
  'confidence-negative': ['minimum', '/destination/confidence'],
  'empty-destination': ['minItems', '/destination/value'],
  'empty-text': ['minLength', '/departure_city/value'],
  'whitespace-text': ['pattern', '/departure_city/value'],
  'invalid-date': ['format', '/dates/value/start_date'],
  'invalid-timestamp': ['format', '/received_at'],
  'unknown-required-name': ['enum', '/missing_required/0'],
  'duplicate-missing-name': ['uniqueItems', '/missing_required'],
  'complete-with-missing-fields': ['const', '/status'],
  'incomplete-with-empty-missing-fields': ['const', '/status'],
  'missing-wrapper-member': ['required', '/pace'],
  'extra-wrapper-member': ['additionalProperties', '/pace'],
  'old-contract-field': ['additionalProperties', ''],
  'negative-party': ['minimum', '/party/value/adults'],
  'zero-duration': ['minimum', '/duration_days/value'],
  'negative-budget': ['exclusiveMinimum', '/budget/value/amount'],
  'invalid-currency': ['pattern', '/budget/value/currency'],
  'initial-parent': ['type', '/parent_version'],
  'revision-without-parent': ['type', '/parent_version'],
  'invalid-creator': ['enum', '/created_by'],
  'invalid-time': ['pattern', '/days/0/items/0/end_time'],
  'invalid-day-date': ['format', '/days/0/date'],
  'unknown-cost-with-source': ['type', '/days/0/items/0/cost/source'],
  'known-cost-without-source': ['enum', '/days/0/items/0/cost/source'],
  'negative-cost': ['minimum', '/days/0/items/0/cost/amount'],
  'negative-summary': ['minimum', '/cost_summary/total_estimate'],
  'old-item-shape': ['additionalProperties', '/days/0/items/0'],
  'duplicate-dependency': ['uniqueItems', '/days/0/items/0/depends_on'],
  'invalid-flag-status': ['enum', '/validation_flags/0/status'],
  'invalid-item-status': ['enum', '/days/0/items/0/status'],
  'empty-days': ['minItems', '/days'],
  'empty-raw-text': ['minLength', '/raw_text'],
  'unpadded-time': ['pattern', '/days/0/items/0/start_time']
};

for (const c of cases) {
  test(`${c.schema}: ${c.name}`, () => {
    const result = validateContract(c.schema, c.value);
    assert.equal(result.valid, c.valid, JSON.stringify(result.errors));
    if (!c.valid) {
      assert.ok(expectedErrors[c.name], `Missing expected error for ${c.name}`);
      const [keyword, instancePath] = expectedErrors[c.name];
      assert.ok(result.errors.some(e => e.keyword === keyword && e.instancePath === instancePath),
        JSON.stringify(result.errors));
    }
  });
}
