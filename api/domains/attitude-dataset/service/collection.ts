import type { SqliteStore } from "../../../infrastructure/sqlite";
import {
	chooseSpeechDelivery,
	decisionDetails,
	type DeliveryContext,
	type Judge,
	type SpeechDelivery,
} from "../../delivery";
import { type Identity, type Sample } from "../contracts";
import * as records from "../repository/records";
import { containsCredential } from "./privacy";

import { adoption, readAdoption } from "./adoption";
export function createDatasetCollection(deps: {
	target: number;
	store: SqliteStore;
	control: () => NonNullable<ReturnType<typeof records.readControl>>;
	unitId: (identity: Identity) => string;
	hash: (value: string) => string;
	track: (work: Promise<unknown>) => void;
	lifetime: () => AbortController;
	recordVolatileError: () => void;
}) {
	const {
		target,
		store,
		control,
		unitId,
		hash,
		track,
		lifetime,
		recordVolatileError,
	} = deps;

	async function decide(args: {
		judge: Judge | undefined;
		model: string | null;
		prepareJudge?: (signal: AbortSignal) => Promise<string | null>;
		text: string;
		context?: DeliveryContext;
		identity?: Identity;
		signal: AbortSignal;
		collectionSignal: AbortSignal;
		budgetMs?: number;
	}) {
		const c = control();
		const identity = args.identity;
		// A chunk must not inherit a complete answer (which can contain future chunks).
		const decisionContext =
			identity?.granularity === "chunk" && args.context
				? { ...args.context, answer: args.text }
				: args.context;
		// Only an actual product turn is eligible. Probes, synthetic fixtures, replay without a run and benchmarks have no identity.
		const id = identity ? unitId(identity) : null;
		let reserved = false;
		if (c.enabled && id && identity) {
			try {
				reserved = await store.write((db) => {
					const now = records.readControl(db)!;
					if (!now.enabled || now.epoch !== c.epoch) return false;
					const n = records.countReserved(db)!.n;
					return n < target && !!records.reserveUnit(db, id).changes;
				});
			} catch {
				recordVolatileError();
			}
		}
		let observed: ReturnType<typeof decisionDetails> | undefined;
		let invoked = false;
		let sent: Record<string, string> | undefined;
		let criteria: Record<string, string> | undefined;
		let rtt = 0;
		let judgedAt: string | null = null;
		const wrapped: Judge | undefined = args.judge
			? async (state, questions, signal) => {
					invoked = true;
					sent = state;
					criteria = questions.emotion!.criteria;
					judgedAt = new Date().toISOString();
					const began = performance.now();
					try {
						const response = await args.judge!(state, questions, signal);
						observed = decisionDetails(response);
						return response;
					} finally {
						rtt = performance.now() - began;
					}
				}
			: undefined;
		let delivery: SpeechDelivery;
		try {
			delivery = await chooseSpeechDelivery(
				wrapped,
				args.text,
				args.signal,
				args.budgetMs,
				decisionContext,
			);
		} catch (error) {
			if (reserved) track(store.write((db) => records.cancelUnit(db, id!)));
			throw error;
		}
		if (!reserved || !id || !identity) return delivery;
		const normalInvoked = invoked;
		const normalDelivery = delivery;
		const collectionOnly = !normalInvoked;
		const originalSkip = !normalInvoked
			? `skip:${delivery.reason ?? "unknown"}`
			: null;
		const collect = async () => {
			const signal = AbortSignal.any([
				args.collectionSignal,
				lifetime().signal,
				AbortSignal.timeout(30000),
			]);
			let model = args.model;
			if (collectionOnly && model === null && args.prepareJudge)
				model = await args.prepareJudge(signal);
			if (collectionOnly && model !== null && wrapped && args.text.trim()) {
				// Separate promise: normal TTS never waits for this all-six-candidate judgment.
				await chooseSpeechDelivery(
					wrapped,
					args.text,
					signal,
					args.budgetMs,
					decisionContext,
				);
			}
			const details = observed;
			const sensitive = containsCredential(
				[
					args.text,
					args.context?.answer,
					...(args.context?.turns.map((t) => t.text) ?? []),
					identity.previousAssistantChunk,
				]
					.filter(Boolean)
					.join("\n"),
			);
			const success =
				!sensitive &&
				details?.valid &&
				details.scored &&
				details.logits &&
				details.scores;
			let sample: Sample | null = null;
			if (success && details && sent && criteria && judgedAt) {
				const current = decisionContext?.answer || args.text;
				const normalized = current
					.normalize("NFKC")
					.toLowerCase()
					.replace(/[\s\p{P}\p{N}]/gu, "");
				const template = hash(`template:${normalized}`);
				sample = {
					schema_version: 1,
					sample_id: id,
					conversation_id: hash(`conversation:${identity.conversationId}`),
					turn_id: hash(`turn:${identity.turnId}`),
					chunk_order: identity.chunkOrder,
					granularity: identity.granularity,
					judged_at: judgedAt,
					template_group_id: template,
					automatic_template_group_id: template,
					template_group_confirmed: false,
					review_context: args.context?.turns ?? [],
					user_utterance:
						args.context?.turns.filter((t) => t.role === "user").at(-1)?.text ??
						null,
					previous_assistant_chunk: identity.previousAssistantChunk ?? null,
					current_chunk: current,
					sent_current_text: sent.current_chunk ?? sent.response ?? "",
					criteria,
					candidate_order: Object.keys(criteria),
					text_transform: "raw-current-excerpt-600",
					client_excerpted: Array.from(current.trim()).length > 600,
					decision: details,
					adopted: null,
					selected_delivery: normalDelivery,
					rejection_reason: collectionOnly
						? originalSkip
						: (delivery.reason ?? null),
					collection_only: collectionOnly,
					round_trip_ms: rtt,
					tts_start_delay_ms: null,
					primary_label: null,
					acceptable_labels: [],
					expression_transition: null,
					review_status: "unreviewed",
					correction_reason: null,
					coverage_tags: [],
					revision: 0,
					split: null,
				};
			}
			await store.write((db) => {
				const now = records.readControl(db)!;
				// A stop/restart or cancellation invalidates outstanding results, including adapters that ignore abort.
				if (signal.aborted || !now.enabled || now.epoch !== c.epoch) {
					records.cancelUnitWithReason(db, originalSkip ?? "cancelled", id);
					return;
				}
				if (sample) {
					for (const row of records.listSamples(db)) {
						const existing = JSON.parse(row.sample!) as Sample;
						if (existing.split) {
							existing.split = null;
							records.saveSample(db, JSON.stringify(existing), row.id);
						}
					}
					const applied = records.readAdoption(db, id);
					if (applied) {
						const saved = readAdoption(applied.delivery);
						sample.adopted = adoption(saved.delivery, saved.voice);
					}
				}
				records.settleUnit(
					db,
					sample ? "succeeded" : "failed",
					sensitive
						? "skip:sensitive-text"
						: (originalSkip ?? (sample ? null : "invalid-or-unscored")),
					sample ? JSON.stringify(sample) : null,
					id,
				);
				const count = records.countSamples(db)!.n;
				if (count >= target) records.disable(db);
			});
		};
		track(
			collect().catch(async () => {
				await store.write((db) =>
					records.failUnit(db, originalSkip ?? "decision-failed", id),
				);
			}),
		);
		return delivery;
	}
	return { decide };
}
