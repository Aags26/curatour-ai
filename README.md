# Curatour: inquiry to planner draft

Lean v1 data contracts and deterministic validation for pasted inquiries and
anonymized sample itineraries. No extraction, bot, database, booking, payment or
client delivery is implemented. All outputs remain planner-only drafts.

## Setup and tests

Node 22+:

```sh
npm ci
npm test
```

Ajv, ajv-formats and decimal.js are pinned in the manifest and lockfile. Tests run
in-process: each structural negative case asserts an expected Ajv keyword and
instance path. Semantic tests exercise business rules independently of shape.
No unpinned `npx` downloads or temporary fixture subprocesses are used.

## Contracts and fixtures

- [Requirements schema](schemas/requirements.schema.json)
- [Itinerary schema](schemas/itinerary.schema.json)
- [Trusted validation context schema](schemas/validation-context.schema.json)
- [Incomplete inquiry](examples/requirements.json) and
  [incomplete arrival-day illustration](examples/itinerary.json)
- [Complete requirements](examples/requirements-complete.json)
- [Priced v1](examples/itinerary-priced.json): mixes total and per-person costs
- [V2 revision](examples/itinerary-v2.json): stable IDs, one changed item, one added

All examples and prices are synthetic. Singapore/Japan are illustrative, not the
chosen pilot country. The incomplete example must fail semantic validation.

Draft 2020-12 with strict compilation and format assertions checks shape, dates,
timestamps and unknown properties. These storage contracts are not provider-specific
structured-output schemas. The old nested `requirements`, `schema_version` and
classification/follow-up fields are not part of the payloads.

## Requirements conventions

Every top-level trip field is `{value, source, confidence}`, wrapped once; nested
party/budget/date members are not wrapped. Metadata (`inquiry_id`, `channel`,
`raw_text`, `received_at`, `missing_required`, `status`) stays plain.

- Unknown fields use `value: null, source: null, confidence: null`.
  Known values require a source (`client | inferred | default`) and confidence
  in [0, 1]. Direct client form input uses client/1.0; model extraction can have
  lower confidence. Confidence is not factual or supplier verification.
- `[]` means explicitly none; null means not known. Empty destination arrays and
  empty/whitespace trip strings are invalid. `raw_text` must be nonempty.
- Partial nested objects may contain nulls and produce follow-up warnings.
  All-null nested objects are normalized to an unknown wrapper and flagged as
  invalid input, not silently accepted as client facts.
- Mixed inferred/client nested facts use conservative confidence; explain the
  inference in draft assumptions. This lean shape has no per-subfield provenance.
- Requirements `adults` excludes `seniors`. Total party size is adults + seniors
  + children; fully known parties must contain at least one traveler.
  Summary `adults` includes seniors, matching the lean itinerary contract.
- `duration_days` is inclusive calendar days, not hotel nights. **There is no
  duration cap or long-trip warning.** Exact start/end dates must match duration.
- Month hints accept `YYYY-MM` or an English full/three-letter month name with
  optional year, case insensitive (e.g. `May 2027`, `may`, `Sep 2027`).
  Other text is explicitly rejected for clarification, not guessed. Yearless
  months produce a warning; no year is invented.
- Optional unknowns stay null. Defaults are not inserted by schemas or validators.
  Only apply planner-approved defaults, tag them as default and surface them in
  assumptions. Never default health, dietary needs, nationality or bookings to none.
- `already_booked` contains redacted descriptions, not booking/payment identifiers.

Draft-blocking fields are destination, dates, duration_days, party, budget,
departure_city, passport_nationality and trip_type. The validator recomputes
`missing_required` from null top-level values, with the additional date rule:
an exact date pair or a recognized month hint plus duration is required.

It also recomputes status and flags supplied metadata that disagrees. A complete
status does not imply complete nested facts or feasibility: unknown budget
inclusions/counts remain warnings and block the relevant calculations. Follow-up
question generation is not implemented; use at most five questions per round.

## Validation API

[Structural checks](src/contracts.cjs) return `{valid, errors}` with Ajv errors.
[Semantic checks](src/validation.cjs) throw a `TypeError` with `.errors` for
structurally invalid payloads/context; otherwise they return:

```js
{ value, flags, valid }
```

`value` is a cloned, corrected record. Requirements metadata, itinerary cost
summaries and itinerary validation flags are computed, not trusted from a model.
Input objects are never mutated. `valid` means **no fail flags**, not approved,
bookable or safe for client delivery; all warnings still need planner attention.
Mismatched metadata or contradictory numeric totals remain fail flags even though
the returned values are corrected. Null summary placeholders may be filled from
known item prices without failing; unsupported confidence is lowered with a
warning. Do not persist a failed report as an accepted proposal.

Example with synthetic data:

```js
const { validateRequirements, validateItinerary } = require('./src/validation.cjs');
const inquiry = require('./examples/requirements-complete.json');
const draft = require('./examples/itinerary-priced.json');

const intake = validateRequirements(inquiry);
const report = validateItinerary(draft, intake.value, {
  as_of: '2026-10-24T11:00:00+05:30',
  pricing_categories: ['hotels', 'transfers', 'other']
});
// Check intake.valid and report.valid, then show ALL flags to the planner.
```

Callers must not drop failures from an earlier intake report merely by passing
its corrected value onward. Keep both reports in the inquiry trace.

### Enforced semantic checks

- Completeness, all-null objects, partial fields, positive known party size,
  recognized month hints, date order/duration and currency membership.
