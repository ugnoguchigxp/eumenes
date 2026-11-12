import type { Database } from "bun:sqlite";
import type { ScheduleReadTarget } from "../../capabilities";
import type { Run, RunViewing } from ".";
import { z } from "zod";

export const diagnosticRef = z.string().regex(/^e[1-9]\d{0,12}$/u);

/** The dialogue host supplies the conversation and its current source restrictions. */
export type DiagnosticScope = {
	conversationId: string;
	viewing: RunViewing | null;
	registrationVisible(requestId: string): boolean;
	run(id: string): Run | null;
	answerSaved(run: Run): boolean;
};

export type DiagnosticResult = {
	coverage: "complete" | "partial";
	scope: Record<string, string>;
	items: Array<Record<string, unknown>>;
};

export type DiagnosticsPort = {
	readInTransaction(
		db: Database,
		scope: DiagnosticScope,
		target: ScheduleReadTarget,
	): DiagnosticResult;
};
