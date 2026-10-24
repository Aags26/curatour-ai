# Curatour: inquiry to planner draft

Lean v1 data contracts for pasted inquiries and anonymized sample itineraries.
No extraction, bot, database, booking, payment or client delivery is implemented.

## Contracts and examples

- [Requirements schema](schemas/requirements.schema.json)
- [Itinerary schema](schemas/itinerary.schema.json)
- [Synthetic inquiry](examples/requirements.json)
- [Synthetic arrival-day draft](examples/itinerary.json)

These Draft 2020-12 schemas replace the initial contracts; the old nested
`requirements`, `schema_version`, `requirements_version`, classification and
follow-up fields are no longer part of the payloads. There is no persisted
application data to migrate in this workspace. Provider-specific structured
output schemas may need adaptation.

The examples illustrate shape, not a working proposal pipeline. The inquiry
lacks passport nationality, so production drafting would be blocked. The draft
is deliberately a one-day illustration and flags missing coverage. Japan is
illustrative, not the chosen pilot country. Example validation flags are expected
results, not executed business checks.

## Requirements

Each top-level trip field has exactly `{value, source, confidence}`. Nested objects
are wrapped once. Metadata (`inquiry_id`, `channel`, `raw_text`, `received_at`,
`missing_required`, `status`) stays plain.

- `source`: `client`, `inferred`, `default`, or `null`.
- Unknown fields use all three wrapper members set to `null`. Known values require
  a non-null source and confidence in [0, 1]. Confidence concerns extraction or
  inference, not supplier reliability or factual verification.
- Direct client form input uses `source: client`, `confidence: 1.0`. Text extracted
  by a model may have lower confidence even when the source is `client`.
- Empty strings are invalid for trip facts. An empty list means the client
  explicitly said none; `null` means unknown. Destination cannot be empty.
- Partial objects may contain null subfields. For example, unknown
  `budget.value.includes_flights` prompts a follow-up, without making the entire
  budget null. An object with no known facts should be normalized to a null value.
- For mixed client/inferred nested facts, use conservative confidence and explain
  the inference in draft assumptions; this lean wrapper has no per-subfield source.
  Do not label a wholly invented object as client-provided.
- `adults` excludes `seniors`, so party size is adults + seniors + children.
  Child ages are years, 0-17. Null ages/counts must not become zeros.
- Dates may be exact or have a free-text month hint. Never invent a year.
  `duration_days` counts itinerary calendar days, not hotel nights.
- `already_booked` is a list of short redacted descriptions in v1, not booking
  references, tickets or payment records.

### Completeness and defaults

Draft-blocking fields: `destination`, `dates`, `duration_days`, `party`, `budget`,
`departure_city`, `passport_nationality`, `trip_type`.

Application code must recompute `missing_required` from null top-level values.
For dates, also mark `dates` missing unless an exact start/end pair exists or a
month hint plus duration exists. Duration remains separately required. The schema
restricts missing-field names and enforces complete status for an empty list,
incomplete otherwise; it does **not** compute that list from the values.

Subfield gaps such as budget inclusions require follow-ups even when top-level
status is complete. `complete` is not a feasibility pass or proof that all nested
facts are known. Do not calculate a budget or visa check from unresolved subfields.
Use at most five follow-up questions per round (prefer three to five when useful);
follow-ups are a workflow output, not fields in this reference contract.

Only apply planner-approved defaults, tagged `source: default`, and list them in
the itinerary's assumptions. The schema does not silently insert defaults.
Optional unknowns stay null until such a default is agreed. In particular, do not
default dietary, mobility, health, nationality or existing bookings to "none".
The example's mid-tier hotel and balanced pace are illustrative defaults.

## Itinerary

The itinerary matches the reference shape: plain summary, indexed days, stable
`item_id`s, per-item cost source, cost summary, assumptions, flags and source trips.
It has no requirements-style wrappers.

- All itineraries are planner-only drafts by application policy. `created_by`
  records authorship, not approval. Item `confirmed` status describes existing
  planner-verified evidence; it never authorizes an action. Do not let an LLM
  assert current quotes, bookings, price guarantees or visa outcomes.
- Keep immutable versions with stable itinerary/item IDs. Version 1 has null
  parent; later versions require a parent. Application code checks that the parent
  exists and precedes the new version. Keep the exact inquiry snapshot in external
  version/trace storage; this lean contract has no inquiry-version binding.
