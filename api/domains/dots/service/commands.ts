import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { claimInput, type Command } from "../contracts";
import * as repo from "../repository";

export function createCommands(store: SqliteStore, now: () => number) {
	function available(db: Database, c: Command, owner: string) {
		if (c.connectionRef !== owner) throw new Error("dots_permission_denied");
		if (!repo.connection(db, owner)?.enabled && c.kind !== "stop")
			throw new Error("dots_unavailable");
		if (c.expiresAt <= now() || c.state === "superseded")
			throw new Error("dots_stale");
		return c;
	}
	return {
		renewStopInTransaction(db: Database, commandId: string) {
			const c = repo.command(db, commandId);
			if (!c || c.kind !== "stop" || c.state === "superseded")
				throw new Error("dots_stale");
			c.expiresAt = now() + 86400000;
			repo.putCommand(db, c);
			return c;
		},
		prepareInTransaction(db: Database, c: Command) {
			const old = repo.command(db, c.commandId);
			if (old) {
				if (old.taskId !== c.taskId || old.kind !== c.kind)
					throw new Error("dots_conflict");
				return old;
			}
			if (
				(
					db.query("SELECT count(*) AS n FROM dots_commands").get() as {
						n: number;
					}
				).n >= (c.kind === "stop" ? 4096 : 3840)
			)
				throw new Error("dots_capacity");
			repo.putCommand(db, c);
			return c;
		},
		list(owner: string, after = 0, limit = 50) {
			if (
				!Number.isSafeInteger(after) ||
				after < 0 ||
				!Number.isSafeInteger(limit) ||
				limit < 1 ||
				limit > 100
			)
				throw new Error("invalid_dots_cursor");
			return store.readSnapshot((db) => {
				const items = repo.commands(db, owner, after, limit + 1);
				return {
					items: items
						.slice(0, limit)
						.filter((r) => r.command.expiresAt > now())
						.map((r) => ({
							commandId: r.command.commandId,
							kind: r.command.kind,
							claimed: r.command.state === "claimed",
						})),
					nextCursor: items.length > limit ? items[limit - 1]!.seq : null,
				};
			});
		},
		getInTransaction(db: Database, owner: string, id: string) {
			const c = repo.command(db, id);
			if (!c) throw new Error("dots_not_found");
			return available(db, c, owner);
		},
		async claim(
			owner: string,
			raw: unknown,
			validate?: (db: Database, c: Command) => void,
		) {
			const data = claimInput.parse(raw);
			return store.write((db) => {
				const c = repo.command(db, data.commandId);
				if (!c) throw new Error("dots_not_found");
				available(db, c, owner);
				validate?.(db, c);
				if (c.state === "reported" && c.kind !== "reminder")
					throw new Error("dots_stale");
				if (c.leaseId && c.leaseId !== data.leaseId)
					throw new Error("dots_conflict");
				c.leaseId = data.leaseId;
				c.state = "claimed";
				repo.putCommand(db, c);
				return {
					commandId: c.commandId,
					leaseId: c.leaseId,
					expiresAt: c.expiresAt,
				};
			});
		},
		supersedeInTransaction(
			db: Database,
			taskId: string,
			preserveReminders = false,
		) {
			for (const c of repo.taskCommands(db, taskId))
				if (
					c.state !== "superseded" &&
					(!preserveReminders || c.kind !== "reminder")
				) {
					c.state = "superseded";
					repo.putCommand(db, c);
				}
		},
		redactInTransaction(db: Database, taskId: string) {
			for (const c of repo.taskCommands(db, taskId)) {
				if (c.kind !== "stop") c.state = "superseded";
				c.snapshot = {
					protocolVersion: 1,
					task: {
						id: taskId,
						...(c.kind === "stop"
							? {
									stopIntent: (c.snapshot.task as { stopIntent?: string })
										.stopIntent,
								}
							: {}),
					},
					project: c.snapshot.project,
					sessions: c.snapshot.sessions,
				};
				repo.putCommand(db, c);
			}
			db.query("DELETE FROM dots_reports WHERE task_id=?").run(taskId);
			db.query("DELETE FROM dots_dialogue_receipts WHERE task_id=?").run(
				taskId,
			);
		},
		purgeInTransaction: repo.purge,
	};
}
