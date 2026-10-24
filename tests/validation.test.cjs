const assert = require('node:assert/strict');
const { test } = require('node:test');
const { validateRequirements, validateItinerary } = require('../src/validation.cjs');
const { validateContract } = require('../src/contracts.cjs');
const complete = require('../examples/requirements-complete.json');
const priced = require('../examples/itinerary-priced.json');
const revision = require('../examples/itinerary-v2.json');

const context = {
  as_of: '2026-10-24T11:00:00+05:30',
  pricing_categories: ['hotels', 'transfers', 'other'],
  evidence: [],
  fx_rates: [],
  history: []
};
const clone = structuredClone;
const has = (report, check, status = 'fail') => report.flags.some(f => f.check === check && f.status === status);

function requirementProbe(name, edit, check) {
  test(`requirements semantic: ${name}`, () => {
    const value = clone(complete);
    edit(value);
    const report = validateRequirements(value);
    assert.ok(has(report, check), JSON.stringify(report.flags));
    assert.equal(report.valid, false);
  });
}

requirementProbe('null destination cannot claim completeness', x => {
  x.destination = { value: null, source: null, confidence: null };
}, 'required_fields');
requirementProbe('reversed dates', x => { x.dates.value.end_date = '2027-04-30'; }, 'date_consistency');
requirementProbe('nonsense month', x => {
  x.dates.value.start_date = null;
  x.dates.value.end_date = null;
  x.dates.value.month_hint = 'banana';
}, 'date_consistency');
requirementProbe('empty party', x => { x.party.value.adults = 0; }, 'party');
requirementProbe('unknown currency', x => { x.budget.value.currency = 'ZZZ'; }, 'currency');
requirementProbe('all-null date object', x => {
  x.dates.value = { start_date: null, end_date: null, flexible: null, month_hint: null };
}, 'empty_object');

test('requirements recomputes completeness without mutating input', () => {
  const value = clone(complete);
  value.destination = { value: null, source: null, confidence: null };
  const before = clone(value);
  const report = validateRequirements(value);
  assert.deepEqual(report.value.missing_required, ['destination']);
  assert.equal(report.value.status, 'incomplete');
  assert.deepEqual(value, before);
  assert.ok(has(report, 'completeness_metadata'));
});

test('400 days is allowed: no implicit duration cap', () => {
  const value = clone(complete);
  value.duration_days.value = 400;
  value.dates.value = { start_date: null, end_date: null, flexible: true, month_hint: 'May 2027' };
  assert.equal(validateRequirements(value).valid, true);
});

test('month plus duration is complete; subfield unknown stays visible', () => {
  const value = clone(complete);
  value.dates.value = { start_date: null, end_date: null, flexible: true, month_hint: '2027-05' };
  value.budget.value.includes_flights = null;
  const report = validateRequirements(value);
  assert.equal(report.value.status, 'complete');
  assert.ok(has(report, 'partial_fields', 'warn'));
});

test('complete fixture has no semantic failures', () => {
  assert.equal(validateRequirements(complete).valid, true);
});

function itineraryProbe(name, edit, check, editContext = () => {}) {
  test(`itinerary semantic: ${name}`, () => {
    const value = clone(priced);
    const trusted = clone(context);
    edit(value);
    editContext(trusted);
    const report = validateItinerary(value, complete, trusted);
    assert.ok(has(report, check), JSON.stringify(report.flags));
    assert.equal(report.valid, false);
  });
}

