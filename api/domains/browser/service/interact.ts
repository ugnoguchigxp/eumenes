import type { Database } from "bun:sqlite";
import { getRun, isTerminalRunStatus } from "eumenes-interact/sqlite";
import { interactMeta } from "../repository/interact";
import type { InteractMeta } from "../contracts/interact";
import { createInteractState, type InteractDeps } from "./interact-state";
import { registerInteractQueue } from "./interact-queue";
import { interactCommands } from "./interact-commands";
/** Domain lifecycle on the host writer and queue; the package owns the saved run status. */
export function createBrowserInteract(deps: InteractDeps) {
	const state = createInteractState(deps);
	const {
		store,
		now,
		memory,
		authority,
		pendingFiles,
		scheduleFlush,
		flush,
		view,
		cancel,
		forget,
	} = state;
	const enqueue = registerInteractQueue(state);
	return {
		afterCommit() {
			scheduleFlush();
		},
		...interactCommands(state, enqueue),
		statusInTransaction: view,
		targetInTransaction(db: Database, owner: string, id: string) {
			const meta = interactMeta(db, id);
			if (!meta || meta.owner !== owner)
				throw new Error("browser_interact_not_found");
			return view(db, owner, meta.conversation_id, id);
		},
		listInTransaction(db: Database, owner: string, conversationId: string) {
			return (
				db
					.query(
						"SELECT run_id FROM browser_interact_runs WHERE owner=? AND conversation_id=? ORDER BY created_at DESC LIMIT 20",
					)
					.all(owner, conversationId) as { run_id: string }[]
			).map((r) => view(db, owner, conversationId, r.run_id));
		},

		cancelInTransaction: cancel,
		forgetInTransaction(
			db: Database,
			owner: string,
			conversationId: string,
			id: string,
		) {
			const { meta } = authority.owned(db, owner, conversationId, id);
			if (meta.execution_id)
				throw new Error("browser_interact_parent_forget_required");
			return forget(db, owner, conversationId, id);
		},
		purgeExecutionInTransaction(db: Database, id: string) {
			const rows = db
				.query("SELECT * FROM browser_interact_runs WHERE execution_id=?")
				.all(id) as InteractMeta[];
			return rows.flatMap((r) =>
				forget(db, r.owner, r.conversation_id, r.run_id),
			);
		},
		captureRunInTransaction(db: Database, owner: string, captureId: string) {
			return db
				.query(
					"SELECT m.run_id,m.conversation_id FROM browser_interact_captures c JOIN browser_interact_runs m ON m.run_id=c.run_id WHERE c.id=? AND m.owner=?",
				)
				.get(captureId, owner) as {
				run_id: string;
				conversation_id: string;
			} | null;
		},
		async sweep() {
			await store.write((db) => {
				const rows = db
					.query("SELECT * FROM browser_interact_runs")
					.all() as InteractMeta[];
				for (const meta of rows) {
					const run = getRun(db, meta.owner, meta.run_id)!;
					if (
						!isTerminalRunStatus(run.status) &&
						(!memory.has(meta.run_id) || Date.parse(run.deadlineAt!) <= now())
					)
						authority.end(
							db,
							meta.run_id,
							Date.parse(run.deadlineAt!) <= now() ? "expired" : "failed",
							Date.parse(run.deadlineAt!) <= now()
								? "deadline"
								: "browser_interact_context_lost",
						);
					if (meta.expires_at <= now())
						forget(db, meta.owner, meta.conversation_id, meta.run_id);
				}
				const expired = db
					.query(
						"SELECT file_ref FROM browser_interact_captures WHERE expires_at<=?",
					)
					.all(now()) as { file_ref: string }[];
				for (const c of expired) pendingFiles.add(c.file_ref);
				db.query(
					"DELETE FROM browser_interact_captures WHERE expires_at<=?",
				).run(now());
			});
			await flush();
			for (const file of await deps.files.listTemp()) {
				const id = file.replace(/\.tmp$/, "");
				if (![...memory.values()].some((m) => m.pendingCaptures?.has(id)))
					await deps.files.remove(file);
			}
			for (const file of await deps.files.listAdopted()) {
				const id = file.replace(/\.webp$/, "");
				const kept =
					store.read((db) =>
						db
							.query("SELECT 1 FROM browser_interact_captures WHERE file_ref=?")
							.get(file),
					) || [...memory.values()].some((m) => m.pendingCaptures?.has(id));
				if (!kept) await deps.files.remove(file);
			}
		},
		async captureContent(
			owner: string,
			conversationId: string,
			runId: string,
			captureId: string,
		) {
			const row = store.read((db) => {
				authority.owned(db, owner, conversationId, runId);
				return db
					.query(
						"SELECT file_ref FROM browser_interact_captures WHERE id=? AND run_id=? AND expires_at>?",
					)
					.get(captureId, runId, now()) as { file_ref: string } | null;
			});
			if (!row) throw new Error("browser_capture_not_found");
			return { bytes: await deps.files.read(row.file_ref), mime: "image/webp" };
		},
		async close() {
			for (const mem of memory.values()) mem.controller.abort();
			await Promise.allSettled(
				[...memory.values()].map((m) => m.driver?.disconnect()),
			);
			memory.clear();
		},
	};
}
export type BrowserInteractService = ReturnType<typeof createBrowserInteract>;
export type BrowserInteractView = ReturnType<
	BrowserInteractService["statusInTransaction"]
>;
