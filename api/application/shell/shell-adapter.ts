import { z } from "zod";
import { cliRun } from "../../domains/capabilities/contracts";
import type { ShellService, ShellRun } from "../../domains/shell";
import type { DomainAdapter } from "../../domains/tool-runtime";
import { sha256Hex } from "../../infrastructure/digest";
export const SHELL_ADAPTER_REF = "adapter:shell@1";
const receiptSchema = z.strictObject({
	attemptId: z.string(),
	task: z.string(),
});
export const shellDomainSchemas = {
	"domain:shell.run-receipt@1": receiptSchema,
};
export const describeShellAdapter = () => ({
	owner: "shell",
	operations: new Map([
		[
			"shell.run",
			{ inputSchemaRef: "builtin:cliRun", effect: "write" as const },
		],
	]),
	queries: new Set(["query:shell.sessions@1"]),
	inputAdapters: new Map(),
	projections: new Set(["projection:shell.run-result@1"]),
	availability: "availability:shell@1",
});
export function shellAttemptId(requestId: string) {
	const hex = sha256Hex(`shell-run:${requestId}`);
	const variant = "89ab"[Number.parseInt(hex[16]!, 16) % 4]!;
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export function createShellAdapter(shell: ShellService): DomainAdapter {
	const result = (r: ShellRun, requestId: string, replay: boolean) => {
		const receipt = { attemptId: r.id, task: r.task };
		return {
			receipt,
			receiptRef: {
				owner: "shell",
				operationId: requestId,
				digest: sha256Hex(JSON.stringify(receipt)),
			},
			resultRefs: [
				{
					owner: "shell",
					kind: "shell-run",
					id: r.id,
					schemaRef: "domain:shell.run-receipt@1",
					revision: 1,
				},
			],
			replay,
			answerContext: {
				delivered: "queued",
				task: r.task,
				completed: false,
				reportedWhenDone: true,
			},
		};
	};
	return {
		ref: SHELL_ADAPTER_REF,
		describe: describeShellAdapter,
		availableInTransaction: () => shell.available(),
		snapshotInTransaction: (db) => ({
			runs: shell
				.recentInTransaction(db)
				.map(({ task, command, state, exitCode }) => ({
					task,
					command,
					state,
					exitCode,
				})),
		}),
		invokeInTransaction(db, request) {
			if (request.operationName !== "shell.run")
				throw new Error("unsupported_operation");
			const id = shellAttemptId(request.requestId);
			const input = cliRun.parse(request.input);
			const previous = shell.runInTransaction(db, id);
			const r = shell.enqueueRunInTransaction(db, {
				...input,
				attemptId: id,
				projectId: "eumenes",
				origin:
					request.origin.kind === "conversation" ? "conversation" : "execution",
				...("conversationId" in request.origin
					? { conversationId: request.origin.conversationId }
					: {}),
			});
			return result(r, request.requestId, !!previous);
		},
		readInTransaction(db, id) {
			const r = shell.runInTransaction(db, shellAttemptId(id));
			return r ? result(r, id, true) : null;
		},
		sourceInTransaction(_db, query, target) {
			if (query !== "query:shell.sessions@1" || target !== undefined)
				return null;
			const data = shell.list();
			return { revision: data.revision, data };
		},
		targetInput: () => ({}),
		execution: {
			currentInTransaction(db, id) {
				const r = shell.runInTransaction(db, shellAttemptId(id));
				const state = !r
					? "failed"
					: r.state === "completed"
						? r.exitCode === 0
							? "completed"
							: "failed"
						: r.state === "timed_out"
							? "failed"
							: r.state === "unknown"
								? "indeterminate"
								: r.state === "cancelled"
									? "cancelled"
									: "running";
				return {
					state,
					ref: { attemptId: shellAttemptId(id) },
					summary: r?.output || r?.state || "run_missing",
					output: r,
					modelCalls: 0,
					references: [],
					...(r?.reason ? { code: r.reason } : {}),
				};
			},
			cancelInTransaction: (db, id) => {
				shell.cancelInTransaction(db, shellAttemptId(id));
			},
			stop: async (id) =>
				(await shell.stop(shellAttemptId(id))) !== "unconfirmed",
			validateAnswerInTransaction: () => false,
		},
	};
}
