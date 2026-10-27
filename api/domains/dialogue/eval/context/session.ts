/**
 * One evaluation conversation on the real services (a temp store with the product's conversation, continuity,
 * memory and work-ledger code) and the production claim-time prepare. Seeds are written through the services' public
 * operations (events appended as the product appends them, State saved through the steward's curation contract, TODOs
 * through the ledger), and a generation is `createPrepare`'s own output: the messages are the product's, never
 * rendered here.
 *
 * Only what the case decides stands in for a port: the model window, the persona, the adopted goals, the known World
 * names and the agency's interests. Offline evaluation only.
 */
import type { WorkOutcome } from "../../repository/work";
import type { Seed, SeedEvent } from "./case-schema";
import {
	conversationSystem,
	memoryDigestOf,
	systemDigestOf,
} from "../../service/conversation-input";
import { createSessionContext } from "./session-context";
import { writeEvent } from "./session-events";
import { type GenerateRequest, generateIn, settleIn } from "./session-run";
import {
	CONVERSATION_ID,
	type EvalCard,
	type Generated,
	type Reply,
	type SeedWiring,
} from "./session-types";

export {
	CONVERSATION_ID,
	DEFAULT_START,
	SEED_SOURCE_MESSAGE,
	type EvalCard,
	type Generated,
	type Persona,
	type Cut,
	type Reply,
	type SeedWiring,
} from "./session-types";

type WorkSeed = NonNullable<Seed["work"]>[number];
type EpisodePart = {
	kind: "summary" | "unsummarized";
	text?: string | undefined;
	events: readonly SeedEvent[];
};

export function createSession(
	wiring: SeedWiring,
	options: { catalog?: readonly EvalCard[] } = {},
) {
	const ctx = createSessionContext(wiring, options);
	const { store, work, refs } = ctx;
	return {
		deps: ctx.deps,
		ports: ctx.ports,
		wiring,
		resolve: ctx.resolve,

		/** Writes the seeded log events in order. */
		appendEvents: (list: readonly SeedEvent[]) =>
			store.write((db) => {
				for (const seed of list) writeEvent(ctx, db, seed);
			}),

		/**
		 * Earlier history the recent conversation no longer shows: its events are written, and the cut is placed
		 * after them (what a cut leaves behind; the rest is read by the history toolchain).
		 */
		appendEpisode: (parts: readonly EpisodePart[]) =>
			store.write((db) => {
				for (const part of parts)
					for (const seed of part.events) writeEvent(ctx, db, seed);
				const newest = ctx.conversation.input
					.latestUtterancesInTransaction(db, CONVERSATION_ID, 1)
					.at(-1);
				// The cut stands on the profile the first generation reads, so that one does not cut again.
				if (parts.length && newest)
					ctx.conversation.input.writeCutInTransaction(db, CONVERSATION_ID, {
						seq: newest.seq,
						systemDigest: systemDigestOf(conversationSystem(ctx.deps, db)),
						memoryDigest: memoryDigestOf(
							ctx.deps.memory?.windowForRunInTransaction(db, CONVERSATION_ID) ??
								null,
						),
						at: newest.at,
					});
			}),

		/** A TODO as the ledger holds it, with the state its owner reported. */
		addWork(seed: WorkSeed) {
			wiring.setNow(seed.at);
			return store.write((db) => {
				const { row } = work.startInTransaction(db, {
					conversationId: CONVERSATION_ID,
					runId: "seed-run",
					card: { id: seed.toolchain, revisionId: `rev-${seed.toolchain}` },
					request: seed.request,
					dedupeKey: seed.key,
					messageIds: [],
				});
				refs.set(seed.key, row.id);
				if (seed.status === "todo") return;
				wiring.setNow(seed.updatedAt ?? seed.at);
				if (seed.status === "waiting")
					work.reportInTransaction(db, row.id, {
						status: "waiting",
						questionId: seed.questionId!,
						question: seed.question!,
					});
				else {
					work.reportInTransaction(db, row.id, {
						status: "done",
						outcome: seed.outcome!,
						result: seed.result ?? null,
					});
					if (seed.archived) work.archiveInTransaction(db, row.id);
				}
			});
		},

		/** The owner of a TODO reports its state (done with a result, or waiting with a question). */
		reportWork(
			key: string,
			at: string,
			report:
				| { status: "waiting"; questionId: string; question: string }
				| { status: "done"; outcome: WorkOutcome; result: unknown },
		) {
			wiring.setNow(at);
			return store.write((db) => {
				const id = refs.get(key);
				if (!id || !work.reportInTransaction(db, id, report))
					throw new Error(`context_eval_work_unknown:${key}`);
			});
		},

		addConfirmation: (
			seed: NonNullable<Seed["confirmations"]>[number],
			at: string,
		) => {
			wiring.setNow(at);
			return store.write((db) => {
				work.issueConfirmationInTransaction(
					db,
					{
						conversationId: CONVERSATION_ID,
						toolchainId: seed.toolchain,
						toolchainRevisionId: `rev-${seed.toolchain}`,
						request: seed.request,
						inputs: null,
						impact: seed.impact,
						statementDeliveryKey: `seed:${seed.toolchain}`,
					},
					[],
				);
			});
		},

		generate: (input: GenerateRequest): Promise<Generated> =>
			generateIn(ctx, input),
		settle: (generated: Generated, reply: Reply = {}) =>
			settleIn(ctx, generated, reply),
	};
}
export type Session = ReturnType<typeof createSession>;
