const { isDeepStrictEqual } = require('node:util');
const Decimal = require('decimal.js').clone({ precision: 40, rounding: 4 });
const { assertContract } = require('./contracts.cjs');

const requiredFields = ['destination', 'dates', 'duration_days', 'party', 'budget', 'departure_city', 'passport_nationality', 'trip_type'];
const currencies = new Set(Intl.supportedValuesOf('currency'));
const categories = ['flights', 'hotels', 'activities', 'transfers', 'other'];
const categoryFor = { flight: 'flights', hotel: 'hotels', activity: 'activities', transfer: 'transfers', meal: 'other', free_time: 'other', visa_task: 'other' };
const monthNames = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const dayNumber = date => Date.parse(`${date}T00:00:00Z`) / 86400000;
const flag = (flags, check, status, message) => flags.push({ check, status, message });
const failed = flags => flags.some(f => f.status === 'fail');
const itemKey = (id, version, itemId) => JSON.stringify([id, version, itemId]);

function timestamp(value, label) {
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new TypeError(`${label}: timestamp is not supported by the JavaScript date runtime.`);
  return result;
}

function parseMonth(hint) {
  if (hint === null) return null;
  const numeric = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(hint.trim());
  if (numeric) return { month: Number(numeric[2]), year: Number(numeric[1]) };
  const named = /^([a-z]+)(?:\s+(\d{4}))?$/i.exec(hint.trim());
  if (!named) return null;
  const name = named[1].toLowerCase();
  const month = name === 'sept' ? 9 : monthNames.findIndex(month => month === name || month.slice(0, 3) === name) + 1;
  return month ? { month, year: named[2] ? Number(named[2]) : null } : null;
}

function normalizeMonth(extraction) {
  const value = structuredClone(extraction);
  const hint = value.dates.value?.month_hint;
  const flags = [];
  if (hint !== undefined && hint !== null) {
    const parsed = parseMonth(hint);
    if (parsed && parsed.year !== null) {
      value.dates.value.month_hint = `${String(parsed.year).padStart(4, '0')}-${String(parsed.month).padStart(2, '0')}`;
    } else {
      value.dates.value.month_hint = null;
      flag(flags, 'month_hint_follow_up', 'warn', `Clarify travel month and year: "${hint}" cannot be stored as YYYY-MM; no year or month was guessed.`);
    }
    if (Object.values(value.dates.value).every(v => v === null)) {
      value.dates = { value: null, source: null, confidence: null };
    }
  }
  return { value, flags };
}

function report(value, flags, requirements = false) {
  const noFailures = !failed(flags);
  const unassessedChecks = [...new Set(flags.filter(f => f.status === 'warn' && /cannot assess/i.test(f.message)).map(f => f.check))];
  return {
    value, flags, valid: noFailures, noFailures,
    ...(requirements ? { complete: value.status === 'complete' } : {}),
    unassessedChecks, unassessedCheckCount: unassessedChecks.length,
    readyToSend: false
  };
}

function requirementsFromExtraction(extraction, system) {
  assertContract('extractionInput', extraction);
  assertContract('system', system);
  const normalized = normalizeMonth(extraction);
  assertContract('extraction', normalized.value);
  const result = evaluateRequirements({
    ...normalized.value, ...structuredClone(system), missing_required: [], status: 'complete'
  }, false);
  return report(result.value, [...normalized.flags, ...result.flags], true);
}

function checkDateRange(start, end, duration, flags, label) {
  if (start && end) {
    const days = dayNumber(end) - dayNumber(start) + 1;
    if (days < 1) flag(flags, 'date_consistency', 'fail', `${label}: end date precedes start date.`);
    else if (duration !== null && days !== duration) flag(flags, 'date_consistency', 'fail', `${label}: date interval does not match duration_days.`);
  } else if (start || end) {
    flag(flags, 'date_consistency', 'warn', `${label}: cannot assess date interval with only one endpoint.`);
  }
}

