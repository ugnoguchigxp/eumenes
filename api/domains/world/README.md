# World (host side)

The host integration of the `eumenes-world-model` package (vendored tgz). World
semantics and SQL live in the package; this domain is the glue: source adapter,
Memory registration, forget/restore lifecycle, the names-only context hint, `world.query` and its research route.

## Assembly (`api/application/world/world.ts`)

`server.ts` builds World through `assembleServerWorld` (`api/application/server-world.ts`)
and `createWorldAssembly`. The mode is decided once at backend startup by
`resolveWorldMode` from the saved setting `world.enabled` (SQLite settings document,
boolean, default `false`; edit it on the settings screen "会話" or through
`POST /api/settings/apply`) and from whether World holds content (`worldHasContent`):

| `world.enabled` | World content | Mode | Effect |
|---|---|---|---|
| false (default) | none | `off` | Nothing is assembled. The application behaves exactly as before. |
| false | exists | `protect` | Lifecycle only: startup recovery, forget intake, feed consumers, release sweeps. World is forced OFF at startup; it reads and writes no content on its own. |
| true | any | `on` | `protect`, plus the first feed pass (initial sync) and then World is turned ON. |

A change of the setting takes effect on the next backend start (the initial sync and the
gate are startup work); the settings screen says so. Turning World off therefore never stops
forget propagation while World content remains: the next start is `protect` by itself.

"Content exists" (`worldHasContent(store)`, `service/world-content.ts`) is true when any of
`world_entity`, `world_assertion`, `world_inbox`, `world_host_extract_event` or
`world_host_forget_intake` has a row (any Scope). It does not depend on the ON/OFF flag or
the gate, so it works before World is assembled. When it selects `protect`, the log line
`world.protect_for_content` is written once at startup.

`EUMENES_WORLD` is no longer read.

Other environment variables (unchanged):

- `EUMENES_WORLD_JOURNAL`: World journal path. Default `world-forget-journal.jsonl`
  next to the Memory journal.
- `EUMENES_WORLD_POLL_MS`: safety-net poll (default 15000, minimum 1000 from the env).
- `EUMENES_WORLD_CURSOR_SECRET`: cursor secret (at least 32 characters). Optional, see below.

### Startup and shutdown order

1. `memory.recover()`
2. `world.recover({ feedResyncRequired })` (journal replay, restore detection, gate opens only after full reconcile; never aborts startup, a failure leaves the gate closed)
3. other recoveries, `queue.recover()`, `queue.start()`
4. `world.start()` (commit-notification and poll triggers)
5. shutdown: `world.close()` (stop triggers, wait for the pass in flight) before any store close

The names-only hint (`assembly.context`, `createWorldContextNames`) is passed to `createDialogueService` as
`worldContext`. It reads the Scope's live target names and tells the conversation model which of them the
utterance mentions; it carries no claim, no relation and no usage receipt. With World OFF it answers `disabled`
and dialogue behaves as it always did.

World content reaches the answer only through the research route: the conversation model delegates to the
`world.query` toolchain, whose sub-agent calls `world.find` (names to target ids and matching adopted goals) and
`world.query` (`api/application/world/world-research-ports.ts`). Each claim read becomes a `world_claim` Source and is
re-checked when the report is adopted (same revision, not ended, and its source utterances still resolvable, so a
forget whose World tombstone is still pending cannot support a report). The old per-turn context broker and the
usage receipts are gone; `service/usage-ledger.ts` only cleans rows older versions left.

`world.query` keeps the complete input-version manifest (including representation and digest) and the
original evidence refs (including byte ranges and quote digests). Research Sources retain the whole
value, predicate, condition and valid time; they are fitted as whole items to the existing byte bounds.
A bounded or omitted read stays partial. The updated package also supports exact assertion refs in
the public Slice API; this is covered on the host store without adding a model-facing selector or
changing the names-only conversation hint. See [the integration record](../../../spec/world-evidence-integration-2026-10-31.md)
for fixed-fixture evidence and the remaining model-acceptance gate.

### Consumers

`pump()` runs the conversation outbox consumer and the Memory change-feed
consumer (bounded pages). Triggers: a debounced `store.onCommit` notification
(feeds only) and the poll (feeds, stuck forgets, `sweepPendingReleases`, and a
retry of recovery while the gate is closed). The consumers never create
inference requests and World owns no model call at all: extraction is the steward's
`curate-world` step (see "Curation"). After a pass that received events, the feed consumer
calls `intake.onEventsReceived(conversationIds)` once the receiving transaction committed;
the application routes it to the steward's kick. A feed pass with nothing new writes
nothing (the cursor save is a no-op), so idle polling causes no commit and no change-stream
traffic.

