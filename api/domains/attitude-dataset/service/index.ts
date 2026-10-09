import { containsCredential } from "./privacy";
import { exportSchema } from "./schema";
import { createHmac } from "node:crypto";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import {
	chooseSpeechDelivery,
	decisionDetails,
	RURI_MODEL,
	emotionSchema,
	type Judge,
	type DeliveryContext,
	type SpeechDelivery,
} from "../../delivery";
import {
	coverageTags,
	reviewSchema,
	type Identity,
	type Sample,
	type VoiceAdoption,
} from "../contracts";
import { groupSplit } from "./split";

type Control = { enabled: number; epoch: number; salt: string };
type Unit = {
	id: string;
	status: string;
	reason: string | null;
	sample: string | null;
};
const target = 300;
export function createAttitudeDataset(store: SqliteStore, path: string) {
	const pending = new Set<Promise<unknown>>();
	let lifetime = new AbortController();
	let volatileErrors = 0;
	const control = () =>
		store.read((db) =>
			db.query<Control, []>("SELECT * FROM dataset_control WHERE id=1").get()!,
		);
	const hash = (value: string) =>
		createHmac("sha256", control().salt).update(value).digest("hex");
	const unitId = (identity: Identity) =>
		hash(
			JSON.stringify([
				identity.conversationId,
				identity.turnId,
				identity.granularity,
				identity.chunkOrder,
			]),
		);
	type SavedAdoption = { delivery: SpeechDelivery; voice?: VoiceAdoption };
	const readAdoption = (value: string): SavedAdoption => {
		const saved = JSON.parse(value);
		return "delivery" in saved ? saved : { delivery: saved };
	};
	const adoption = (d: SpeechDelivery, voice?: VoiceAdoption) => ({
		emotion: d.emotion,
		motion: d.motion,
		tone: voice?.tone ?? null,
		voice_application: voice?.application ?? null,
		source: d.source,
		reason: d.reason ?? null,
	});
	const units = () =>
		store.read((db) =>
			db.query<Unit, []>("SELECT * FROM dataset_units ORDER BY id").all(),
		);
	const samples = () =>
		units()
			.filter((u) => u.sample)
			.map((u) => JSON.parse(u.sample!) as Sample);
	function track(work: Promise<unknown>) {
		pending.add(work);
		void work
			.catch(async () => {
				volatileErrors++;
				await store
					.write((db) =>
						db.exec("UPDATE dataset_errors SET count=count+1 WHERE id=1"),
					)
					.catch(() => {});
			})
			.finally(() => pending.delete(work));
	}
	function status() {
		const all = units(),
			data = all
				.filter((u) => u.sample)
				.map((u) => JSON.parse(u.sample!) as Sample);
		const byReason: Record<string, number> = {};
		all
			.filter((u) => u.reason)
			.forEach((u) => (byReason[u.reason!] = (byReason[u.reason!] ?? 0) + 1));
		return {
			enabled: !!control().enabled,
			target,
			successful: data.length,
			unreviewed: data.filter((s) => s.review_status === "unreviewed").length,
			reviewed: data.filter((s) => s.review_status === "reviewed").length,
			held: data.filter((s) => s.review_status === "held").length,
			skipped: all.filter((u) => u.reason?.startsWith("skip:")).length,
			skip_reasons: byReason,
			pending: all.filter((u) => u.status === "pending").length,
			failed: all.filter((u) => u.status === "failed").length,
			storage_errors: Math.max(
				volatileErrors,
				store.read(
					(db) =>
						db
							.query<{ count: number }, []>(
								"SELECT count FROM dataset_errors WHERE id=1",
							)
							.get()!.count,
				),
			),
			path,
			score_notice:
				"合成データ由来の暫定校正。実会話の正解確率ではありません。",
		};
	}
	async function setEnabled(enabled: boolean) {
		if (!enabled) {
			lifetime.abort();
			lifetime = new AbortController();
		}
		await store.write((db) => {
			const previous = db
				.query<Control, []>("SELECT * FROM dataset_control WHERE id=1")
				.get()!;
			if (!!previous.enabled === enabled) return;
			const count = db
				.query<{ n: number }, []>(
					"SELECT count(*) AS n FROM dataset_units WHERE sample IS NOT NULL",
				)
				.get()!.n;
			if (enabled && count >= target)
				throw new Error("invalid_collection_target_reached");
			db.query(
				"UPDATE dataset_control SET enabled=?,epoch=epoch+1 WHERE id=1",
			).run(enabled ? 1 : 0);
			if (!enabled)
				db.exec(
					"UPDATE dataset_units SET status='cancelled',reason=COALESCE(reason,'stopped') WHERE status='pending'",
				);
		});
		if (!enabled) await Promise.allSettled(pending);
		return status();
	}
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
					const now = db
						.query<Control, []>("SELECT * FROM dataset_control WHERE id=1")
						.get()!;
					if (!now.enabled || now.epoch !== c.epoch) return false;
					const n = db
						.query<{ n: number }, []>(
							"SELECT count(*) AS n FROM dataset_units WHERE sample IS NOT NULL OR status='pending'",
						)
						.get()!.n;
					return (
						n < target &&
						!!db
							.query(
								"INSERT OR IGNORE INTO dataset_units(id,status) VALUES(?,'pending')",
							)
							.run(id).changes
					);
				});
			} catch {
				volatileErrors++;
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
			if (reserved)
				track(
					store.write((db) =>
						db
							.query(
								"UPDATE dataset_units SET status='cancelled',reason='cancelled' WHERE id=?",
							)
							.run(id!),
					),
				);
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
				lifetime.signal,
				AbortSignal.timeout(30000),
			]);
			let model = args.model;
			if (collectionOnly && model === null && args.prepareJudge)
				model = await args.prepareJudge(signal);
			if (
				collectionOnly &&
				model === RURI_MODEL &&
				wrapped &&
				args.text.trim()
			) {
				// Separate promise: normal TTS never waits for this all-six-candidate judgment.
				await chooseSpeechDelivery(
					wrapped,
					args.text,
					signal,
					args.budgetMs,
					decisionContext,
					{ fullCandidates: true },
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
				details.model === RURI_MODEL &&
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
				const now = db
					.query<Control, []>("SELECT * FROM dataset_control WHERE id=1")
					.get()!;
				// A stop/restart or cancellation invalidates outstanding results, including adapters that ignore abort.
				if (signal.aborted || !now.enabled || now.epoch !== c.epoch) {
					db.query(
						"UPDATE dataset_units SET status='cancelled',reason=? WHERE id=?",
					).run(originalSkip ?? "cancelled", id);
					return;
				}
				if (sample) {
					for (const row of db
						.query<Unit, []>(
							"SELECT * FROM dataset_units WHERE sample IS NOT NULL",
						)
						.all()) {
						const existing = JSON.parse(row.sample!) as Sample;
						if (existing.split) {
							existing.split = null;
							db.query("UPDATE dataset_units SET sample=? WHERE id=?").run(
								JSON.stringify(existing),
								row.id,
							);
						}
					}
					const applied = db
						.query<{ delivery: string }, [string]>(
							"SELECT delivery FROM dataset_adoptions WHERE id=?",
						)
						.get(id);
					if (applied) {
						const saved = readAdoption(applied.delivery);
						sample.adopted = adoption(saved.delivery, saved.voice);
					}
				}
				db.query(
					"UPDATE dataset_units SET status=?,reason=?,sample=? WHERE id=?",
				).run(
					sample ? "succeeded" : "failed",
					sensitive
						? "skip:sensitive-text"
						: (originalSkip ?? (sample ? null : "invalid-or-non-ruri")),
					sample ? JSON.stringify(sample) : null,
					id,
				);
				const count = db
					.query<{ n: number }, []>(
						"SELECT count(*) AS n FROM dataset_units WHERE sample IS NOT NULL",
					)
					.get()!.n;
				if (count >= target)
					db.exec("UPDATE dataset_control SET enabled=0 WHERE id=1");
			});
		};
		track(
			collect().catch(async () => {
				await store.write((db) =>
					db
						.query(
							"UPDATE dataset_units SET status='failed',reason=? WHERE id=?",
						)
						.run(originalSkip ?? "decision-failed", id),
				);
			}),
		);
		return delivery;
	}
	function report() {
		const data = samples();
		const counts = Object.fromEntries(emotionSchema.options.map((k) => [k, 0]));
		const coverage = Object.fromEntries(coverageTags.map((k) => [k, 0]));
		const differences: unknown[] = [];
		for (const s of data) {
			for (const tag of s.coverage_tags)
				coverage[tag] = (coverage[tag] ?? 0) + 1;
			if (s.review_status === "reviewed" && s.primary_label) {
				counts[s.primary_label] = (counts[s.primary_label] ?? 0) + 1;
				if (
					s.decision.top_label !== s.primary_label ||
					s.decision.api_label !== s.primary_label
				)
					differences.push({
						sample_id: s.sample_id,
						model_top: s.decision.top_label,
						api_label: s.decision.api_label,
						primary_label: s.primary_label,
						acceptable_labels: s.acceptable_labels,
						reason: s.correction_reason,
					});
			}
		}
		const contrast = new Map<string, Sample[]>();
		for (const s of data) {
			const key = s.current_chunk.trim();
			contrast.set(key, [...(contrast.get(key) ?? []), s]);
		}
		const contrasts = [...contrast.values()]
			.filter((g) => new Set(g.map((s) => s.user_utterance)).size > 1)
			.map((g) => ({
				sample_ids: g.map((s) => s.sample_id),
				reviewed: g.filter((s) => s.review_status === "reviewed").length,
			}));
		const reviewedCount = data.filter(
			(s) => s.review_status === "reviewed",
		).length;
		return {
			...status(),
			contrasting_context_groups: contrasts,
			short_texts: data.filter((s) => Array.from(s.current_chunk).length <= 20)
				.length,
			dominant_class_fraction: reviewedCount
				? Math.max(...Object.values(counts)) / reviewedCount
				: null,
			classes: counts,
			rejections: Object.fromEntries(
				[...new Set(data.map((s) => s.rejection_reason).filter(Boolean))].map(
					(reason) => [
						reason,
						data.filter((s) => s.rejection_reason === reason).length,
					],
				),
			),
			coverage,
			missing_classes: Object.keys(counts).filter((k) => !counts[k]),
			missing_coverage: Object.keys(coverage).filter((k) => !coverage[k]),
			differences,
			granularity: {
				answer: data.filter((s) => s.granularity === "answer").length,
				chunk: data.filter((s) => s.granularity === "chunk").length,
			},
			splits: Object.fromEntries(
				["train", "calibration", "eval"].map((k) => [
					k,
					data.filter((s) => s.split === k).length,
				]),
			),
			warnings: [
				"不足は実会話から収集してください。合成例・速度測定を300件に含めません。",
				"類似テンプレートは人手で同じtemplate_group_idへ統合し、確認してください。",
				"evalを分類ヘッド学習・温度校正・閾値調整に使わないでください。",
			],
		};
	}
	return {
		decide,
		status,
		setEnabled,
		report,
		adopt(identity: Identity, delivery: SpeechDelivery, voice?: VoiceAdoption) {
			const id = unitId(identity);
			track(
				store.write((db) => {
					const unit = db
						.query<Unit, [string]>("SELECT * FROM dataset_units WHERE id=?")
						.get(id);
					if (!unit) return;
					const previous = db
						.query<{ delivery: string }, [string]>(
							"SELECT delivery FROM dataset_adoptions WHERE id=?",
						)
						.get(id);
					const saved: SavedAdoption = previous
						? readAdoption(previous.delivery)
						: { delivery };
					// A replay may produce a new plan. Keep the first accepted plan and only enrich its own voice application.
					if (saved.delivery.id !== delivery.id) return;
					if (voice && !saved.voice) saved.voice = voice;
					db.query(
						"INSERT INTO dataset_adoptions(id,delivery) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET delivery=excluded.delivery",
					).run(id, JSON.stringify(saved));
					if (unit.sample) {
						const sample = JSON.parse(unit.sample) as Sample;
						sample.adopted = adoption(saved.delivery, saved.voice);
						db.query("UPDATE dataset_units SET sample=? WHERE id=?").run(
							JSON.stringify(sample),
							id,
						);
					}
				}),
			);
		},
		list: () =>
			samples().map(
				({ sample_id, review_status, revision, granularity, chunk_order }) => ({
					sample_id,
					review_status,
					revision,
					granularity,
					chunk_order,
				}),
			),
		get(id: string, blind = true) {
			const sample = samples().find((s) => s.sample_id === id);
			if (!sample) return null;
			if (!blind) return sample;
			const {
				decision: _decision,
				adopted: _adopted,
				selected_delivery: _selected,
				rejection_reason: _reason,
				criteria: _criteria,
				candidate_order: _order,
				...rest
			} = sample;
			return rest;
		},
		async review(id: string, body: unknown) {
			const parsed = reviewSchema.safeParse(body);
			if (!parsed.success) throw new Error("invalid_review");
			if (
				containsCredential(
					[parsed.data.correction_reason, parsed.data.template_group_id]
						.filter(Boolean)
						.join("\n"),
				)
			)
				throw new Error("invalid_review_sensitive_text");
			return store.write((db) => {
				const row = db
					.query<Unit, [string]>("SELECT * FROM dataset_units WHERE id=?")
					.get(id);
				if (!row?.sample) throw new Error("invalid_sample");
				const sample = JSON.parse(row.sample) as Sample;
				const { revision, ...review } = parsed.data;
				if (sample.revision !== revision) throw new Error("revision_conflict");
				const updated = {
					...sample,
					...review,
					revision: revision + 1,
					split: null,
				};
				// Any review/group change invalidates all existing split assignments.
				for (const row of db
					.query<Unit, []>(
						"SELECT * FROM dataset_units WHERE sample IS NOT NULL",
					)
					.all()) {
					const s = JSON.parse(row.sample!) as Sample;
					s.split = null;
					db.query("UPDATE dataset_units SET sample=? WHERE id=?").run(
						JSON.stringify(s),
						row.id,
					);
				}
				db.query("UPDATE dataset_units SET sample=? WHERE id=?").run(
					JSON.stringify(updated),
					id,
				);
				return {
					sample_id: id,
					revision: updated.revision,
					review_status: updated.review_status,
				};
			});
		},
		async split() {
			return store.write((db) => {
				const data = db
					.query<Unit, []>(
						"SELECT * FROM dataset_units WHERE sample IS NOT NULL ORDER BY id",
					)
					.all()
					.map((r) => JSON.parse(r.sample!) as Sample);
				const result = groupSplit(data);
				for (const sample of data) {
					sample.split = result.assigned.get(sample.sample_id) ?? null;
					db.query("UPDATE dataset_units SET sample=? WHERE id=?").run(
						JSON.stringify(sample),
						sample.sample_id,
					);
				}
				return {
					counts: result.counts,
					groups: result.groups,
					warning:
						result.groups < 3
							? "独立グループが3未満です。会話・テンプレートを分割せず、追加収集してください。"
							: null,
				};
			});
		},
		export() {
			const reviewed = samples().filter((s) => s.review_status === "reviewed");
			if (reviewed.some((s) => !s.split))
				throw new Error("invalid_split_required");
			return {
				partitions: Object.fromEntries(
					["train", "calibration", "eval"].map((split) => [
						split,
						reviewed
							.filter((s) => s.split === split)
							.map((s) => JSON.stringify(s))
							.join("\n") +
							(reviewed.some((s) => s.split === split) ? "\n" : ""),
					]),
				),
				jsonl:
					reviewed.map((s) => JSON.stringify(s)).join("\n") +
					(reviewed.length ? "\n" : ""),
				report: report(),
				schema: exportSchema,
			};
		},
		async recover() {
			await store.write((db) =>
				db.exec(
					"UPDATE dataset_control SET enabled=0,epoch=epoch+1 WHERE id=1; UPDATE dataset_units SET status='interrupted',reason='restart' WHERE status='pending'",
				),
			);
		},
		async close() {
			await setEnabled(false);
		},
		async drain() {
			await Promise.allSettled(pending);
		},
	};
}
export type AttitudeDataset = ReturnType<typeof createAttitudeDataset>;
