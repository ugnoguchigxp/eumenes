import type { Database } from "bun:sqlite";
import type { ScopeRef } from "eumenes-world-model";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { ConversationService } from "../../conversation";
import type {
	CurationElement,
	CurationPrepareResult,
	CurationSettleResult,
	PendingCurationEvent,
	PreparedCuration,
} from "../../world";
import type { StewardWorld, StewardWorldCuration } from "../service/types";
import type { WorldView } from "../service/world-view";

export const FAKE_SCOPE: ScopeRef = { principal: "p1", scopeKey: "s1" };

/**
 * A scripted stand-in for World's curation: the same operations, the events in a table of the SAME database (so a
 * rolled back steward transaction takes the fake's writes with it), the behaviors a test sets. World's own rules
 * are tested in the world domain; this is what the steward's flow is tested against.
 */
export async function createFakeWorld(
	store: SqliteStore,
	conversation: ConversationService,
	kick: (conversationId: string) => Promise<void>,
) {
	await store.write((db) => {
		db.exec(`CREATE TABLE fake_world_event (
			event_id TEXT PRIMARY KEY, message_id TEXT NOT NULL, revision TEXT NOT NULL, digest TEXT NOT NULL,
			speaker TEXT NOT NULL, conversation_id TEXT NOT NULL, seq INTEGER NOT NULL,
			state TEXT NOT NULL, reason TEXT, held INTEGER NOT NULL DEFAULT 0, registered INTEGER NOT NULL DEFAULT 0
		)`);
	});
	let seq = 0;
	let epoch = 1;
	let claimCounter = 0;
	const calls: Array<{ call: string; detail?: unknown }> = [];
	const log = (call: string, detail?: unknown) =>
		calls.push({ call, ...(detail === undefined ? {} : { detail }) });
	const forgetIds: string[] = [];
	const resumed: string[] = [];

	const fake = {
		calls,
		resumed,
		/** What `prepare` answers; default: ready with the window's utterances. */
		onPrepare: null as
			| null
			| ((eventIds: readonly string[]) => CurationPrepareResult | undefined),
		/** What `settle` answers; default: every claim applied, the events settled. */
		onSettle: null as
			| null
			| ((
					db: Database,
					prepared: PreparedCuration,
					output: unknown,
			  ) => CurationSettleResult | undefined),
		/** The World epoch a prepare records (a test moves it to simulate a World forget). */
		epoch: () => epoch,
		bumpEpoch: () => void (epoch += 1),
		/** The messages that are evidence of a claim or entity (what `evidenceMessagesOf` answers). */
		evidence: new Map<string, string[]>(),
		unavailable: false,
		/** `evidenceMessagesOf` could read only part of the evidence. */
		evidenceIncomplete: false,
		view: null as WorldView | null,
		/** World received these messages as events (one page of the feed: one notice after all of them). */
		async receiveAll(
			messageIds: readonly string[],
			over: { digest?: string; revision?: string } = {},
		) {
			const conversations = await store.write((db) =>
				messageIds.map((messageId) => {
					const state = conversation.sourceInTransaction(db, messageId);
					if (state.state !== "available") throw new Error("no_source");
					db.query(
						`INSERT INTO fake_world_event (event_id, message_id, revision, digest, speaker, conversation_id, seq, state)
						 VALUES (?,?,?,?,?,?,?, 'received')`,
					).run(
						`ev-${messageId}-${over.revision ?? state.revision}-${over.digest ?? state.digest}`,
						messageId,
						over.revision ?? state.revision,
						over.digest ?? state.digest,
						state.message.role,
						state.message.conversationId,
						++seq,
					);
					return state.message.conversationId;
				}),
			);
			for (const id of new Set(conversations)) await kick(id);
		},
		receive: (
			messageId: string,
			over: { digest?: string; revision?: string } = {},
		) => fake.receiveAll([messageId], over),
		events: () =>
			store.read(
				(db) =>
					db
						.query(
							"SELECT event_id AS eventId, message_id AS messageId, state, reason, held, registered FROM fake_world_event ORDER BY seq",
						)
						.all() as Array<{
						eventId: string;
						messageId: string;
						state: string;
						reason: string | null;
						held: number;
						registered: number;
					}>,
			),
		callsOf: (call: string) => calls.filter((c) => c.call === call),
		forgetIds,
	};

	const rows = (db: Database, ids: readonly string[]) =>
		ids.length === 0
			? []
			: (db
					.query(
						`SELECT event_id AS eventId, message_id AS messageId, revision, digest, speaker, conversation_id AS conversationId,
						 seq, state, held FROM fake_world_event WHERE event_id IN (${ids.map(() => "?").join(",")}) ORDER BY seq`,
					)
					.all(...ids) as Array<
					PendingCurationEvent & { state: string; held: number }
				>);
	const setState = (
		db: Database,
		ids: readonly string[],
		state: string,
		reason: string | null = null,
	) => {
		for (const id of ids)
			db.query(
				"UPDATE fake_world_event SET state = ?, reason = ?, registered = 0 WHERE event_id = ? AND state = 'received'",
			).run(state, reason, id);
	};

	const curation: StewardWorldCuration = {
		pendingEventsInTransaction(db, _scope, limit, conversationId) {
			return db
				.query(
					`SELECT event_id AS eventId, message_id AS messageId, revision, digest, speaker, conversation_id AS conversationId, seq
						 FROM fake_world_event WHERE state = 'received' AND held = 0 AND (?1 IS NULL OR conversation_id = ?1) ORDER BY seq LIMIT ?2`,
				)
				.all(conversationId ?? null, limit) as PendingCurationEvent[];
		},
		prepareCurationInTransaction(db, input) {
			log("prepare", input.eventIds);
			const scripted = fake.onPrepare?.(input.eventIds);
			if (scripted) return scripted;
			const events = rows(db, input.eventIds).filter(
				(e) => e.state === "received",
			);
			if (events.length === 0)
				return { status: "stale", reason: "no_input", finalized: [] };
			for (const e of events)
				db.query(
					"UPDATE fake_world_event SET registered = 1 WHERE event_id = ?",
				).run(e.eventId);
			const prepared = {
				scope: input.scope,
				eventIds: events.map((e) => e.eventId),
				deferredEventIds: [],
				model: {
					utterances: events.map((e, i) => ({
						label: `e${i + 1}`,
						speaker: e.speaker,
						text:
							conversation.messageInTransaction(db, e.messageId)?.message
								.text ?? "",
					})),
					entities: [{ ref: "w1", name: "音声サービス", aliases: ["音声"] }],
					claims: [],
				},
				host: {
					version: 1,
					windowId: "w",
					forgetEpoch: String(epoch),
					entityDigest: "d",
					events: events.map((e, i) => ({
						label: `e${i + 1}`,
						eventId: e.eventId,
						messageId: e.messageId,
						conversationId: e.conversationId,
						speaker: e.speaker,
						source: {},
						manifestId: `m-${e.eventId}`,
						rootEvidenceId: `r-${e.eventId}`,
						receivedCursor: "c",
					})),
				},
			} as unknown as PreparedCuration;
			return { status: "ready", prepared, finalized: [] };
		},
		settleCurationInTransaction(db, input) {
			log("settle", input.output);
			const scripted = fake.onSettle?.(db, input.prepared, input.output);
			if (scripted) return scripted;
			const output = input.output as { claims?: unknown[] };
			const claims = output.claims ?? [];
			const elements: CurationElement[] = claims.map((_, index) => ({
				kind: "claim",
				index,
				op: "assert",
				status: "applied",
				reasonCodes: [],
				outcome: "adopted",
				claimId: `claim-${++claimCounter}`,
			}));
			const eventIds = input.prepared.host.events.map((e) => e.eventId);
			setState(db, eventIds, "applied");
			return {
				status: "settled",
				elements,
				eventIds,
				touched: {
					claimIds: elements.flatMap((e) => (e.claimId ? [e.claimId] : [])),
					entityIds: [],
					messageIds: input.prepared.host.events.map((e) => e.messageId),
				},
				changed: elements.length > 0,
			};
		},
		settleEmptyInTransaction(db, _scope, eventIds) {
			log("settleEmpty", eventIds);
			const live = rows(db, eventIds).filter((e) => e.state === "received");
			setState(
				db,
				live.map((e) => e.eventId),
				"applied",
				"ROUTED_EMPTY",
			);
			return live.map((e) => e.eventId);
		},
		giveUpEventsInTransaction(db, _scope, eventIds) {
			log("giveUp", eventIds);
			const live = rows(db, eventIds).filter((e) => e.state === "received");
			setState(
				db,
				live.map((e) => e.eventId),
				"rejected",
				"STEWARD_GAVE_UP",
			);
			return live.map((e) => e.eventId);
		},
		releaseCurationInTransaction(db, _scope, eventIds) {
			log("release", eventIds);
			for (const id of eventIds)
				db.query(
					"UPDATE fake_world_event SET registered = 0 WHERE event_id = ?",
				).run(id);
		},
		acceptSourceForgetInTransaction(_db, request) {
			log("sourceForget", request.messageIds);
			if (request.messageIds.length === 0) return { status: "nothing" };
			const forgetId = `sb-${forgetIds.length + 1}`;
			forgetIds.push(forgetId);
			return { status: "accepted", forgetId };
		},
		forgetClaimsInTransaction(_db, input) {
			log("forgetClaims", input.claimIds);
			if (fake.unavailable)
				return { status: "unavailable", reason: "world_unavailable" };
			if (input.claimIds.length === 0) return { status: "nothing" };
			const forgetId = `sc-${forgetIds.length + 1}`;
			forgetIds.push(forgetId);
			return {
				status: "accepted",
				forgetId,
				claimIds: [...input.claimIds],
				missing: [],
			};
		},
		forgetEntitiesInTransaction(_db, input) {
			log("forgetEntities", input.entityIds);
			if (fake.unavailable)
				return { status: "unavailable", reason: "world_unavailable" };
			if (input.entityIds.length === 0) return { status: "nothing" };
			const forgetId = `se-${forgetIds.length + 1}`;
			forgetIds.push(forgetId);
			return {
				status: "accepted",
				forgetId,
				entityIds: [...input.entityIds],
				missing: [],
			};
		},
		evidenceMessagesOf(_db, input) {
			log("evidence", { claims: input.claimIds, entities: input.entityIds });
			if (fake.unavailable)
				return { status: "unavailable", reason: "world_unavailable" };
			const ids = new Set<string>();
			for (const id of [...input.claimIds, ...input.entityIds])
				for (const message of fake.evidence.get(id) ?? []) ids.add(message);
			return {
				status: "ok",
				messageIds: [...ids].sort(),
				complete: !fake.evidenceIncomplete,
			};
		},
		forgetEpochInTransaction: () => String(epoch),
	};

	const world: StewardWorld = {
		curation,
		// What the model is shown of World (refs w1.. for entities, k1.. for claims): a test sets it.
		view: () => fake.view,
		resumeForget(forgetId) {
			resumed.push(forgetId);
		},
		scope: FAKE_SCOPE,
	};
	return { fake, world };
}
export type FakeWorld = Awaited<ReturnType<typeof createFakeWorld>>["fake"];
