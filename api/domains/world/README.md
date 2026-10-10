# World (host side)

The host integration of the `eumenes-world-model` package (vendored tgz). World
semantics and SQL live in the package; this domain is the glue: source adapter,
Memory registration, forget/restore lifecycle, Context Broker, usage receipts.

## Assembly (`api/application/world.ts`)

`server.ts` builds World through `createWorldAssembly`, behind one switch:

| `EUMENES_WORLD` | Effect |
|---|---|
| unset, `off`, `0`, `false` (default) | Nothing is assembled. The application behaves exactly as before. |
| `protect` | Lifecycle only: startup recovery, forget intake, feed consumers, release sweeps. World is forced OFF at startup; it reads and writes no content on its own. |
| `on` (`1`, `true`) | `protect`, plus the first feed pass (initial sync) and then World is turned ON. |

Any other value fails startup (`world_mode_invalid`): a typo must not mean "no forgetting".
Going from `protect`/`on` back to `off` stops forget propagation; keep `protect`
while World content exists in the database.

Other settings:

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

The Broker port (`assembly.context`) is passed to `createDialogueService` as
`worldContext`. With World OFF it answers `disabled` and dialogue behaves as it always did.

### Consumers

`pump()` runs the conversation outbox consumer and the Memory change-feed
consumer (bounded pages). Triggers: a debounced `store.onCommit` notification
(feeds only) and the poll (feeds, stuck forgets, `sweepPendingReleases`, and a
retry of recovery while the gate is closed). The consumers never create
inference requests; only in mode `on`, a pass that leaves unsettled input also
schedules ONE `world.extract` queue job (see "Local extraction"). A feed pass with nothing new writes nothing (the cursor save is
a no-op), so idle polling causes no commit and no change-stream traffic.

### Enabling

`assembly.setEnabled(true)` runs the initial sync, then turns World ON; the
database refuses ON until `markInitialSyncComplete` was recorded. The initial
sync drains both change feeds from the start (bounded, 2000 pages each) and
records the flag only when both are drained. There is no HTTP route or UI.
Explicit registration (targets, structured claims) goes through
`assembly.service.apply(...)` with `manualAccess()`; there is no extraction yet.

### Cursor secret

Masks and authenticates the conversation change cursor. It is host-owned and
never derived from database content: `EUMENES_WORLD_CURSOR_SECRET` if set, else
`<db dir>/keys/world-cursor.key` (32 random bytes as hex, directory 0700, file
0600, created once). A short or damaged file fails startup and is never
replaced silently. If the secret does change, the next pass cannot decode the
stored cursor; the assembly answers with a restore (new epoch, cursors dropped,
feeds read again), it does not stay stuck.

## Continuous input and Local extraction (P4-01, P4-02)

### Input receipt and progress (`service/extraction-intake.ts`, `repository/extraction.ts`)

The source outbox and Memory's change feed keep SEPARATE cursors. A source-feed
page is handled in ONE writer callback, in this order: retractions become forget
intakes, corrections stop the claims standing on the old version, and only then
every remaining user addition/correction is handed to World's inbox
(`inbox.receive`, event id = hash of the Scope and the exact message revision, so
a resend, a resync or a wider Scope set is the same event) and the cursor is
saved. If that callback fails (database, Writer) nothing of it remains and the
cursor does not move; a deterministic World refusal of one event records that
input as `skipped` and never holds a retraction on the same page. The semantic
application is a later step (`candidate.settle`, see below) and moves a separate
World checkpoint.

- `lifecycle.feedStages(scope)` answers, per feed: owner (more at the source?),
  scanned (host cursor), received (delivered to World's inbox, with the cursor of
  the newest event) and applied (settled events; `cursor` is the received cursor
  of the settled PREFIX: it never passes the oldest unsettled event, and
  `pending` events are never counted as applied). The Memory feed has no inbox
  stage (its notifications become forget intakes/invalidations in the same
  callback as the cursor).
- The package has no read API for `world_inbox`/`world_checkpoint`, so the host
  keeps its own record, `world_host_extract_event`, written in the SAME writer
  callback as every `inbox.receive`/`candidate.settle` (ids and opaque cursors,
  no text). World's tables stay authoritative for World; tests cross-check the
  two. A package read API would let the host drop the record.
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

### Local extraction (`service/extraction-handler.ts`)

Queue kind `world.extract`, background lane, resource `inference.llm` (capacity 1),
2 attempts. `createWorldAssembly({ extraction: { queue, inference } })` registers
it ONLY in mode `on`; `protect`/`off` have no such job kind. `pump()` schedules
after the feed passes: unsettled input becomes ONE job per Scope (the oldest
events, at most 12); no input, nothing in backoff, or World OFF/gate closed
creates no job and so no model call.