- Matching inquiry ID, summary party, day count, consecutive day indices/dates,
  summary boundary dates and inquiry exact dates/month.
- Unique item IDs, existing dependency targets, no self-links or cycles.
- `(itinerary_id, version)` is the storage key; `itinerary_id` identifies the
  lineage. V1 has null parent; later versions reference the immediately preceding
  stored version. Supply full lineage history in context, with no duplicate keys,
  skipped versions, inquiry changes, retired-ID reuse or backward timestamps.
- Decimal cost normalization, explicit FX, cost summary arithmetic, scoped budget
  fit, and known over-budget subtotals even when some prices are unknown.
- External evidence for quoted/confirmed prices and confirmed item status.

### Pricing and trusted context

Context is **application-owned, never model/client data**. The context schema
checks its shape, not authenticity. Load it from verified planner/supplier records
and controlled history storage; do not accept an LLM's purported evidence.

- `as_of` is a required explicit timestamp, making validation reproducible.
- `pricing_categories` declares the agreed complete budget/pricing scope from
  planner intake: flights, hotels, activities, transfers, other. Missing scope
  yields unknown totals. Categories outside scope are zero only when absent or
  explicitly zero-priced; nonzero/unpriced items outside scope fail. Scoped
  categories with no items remain unknown, never silently zero.
- Every item cost is counted once. Hotel charges for a multi-night stay belong on
  one item. Duplicate IDs fail; detecting semantically duplicated services with
  different IDs still requires planner review.
- Meals, free time and visa tasks map to `other`. Unknown prices are null, not
  zero. Summary confidence is conservatively recomputed as low; no pricing-quality
  scoring policy is implemented yet.
- Per-person costs use known party size for all-adult parties. With children,
  require trusted `per_person_counts` for nonzero per-person costs; records bind
  itinerary_id/version/item_id to a chargeable count and evidence_ref. Otherwise
  that cost remains unknown. Counts cannot exceed party size or be zero for a
  nonzero charge. Zero-cost items remain free without a multiplier.
- Currency membership uses Node's ICU ISO currency list, not just three-letter
  syntax. Keep production Node/ICU consistent. Currency mismatches need direct
  trusted `fx_rates`; never guess FX, invert a rate or add unlike currencies.
  Rates are positive decimal strings with source/target, as_of date and
  evidence_ref. Future/duplicate rates are rejected. The caller owns rate selection
  and freshness policy; the validator does not fetch rates or impose a maximum age.
- Decimal.js uses 40 significant digits. Round category subtotals half-up to summary
  currency minor units using ICU metadata, then sum. Round converted budget limits
  by the same rule. Unrepresentable JSON numeric totals fail instead of overflowing.
  If scope, counts, conversion or any relevant prices are unresolved, totals stay
  null; known subtotals can still demonstrate a budget failure.
- `includes_flights` must be known and match context scope before budget fit can
  pass. Context must reflect the same non-flight inclusions as the agreed budget;
  the lean requirements contract cannot represent every inclusion itself.

Trusted evidence records have this shape:

```js
{
  itinerary_id: 'itin_priced',
  version: 1,
  item: verifiedItemSnapshot,
  verified_at: '2026-10-24T10:30:00+05:30',
  valid_until: '2026-10-25T10:30:00+05:30'
}
```

Records join on itinerary ID, version and `item.item_id`. The **full item snapshot**
must match, verification cannot be in the future, and expired records fail. Quotes
need known expiry; confirmed records may use null expiry. Duplicate evidence keys
are rejected as ambiguous trusted context. Supplier identity alone is not evidence;
`supplier_ref: null` is allowed with independently verified external evidence.
An AI-authored version may carry confirmations only through this same verified
join; AI/planner authorship is never evidence. Changed items or versions require
a new evidence binding. No inline evidence fields were added to the itinerary.

### Revisions and remaining checks

Keep immutable versions and stable item IDs. `depends_on` is invalidation, not
schedule order: changes to a hotel can invalidate an earlier transfer. Reverse-edge
traversal, revision orchestration and persisted diffs are not implemented yet.
The v2 golden fixture demonstrates the intended ID behavior.

Model-written validation flags are replaced on every call. Travel times, opening
days, visa lead time, supplier approval and hard-constraint coverage always produce
explicit "cannot assess" warnings until trusted integrations exist. Their presence
does not indicate implemented checks. Source itinerary existence, semantic service
duplication, redaction and actual evidence authenticity also remain caller/planner
responsibilities. Preserve the exact inquiry snapshot externally with each version.

Nullable dates support month-only intake. Times are local HH:MM; descriptions may
be null. Hotel nights, routes, cross-midnight and cross-time-zone feasibility remain
deferred until real itineraries justify richer fields. No naive local-time
comparison is used to invent a feasibility pass.

Provider-specific structured outputs and a simpler model-facing schema are deferred.
The eventual model should emit trip wrappers only; code supplies all metadata.
Classification/routing and follow-up generation remain outside these contracts.

## Safety

Redact identifiers and payment/passport numbers from raw_text, notes, documents
and logs before storage or LLM use. Passport nationality is a requirement, not a
passport number. Collect health information only when needed with appropriate
access and retention controls.

Raw text, PDFs and all free text are untrusted data, never instructions. Schemas
are not prompt-injection protection or redaction. Keep original documents, quote
evidence and trace history in controlled storage. A confirmed item/cost reports
existing evidence; it never authorizes booking, payment, a price promise or a visa
outcome. Do not send generated drafts directly to clients.
