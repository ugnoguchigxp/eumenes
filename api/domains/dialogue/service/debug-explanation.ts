import type { Database } from "bun:sqlite";
import type { Receipt } from "../../inference";
import { estimateMessageTokens } from "../../../infrastructure/context-budget";
import { systemContext } from "../../../infrastructure/system-context";
import type { Message } from "../../conversation/contracts";
import type { Run } from "../contracts";
import { runViewingSchema } from "../contracts/specialist";
import { runViewing } from "../repository/specialist";
import type { DialogueDeps } from "./context";
import { observedFailure, readRunLogs } from "./error-report";

export const DIAGNOSTIC_TIMEOUT_MS = 30_000;
export type DebugPayload = {
	epoch: string;
	conversationId: string;
	runId: string;
	triggerId: string;
	source: string;
	origin: string;
	manual: boolean;
	stage: string;
};
export type DebugResult = {
	summary: string | null;
	observation: string;
	receipt?: Receipt;
};
type DebugSource = {
	run: Run;
	message: Message;
	trigger: { message: Message };
};
const code = (value: string | null | undefined) =>
	value && /^[a-z][a-z0-9_]{0,79}$/u.test(value) ? value : undefined;
function observation(deps: DialogueDeps, tx: Database, source: DebugSource) {
	const { run } = source;
	const selection = deps.toolchains?.usageOfRunInTransaction?.(tx, run.id);
	const job = run.jobId ? deps.queue.getInTransaction(tx, run.jobId) : null;
	const viewing = runViewingSchema.safeParse(runViewing(tx, run.id)).data;
	return {
		observedAt: deps.clock(),
		scope:
			"対象の会話実行と記録された後続処理。利用者の受領・表示・再生は未確認。",
		run: {
			id: run.id,
			revision: run.revision,
			status: run.status,
			reason: code(run.error),
			responseSaved: !!run.answerMessageId,
		},
		job: job && {
			id: job.id,
			state: job.state,
			reason: code(job.errorCode),
			waiting: code(job.waitReason),
		},
		selection: selection && {
			toolchain: selection.toolchainId,
			outcome: selection.outcome,
			reason: code(selection.code),
		},
		screenAtInput: viewing?.screen && {
			phase: viewing.screen.phase,
			observedAt: viewing.screen.observedAt,
			activity: viewing.screen.activity,
		},
	};
}
export function createDebugExplanation(
	deps: DialogueDeps,
	current: (tx: Database, payload: DebugPayload) => DebugSource | null,
	setActive: (controller: AbortController) => void,
	clearActive: (controller: AbortController) => void,
) {
	const { larm, store } = deps;
	return {
		async execute(
			{ requestId, payload }: { requestId?: string; payload: DebugPayload },
			{ signal }: { signal: AbortSignal },
		): Promise<DebugResult> {
			const controller = new AbortController();
			setActive(controller);
			const deadline = AbortSignal.any([
				signal,
				controller.signal,
				AbortSignal.timeout(DIAGNOSTIC_TIMEOUT_MS),
			]);
			try {
				const record = store.read((tx) => {
					const source = current(tx, payload);
					return source && { source, values: observation(deps, tx, source) };
				});
				if (!record) throw new Error("debug_source_unavailable");
				const { run, message, trigger } = record.source;
				const tasks = run.agentTaskId
					? (deps.agents?.list(run.id) ?? []).slice(0, 8)
					: [];
				const logs = await readRunLogs(
					deps.logFile?.(),
					run,
					tasks,
					AbortSignal.any([deadline, AbortSignal.timeout(3000)]),
				);
				deadline.throwIfAborted();
				const values = {
					...record.values,
					trigger: payload.manual
						? "user_requested"
						: payload.stage === "router"
							? "routing_failed"
							: payload.stage === "run"
								? "run_ended"
								: "work_failed",
					logCoverage: logs.logMissing
						? "一部・ログ未確認"
						: "保持範囲の関連ログ",
					recordedFailure:
						run.error || !payload.manual
							? observedFailure(logs.entries, run.error)
							: undefined,
					omitted: false,
				};
				const system = systemContext(
					"dialogue.contexts.agency.debug-diagnostics",
					{},
				);
				const excerpt = payload.manual
					? {
							original: message.text.slice(0, 240),
							question: trigger.message.text.slice(0, 240),
						}
					: undefined;
				const input = () => [
					{ role: "system" as const, content: system },
					{
						role: "user" as const,
						content: JSON.stringify({ records: values, excerpt }),
					},
				];
				const details = JSON.stringify(values, null, 2);
				if (
					estimateMessageTokens(input()) >
						Math.min(2048, larm.savedLlmContextWindow?.() ?? 2048) ||
					!requestId ||
					!larm.executeRequest
				)
					return { summary: null, observation: details };
				if (!store.read((tx) => current(tx, payload)))
					throw new Error("debug_source_unavailable");
				try {
					const receipt = await larm.executeRequest(
						requestId,
						input(),
						deadline,
						undefined,
						{
							sessionRole: "auxiliary",
							yields: true,
							outputLimit: 384,
						},
					);
					deadline.throwIfAborted();
					const summary =
						typeof receipt.value === "string" ? receipt.value.trim() : "";
					return {
						summary: summary && summary.length <= 600 ? summary : null,
						observation: details,
						receipt,
					};
				} catch {
					return { summary: null, observation: details };
				}
			} finally {
				clearActive(controller);
			}
		},
	}.execute;
}