function validateRequirements(input) {
  assertContract('requirementsInput', input, 'requirements');
  const trip = {};
  for (const field of Object.keys(input ?? {})) {
    if (!['inquiry_id', 'channel', 'raw_text', 'received_at', 'missing_required', 'status'].includes(field)) trip[field] = input[field];
  }
  const normalized = normalizeMonth(trip);
  const result = evaluateRequirements({ ...input, ...normalized.value }, true);
  return report(result.value, [...normalized.flags, ...result.flags], true);
}

function evaluateRequirements(input, checkMetadata) {
  assertContract('requirements', input);
  timestamp(input.received_at, 'received_at');
  const value = structuredClone(input);
  const flags = [];
  for (const [name, field] of Object.entries(value)) {
    if (!field || typeof field !== 'object' || !Object.hasOwn(field, 'value')) continue;
    if (field.value && !Array.isArray(field.value) && typeof field.value === 'object') {
      const entries = Object.values(field.value);
      if (entries.every(v => v === null)) {
        Object.assign(field, { value: null, source: null, confidence: null });
        flag(flags, 'empty_object', 'fail', `${name}: all-null object normalized to an unknown field.`);
      } else if (entries.some(v => v === null)) {
        flag(flags, 'partial_fields', 'warn', `${name}: unresolved subfields require follow-up.`);
      }
    }
  }
  const dates = value.dates.value;
  const month = dates ? parseMonth(dates.month_hint) : null;
  const exactDates = Boolean(dates?.start_date && dates?.end_date);
  const monthDates = Boolean(month && value.duration_days.value !== null);
  const missing = requiredFields.filter(name => value[name].value === null || (name === 'dates' && !exactDates && !monthDates));
  if (checkMetadata && (!isDeepStrictEqual([...input.missing_required].sort(), [...missing].sort()) ||
      input.status !== (missing.length ? 'incomplete' : 'complete'))) {
    flag(flags, 'completeness_metadata', 'fail', 'Supplied completeness metadata disagrees with recomputed requirements.');
  }
  value.missing_required = missing;
  value.status = missing.length ? 'incomplete' : 'complete';
  flag(flags, 'required_fields', missing.length ? 'fail' : 'pass',
    missing.length ? `Missing draft-blocking fields: ${missing.join(', ')}.` : 'All draft-blocking top-level requirements are present.');
  if (dates) {
    checkDateRange(dates.start_date, dates.end_date, value.duration_days.value, flags, 'Requirements');
    if (month) {
      if (dates.start_date && (Number(dates.start_date.slice(5, 7)) !== month.month ||
          (month.year !== null && Number(dates.start_date.slice(0, 4)) !== month.year))) {
        flag(flags, 'date_consistency', 'fail', 'Start date contradicts month_hint.');
      }
    }
  }
  const party = value.party.value;
  if (party) {
    const counts = [party.adults, party.seniors, party.children_ages];
    const knownSize = (party.adults ?? 0) + (party.seniors ?? 0) + (party.children_ages?.length ?? 0);
    if (counts.every(v => v !== null) && knownSize === 0) flag(flags, 'party', 'fail', 'Party must contain at least one traveler.');
  }
  if (value.budget.value?.currency && !currencies.has(value.budget.value.currency)) {
    flag(flags, 'currency', 'fail', 'Budget currency is not in the runtime ISO currency list.');
  }
  return report(value, flags, true);
}

function checkGraph(items, flags) {
  const byId = new Map();
  for (const item of items) {
    if (byId.has(item.item_id)) flag(flags, 'dependencies', 'fail', `Duplicate item_id: ${item.item_id}.`);
    byId.set(item.item_id, item);
  }
  for (const item of items) {
    for (const id of item.depends_on) {
      if (!byId.has(id)) flag(flags, 'dependencies', 'fail', `${item.item_id}: unknown dependency ${id}.`);
      if (id === item.item_id) flag(flags, 'dependencies', 'fail', `${id}: self-dependency.`);
    }
  }
  // Kahn's algorithm avoids recursion limits on long dependency chains.
  const indegree = new Map([...byId].map(([id, item]) => [id, item.depends_on.filter(dep => byId.has(dep)).length]));
  const dependents = new Map([...byId.keys()].map(id => [id, []]));
  for (const [id, item] of byId) for (const dep of item.depends_on) if (byId.has(dep)) dependents.get(dep).push(id);
  const ready = [...indegree.keys()].filter(id => indegree.get(id) === 0);
  for (let i = 0; i < ready.length; i++) {
    for (const id of dependents.get(ready[i])) {
      indegree.set(id, indegree.get(id) - 1);
      if (indegree.get(id) === 0) ready.push(id);
    }
  }
  if (ready.length !== byId.size) flag(flags, 'dependencies', 'fail', 'Dependency graph contains a cycle.');
  if (!flags.some(f => f.check === 'dependencies' && f.status === 'fail')) flag(flags, 'dependencies', 'pass', 'Item IDs and dependency graph are valid.');
}