itineraryProbe('duplicate item IDs', x => { x.days[0].items[1].item_id = 'hotel_stay'; }, 'dependencies');
itineraryProbe('unknown dependency', x => { x.days[0].items[1].depends_on = ['missing']; }, 'dependencies');
itineraryProbe('self dependency', x => { x.days[0].items[0].depends_on = ['hotel_stay']; }, 'dependencies');
itineraryProbe('cycle', x => { x.days[0].items[0].depends_on = ['arrival_transfer']; }, 'dependencies');
itineraryProbe('unconverted item currency', x => { x.days[0].items[0].cost.currency = 'USD'; }, 'currency_conversion');
itineraryProbe('unknown price with claimed total', x => {
  x.days[0].items[0].cost.amount = null;
  x.days[0].items[0].cost.source = null;
}, 'cost_summary');
itineraryProbe('skipped parent', x => { x.version = 3; x.parent_version = 1; }, 'versions');
itineraryProbe('reversed summary dates', x => { x.summary.end_date = '2027-04-30'; }, 'date_consistency');
itineraryProbe('wrong day index', x => { x.days[1].index = 3; }, 'date_consistency');
itineraryProbe('wrong day date', x => { x.days[1].date = '2027-05-03'; }, 'date_consistency');
itineraryProbe('unknown summary currency', x => { x.summary.currency = 'ZZZ'; }, 'currency');
itineraryProbe('quoted without evidence', x => { x.days[0].items[0].cost.source = 'quoted'; }, 'cost_provenance');
itineraryProbe('AI confirmed without evidence', x => { x.days[0].items[0].status = 'confirmed'; }, 'cost_provenance');
itineraryProbe('planner confirmed without evidence', x => {
  x.created_by = 'planner';
  x.days[0].items[0].status = 'confirmed';
}, 'cost_provenance');

test('priced golden fixture computes mixed total/per-person costs', () => {
  const before = clone(priced);
  const report = validateItinerary(priced, complete, context);
  assert.equal(report.valid, true, JSON.stringify(report.flags));
  assert.deepEqual(report.value.cost_summary, priced.cost_summary);
  assert.ok(has(report, 'budget_fit', 'pass'));
  assert.ok(has(report, 'travel_times', 'warn'));
  assert.deepEqual(priced, before);
});

test('v2 fixture keeps IDs, changes one item and adds one', () => {
  const report = validateItinerary(revision, complete, { ...context, history: [priced] });
  assert.equal(report.valid, true, JSON.stringify(report.flags));
  const old = new Map(priced.days.flatMap(d => d.items).map(i => [i.item_id, i]));
  const items = revision.days.flatMap(d => d.items);
  assert.deepEqual(items.filter(i => !old.has(i.item_id)).map(i => i.item_id), ['departure_transfer']);
  assert.deepEqual(items.filter(i => old.has(i.item_id) && JSON.stringify(old.get(i.item_id)) !== JSON.stringify(i))
    .map(i => i.item_id), ['hotel_stay']);
  assert.equal(report.value.cost_summary.total_estimate, 7000);
});

test('model validation flags are discarded', () => {
  const value = clone(priced);
  value.validation_flags = [{ check: 'invented_pass', status: 'pass', message: 'Trust me' }];
  const report = validateItinerary(value, complete, context);
  assert.ok(!report.flags.some(f => f.check === 'invented_pass'));
  assert.deepEqual(report.value.validation_flags, report.flags);
});

test('money is summed as decimals, not binary floats', () => {
  const value = clone(priced);
  Object.assign(value.days[0].items[0].cost, { amount: 0.1 });
  Object.assign(value.days[0].items[1].cost, { amount: 0.1 });
  value.cost_summary = { total_estimate: 0.3, by_category: { flights: 0, hotels: 0.1, activities: 0, transfers: 0.2, other: 0 }, confidence: 'low' };
  const report = validateItinerary(value, complete, context);
  assert.equal(report.valid, true, JSON.stringify(report.flags));
  assert.equal(report.value.cost_summary.total_estimate, 0.3);
});

test('trusted FX conversion is explicit and decimal', () => {
  const value = clone(priced);
  value.days[0].items[0].cost.currency = 'USD';
  value.days[0].items[0].cost.amount = 50;
  const trusted = clone(context);
  trusted.fx_rates = [{ from: 'USD', to: 'INR', rate: '100', as_of: '2026-10-24', evidence_ref: 'fx_001' }];
  const report = validateItinerary(value, complete, trusted);
  assert.equal(report.valid, true, JSON.stringify(report.flags));
  assert.equal(report.value.cost_summary.total_estimate, 6000);
});

function evidenceFor(value) {
  return {
    itinerary_id: value.itinerary_id,
    version: value.version,
    item: clone(value.days[0].items[0]),
    verified_at: '2026-10-24T10:30:00+05:30',
    valid_until: '2026-10-25T10:30:00+05:30'
  };
}