### Enabling

`assembly.setEnabled(true)` runs the initial sync, then turns World ON; the
database refuses ON until `markInitialSyncComplete` was recorded. The initial
sync drains both change feeds from the start (bounded, 2000 pages each) and
records the flag only when both are drained. There is no HTTP route or UI.
Explicit registration (targets, structured claims) by the host goes through
`assembly.service.apply(...)`. The steward curates conversation input through
`assembly.curation` (below).

### Cursor secret

Masks and authenticates the conversation change cursor. It is host-owned and
never derived from database content: `EUMENES_WORLD_CURSOR_SECRET` if set, else
`<db dir>/keys/world-cursor.key` (32 random bytes as hex, directory 0700, file
0600, created once). A short or damaged file fails startup and is never
replaced silently. If the secret does change, the next pass cannot decode the
stored cursor; the assembly answers with a restore (new epoch, cursors dropped,
feeds read again), it does not stay stuck.

## Continuous input and curation (P4-01, steward-driven)

### Input receipt and progress (`service/extraction-intake.ts`, `repository/extraction.ts`)

The source outbox and Memory's change feed keep SEPARATE cursors. A source-feed
page is handled in ONE writer callback, in this order: retractions become forget
intakes, corrections stop the claims standing on the old version, and only then
every remaining input is handed to World's inbox (`inbox.receive`, event id = hash of
the Scope and the exact message revision, so a resend, a resync or a wider Scope set is
the same event) and the cursor is saved. If that callback fails (database, Writer)
nothing of it remains and the cursor does not move; a deterministic World refusal of one
event records that input as `skipped` and never holds a retraction on the same page. The
semantic application is a later step (`candidate.settle`, see "Curation") and moves a
separate World checkpoint.

