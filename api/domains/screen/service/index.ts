import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import {
	SCREEN_COMMAND_TTL_MS,
	type ScreenAction,
	type ScreenCommand,
	type ScreenReceipt,
	type ScreenReceiptResponse,
} from "../contracts";
import {
	getCommand,
	insertCommand,
	pendingCommands,
	settleCommand,
	staleCommands,
} from "../repository";

export type ScreenDeps = {
	store: SqliteStore;
	now?: () => number;
	/** Runs in the settling transaction, for every command that settles (a receipt or its expiry). */
	onSettled?: (db: Database, command: ScreenCommand) => void;
};

export type IssueScreenCommand = {
	conversationId: string;
	/** The canonical resource URI. */
	uri: string;
	action: ScreenAction;
	adapterRef: string;
	targetRef: string;
};

export function createScreen(deps: ScreenDeps) {
	const now = deps.now ?? Date.now;
	const iso = (ms: number) => new Date(ms).toISOString();

	/** Settles one pending command and tells the hook; null when it was settled already. */
	const settle = (
		db: Database,
		command: ScreenCommand,
		status: Exclude<ScreenCommand["status"], "pending">,
	): ScreenCommand | null => {
		const at = iso(now());
		if (!settleCommand(db, command.seq, status, at)) return null;
		const settled = { ...command, status, settledAt: at };
		deps.onSettled?.(db, settled);
		return settled;
	};

	/** Expires every pending command no screen received within the TTL. */
	const expireInTransaction = (db: Database): ScreenCommand[] =>
		staleCommands(db, iso(now() - SCREEN_COMMAND_TTL_MS)).flatMap(
			(command) => settle(db, command, "expired") ?? [],
		);

	return {
		/** Appends a pending command; commands older than the TTL expire in the same transaction. */
		issueInTransaction(db: Database, input: IssueScreenCommand): ScreenCommand {
			expireInTransaction(db);
			return insertCommand(db, { ...input, createdAt: iso(now()) });
		},
		expireInTransaction,
		/** Pending commands newer than `afterSeq` that are still inside the TTL, oldest first. */
		pendingAfter(conversationId: string, afterSeq: number): ScreenCommand[] {
			return deps.store.read((db) =>
				pendingCommands(
					db,
					conversationId,
					afterSeq,
					iso(now() - SCREEN_COMMAND_TTL_MS),
				),
			);
		},
		/** The first receipt settles the command; a later one (or one after expiry) is `command_settled`. */
		receipt(
			seq: number,
			outcome: ScreenReceipt["outcome"],
		): Promise<ScreenReceiptResponse> {
			return deps.store.write((db): ScreenReceiptResponse => {
				const command = getCommand(db, seq);
				if (!command) return { ok: false, code: "command_not_found" };
				if (command.status !== "pending")
					return { ok: false, code: "command_settled" };
				if (Date.parse(command.createdAt) < now() - SCREEN_COMMAND_TTL_MS) {
					settle(db, command, "expired");
					return { ok: false, code: "command_settled" };
				}
				const settled = settle(db, command, outcome);
				return settled
					? { ok: true, command: settled }
					: { ok: false, code: "command_settled" };
			});
		},
		command: (seq: number): ScreenCommand | null =>
			deps.store.read((db) => getCommand(db, seq)),
	};
}

export type ScreenService = ReturnType<typeof createScreen>;