function checkVersions(value, history, flags) {
  const lineage = history.filter(h => h.itinerary_id === value.itinerary_id);
  const versions = new Set();
  for (const entry of lineage) {
    if (versions.has(entry.version)) flag(flags, 'versions', 'fail', 'Duplicate (itinerary_id, version) in history.');
    versions.add(entry.version);
    if (entry.version >= value.version) flag(flags, 'versions', 'fail', 'Version already exists or is older than stored history.');
    if (entry.inquiry_id !== value.inquiry_id) flag(flags, 'versions', 'fail', 'Inquiry ID changed within itinerary lineage.');
  }
  if (value.version > 1) {
    const parent = lineage.find(h => h.version === value.parent_version);
    if (value.parent_version !== value.version - 1 || !parent) {
      flag(flags, 'versions', 'fail', 'Revision must reference the immediately preceding stored version.');
    }
    const ordered = [...lineage].sort((a, b) => a.version - b.version);
    if (ordered.length !== value.version - 1 || ordered.some((entry, i) =>
      entry.version !== i + 1 || entry.parent_version !== (i === 0 ? null : i))) {
      flag(flags, 'versions', 'fail', 'Trusted history must contain the full consecutive lineage before this revision.');
    }
    if (ordered.some((entry, i) => i > 0 && timestamp(entry.created_at, 'history created_at') < timestamp(ordered[i - 1].created_at, 'history created_at'))) {
      flag(flags, 'versions', 'fail', 'Stored history timestamps are not monotonic.');
    }
    if (parent && timestamp(parent.created_at, 'parent created_at') > timestamp(value.created_at, 'created_at')) {
      flag(flags, 'versions', 'fail', 'Revision timestamp precedes parent.');
    }
    const parentIds = new Set(parent?.days.flatMap(d => d.items).map(i => i.item_id));
    const retired = new Set(lineage.filter(h => h.version < value.parent_version)
      .flatMap(h => h.days.flatMap(d => d.items)).map(i => i.item_id).filter(id => !parentIds.has(id)));
    if (value.days.some(d => d.items.some(i => retired.has(i.item_id)))) flag(flags, 'versions', 'fail', 'A retired item ID was reused.');
  }
  if (!flags.some(f => f.check === 'versions' && f.status === 'fail')) flag(flags, 'versions', 'pass', 'Version and parent history are consistent.');
}

function uniqueIndex(records, key, label) {
  const result = new Map();
  for (const record of records) {
    const id = key(record);
    if (result.has(id)) throw new TypeError(`Ambiguous trusted context: duplicate ${label} ${id}`);
    result.set(id, record);
  }
  return result;
}

function trustedIndexes(context) {
  timestamp(context.as_of, 'context as_of');
  for (const record of context.evidence ?? []) {
    timestamp(record.verified_at, 'evidence verified_at');
    if (record.valid_until !== null) timestamp(record.valid_until, 'evidence valid_until');
  }
  for (const record of context.history ?? []) timestamp(record.created_at, 'history created_at');
  const evidence = uniqueIndex(context.evidence ?? [], e => itemKey(e.itinerary_id, e.version, e.item.item_id), 'evidence');
  const counts = uniqueIndex(context.per_person_counts ?? [], e => itemKey(e.itinerary_id, e.version, e.item_id), 'per-person count');
  const fx = uniqueIndex(context.fx_rates ?? [], r => JSON.stringify([r.from, r.to]), 'FX pair');
  for (const rate of fx.values()) {
    if (!currencies.has(rate.from) || !currencies.has(rate.to) || new Decimal(rate.rate).lte(0)) {
      throw new TypeError('Invalid trusted FX currency or non-positive rate.');
    }
    if (rate.as_of > new Date(context.as_of).toISOString().slice(0, 10)) throw new TypeError('Trusted FX rate is dated in the future.');
  }
  return { evidence, counts, fx };
}