test('AI may preserve an externally verified confirmation without supplier_ref', () => {
  const value = clone(priced);
  value.days[0].items[0].status = 'confirmed';
  value.days[0].items[0].cost.source = 'confirmed';
  const trusted = { ...context, evidence: [evidenceFor(value)] };
  assert.equal(validateItinerary(value, complete, trusted).valid, true);
});

for (const [name, change] of [
  ['wrong version', e => { e.version = 2; }],
  ['changed cost', e => { e.item.cost.amount = 123; }],
  ['changed title', e => { e.item.title = 'Different hotel'; }],
  ['expired', e => { e.valid_until = '2026-10-24T10:45:00+05:30'; }],
  ['future verification', e => { e.verified_at = '2026-10-25T10:30:00+05:30'; }]
]) {
  test(`external evidence rejected: ${name}`, () => {
    const value = clone(priced);
    value.days[0].items[0].cost.source = 'quoted';
    const evidence = evidenceFor(value);
    change(evidence);
    assert.ok(has(validateItinerary(value, complete, { ...context, evidence: [evidence] }), 'cost_provenance'));
  });
}

test('invalid structure throws explicitly before business checks', () => {
  assert.throws(() => validateRequirements({}), /Invalid requirements contract/);
  assert.throws(() => validateItinerary({}, complete, context), /Invalid itinerary contract/);
});

for (const [contract, file] of [
  ['requirements', 'requirements-complete.json'],
  ['itinerary', 'itinerary-priced.json'],
  ['itinerary', 'itinerary-v2.json']
]) {
  test(`golden structural fixture: examples/${file}`, () => {
    const result = validateContract(contract, require(`../examples/${file}`));
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });
}

test('all-null nested objects become explicit unknowns, with failure visible', () => {
  const value = clone(complete);
  value.dates.value = { start_date: null, end_date: null, flexible: null, month_hint: null };
  const report = validateRequirements(value);
  assert.deepEqual(report.value.dates, { value: null, source: null, confidence: null });
  assert.ok(report.value.missing_required.includes('dates'));
});

test('unknown prices stay null, not zero, and budget cannot pass', () => {
  const value = clone(priced);
  Object.assign(value.days[0].items[0].cost, { amount: null, source: null });
  const report = validateItinerary(value, complete, context);
  assert.equal(report.value.cost_summary.by_category.hotels, null);
  assert.equal(report.value.cost_summary.total_estimate, null);
  assert.ok(has(report, 'budget_fit', 'warn'));
  assert.ok(!has(report, 'budget_fit', 'pass'));
});

test('a known over-budget subtotal fails even when another item is unpriced', () => {
  const value = clone(priced);
  value.days[0].items[0].cost.amount = 11000;
  Object.assign(value.days[0].items[1].cost, { amount: null, source: null });
  const report = validateItinerary(value, complete, context);
  assert.ok(has(report, 'budget_fit'));
});

test('missing scoped category cannot silently become a zero-priced category', () => {
  const report = validateItinerary(priced, complete, { ...context, pricing_categories: ['flights', 'hotels', 'transfers', 'other'] });
  assert.equal(report.value.cost_summary.by_category.flights, null);
  assert.equal(report.value.cost_summary.total_estimate, null);
});

test('missing pricing scope never yields a complete cost summary', () => {
  const report = validateItinerary(priced, complete, { as_of: context.as_of });
  assert.ok(has(report, 'pricing_scope', 'warn'));
  assert.equal(report.value.cost_summary.total_estimate, null);
});

test('unknown budget inclusions cannot pass budget validation', () => {
  const inquiry = clone(complete);
  inquiry.budget.value.includes_flights = null;
  const report = validateItinerary(priced, inquiry, context);
  assert.ok(has(report, 'budget_fit', 'warn'));
});

test('summary adults includes seniors exactly once', () => {
  const inquiry = clone(complete);
  inquiry.party.value = { adults: 1, seniors: 1, children_ages: [] };
  assert.equal(validateItinerary(priced, inquiry, context).valid, true);
});

