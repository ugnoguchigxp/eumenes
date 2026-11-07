import { reviewInteractFinish } from "./interact-completion";
import {
	applyResult,
	parseStep,
	prepareStep,
	startRun,
} from "eumenes-interact";
import { createPartExecutor } from "eumenes-interact/parts";
import { getRun } from "eumenes-interact/sqlite";
import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type {
	InteractInference,
	InteractMemory,
	InteractDriver,
} from "../contracts/interact";
import type {
	CaptureFiles,
	ImageEncoder,
	HostResolver,
} from "../contracts/ports";
import { createInteractExecution } from "./interact-execution";
import { interactMeta } from "../repository/interact";
import type { InteractAuthority } from "./interact-authority";
import { waitInteract } from "./interact-wait";
import { interactHash } from "./interact-authority";
import { Refusal } from "eumenes-interact/parts";
import { interactKnowledge } from "./interact-knowledge";

export type InteractStepResult =
	| { kind: "continue" }
	| { kind: "question"; text: string; approval: boolean; capture?: boolean }
	| {
			kind: "end";
			status: "completed" | "partial" | "failed" | "indeterminate";
			code: string;
			text?: string;
	  };
export type InteractStepInput = {
	runId: string;
	owner: string;
	conversationId: string;
	generation: number;
	jobId: string;
	jobGeneration: number;
	deadline: number;
};
export type InteractStepDeps = {
	store: SqliteStore;
	authority: InteractAuthority;
	memory: Map<string, InteractMemory>;
	now: () => number;
	infer: InteractInference;
	createDriver: (runId: string) => InteractDriver;
	files: CaptureFiles;
	encoder: ImageEncoder;
	resolveHost: HostResolver;
	webOrigins: readonly string[];
	reviewInstructions: string;
};
const ended = (
	status: "partial" | "failed" | "indeterminate",
	code: string,
): InteractStepResult => ({ kind: "end", status, code });

