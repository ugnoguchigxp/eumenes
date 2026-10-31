import type { Database } from "bun:sqlite";
import type { Run } from "./index";
/** An external voice frontend owns the speech; domain execution and approval stay here. */
export type ExternalOutputPort = {
	active(db: Database, conversationId: string): boolean;
	reattach(
		db: Database,
		runId: string,
		conversationId: string,
		input?: { text: string; existing: boolean },
	): void;
	owns(db: Database, runId: string): boolean;
	assertCurrent(db: Database, runId: string): void;
	offer(db: Database, run: Run, text: string, confirmation?: boolean): boolean;
	/** A settled delegated work result, independent of later conversational input versions. */
	report?(
		db: Database,
		input: { id: string; runId: string; conversationId: string; text: string },
	): boolean;
	announce(
		run: Run,
		text: string,
		signal: AbortSignal,
	): Promise<"full" | "partial">;
};