test('children need trusted chargeable counts for per-person costs', () => {
  const inquiry = clone(complete);
  inquiry.party.value.children_ages = [5];
  const value = clone(priced);
  value.summary.party.children_ages = [5];
  const unresolved = validateItinerary(value, inquiry, context);
  assert.equal(unresolved.value.cost_summary.by_category.transfers, null);
  assert.ok(has(unresolved, 'per_person_pricing', 'warn'));
  const trusted = {
    ...context,
    per_person_counts: [{ itinerary_id: value.itinerary_id, version: 1, item_id: 'arrival_transfer', count: 2, evidence_ref: 'child_free_record' }]
  };
  assert.equal(validateItinerary(value, inquiry, trusted).valid, true);
});

test('per-person budget is normalized using known party size', () => {
  const inquiry = clone(complete);
  inquiry.budget.value.basis = 'per_person';
  inquiry.budget.value.amount = 3000;
  assert.ok(has(validateItinerary(priced, inquiry, context), 'budget_fit', 'pass'));
  inquiry.budget.value.amount = 2999;
  assert.ok(has(validateItinerary(priced, inquiry, context), 'budget_fit'));
});

test('a revision needs the stored parent, not just a parent number', () => {
  assert.ok(has(validateItinerary(revision, complete, context), 'versions'));
});

test('removed IDs cannot be recycled', () => {
  const v2 = clone(revision);
  v2.days[1].items = v2.days[1].items.filter(i => i.item_id !== 'free_morning');
  const v3 = clone(revision);
  v3.version = 3;
  v3.parent_version = 2;
  const report = validateItinerary(v3, complete, { ...context, history: [priced, v2] });
  assert.ok(has(report, 'versions'));
});

test('history must contain the full lineage', () => {
  const v3 = clone(revision);
  v3.version = 3;
  v3.parent_version = 2;
  assert.ok(has(validateItinerary(v3, complete, { ...context, history: [revision] }), 'versions'));
});

for (const [name, edit] of [
  ['missing as_of', x => { delete x.as_of; }],
  ['unknown context key', x => { x.trust_model = true; }],
  ['duplicate evidence', x => {
    const e = evidenceFor(priced);
    x.evidence = [e, clone(e)];
  }],
  ['duplicate FX pair', x => {
    const rate = { from: 'USD', to: 'INR', rate: '100', as_of: '2026-10-24', evidence_ref: 'fx' };
    x.fx_rates = [rate, clone(rate)];
  }],
  ['zero FX rate', x => { x.fx_rates = [{ from: 'USD', to: 'INR', rate: '0', as_of: '2026-10-24', evidence_ref: 'fx' }]; }],
  ['future FX rate', x => { x.fx_rates = [{ from: 'USD', to: 'INR', rate: '100', as_of: '2026-10-25', evidence_ref: 'fx' }]; }]
]) {
  test(`invalid trusted context fails explicitly: ${name}`, () => {
    const trusted = clone(context);
    edit(trusted);
    assert.throws(() => validateItinerary(priced, complete, trusted), TypeError);
  });
}

test('explicitly unverified original examples remain blocked, not success-shaped', () => {
  const report = validateItinerary(require('../examples/itinerary.json'), require('../examples/requirements.json'), context);
  assert.equal(report.valid, false);
  assert.ok(has(report, 'required_fields'));
  assert.equal(report.value.cost_summary.total_estimate, null);
});

test('null summary placeholders are populated from known prices without failing', () => {
  const value = clone(priced);
  value.cost_summary.total_estimate = null;
  for (const category of Object.keys(value.cost_summary.by_category)) value.cost_summary.by_category[category] = null;
  const report = validateItinerary(value, complete, context);
  assert.equal(report.valid, true, JSON.stringify(report.flags));
  assert.deepEqual(report.value.cost_summary, priced.cost_summary);
});

test('unresolved party counts keep even total-only summaries unknown', () => {
  const inquiry = clone(complete);
  inquiry.party.value.seniors = null;
  const value = clone(priced);
  Object.assign(value.days[0].items[1].cost, { amount: 1000, basis: 'total' });
  const report = validateItinerary(value, inquiry, context);
  assert.equal(report.value.cost_summary.total_estimate, null);
  assert.ok(has(report, 'party', 'warn'));
});