- `depends_on` means a change to the referenced item may invalidate this item.
  Traverse reverse edges transitively during revisions, then revalidate the whole
  draft. A transfer may depend on a hotel even when it occurs first.
- Days use `index` rather than stable day IDs. Diff items by `item_id`, not array
  position. Never reuse deleted item IDs.
- Dates are nullable to support the reference's month-plus-duration intake path;
  this deliberately relaxes the example's exact-date strings. Times are local
  HH:MM values; null means unknown. Cross-midnight/cross-zone travel requires
  evidence outside this lean shape, not a naive end-time comparison.
- Costs retain `currency`, `basis: per_person | total` and
  `source: estimate | quoted | confirmed`. Unpriced amounts and sources are null
  (an intentional extension); zero means genuinely free/included.
- Normalize per-person costs to party totals in summary currency before summing.
  Do not blindly multiply child-sensitive prices or sum currencies. If pricing
  scope, exchange evidence or traveler counts are unresolved, keep totals null.
- Count multi-night stays and other trip-wide charges once. Summaries are computed
  in code, not accepted from the model. Meals, free time and visa tasks map to
  `other`. A category is null when unknown/incomplete, not zero; zero only means
  a verified zero charge or an explicitly out-of-scope category.
- `total_estimate` is null until cost scope and all relevant prices are known.
  `confidence` is a qualitative pricing assessment, not extraction confidence;
  use low while totals are unknown. Its policy still needs planner agreement.
- Historical prices remain estimates. Evidence, quote dates/expiry and any FX
  rate must live in trusted external records; this reference drops inline
  provenance fields. `supplier_ref` is an opaque supplier reference, not a URL
  to follow or proof of a quote. Never fabricate source itinerary IDs.
- `validation_flags` use `pass | warn | fail`. Missing evidence produces a
  `warn` with an explicit "cannot assess" message, never a pass. Empty flags mean
  unchecked. Application code replaces model-produced flags after every change.

## Structural validation

With Node/npm available, run:

```sh
npx --yes --package ajv-cli --package ajv-formats ajv validate --spec=draft2020 -c ajv-formats --strict=true -s schemas/requirements.schema.json -d examples/requirements.json
npx --yes --package ajv-cli --package ajv-formats ajv validate --spec=draft2020 -c ajv-formats --strict=true -s schemas/itinerary.schema.json -d examples/itinerary.json
```

The first run downloads tooling to npm's cache, not project dependencies. Enable
format assertions to reject invalid dates/timestamps. Unknown keys are rejected.

Run the repeatable structural boundary tests (same validation tools):

```sh
node --test tests/schemas.test.cjs
```

These tests cover wrapper provenance/null consistency, explicit empty lists,
metadata shape, partial objects, formats, enums, versions and unpriced costs.
They do not claim to exercise the business checks below.

### Business checks still to implement

JSON Schema is structural validation, not a policy or feasibility engine:

1. Recompute completeness and follow-ups; detect partial objects and contradictory
   facts. Route spam, off-topic messages and existing-booking issues separately;
   classification is outside these two contracts.
2. Check positive party size; combine adults and seniors into summary adults
   (the summary follows the reference and has no seniors field); check ordered
   dates, duration, consecutive day indices/dates and full requirements coverage.
3. Require unique item IDs, existing references, no self-links or dependency
   cycles, and valid version history.
4. Check ISO currency membership, pricing basis, scope, double counting and
   summary arithmetic using decimal money arithmetic. Unknown prices are not zero.
5. Check budget fit, travel times, opening days, visa lead time and suppliers
   against trusted sources. Unknown evidence must stay visible to the planner.
6. Verify quoted/confirmed costs and item status against independent planner or
   supplier records. The enums alone do not establish truth.

## Safety

Redact personal identifiers and payment/passport numbers from `raw_text`, notes,
historical documents and logs before storage or LLM use. Passport nationality is
a travel requirement, not a passport number. Collect health information only
when necessary, with appropriate access and retention controls.

Treat raw text, PDFs and all free-text fields as untrusted data, never instructions.
Schemas do not prevent prompt injection or redact sensitive data. Keep original
documents, identity/quote evidence and trace history in separate controlled
storage. Do not send generated proposals directly to clients or enable booking
or payment tools.