- prepare: re-reads every source through its adapter (retracted/changed events
  are settled `rejected`, in order), builds the window with the package's
  `prepareExtraction` (12 utterances / 32 KiB / 32 dependencies; an utterance that
  cannot be split is final `rejected UTTERANCE_TOO_LARGE`, the next window starts
  after it), registers Memory's external dependents of one manifest per event
  BEFORE the model sees the text (refused -> `stale`, execute is never called),
  then captures the inference request. Everything is fixed here.
- execute: `captureMaintenanceControlInTransaction` + `executeControl` only (the
  inference control path: route pinned to `larm-only`, `cloudAllowed=false`,
  JSON output, exact context). 30 s stage budget; on expiry the call is aborted
  and must be CONFIRMED ended (5 s) before the attempt is reported as
  `extract_timeout` (retried once by the queue). A call that never ends gives
  `extract_cancel_unconfirmed` (no retry) and the next execute is refused
  (`extract_slot_busy`) until it ends: the slot is not reused.
- settle: any source version that moved since prepare voids the result (nothing
  adopted, events stay pending). The prompt/interpretation version/entities JSON
  snapshot is also rechecked; changing it voids the old result. Otherwise `validateCandidates` runs against the
  current states; ids, lifecycle (always `candidate`), origin, evidence ids and
  times are assigned by the host, never the model. Malformed/oversize output ->
  events `rejected` (final). 9th and later candidates -> `CANDIDATE_OVERFLOW`.
  Accepted drafts and the manifest go through `candidate.settle` per event, in
  order, in the queue's settle transaction with the inference receipt; any
  failure rolls everything back.
- Any `held` candidate holds the WHOLE window: no drafts, package settle or applied
  cursor are written. Host and package inbox stay `received`. Memory manifests and
  the inference request are released using the existing lifecycle. A host-only
  `held_context_digest` prevents another job/request for the same extraction
  context, including after restart. New context permits re-evaluation. An unchanged
  held head blocks later application; source retraction/correction and forget still
  take priority. Empty valid output and final rejected output keep their existing policy.
- `world/0008-extraction-hold` appends a nullable column; old terminal events are
  not reopened and history is not re-extracted. An older binary refuses a database
  with this unknown migration. Downgrade by ignoring the column is not supported;
  keep the migrated binary or use a separately planned backup restoration.
- Failures that are not about the content (provider unavailable, timeout, Memory
  refusal) leave the events pending with an exponential backoff (30 s .. 15 min).

**Local classification relied on.** "Local" is the registered LARM section of the
settings, reached through the inference control path that pins the route to
`larm-only` with `cloudAllowed=false`; prepare reads the request snapshot back
and refuses to run unless it says so (no snapshot, no proof, no run). A LAN
address is never the criterion. Cloud fallback does not exist on that route.

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
- Gap -> Task: `linkGaps: true` (not in the model vocabulary) hands the first 5 Gaps to the
  host's `GapTaskPort` in one writer transaction. The port checks delegation and budget and
  may deny; World keeps only `world_host_gap_task` (hashed Gap key -> task ref), so the same
  Gap never reaches the port twice. Without a port the answer is `taskLinkage:
  not_accepted`. **Task linkage is NOT accepted against the real Tasks domain**: its only
  kind is `coding` and needs a user-issued workspace grant that a Gap cannot supply; the
  port is tested with a fake host only.
- `createWorldQueryTool` is the model-callable definition (id `world.query`); registering it
  in the capability catalog / tool runtime is host wiring in those domains (not done).
  `registerWorldQuery` (`controller/`) is `POST /api/world/query`, not mounted by default.
- Condition evaluation gets no observations here, so a condition on a measurement stays
  `unknown`; an `explicitly_unconditional` claim is satisfied.

## Grounded claim list and correction screen (P5-02)

`createWorldClaims({ store, world, lifecycle, state, reasonSource, ... })`
(`service/world-claims.ts`) behind `registerWorldClaims` (`controller/claims.ts`), mounted by
`createApp({ worldClaims })` only when World is configured (`EUMENES_WORLD` protect or on). With
World OFF nothing is assembled and every `/api/world/*` route is a plain 404 (the bearer and
origin checks of `/api/*` still come first). The Scope is bound by the host (`claimsContext`),
never by a body or a query string.