function usableEvidence(value, item, context, indexes, flags) {
  if (!['quoted', 'confirmed'].includes(item.cost.source) && item.status !== 'confirmed') return true;
  const evidence = indexes.evidence.get(itemKey(value.itinerary_id, value.version, item.item_id));
  const now = Date.parse(context.as_of);
  const valid = evidence && isDeepStrictEqual(evidence.item, item) &&
    Date.parse(evidence.verified_at) <= now &&
    (evidence.valid_until === null ? item.cost.source !== 'quoted' :
      Date.parse(evidence.valid_until) > now && Date.parse(evidence.valid_until) >= Date.parse(evidence.verified_at));
  if (!valid) flag(flags, 'cost_provenance', 'fail', `${item.item_id}: quoted/confirmed claims need matching, current external evidence for this version and full item snapshot.`);
  return Boolean(valid);
}

function moneyNumber(amount, currency, flags) {
  const rounded = roundMoney(amount, currency);
  const result = rounded.toNumber();
  if (!Number.isFinite(result) || !new Decimal(result).eq(rounded)) {
    flag(flags, 'cost_summary', 'fail', 'Total cannot be represented safely by the numeric JSON contract.');
    return null;
  }
  return result;
}

function roundMoney(amount, currency) {
  const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
  return amount.toDecimalPlaces(digits);
}

function computeCosts(value, items, context, indexes, party, flags) {
  const totals = Object.fromEntries(categories.map(c => [c, new Decimal(0)]));
  const unknown = new Set();
  const scope = context.pricing_categories;
  const summaryCurrencyValid = currencies.has(value.summary.currency);
  let scopeValid = Array.isArray(scope);
  const countKnown = party && party.adults !== null && party.seniors !== null && party.children_ages !== null;
  const partySize = countKnown ? party.adults + party.seniors + party.children_ages.length : null;
  if (!scopeValid) flag(flags, 'pricing_scope', 'warn', 'Cannot assess full pricing without trusted pricing_categories.');
  if (scopeValid) {
    for (const category of scope) {
      if (!items.some(item => categoryFor[item.type] === category)) unknown.add(category);
    }
  }
  for (const item of items) {
    const category = categoryFor[item.type];
    if (scopeValid && !scope.includes(category) && (item.cost.amount === null || item.cost.amount !== 0)) {
      flag(flags, 'pricing_scope', 'fail', `${item.item_id}: priced or unpriced item falls outside the declared pricing scope.`);
      scopeValid = false;
    }
    const evidenceValid = usableEvidence(value, item, context, indexes, flags);
    if (!currencies.has(item.cost.currency)) {
      flag(flags, 'currency', 'fail', `${item.item_id}: unknown currency.`);
      unknown.add(category);
      continue;
    }
    const rate = item.cost.currency !== value.summary.currency
      ? indexes.fx.get(JSON.stringify([item.cost.currency, value.summary.currency])) : null;
    if (summaryCurrencyValid && item.cost.currency !== value.summary.currency && !rate) {
      flag(flags, 'currency_conversion', 'fail', `${item.item_id}: currency differs from summary without trusted FX evidence.`);
      unknown.add(category);
      continue;
    }
    if (item.cost.amount === null || !evidenceValid || !summaryCurrencyValid) {
      unknown.add(category);
      continue;
    }
    let amount = new Decimal(item.cost.amount);
    if (item.cost.basis === 'per_person' && !amount.isZero()) {
      const countRecord = indexes.counts.get(itemKey(value.itinerary_id, value.version, item.item_id));
      const multiplier = countRecord?.count ?? (countKnown && party.children_ages.length === 0 ? partySize : null);
      if (multiplier === null || partySize === null || multiplier > partySize || multiplier <= 0) {
        flag(flags, 'per_person_pricing', 'warn', `${item.item_id}: cannot assess chargeable traveler count; child-sensitive prices need trusted per_person_counts.`);
        unknown.add(category);
        continue;
      }
      amount = amount.mul(multiplier);
    }
    if (item.cost.currency !== value.summary.currency) {
      amount = amount.mul(rate.rate);
    }
    totals[category] = totals[category].plus(amount);
  }
  const byCategory = {};
  for (const category of categories) {
    byCategory[category] = scopeValid && summaryCurrencyValid && countKnown && partySize > 0 && !unknown.has(category)
      ? moneyNumber(totals[category], value.summary.currency, flags) : null;
  }
  const complete = Object.values(byCategory).every(v => v !== null);
  const total = complete ? moneyNumber(Object.values(byCategory).reduce((sum, n) => sum.plus(n), new Decimal(0)), value.summary.currency, flags) : null;
  const computed = { total_estimate: total, by_category: byCategory, confidence: 'low' };
  const claimed = value.cost_summary;
  if ((claimed.total_estimate !== null && claimed.total_estimate !== total) ||
      categories.some(c => claimed.by_category[c] !== null && claimed.by_category[c] !== byCategory[c])) {
    flag(flags, 'cost_summary', 'fail', 'Supplied numeric cost claims disagree with computed totals.');
  } else {
    flag(flags, 'cost_summary', 'pass', 'Cost summary recomputed from normalized item costs; null placeholders populated only when known.');
  }
  if (claimed.confidence !== 'low') {
    flag(flags, 'pricing_confidence', 'warn', 'Confidence reset to low: a trusted pricing-quality policy is not implemented.');
  }
  if (!complete) flag(flags, 'cost_completeness', 'warn', 'Cannot assess total: scope, pricing, evidence or traveler counts are unresolved.');
  else flag(flags, 'cost_completeness', 'pass', 'All scoped item costs are normalized and summed.');
  value.cost_summary = computed;
  return { totals, scopeValid, partySize };
}

