import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
	reportSchema,
	type DotReport,
	type Command,
	type NativeSession,
} from "../contracts";
import * as repo from "../repository";

export function createInbox(now: () => number) {
	return {
		dialogueReceiptInTransaction(db: Database, runId: string) {
			const r = db
				.query("SELECT receipt_json FROM dots_dialogue_receipts WHERE run_id=?")
				.get(runId) as { receipt_json: string } | null;
			return r ? (JSON.parse(r.receipt_json) as unknown) : null;
		},
		saveDialogueReceiptInTransaction(
			db: Database,
			runId: string,
			conversationId: string,
			taskId: string,
			receipt: unknown,
		) {
			db.query("INSERT INTO dots_dialogue_receipts VALUES(?,?,?,?)").run(
				runId,
				conversationId,
				taskId,
				JSON.stringify(receipt),
			);
		},
		projectsInTransaction(db: Database) {
			return (
				db
					.query("SELECT data_json FROM dots_projects ORDER BY ref LIMIT 64")
					.all() as { data_json: string }[]
			).map(
				(r) =>
					JSON.parse(r.data_json) as NonNullable<
						ReturnType<typeof repo.project>
					>,
			);
		},
		sessionsInTransaction(db: Database, taskId: string): NativeSession[] {
			return (
				db
					.query("SELECT data_json FROM dots_sessions WHERE task_id=?")
					.all(taskId) as { data_json: string }[]
			).map((r) => JSON.parse(r.data_json));
		},
		sessionAssociationsInTransaction(db: Database, threadId: string) {
			return (
				db
					.query(
						"SELECT task_id,data_json FROM dots_sessions WHERE thread_id=?",
					)
					.all(threadId) as { task_id: string; data_json: string }[]
			).map((r) => ({
				taskId: r.task_id,
				session: JSON.parse(r.data_json) as NativeSession,
			}));
		},
		appendInTransaction<T>(
			db: Database,
			owner: string,
			raw: unknown,
			adopt: (r: DotReport, c: Command) => T,
		) {
			const r = reportSchema.parse(raw),
				c = repo.command(db, r.commandId);
			if (!c || c.connectionRef !== owner || c.taskId !== r.taskId)
				throw new Error("dots_permission_denied");
			const digest = createHash("sha256")
					.update(JSON.stringify(r))
					.digest("hex"),
				old = repo.report(db, r.reportId);
			if (old) {
				if (old.task_id !== r.taskId || old.digest !== digest)
					throw new Error("dots_conflict");
				return JSON.parse(old.receipt_json) as T;
			}
			if (c.state === "superseded" || c.expiresAt <= now() || !c.leaseId)
				throw new Error("dots_stale");
			if (
				c.authorityEpoch !== r.authorityEpoch ||
				c.executionGeneration !== r.executionGeneration
			)
				throw new Error("dots_stale");
			if (r.sourceSequence !== repo.lastSequence(db, r.taskId) + 1)
				throw new Error("dots_sequence_gap");
			if (
				r.kind !== "stopped" &&
				(
					db
						.query(
							"SELECT count(*) AS n FROM dots_reports WHERE task_id=? AND json_extract(data_json,'$.kind')!='stopped'",
						)
						.get(r.taskId) as { n: number }
				).n >= 1000
			)
				throw new Error("dots_capacity");
			if (r.kind === "reminder") {
				if (!r.reminder) throw new Error("invalid_dots_report");
				const s = db
					.query(
						"SELECT task_id,connection_ref,command_id,expires_at FROM dots_schedules WHERE ref=?",
					)
					.get(r.reminder.scheduleRef) as {
					task_id: string;
					connection_ref: string;
					command_id: string;
					expires_at: number;
				} | null;
				if (
					s?.task_id !== r.taskId ||
					s.connection_ref !== owner ||
					s.command_id !== c.commandId ||
					s.expires_at <= now()
				)
					throw new Error("dots_permission_denied");
				if (
					db
						.query(
							"SELECT report_id FROM dots_reminders WHERE schedule_ref=? AND occurrence_ref=?",
						)
						.get(r.reminder.scheduleRef, r.reminder.occurrenceRef)
				)
					throw new Error("dots_conflict");
			}
			const receipt = adopt(r, c);
			for (const s of r.sessions) {
				const oldSession = db
					.query(
						"SELECT task_id,data_json FROM dots_sessions WHERE thread_id=? AND task_id=?",
					)
					.get(s.threadId, r.taskId) as {
					task_id: string;
					data_json: string;
				} | null;
				if (
					oldSession &&
					(oldSession.task_id !== r.taskId ||
						oldSession.data_json !== JSON.stringify(s))
				)
					throw new Error("dots_conflict");
				db.query("INSERT OR IGNORE INTO dots_sessions VALUES(?,?,?)").run(
					s.threadId,
					r.taskId,
					JSON.stringify(s),
				);
			}
			if (r.reminder && r.kind === "reminder")
				db.query("INSERT INTO dots_reminders VALUES(?,?,?)").run(
					r.reminder.scheduleRef,
					r.reminder.occurrenceRef,
					r.reportId,
				);
			if (r.kind !== "progress") {
				c.state = "reported";
				repo.putCommand(db, c);
			}
			repo.saveReport(
				db,
				r.kind === "stopped"
					? {
							...r,
							summary: "stop_confirmed",
							sessions: [],
							facts: [],
							limitations: [],
							evidenceRefs: [],
							question: undefined,
							completionChecks: undefined,
							reminder: undefined,
						}
					: r,
				digest,
				receipt,
			);
			return receipt;
		},
		scheduleInTransaction(db: Database, scheduleRef: string) {
			return db
				.query(
					"SELECT task_id,connection_ref,command_id,expires_at FROM dots_schedules WHERE ref=?",
				)
				.get(scheduleRef) as {
				task_id: string;
				connection_ref: string;
				command_id: string;
				expires_at: number;
			} | null;
		},
		bindScheduleInTransaction(
			db: Database,
			owner: string,
			taskId: string,
			scheduleRef: string,
			commandId: string,
			expiresAt: number,
		) {
			const old = db
				.query("SELECT task_id,connection_ref FROM dots_schedules WHERE ref=?")
				.get(scheduleRef) as { task_id: string; connection_ref: string } | null;
			if (old && (old.task_id !== taskId || old.connection_ref !== owner))
				throw new Error("dots_conflict");
			db.query(
				"INSERT INTO dots_schedules VALUES(?,?,?,?,?) ON CONFLICT(ref) DO UPDATE SET command_id=excluded.command_id,expires_at=excluded.expires_at",
			).run(scheduleRef, owner, taskId, commandId, expiresAt);
		},
		lastSequenceInTransaction: repo.lastSequence,
		connectionInTransaction: repo.connection,
		projectInTransaction: repo.project,
		commandsInTransaction: repo.taskCommands,
	};
}