| Route | What |
|---|---|
| `GET /api/world/status` | mode, enabled, usable, gate, the granted Scopes |
| `GET /api/world/claims[?scopeKey]` | list: target, claim, adoption, origin/evidence kinds, freshness, `tone` as SEPARATE fields; `complete:false` = a budget stopped the read; `stopped` = claims stopped by a changed source |
| `GET /api/world/claims/:id[?scopeKey]` | detail: condition (`unknown` without observations, never assumed true), supports, refutations, source versions (current / changed / unavailable), history |
| `GET /api/world/forgets[?scopeKey]` | the durable forget intake of the Scope (works with World OFF and with a closed gate): `pending`, `awaiting_confirmation`, `abandoned`, `complete`; only `complete` is "done" |
| `POST /api/world/claims/correct` | explicit correction: supersede + explicit adoption in ONE writer transaction, citing the person's own confirmed message (`reasonMessageId`) |
| `POST /api/world/claims/retract` | explicit retraction; the reason source is the person's own confirmed message |
| `POST /api/world/claims/forget` | durable intake of a forget of every revision of the claim; the answer is `accepted` with the ledger's own state |

- Every change carries `expectedRevision` (what the person saw) and a `requestId` (one per action).
  A different current revision is `409 {error: "revision_conflict", reload: true}` and nothing is
  written. The target is `{claimId}` or `{subjectId, predicate}`; a selector that matches more than
  one live claim answers `200 {status: "unresolved", candidates}` and writes nothing.
- Unknown claim, Scope not granted, other principal, a closed gate and a forgotten claim are ONE
  answer: `404 {error: "not_found"}`. World OFF is `409 world_disabled`.
- `claimTone`: only an adopted report/document is `adopted`; an adopted `model_hypothesis` is
  `hypothesis`, a `runtime_observation` is `measured`, and any unadopted claim is `candidate`.
- A forget that stops while advancing is still accepted (the intake is durable) and shown as
  pending; the host's pass resumes it. While a forget is unfinished the Scope gate is closed, so
  the list answers `not_found` and the screen explains that from the forget list.
- No graph, no edge editing, and the screen is a settings page: it is not read aloud.
- Known limits: correction and retraction need a confirmed message of the person as the reason
  (the screen offers the latest 20 of the main conversation); a relation claim cannot be
  corrected by value; source text is not shown (opaque id and version only); a retry of an
  already applied change is a revision conflict (reload shows the result); the forget intake
  covers revisions up to the one the person saw.

## What is fixture-grade

- Deterministic evidence uses a fixture inference port and a TTS spy. No real Local Provider was run: `api/application/world-real-local-provider.test.ts` is skipped by default, fails on purpose when forced, and is reported as **not executed** (carried to P4-05).
- Automatic extraction (P4-02) is covered with fixture providers only: a stub LARM
  port behind the REAL queue and inference service (`api/application/world-extraction.test.ts`)
  and fakes (`test/extraction-handler.test.ts`). Extraction quality on a real model is not measured.
- World's entities cannot be listed through the package, so the production
  default for `extraction.entities` is none: every named subject is held
  (`SUBJECT_UNRESOLVED`) until a listing exists. IDs also need to exist in the
  supplied entity snapshot; an empty snapshot does not resolve them. This fix
  preserves held input but does not supply the missing production listing port.
- No product entry point forgets a message yet. Nothing calls `conversation.retract` or Memory's host-source forget in production; the acceptance test composes both. The consumers handle either when it happens.
- Only the default Scope (`local:owner` / `profile:owner`) is consumed.
- Answers already adopted stay in the conversation history. They are conversation data and are removed by the conversation domain, not by World.
- The initial sync reads the outbox. Messages that predate the outbox have no events; a retracted one is unreadable to World anyway (`SOURCE_NOT_AVAILABLE`).
- Migrations were run on temp databases only; running them on a product database is an operations step.

## Tests

- `api/domains/world/test/*`: World domain, lifecycle, Broker (real store, production migrations);
  `change-feed.test.ts` (P4-01: A28, A29, A42) and `extraction-handler.test.ts` (P4-02: A19, A20, A43).
- `api/application/world-extraction.test.ts`: P4-02 on the real queue and inference (no Cloud request observed).
- `api/application/world.test.ts`: mode flag, cursor secret, enabling, idle quietness, cursor reset.
- `api/application/world-acceptance-p3.test.ts`: P3-09 on the real assembly (A34 host side, A35 to A41). It lives in `application` because the world domain may not depend on dialogue, voice or queue.
- `api/domains/dialogue/test/world-context.test.ts`, `api/domains/voice-dialogue/test/world-release.test.ts`: A40 and A41 in depth.
- `api/domains/world/test/world-query.test.ts`: P5-01 (A14 to A16, A47) on a real store, fake host Task port.
- `api/domains/world/test/world-claims.test.ts`, `api/application/world-claims-http.test.ts`: P5-02 server side (A48) on a real store and the real HTTP app. Web: `web/src/components/domains/world/WorldPanel.test.tsx`; browser: `tests/browser/world.spec.ts` against `api/application/world-claims.fixture.ts` (fixture backend, stub model).
- Run: `bun test api/application/world*.test.ts` and `bun run verify -- --domain world`.