function checkBudget(value, requirements, costs, context, indexes, flags) {
  const budget = requirements.budget.value;
  if (!budget || budget.amount === null || budget.currency === null || budget.basis === null || budget.includes_flights === null ||
      !costs.scopeValid || !currencies.has(budget.currency) || !currencies.has(value.summary.currency)) {
    flag(flags, 'budget_fit', 'warn', 'Cannot assess budget: currency, basis, inclusions or pricing scope are unresolved.');
    return;
  }
  if (context.pricing_categories.includes('flights') !== budget.includes_flights) {
    flag(flags, 'budget_fit', 'warn', 'Cannot assess budget: flight inclusion differs from declared pricing scope.');
    return;
  }
  let limit = new Decimal(budget.amount);
  if (budget.basis === 'per_person') {
    if (costs.partySize === null) {
      flag(flags, 'budget_fit', 'warn', 'Cannot assess per-person budget without a known party size.');
      return;
    }
    limit = limit.mul(costs.partySize);
  }
  if (budget.currency !== value.summary.currency) {
    const rate = indexes.fx.get(JSON.stringify([budget.currency, value.summary.currency]));
    if (!rate) {
      flag(flags, 'budget_fit', 'warn', 'Cannot assess budget without trusted conversion to summary currency.');
      return;
    }
    limit = limit.mul(rate.rate);
  }
  const subtotal = Object.values(costs.totals).reduce((sum, amount) => sum.plus(roundMoney(amount, value.summary.currency)), new Decimal(0));
  if (subtotal.gt(roundMoney(limit, value.summary.currency))) flag(flags, 'budget_fit', 'fail', 'Known scoped subtotal exceeds budget, including any still-unpriced items.');
  else if (value.cost_summary.total_estimate === null) flag(flags, 'budget_fit', 'warn', 'Cannot assess budget fit until scoped costs are complete.');
  else flag(flags, 'budget_fit', 'pass', 'Computed scoped total is within the matching budget.');
}

