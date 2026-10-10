import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { WorkTask } from "../contracts";
import * as repo from "../repository";
import type { TaskCore } from "./core";
import { terminal } from "./helpers";

/** Read models: task detail with available actions, listing and event history. */
export function createTaskQueries(store: SqliteStore, core: TaskCore) {
	const { now, kindFor, requireTask } = core;
	return {
		get(taskId: string) {
			return store.readSnapshot((tx) => {
				const t = requireTask(tx, taskId);
				const actions: (
					| "start"
					| "amend"
					| "answer"
					| "pause"
					| "cancel"
					| "forget"
				)[] = [];
				const valid =
					Date.parse(t.grant.expiresAt) > now() &&
					(t.executionDeadlineAt === null ||
						Date.parse(t.executionDeadlineAt) > now());
				if (t.forgottenAt === null) actions.push("forget");
				if (
					["registered", "paused"].includes(t.state) &&
					valid &&
					kindFor(t)?.available()
				)
					actions.push("start");
				if (
					!terminal(t.state) &&
					!["stopping", "reconciling"].includes(t.state) &&
					(t.executionDeadlineAt === null ||
						Date.parse(t.executionDeadlineAt) > now())
				)
					actions.push("amend");
				if (
					t.state === "waiting_user" &&
					valid &&
					kindFor(t)?.available() &&
					kindFor(t)?.answerInTransaction
				)
					actions.push("answer");
				if (!terminal(t.state)) {
					if (!["stopping", "paused"].includes(t.state)) actions.push("pause");
					if (t.stopIntent !== "cancel") actions.push("cancel");
				}
				return {
					task: t,
					question: repo.openQuestion(tx, taskId),
					availableActions: actions,
					execution: null,
					supervisor: null,
					latestReport: null,
				};
			});
		},
		list(
			query: {
				state?: WorkTask["state"];
				conversationId?: string;
				cursor?: string;
				limit?: number;
			} = {},
		) {
			const size = query.limit ?? 50;
			const cursor =
				query.cursor === undefined ? undefined : Number(query.cursor);
			if (
				!Number.isInteger(size) ||
				size < 1 ||
				size > 100 ||
				(cursor !== undefined &&
					(!/^[1-9]\d*$/.test(query.cursor!) ||
						!Number.isSafeInteger(cursor) ||
						cursor < 1))
			)
				throw new Error("invalid_cursor");
			const rows = store.read((tx) =>
				repo.list(tx, { ...query, cursor, limit: size + 1 }),
			);
			return {
				items: rows.slice(0, size).map((r) => r.task),
				nextCursor: rows.length > size ? String(rows[size - 1]!.seq) : null,
			};
		},
		events(taskId: string, cursor = "0", limit = 50) {
			const after = Number(cursor);
			if (
				!/^\d+$/.test(cursor) ||
				!Number.isSafeInteger(after) ||
				after < 0 ||
				!Number.isInteger(limit) ||
				limit < 1 ||
				limit > 100
			)
				throw new Error("invalid_cursor");
			return store.readSnapshot((tx) => {
				const t = requireTask(tx, taskId);
				if (after > t.eventSeq) throw new Error("invalid_cursor");
				const items = repo.events(tx, taskId, after, limit);
				return {
					items,
					nextCursor: String(items.at(-1)?.seq ?? after),
					historyExpired: t.metadataExpired,
				};
			});
		},
	};
}