/** Core state and observations are transient. Queue jobs persist only identifiers and counts. */
export function createInteractStep(deps: InteractStepDeps) {
	async function setup(
		input: InteractStepInput,
		mem: InteractMemory,
		signal: AbortSignal,
	) {
		const context = { ...input, signal };
		if (!mem.bridge) {
			mem.driver = deps.createDriver(input.runId);
			mem.bridge = createInteractExecution(
				{ ...deps, memory: mem, driver: mem.driver },
				context,
			);
		} else mem.bridge.setContext(context);
		if (!mem.parts)
			mem.parts = createPartExecutor({
				executor: mem.bridge.port,
				tabs: mem.bridge.tabs,
				request: mem.request,
				grants: mem.bridge.grants,
				captures: { save: mem.bridge.save },
				recorder: { partCall() {}, partResult() {}, captureSaved() {} },
				events: { event() {} },
				knowledge: interactKnowledge(deps.store, input.owner, deps.now),
			});
		if (!mem.core) {
			const first =
				mem.driver!.state().state === "connected"
					? await mem.bridge.port.execute({ kind: "observe" })
					: null;
			const page =
				first?.kind === "outcome" && first.outcome.kind === "observation"
					? {
							tabs: mem.bridge.tabs.open(),
							observation: first.outcome.observation,
						}
					: await mem.bridge.begin(mem.startUrl);
			const run = deps.store.read((db) =>
				getRun(db, input.owner, input.runId),
			)!;
			const meta = deps.store.read((db) => interactMeta(db, input.runId))!;
			mem.core = startRun({
				arm: "arm1",
				request: mem.request,
				brief: mem.brief,
				reference: {
					page: mem.parts.begin(page),
					priorResults: [...mem.results.values()].map((r) => ({
						part: r.part,
						status: r.status,
						resultId: r.resultId,
					})),
				},
				policy: {
					...run.policy,
					maxModelCalls: Math.max(1, run.policy.maxModelCalls - meta.calls - 1),
				},
				nowMs: deps.now(),
			});
		}
	}
	async function infer(
		input: InteractStepInput,
		mem: InteractMemory,
		signal: AbortSignal,
		prepared: Parameters<InteractInference>[0]["prepared"],
		purpose: "execute" | "completion_review",
	) {
		const current = (db: Database) =>
			deps.authority.current(
				db,
				input.runId,
				input.generation,
				input.jobId,
				input.jobGeneration,
			);
		const step = await deps.store.write((db) => {
			if (!current(db)) throw new Error("browser_interact_not_active");
			const run = getRun(db, input.owner, input.runId)!;
			const meta = interactMeta(db, input.runId)!;
			if (meta.calls >= run.policy.maxModelCalls)
				throw new Error("budget_exhausted");
			db.query(
				"UPDATE browser_interact_runs SET calls=calls+1,revision=revision+1 WHERE run_id=?",
			).run(input.runId);
			return meta.calls + 1;
		});
		return deps.infer(
			{ ...input, step, purpose, prepared, source: mem.source },
			signal,
			current,
		);
	}
	async function acceptPart(
		mem: InteractMemory,
		call: import("eumenes-interact").PartCall,
	): Promise<InteractStepResult> {
		const captureQuestion = (): InteractStepResult => {
			mem.pendingPart = call;
			return {
				kind: "question",
				approval: true,
				capture: true,
				text: "選択した範囲を画像として保存してよいですか。",
			};
		};
		if (
			call.part === "page.capture" &&
			call.args.phase === "save" &&
			mem.captureApproval?.partDigest !== interactHash(call)
		)
			return captureQuestion();
		let executed;
		try {
			executed = await mem.parts!.run(call);
		} catch (e) {
			if (e instanceof Refusal && e.code === "capture_approval_stale")
				return captureQuestion();
			throw e;
		}
		if (executed.kind === "end")
			return ended(
				executed.status === "indeterminate" ? "indeterminate" : "failed",
				executed.code,
			);
		if (
			executed.outcome.kind === "part" &&
			executed.outcome.result.code === "capture_approval_stale"
		)
			return captureQuestion();
		if (executed.outcome.kind === "stop") {
			mem.pendingPart = call;
			return { kind: "question", text: executed.outcome.text, approval: true };
		}
		if (executed.outcome.kind === "part")
			mem.results.set(
				executed.outcome.result.resultId,
				executed.outcome.result,
			);
		const applied = applyResult(mem.core!, executed.outcome);
		mem.core = applied.state;
		mem.pendingPart = undefined;
		if (applied.step.kind === "failed")
			return ended("failed", applied.step.code);
		if (applied.step.kind === "stopped")
			return { kind: "question", text: applied.step.text, approval: false };
		return { kind: "continue" };
	}

	const executeStep = async (
		input: InteractStepInput,
		jobSignal: AbortSignal,
	): Promise<InteractStepResult> => {
		const mem = deps.memory.get(input.runId);
		if (!mem) return ended("failed", "browser_interact_context_lost");
		const signal = AbortSignal.any([
			jobSignal,
			mem.controller.signal,
			AbortSignal.timeout(Math.max(1, input.deadline - deps.now())),
		]);
		await setup(input, mem, signal);
		let outcome: InteractStepResult;
		if (mem.pendingPart) outcome = await acceptPart(mem, mem.pendingPart);
		else {
			const raw = await infer(
				input,
				mem,
				signal,
				prepareStep(mem.core!),
				"execute",
			);
			signal.throwIfAborted();
			const parsed = parseStep(mem.core!, raw);
			mem.core = parsed.state;
			const step = parsed.step;
			switch (step.kind) {
				case "continue":
					outcome = { kind: "continue" };
					break;
				case "call":
					outcome =
						step.call.kind === "part"
							? await acceptPart(mem, step.call.part)
							: ended("failed", "unsupported");
					break;
				case "clarify":
					outcome = { kind: "question", text: step.text, approval: false };
					break;
				case "stop":
					outcome = { kind: "question", text: step.text, approval: false };
					break;
				case "failed":
					outcome = ended("failed", step.code);
					break;
				case "finish":
					outcome = await reviewInteractFinish(
						input,
						mem,
						signal,
						step,
						infer,
						deps.reviewInstructions,
					);
					break;
			}
		}
		if (outcome.kind === "end") await mem.driver?.disconnect();
		signal.throwIfAborted();
		return outcome;
	};
	return (input: InteractStepInput, jobSignal: AbortSignal) => {
		const mem = deps.memory.get(input.runId);
		const signal = AbortSignal.any([
			jobSignal,
			...(mem ? [mem.controller.signal] : []),
			AbortSignal.timeout(Math.max(1, input.deadline - deps.now())),
		]);
		return waitInteract(executeStep(input, signal), signal);
	};
}