What is an input (`isExtractionInput`, decided with the host's `IntakePorts`):

| Message | Input? |
|---|---|
| user message, added or corrected | yes |
| assistant message, `added`, and `intake.isAdoptedAnswer(db, messageId)` (its run completed) | yes |
| assistant message that no run adopted, a corrected answer, a retraction | no |
| any message `intake.blockedMessageIds` names (the steward's exclusion ledger) | no: recorded `skipped SOURCE_BLOCKED` |

`isAdoptedAnswer` must already be true when the feed first sees the message (the answer and
its run's completion commit together). The host record keeps the `speaker` and the
`conversation_id` of every event (migration `world/0009-extraction-steward`). Without
`intake` ports (tests) only user messages are input and nothing is blocked.

- `lifecycle.feedStages(scope)` answers, per feed: owner (more at the source?),
  scanned (host cursor), received (delivered to World's inbox, with the cursor of
  the newest event) and applied (settled events; `cursor` is the received cursor
  of the settled PREFIX: it never passes the oldest unsettled event, and
  `pending` events are never counted as applied). The package checkpoint's applied cursor is
  the last event settled, in settle order (the steward settles per conversation, so the
  order across conversations is not the arrival order); the host's prefix is what is reported.
- The package has no read API for `world_inbox`/`world_checkpoint`, so the host
  keeps its own record, `world_host_extract_event`, written in the SAME writer
  callback as every `inbox.receive`/`candidate.settle` (ids and opaque cursors,
  no text). Events received before `world/0009` have no conversation and are never listed
  for the steward (history is not backfilled).
- Input scanned while World is OFF or its gate is closed is recorded as
  `skipped` and never delivered or extracted. There is NO backfill of history: a
  resync (restore, Scope change) does not extract old messages for the first time.
- A different Scope set (`LifecycleOptions.scopes`) or a restore epoch change
  discards the cursors and reads the feed again. Known events are skipped by id,
  an unsettled event settles under the FeedSpec it was delivered under, and a
  restore deletes the unsettled records together with World's inbox rows.
- A forget names the extraction events of the forgotten sources as `candidate`
  roots and deletes the host record (any state): nothing of the message remains.
- Memory feed content is NOT an extraction input (no content reader exists).

### Curation (`service/curation*.ts`, `createWorldCuration`, `assembly.curation`)

The World half of the steward's `curate-world` step. The steward owns the model call (on the
conversation's route, cloud allowed) and the transaction; every operation below runs inside the
transaction the caller owns, and a thrown error means "roll that transaction back". No queue job
and no model call exists in this domain.

| Operation | What |
|---|---|
| `pendingEventsInTransaction(db, scope, limit, conversationId?)` | received, unsettled events, oldest first: message id, revision, digest, speaker, conversation id, seq. A window that was held is not listed until the Scope's entities changed. With `conversationId` only that conversation's events are read (in the query, so the limit counts offerable events only); events without a conversation never block. |
| `prepareCurationInTransaction(db, { scope, eventIds })` | re-reads the sources, builds the window (12 utterances / 32 KiB / 32 dependencies, the package's `prepareExtraction`), registers Memory's external dependents BEFORE any model sees the text, and returns what the model sees plus an opaque host table. It may write (events whose source is gone, superseded, too large, blocked or an un-adopted answer are settled `rejected` for good and listed in `finalized`), so the caller commits even when the status is not `ready`. |
| `settleCurationInTransaction(db, { prepared, output })` | re-validates (forget epoch, sources, entities), checks every element, places the claims event by event and adopts them, all in the caller's transaction. |
| `settleEmptyInTransaction(db, scope, eventIds)` | events routed out: settled `applied` with no candidates (`ROUTED_EMPTY`). |
| `giveUpEventsInTransaction(db, scope, eventIds)` | `rejected STEWARD_GAVE_UP`, final. |
| `releaseCurationInTransaction(db, scope, eventIds)` | gives back the Memory dependents of a prepare that was never settled. Idempotent. |

What the model sees (`PreparedCuration.model`): the utterances (`e1..`, speaker `user` or
`assistant`, text), at most 30 candidate entities (`w1..`, name and aliases: entities whose
name/alias starts with a word of the utterances, then the entities of the most recently recorded
claims; relation objects of the shown claims are added up to 40) and the live claims about
them (`c1..`, at most 40, newest first). Entities have no kind: the type of an entity is a claim.
No host id, event id or message id is shown. A window that does not fit leaves the rest pending
(`deferredEventIds`).

The model's answer (`CurationOutput`) is `{ entities: [{ name, aliases }], claims: [{ op:
assert|correct|retract, ref, subject, predicate, value, relation, evidence, origin, validFrom,
validUntil }] }`; `subject` is `w1`, `new:<index of an entity of this output>` or a plain name
resolved among the shown entities (ambiguous or unknown: the window is `held`). There is no
entity `alias` operation (the package cannot add an alias to an entity) and no free text
`condition` (a condition is left `unspecified`: the package's conditions are structured
expressions over observations). Each element is judged on its own and dropped with a reason
code (host codes lower case: `origin_mismatch`, `unknown_ref`, `unknown_evidence`,
`invalid_element`, `invalid_valid_time`, `duplicate_claim`, `claim_conflict`,
`correct_requires_user_report`, `retract_requires_user_report`, `correct_target_mismatch`, `not_in_evidence`,
`unused_entity`, `entity_overflow`; World's upper case: `CANDIDATE_OVERFLOW` for the 9th claim, validator codes):

- evidence, ids, times and the quote (the whole utterance) are the host's; `validateCandidates` checks the rest;
- grounding: the subject and the relation object of a claim must be named in its evidence utterance
  (the entity's name or an alias, or the name being registered; NFKC, trimmed, case-insensitive,
  Latin-script edges need non-alphanumeric boundaries), and so must the subject of the claim a
  `correct` or `retract` targets, else `not_in_evidence`. A new entity whose name occurs in no
  utterance of the window is not registered (`not_in_evidence`), nor is one that no claim to be
  written names as subject or relation object (`unused_entity`);
- speaker and origin: a user utterance gives `user_report` only, an assistant answer
  `model_hypothesis` only (a mismatch is dropped `origin_mismatch`). The package knows no
  assistant utterance origin, so an assistant answer is passed as `document_claim`; its evidence kind is
  therefore `document` and the claim's origin `model_hypothesis`;
- adoption (steward plan section 3.3), all explicit adoptions in the same transaction: `user_report` -> active,
  `model_hypothesis` -> active with the `hypothesis` tone, `correct` (the person's words, a value claim of
  the same subject and predicate) -> supersede + adopt; a `correct` of a relation claim is, in the same
  settle, a retract of it plus an assert of the new relation (same subject and kind, new object; two
  elements under the claim's index), `retract` -> retract with the message as reason;
- a result is `stale` (nothing written, dependents released) when World is unavailable, the forget
  epoch moved, an event is gone or changed, a source became blocked, or a shown entity changed; an
  answer without the object shape is `invalid_output` (nothing written, events stay pending);
- any `held` candidate holds the WHOLE window: nothing is written, the events record the digest of
  the Scope's entities and are listed again only after it changed. Repeated holds are the
  steward's to count; it ends them with `giveUpEventsInTransaction`;
- the result lists per element what happened and the ids touched (`claimIds`, `entityIds`, `messageIds`)
  for the steward's decision refs.

The Memory dependents registered at prepare are released by settle itself when it does not adopt
(`stale`, `held`, `invalid_output`); `applied` keeps them (they now stand for the claims).

### Forget operations

All are durable intakes in the caller's transaction (`origin: "steward"`); the caller resumes the
forget with `lifecycle.resumeForget(forgetId)` after that transaction committed, so `accepted` is never
`complete`. The Scope's forget epoch moves with the intake.

- `acceptSourceForgetInTransaction(db, { scope, messageIds, reasonCode: "SOURCE_BLOCKED", origin: "steward" })`: messages
  the steward put on the exclusion ledger leave World as forgotten sources (World's tombstone reason is
  `SOURCE_FORGOTTEN`: the package has no other for a source). The forget id is derived from the message set.
- `forgetClaimsInTransaction(db, { scope, claimIds })`, `forgetEntitiesInTransaction(db, { scope, entityIds })`: every
  revision of the claims; the entities with everything on them (the package reaches relations and merged members).
- `evidenceMessagesOf(db, { scope, claimIds, entityIds })`: the conversation messages standing as evidence of those
  claims (every revision) and of the live claims about those entities. Read it BEFORE the forget. Known limit:
  the package's public reads list live claims only, so the evidence of an entity's already retracted or
  invalidated claims is not returned.
- `forgetEpochInTransaction(db, scope)`: a result prepared under another epoch must not be adopted.

## Decision API: `world.query` (P5-01)

`createWorldQuery({ store, world, gapTasks?, resourceStates? })` (`service/world-query.ts`)
is the one product entry for World's pure reasoning. Read-only, enumerated:

| `mode` | Pure API | Needs |
|---|---|---|
| `snapshot` | (projection entries) | optional `entityIds` (<= 10), `depth` (<= 4) |
| `relevance` | `explainRelevance` | `entityId` |
| `influence` | `traceInfluence` | `entityId`, `direction` forward/reverse |
| `dependencies` | `checkDependencies` | `entityId`; resource states come from the host port only |
| `scenarios` | `compareScenarios` | `entityId`, two hypothetical overlays (never stored) |
| `gaps` | `findResearchGaps` | optional `entityIds`, `goalId` (adopted or withdrawn Goal of the scope) |

- No free-form SQL and no graph mutation exist in the request vocabulary. A strict schema
  rejects every unknown key (a `principal`, `sql`, resource states, ...). The caller binds
  `WorldQueryContext` (principal + granted scope keys); the request cannot name a principal.
- Bounds (`WORLD_QUERY_LIMITS`): request 64 KiB, ids 256 bytes, budgets = the C5 defaults
  (a value above it is `limit_exceeded`, never clamped; `candidates`/`expansions` >= 2),
  start points 10, overlay edges 100. A budget stop gives `completeness: "partial"` with the
  reason and the real counters (`retrieval.fetchedRows/expandedRows`).
- Answers: `ok` (with `basis`: the evidence sources, conditions, freshness and refutations of
  every claim named), `disabled` (World OFF), `blocked world_unavailable` (startup gate,
  store closing), `rejected` (`invalid_request`, `unknown_mode`, `limit_exceeded`,
  `not_available`). A scope/Goal not granted, a foreign or non-adopted Goal, a forgotten
  entity and a blocked read all give the one `not_available`; an unknown start entity is an
  empty `ok` (no path found, never "no effect").
- Claim text is reference data (`referenceOnly: true`) and a result grants nothing
  (`executionPermission: "none"`). Gaps are investigation candidates.
- Gap -> Task: `linkGaps: true` hands the first 5 Gaps to the
  host's `GapTaskPort` in one writer transaction. The port checks delegation and budget and
  may deny; World keeps only `world_host_gap_task` (hashed Gap key -> task ref), so the same
  Gap never reaches the port twice. Without a port the answer is `taskLinkage:
  not_accepted`. **Task linkage is NOT accepted against the real Tasks domain**: its only
  kind is `coding` and needs a user-issued workspace grant that a Gap cannot supply; the
  port is tested with a fake host only.
- There is no model tool and no HTTP route for it; the host calls `createWorldQuery` directly.
- Condition evaluation gets no observations here, so a condition on a measurement stays
  `unknown`; an `explicitly_unconditional` claim is satisfied.

## Grounded claim list (P5-02, view only)

`createWorldClaims({ store, world, lifecycle, state, ... })`
(`service/world-claims.ts`) is read by the World screen's adapter (`api/application/world/world-adapter.ts`)
only when World is assembled (mode `protect` or `on`). There is no HTTP route for it. The Scope is bound by
the host (`claimsContext`), never by a body or a query string.

| Read | What |
|---|---|
| `status` | mode, enabled, usable, gate, the granted Scopes |
| `list` | target, claim, adoption, origin/evidence kinds, freshness, `tone` as SEPARATE fields; `complete:false` = a budget stopped the read; `stopped` = claims stopped by a changed source |
| `detail` | condition (`unknown` without observations, never assumed true), supports, refutations, source versions (current / changed / unavailable), history |
| `forgets` | the durable forget intake of the Scope (works with World OFF and with a closed gate): `pending`, `awaiting_confirmation`, `abandoned`, `complete`; only `complete` is "done" |

Claims are kept by the memory steward: the owner can look but not change them (plan G3), so there is no
change operation. A correction, retraction or forget of a claim is a steward operation (`service/curation-adopt.ts`).

- Unknown claim, Scope not granted, other principal, a closed gate and a forgotten claim are ONE
  answer: `not_found`. World OFF is `world_disabled`.
- `claimTone`: only an adopted report/document is `adopted`; an adopted `model_hypothesis` is
  `hypothesis`, a `runtime_observation` is `measured`, and any unadopted claim is `candidate`.
- A forget that stops while advancing is still accepted (the intake is durable) and shown as
  pending; the host's pass resumes it. While a forget is unfinished the Scope gate is closed, so
  the list answers `not_found` and the screen explains that from the forget list.
- No graph, no edge editing, and the screen is a settings page: it is not read aloud.
- Known limits: source text is not shown (opaque id and version only).

## What is fixture-grade

- Deterministic evidence uses a fixture inference port and a TTS spy. No real Local Provider was run; curation runs on the conversation route and its live acceptance is the steward's.
- Curation is covered with a fixture model (a function of what it is shown) on the real store, the real
  World package and the real conversation adapter (`test/curation-*.test.ts`). Extraction quality on a real model is
  not measured here; the steward's live acceptance does that.
- No product entry point forgets a message yet. Nothing calls `conversation.retract` or Memory's host-source forget in production; the acceptance test composes both. The consumers handle either when it happens.
- Only the default Scope (`local:owner` / `profile:owner`) is consumed.
- Answers already adopted stay in the conversation history. They are conversation data and are removed by the conversation domain, not by World.
- The initial sync reads the outbox. Messages that predate the outbox have no events; a retracted one is unreadable to World anyway (`SOURCE_NOT_AVAILABLE`).
- Migrations were run on temp databases only; running them on a product database is an operations step.

## Tests

- `api/domains/world/test/*`: World domain, lifecycle, names hint (real store, production migrations);
  `change-feed.test.ts` (P4-01: A28, A29, A42), `curation-*.test.ts` (claims, entities, windows, settle, pending, forget operations; shared rig in `curation-fixture.ts`)
  and `steward-migration.test.ts`.
- `api/application/world/world.test.ts`: mode flag, cursor secret, enabling, idle quietness, cursor reset.
- `api/application/world/world-acceptance-p3.test.ts`: P3-09 on the real assembly (A34 host side, A35 to A41). It lives in `application` because the world domain may not depend on dialogue, voice or queue.
- `api/domains/dialogue/test/world-context.test.ts`: the names-only hint in the dialogue.
- `api/application/world/world-research.test.ts`: the research route end to end (find, query, adoption re-check, forget, readings limits).
- `api/domains/world/test/world-query.test.ts`: P5-01 (A14 to A16, A47) on a real store, fake host Task port.
- `api/domains/world/test/world-claims.test.ts`, `api/application/world/world-claims-http.test.ts`: P5-02 server side (A48) on a real store and the real HTTP app. Web: `web/src/components/domains/world/WorldPanel.test.tsx`; browser: `tests/browser/world.spec.ts` against `api/application/world/world-claims.fixture.ts` (fixture backend, stub model).
- Run: `bun test api/application/world/world*.test.ts` and `bun run verify -- --domain world`.
