import type { Database } from "bun:sqlite";
import type { DialogueService } from "../../domains/dialogue";
import type { ChildExecution, ChildResult } from "../../domains/tool-runtime";

/** The object-recognition backend keeps its existing consent, snapshot and ownership checks. */
export interface TaskLegacyPorts {
	availableInTransaction(
		db: Database,
		kind: "object-recognition",
		revisionId: string,
		sourceRunId?: string,
	): boolean;
	invokeInTransaction(
		db: Database,
		child: ChildExecution,
		prepared: Parameters<DialogueService["executionCommands"]["execute"]>[0],
		command: unknown,
	): ChildResult;
	currentInTransaction(
		db: Database,
		child: ChildExecution,
		ref: unknown,
	): ChildResult;
	cancelInTransaction(db: Database, child: ChildExecution, ref: unknown): void;
	validateAnswerInTransaction(
		db: Database,
		child: ChildExecution,
		ref: unknown,
		input: unknown,
	): boolean;
}
export function taskLegacyPorts(dialogue: DialogueService): TaskLegacyPorts {
	const commands = dialogue.executionCommands;
	function currentInTransaction(
		_db: Database,
		child: ChildExecution,
		raw: unknown,
	): ChildResult {
		return {
			state: "failed",
			ref: raw,
			output: null,
			summary: JSON.stringify({ errorCode: "delegation_result_unavailable" }),
			modelCalls: (child.usedModelCalls ?? 0) + 1,
			references: [],
		};
	}
	return {
		availableInTransaction: (db, _kind, _revision, runId) =>
			commands.legacyAvailableInTransaction(db, runId ?? ""),
		invokeInTransaction(db, child, prepared, command) {
			const receipt = commands.invokeLegacyInTransaction(
				db,
				child,
				prepared,
				command,
			);
			const read = ["read", "cancel"].includes(
				(receipt as { action?: string } | null)?.action ?? "",
			);
			// Opening or offering the screen is the whole command: the user continues there, so it is a success.
			return {
				state: "completed",
				ref: { kind: "legacy" as const, type: prepared.backend, receipt },
				output: receipt,
				summary: read
					? JSON.stringify(receipt)
					: `物体認識の画面を開き、利用者の操作を案内しました。${JSON.stringify(receipt)}`,
				modelCalls: (child.usedModelCalls ?? 0) + 1,
				references: [],
			};
		},
		currentInTransaction,
		validateAnswerInTransaction: () => false,
		cancelInTransaction() {},
	};
}
