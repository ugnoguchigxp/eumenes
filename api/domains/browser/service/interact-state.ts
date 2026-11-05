import type { Database } from "bun:sqlite";
import {
	getRun,
	isTerminalRunStatus,
	transitionRun,
	forgetRun,
} from "eumenes-interact/sqlite";
import { type InteractMemory, type InteractMeta } from "../contracts/interact";
import { interactMeta } from "../repository/interact";
import {
	createInteractStep,
	type InteractStepDeps,
	type InteractStepResult,
} from "./interact-step";
import { interactAuthority, interactIso } from "./interact-authority";
import type { QueueService } from "../../queue";
import { createHostResolver } from "../adapters/host-resolver";
import { getLogger } from "../../../infrastructure/logger";

export type InteractDeps = Omit<
	InteractStepDeps,
	"authority" | "memory" | "resolveHost"
> & {
	resolveHost?: import("../contracts/ports").HostResolver;
	queue: QueueService;
	skill: { ref: string; digest: string };
	validSource?: (db: Database, source: unknown) => boolean;
	knowledgeSeed?: unknown;
};

export function createInteractState(deps: InteractDeps) {
	const { store, queue, now } = deps;
	const memory = new Map<string, InteractMemory>();
	const authority = interactAuthority({ ...deps, memory });
	const step = createInteractStep({
		...deps,
		resolveHost: deps.resolveHost ?? createHostResolver(),
		memory,
		authority,
	});
	const pendingFiles = new Set<string>();
	const scheduleFlush = () => {
		void flush().catch(() =>
			getLogger("browser").warn("browser.interact_cleanup_failed", {
				reason: "cleanup_failed",
			}),
		);
	};

	function view(
		db: Database,
		owner: string,
		conversationId: string,
		runId: string,
	) {
		const { meta, run } = authority.owned(db, owner, conversationId, runId);
		const mem = memory.get(runId);
		const captures = db
			.query(
				"SELECT id,width,height,bytes,expires_at FROM browser_interact_captures WHERE run_id=? AND expires_at>? ORDER BY rowid",
			)
			.all(runId, now()) as {
			id: string;
			width: number;
			height: number;
			bytes: number;
			expires_at: number;
		}[];
		return {
			runId,
			conversationId,
			parentExecutionId: meta.execution_id,
			state: run.status,
			code: run.statusReason,
			generation: meta.generation,
			revision: meta.revision,
			calls: meta.calls,
			deadline: Date.parse(run.deadlineAt!),
			question: meta.question_id
				? {
						id: meta.question_id,
						kind: meta.question_kind,
						text:
							mem?.question ??
							"確認内容を取得できません。取消してやり直してください。",
						deadline: meta.question_deadline,
					}
				: null,
			answer: mem?.answer ?? null,
			captures: captures.map((c) => ({
				captureId: c.id,
				width: c.width,
				height: c.height,
				bytes: c.bytes,
				expiresAt: c.expires_at,
			})),
		};
	}
	function question(
		db: Database,
		meta: InteractMeta,
		result: Extract<InteractStepResult, { kind: "question" }>,
	) {
		const run = getRun(db, meta.owner, meta.run_id)!;
		transitionRun(db, meta.owner, meta.run_id, "needs_input", {
			nowIso: interactIso(now()),
			reason: result.approval ? "approval_required" : "clarify",
		});
		db.query(
			"UPDATE browser_interact_runs SET question_id=?,question_kind=?,question_deadline=?,revision=revision+1 WHERE run_id=?",
		).run(
			crypto.randomUUID(),
			result.capture ? "capture" : result.approval ? "approval" : "text",
			Math.min(now() + 600000, Date.parse(run.deadlineAt!)),
			meta.run_id,
		);
		memory.get(meta.run_id)!.question = result.text;
	}
	async function flush() {
		const closing: Promise<unknown>[] = [];
		for (const [id, mem] of memory) {
			const meta = store.read((db) => interactMeta(db, id));
			const run = meta ? store.read((db) => getRun(db, meta.owner, id)) : null;
			if (run && !isTerminalRunStatus(run.status)) continue;
			mem.controller.abort();
			if (meta?.job_id) queue.flushCancellations([meta.job_id]);
			if (mem.driver)
				closing.push(mem.driver.disconnect().catch(() => undefined));
			mem.driver = undefined;
			mem.core = null;
			mem.parts = undefined;
			mem.bridge = undefined;
			mem.results.clear();
			mem.request = "";
			mem.source = undefined;
			mem.pendingPart = undefined;
			mem.captureApproval = undefined;
			mem.brief = undefined;
			mem.startUrl = "";
			mem.execution = undefined;
			mem.question = undefined;
			if (!run) memory.delete(id);
		}
		for (const file of pendingFiles) {
			if (
				!store.read((db) =>
					db
						.query("SELECT 1 FROM browser_interact_captures WHERE file_ref=?")
						.get(file),
				)
			)
				closing.push(deps.files.remove(file));
			pendingFiles.delete(file);
		}
		queue.wake();
		await Promise.allSettled(closing);
	}
	function cancel(
		db: Database,
		owner: string,
		conversationId: string,
		id: string,
	) {
		const { meta } = authority.owned(db, owner, conversationId, id);
		authority.end(db, id, "cancelled", "cancel_requested");
		if (meta.job_id)
			queue.cancelInTransaction(db, meta.job_id, "cancel_requested");
		return view(db, owner, conversationId, id);
	}
	function forget(
		db: Database,
		owner: string,
		conversationId: string,
		id: string,
	) {
		cancel(db, owner, conversationId, id);
		const captures = db
			.query("SELECT file_ref FROM browser_interact_captures WHERE run_id=?")
			.all(id) as { file_ref: string }[];
		forgetRun(db, owner, id);
		for (const c of captures) pendingFiles.add(c.file_ref);
		db.query("DELETE FROM browser_approvals WHERE task_id=?").run(id);
		return captures.map((c) => c.file_ref);
	}
	return {
		deps,
		store,
		queue,
		now,
		memory,
		authority,
		step,
		pendingFiles,
		scheduleFlush,
		flush,
		view,
		question,
		cancel,
		forget,
	};
}
export type InteractState = ReturnType<typeof createInteractState>;