function validateItinerary(input, inquiry, context) {
  assertContract('itinerary', input);
  assertContract('context', context);
  const requirements = validateRequirements(inquiry);
  const value = structuredClone(input);
  const flags = [...requirements.flags];
  const indexes = trustedIndexes(context);
  const items = value.days.flatMap(d => d.items);
  if (value.inquiry_id !== requirements.value.inquiry_id) flag(flags, 'inquiry_link', 'fail', 'Itinerary references a different inquiry.');
  checkGraph(items, flags);
  checkVersions(value, context.history ?? [], flags);
  if (timestamp(value.created_at, 'created_at') > timestamp(context.as_of, 'context as_of')) flag(flags, 'versions', 'fail', 'Itinerary timestamp is in the future.');
  const party = requirements.value.party.value;
  if (value.summary.party.adults + value.summary.party.children_ages.length <= 0) flag(flags, 'party', 'fail', 'Summary party must contain at least one traveler.');
  if (party && party.adults !== null && party.seniors !== null && party.children_ages !== null) {
    if (value.summary.party.adults !== party.adults + party.seniors ||
        !isDeepStrictEqual(value.summary.party.children_ages, party.children_ages)) flag(flags, 'party', 'fail', 'Summary party differs from requirements (summary adults includes seniors).');
  } else {
    flag(flags, 'party', 'warn', 'Cannot assess summary party against unresolved inquiry counts.');
  }
  const duration = requirements.value.duration_days.value;
  checkDateRange(value.summary.start_date, value.summary.end_date, duration, flags, 'Summary');
  if (duration !== null && value.days.length !== duration) flag(flags, 'requirements_coverage', 'fail', 'Day count does not match requested duration.');
  const dates = requirements.value.dates.value;
  const month = dates ? parseMonth(dates.month_hint) : null;
  if (dates) {
    for (const endpoint of ['start_date', 'end_date']) {
      if (dates[endpoint] && value.summary[endpoint] !== dates[endpoint]) flag(flags, 'date_consistency', 'fail', `Summary ${endpoint} differs from the inquiry.`);
    }
  }
  if (month && value.summary.start_date &&
      (Number(value.summary.start_date.slice(5, 7)) !== month.month ||
      (month.year !== null && Number(value.summary.start_date.slice(0, 4)) !== month.year))) {
    flag(flags, 'date_consistency', 'fail', 'Summary start date contradicts inquiry month_hint.');
  }
  let anchor = null;
  for (let i = 0; i < value.days.length; i++) {
    const day = value.days[i];
    if (day.index !== i + 1) flag(flags, 'date_consistency', 'fail', 'Day indices must be consecutive starting at one.');
    if (value.summary.start_date && (!day.date || dayNumber(day.date) !== dayNumber(value.summary.start_date) + i)) {
      flag(flags, 'date_consistency', 'fail', `Day ${i + 1} date does not align with summary start date.`);
    }
    if (day.date && value.summary.end_date && day.date > value.summary.end_date) flag(flags, 'date_consistency', 'fail', `Day ${i + 1} falls after summary end date.`);
    if (day.date && anchor && dayNumber(day.date) !== anchor.date + i - anchor.index) {
      flag(flags, 'date_consistency', 'fail', 'Known day dates must be consecutive.');
    }
    if (day.date && !anchor) anchor = { date: dayNumber(day.date), index: i };
  }
  const lastDay = value.days.at(-1);
  if (value.summary.end_date && lastDay.date && lastDay.date !== value.summary.end_date) {
    flag(flags, 'date_consistency', 'fail', 'Last day does not match summary end date.');
  }
  if (!value.summary.start_date || !value.summary.end_date || value.days.some(d => d.date === null)) {
    flag(flags, 'date_consistency', 'warn', 'Cannot assess all calendar checks without exact dates.');
  }
  if (!currencies.has(value.summary.currency)) flag(flags, 'currency', 'fail', 'Summary currency is not in the runtime ISO currency list.');
  const costs = computeCosts(value, items, context, indexes, party, flags);
  checkBudget(value, requirements.value, costs, context, indexes, flags);
  for (const check of ['travel_times', 'opening_days', 'visa_lead_time', 'valid_suppliers', 'constraint_coverage']) {
    flag(flags, check, 'warn', 'Cannot assess: trusted feasibility/constraint data integration is not implemented.');
  }
  value.validation_flags = flags;
  assertContract('itinerary', value);
  return report(value, flags);
}

module.exports = { validateRequirements, validateItinerary, requirementsFromExtraction };
