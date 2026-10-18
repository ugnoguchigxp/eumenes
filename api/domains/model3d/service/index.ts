import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { QueueService } from "../../queue";
import { getLogger } from "../../../infrastructure/logger";
import {
	errorLabel,
	model3dTags,
	model3dTitle,
	type Model3dCompletion,
	type Model3dLarm,
	type Model3dSource,
} from "../contracts";
import {
	FOCUS_SLOT,
	activeGenerationCount,
	focusOf,
	generationByRequest,
	generationRow,
	generationView,
	listGenerations,
	operationRow,
	ownedGeneration,
	patchGeneration,
	setFocus,
	type GenerationRow,
} from "../repository";
import { registerModel3dHandlers, type Stage } from "./handlers";
import { createModel3dCommands } from "./commands";
import { createModel3dAssets } from "./assets";

const log = getLogger("model3d");

/** How long a generation is followed before the screen offers a recheck instead. */
const FOLLOW_MS = 60 * 60_000;
const ACTIVE_LIMIT = 3;

export function createModel3d(deps: {
	store: SqliteStore;
	queue: QueueService;
	/** LARM's 3D API on the saved Control connection; `null` while LARM is not configured. */
	larm: () => Model3dLarm | null;
	/** A finished generation or a failed operation, reported into the conversation that asked for it. */
	announceInTransaction?: (db: Database, notice: Model3dCompletion) => void;
	/** Pause between status reads (LARM reports stages, not a push). */
	pollMs?: number;
	/** How long a generation is followed before the screen offers a recheck. */
	followMs?: number;
}) {
	const { store, queue } = deps;
	function enqueue(db: Database, id: string, stage: Stage, delay = 0) {
		const r = generationRow(db, id)!;
		const step = r.step + 1;
		patchGeneration(db, id, { step });
		queue.enqueueInTransaction(db, {
			scope: "model3d",
			kind: `model3d.${stage}`,
			dedupeKey: `${id}:${step}`,
			payload: { id, step },
			subjectRef: id,
			lane: "interactive",
			resourceKey: "model3d",
			concurrencyKey: `model3d:${id}`,
			availableAtMs: Date.now() + delay,
			maxAttempts: 3,
		});
	}
	function announce(
		db: Database,
		id: string,
		conversationId: string,
		message: string,
	) {
		deps.announceInTransaction?.(db, {
			id,
			conversationId,
			message,
			at: new Date().toISOString(),
		});
	}
	function notify(
		db: Database,
		r: GenerationRow,
		kind: "completed" | "failed",
	) {
		const v = generationView(r);
		if (kind === "failed")
			log.warn("model3d.generation_failed", {
				subjectId: r.id,
				jobId: r.job_id ?? undefined,
				reason: r.error_code ?? undefined,
			});
		if (r.origin !== "conversation" || r.announced) return;
		patchGeneration(db, r.id, { announced: 1 });
		const warnings = v.warnings.length
			? `注意: ${v.warnings.slice(0, 2).join(" / ").slice(0, 160)}`
			: "";
		announce(
			db,
			// A recheck may end the same generation again, so each ending has its own notice.
			`model3d:${r.id}:${kind}:${r.step}`,
			r.conversation_id,
			kind === "completed"
				? v.deleted
					? `「${v.title}」の生成は完了しましたが、完成品は削除済みです。`
					: `「${v.title}」の3Dモデルができました。画面で回転して確認できます。${warnings}`
				: `「${v.title}」の3Dモデルを作れませんでした（${v.errorLabel ?? "生成に失敗しました"}）。`,
		);
	}
	function notifyOperation(db: Database, id: string) {
		const o = operationRow(db, id)!;
		if (o.state !== "failed") return;
		announce(
			db,
			`model3d-operation:${o.id}`,
			o.conversation_id,
			o.kind === "delete"
				? "3Dモデルを削除できませんでした。画面で状態を確認してください。"
				: "3Dモデルの名前・タグを変更できませんでした。画面で状態を確認してください。",
		);
	}
	registerModel3dHandlers({
		store,
		queue,
		larm: deps.larm,
		enqueue,
		notify,
		notifyOperation,
		cancelUnconfirmed,
		pollMs: deps.pollMs ?? 3000,
		waitMs: (deps.pollMs ?? 3000) * 3,
	});

	function createInTransaction(
		db: Database,
		input: {
			owner: string;
			conversationId: string;
			origin: "conversation" | "screen";
			requestId: string;
			title: string;
			tags: string[];
			source: Model3dSource;
		},
	) {
		const title = model3dTitle.parse(input.title);
		const tags = model3dTags.parse([
			...new Set(input.tags.map((t) => t.trim())),
		]);
		const existing = generationByRequest(db, input.requestId);
		if (existing) {
			if (
				existing.owner !== input.owner ||
				existing.title !== title ||
				existing.tags_json !== JSON.stringify(tags) ||
				existing.source_json !== JSON.stringify(input.source)
			)
				throw new Error("request_conflict");
			return generationView(existing);
		}
		if (activeGenerationCount(db, input.owner) >= ACTIVE_LIMIT)
			throw new Error("model3d_capacity");
		const id = crypto.randomUUID();
		const now = Date.now();
		db.query(
			`INSERT INTO model3d_generations(id,owner,conversation_id,origin,request_id,idempotency_key,title,tags_json,
			 source_json,seed,state,stage,deadline,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		).run(
			id,
			input.owner,
			input.conversationId,
			input.origin,
			input.requestId,
			crypto.randomUUID(),
			title,
			JSON.stringify(tags),
			JSON.stringify(input.source),
			crypto.getRandomValues(new Uint32Array(1))[0]! % 2_147_483_647,
			"submitting",
			null,
			now + (deps.followMs ?? FOLLOW_MS),
			now,
			now,
		);
		enqueue(db, id, "submit");
		setFocus(db, input.owner, FOCUS_SLOT, {
			kind: "generation",
			generationId: id,
		});
		return generationView(generationRow(db, id)!);
	}
	function cancelInTransaction(db: Database, owner: string, id: string) {
		const r = ownedGeneration(db, id, owner);
		if (!["submitting", "queued", "running"].includes(r.state))
			return generationView(r);
		const cancelled = patchGeneration(db, id, {
			state: "cancelled",
			stage: null,
		});
		if (r.job_id) enqueue(db, id, "cancel");
		// A sent body may have started a job: resend it to learn the job ID, then cancel that job.
		else if (r.request_json) enqueue(db, id, "submit");
		return generationView(cancelled);
	}
	let lastStatus: { available: boolean; reason: string | null } | null = null;
	const assets = createModel3dAssets(store, deps.larm, (status) => {
		lastStatus = status;
	});
	/** Configured, and not reported missing by the last catalog read; `reason` is shown as is. */
	function availability() {
		const code = !deps.larm()
			? "model3d_larm_unconfigured"
			: lastStatus?.available === false
				? lastStatus.reason
				: null;
		return { available: code === null, reason: errorLabel(code) };
	}
	function cancelUnconfirmed(_db: Database, r: GenerationRow) {
		log.warn("model3d.cancel_unconfirmed", {
			subjectId: r.id,
			jobId: r.job_id ?? undefined,
		});
	}
	const commands = createModel3dCommands({
		createInTransaction,
		cancelInTransaction,
		enqueueOperation(db, row) {
			queue.enqueueInTransaction(db, {
				scope: "model3d",
				kind: "model3d.operation",
				dedupeKey: row.id,
				payload: { id: row.id },
				subjectRef: row.id,
				lane: "interactive",
				resourceKey: "model3d",
				concurrencyKey: `model3d:${row.assetId}`,
				maxAttempts: 1,
			});
		},
	});
	return {
		...commands,
		createInTransaction,
		cancelInTransaction,
		availableInTransaction: () => deps.larm() !== null,
		create: (
			owner: string,
			conversationId: string,
			input: {
				requestId: string;
				title: string;
				tags: string[];
				source: Model3dSource;
			},
		) =>
			store.write((db) =>
				createInTransaction(db, {
					...input,
					owner,
					conversationId,
					origin: "screen",
				}),
			),
		list: (owner: string) => store.read((db) => listGenerations(db, owner)),
		get: (owner: string, id: string) =>
			store.read((db) => generationView(ownedGeneration(db, id, owner))),
		cancel: (owner: string, id: string) =>
			store.write((db) => cancelInTransaction(db, owner, id)),
		/** Follow a generation again after a timeout or an unconfirmed step; never a new generation. */
		recheck: (owner: string, id: string) =>
			store.write((db) => {
				const r = ownedGeneration(db, id, owner);
				if (r.state !== "failed") throw new Error("model3d_not_recheckable");
				const deadline = Date.now() + (deps.followMs ?? FOLLOW_MS);
				if (r.job_id) {
					patchGeneration(db, id, {
						state: "running",
						error_code: null,
						announced: 0,
						deadline,
					});
					enqueue(db, id, "poll");
				} else if (r.error_code === "model3d_submission_unconfirmed") {
					// Same key and the same fixed body: LARM answers with the job it already has.
					patchGeneration(db, id, {
						state: "submitting",
						error_code: null,
						announced: 0,
						deadline,
					});
					enqueue(db, id, "submit");
				} else throw new Error("model3d_not_recheckable");
				return generationView(generationRow(db, id)!);
			}),
		...assets,
		sourceInTransaction(db: Database, owner: string) {
			const generations = listGenerations(db, owner);
			const focus = focusOf(db, owner, FOCUS_SLOT);
			const updated = Math.max(0, ...generations.map((g) => g.updatedAt));
			return {
				// Both parts only grow, so the sum changes whenever either does.
				revision: updated + (focus?.seq ?? 0),
				data: {
					generations,
					focus,
					...availability(),
				},
			};
		},
	};
}
export type Model3dService = ReturnType<typeof createModel3d>;