test('currency rounding is consistent between category sums and budget fit', () => {
  const value = clone(priced);
  value.days[0].items[0].cost.amount = 0.005;
  Object.assign(value.days[0].items[1].cost, { amount: 0, basis: 'total' });
  value.cost_summary.total_estimate = 0.01;
  value.cost_summary.by_category.hotels = 0.01;
  value.cost_summary.by_category.transfers = 0;
  const inquiry = clone(complete);
  inquiry.budget.value.amount = 0.004;
  const report = validateItinerary(value, inquiry, context);
  assert.equal(report.value.cost_summary.total_estimate, 0.01);
  assert.ok(has(report, 'budget_fit'));
});

test('budget in another currency requires trusted FX independently of item currencies', () => {
  const inquiry = clone(complete);
  inquiry.budget.value.currency = 'USD';
  inquiry.budget.value.amount = 100;
  assert.ok(has(validateItinerary(priced, inquiry, context), 'budget_fit', 'warn'));
  const trusted = { ...context, fx_rates: [{ from: 'USD', to: 'INR', rate: '100', as_of: '2026-10-24', evidence_ref: 'fx' }] };
  assert.ok(has(validateItinerary(priced, inquiry, trusted), 'budget_fit', 'pass'));
});

test('quoted records require expiry, confirmed evidence may have no expiry', () => {
  const value = clone(priced);
  value.days[0].items[0].cost.source = 'quoted';
  let evidence = evidenceFor(value);
  evidence.valid_until = null;
  assert.ok(has(validateItinerary(value, complete, { ...context, evidence: [evidence] }), 'cost_provenance'));
  value.days[0].items[0].cost.source = 'confirmed';
  evidence = evidenceFor(value);
  evidence.valid_until = null;
  assert.equal(validateItinerary(value, complete, { ...context, evidence: [evidence] }).valid, true);
});

test('unsupported pricing confidence is visibly lowered, not accepted as model judgment', () => {
  const value = clone(priced);
  value.cost_summary.confidence = 'high';
  const report = validateItinerary(value, complete, context);
  assert.equal(report.value.cost_summary.confidence, 'low');
  assert.ok(has(report, 'pricing_confidence', 'warn'));
});

test('unrepresentable category totals are rejected rather than overflowing', () => {
  const value = clone(priced);
  value.days[0].items[0].cost.amount = 1e308;
  value.days[0].items[1].type = 'hotel';
  Object.assign(value.days[0].items[1].cost, { amount: 1e308, basis: 'total' });
  assert.ok(has(validateItinerary(value, complete, context), 'cost_summary'));
});

test('yearless month remains usable without inventing a year', () => {
  const value = clone(complete);
  value.dates.value = { start_date: null, end_date: null, flexible: true, month_hint: 'May' };
  const report = validateRequirements(value);
  assert.equal(report.valid, true);
  assert.equal(report.value.status, 'complete');
  assert.ok(has(report, 'date_consistency', 'warn'));
});

test('single endpoint without a month is incomplete, not an invented date pair', () => {
  const value = clone(complete);
  value.dates.value.end_date = null;
  const report = validateRequirements(value);
  assert.ok(report.value.missing_required.includes('dates'));
  assert.ok(has(report, 'date_consistency', 'warn'));
});

test('known dates must align across an intervening unknown day', () => {
  const inquiry = clone(complete);
  inquiry.duration_days.value = 3;
  inquiry.dates.value = { start_date: null, end_date: null, flexible: true, month_hint: 'May 2027' };
  const value = clone(priced);
  value.summary.start_date = null;
  value.summary.end_date = null;
  const middle = clone(value.days[1]);
  middle.date = null;
  middle.items[0].item_id = 'free_middle';
  value.days.splice(1, 0, middle);
  value.days[2].index = 3;
  value.days[2].date = '2027-05-04';
  assert.ok(has(validateItinerary(value, inquiry, context), 'date_consistency'));
});

test('unsupported leap-second timestamps fail explicitly instead of bypassing comparisons', () => {
  const trusted = clone(context);
  trusted.as_of = '2016-12-31T23:59:60Z';
  assert.throws(() => validateItinerary(priced, complete, trusted), /not supported/);
});
