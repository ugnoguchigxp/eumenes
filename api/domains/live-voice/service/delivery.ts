import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { active, session } from "../repository";

export function createLiveDelivery(
	store: SqliteStore,
	sendState: (id: string) => void,
	usable: (id: string) => boolean = () => true,
) {
	const waiters = new Map<string, () => void>();
	function owns(db: Database, runId: string) {
		return !!db
			.query("SELECT 1 FROM live_voice_runs WHERE run_id=?")
			.get(runId);
	}
	function assertCurrent(db: Database, runId: string) {
		const run = db
			.query(
				"SELECT session_id,input_version FROM live_voice_runs WHERE run_id=?",
			)
			.get(runId) as { session_id: string; input_version: number } | null;
		if (!run) return;
		const row = session(db, run.session_id);
		if (!row || row.status !== "active" || !usable(row.id))
			throw new Error("live_session_inactive");
		if (row.input_version !== run.input_version)
			throw new Error("live_input_changed");
	}
	function capture(
		db: Database,
		runId: string,
		conversationId: string,
		input?: { text: string; existing: boolean },
	) {
		const row = active(db, conversationId);
		if (!row || row.test || row.status !== "active") return;
		if (!usable(row.id)) throw new Error("live_session_inactive");
		if (input && !input.existing) {
			db.query(
				"UPDATE live_voice_sessions SET input_version=input_version+1 WHERE id=?",
			).run(row.id);
			row.input_version++;
			db.query(
				"INSERT INTO live_voice_outputs(session_id,run_id,text,kind) VALUES(?,?,?,'thinking')",
			).run(
				row.id,
				runId,
				`利用者の文字入力（backendで処理中、再委任不要）:\n${input.text}`,
			);
		}
		db.query("INSERT OR IGNORE INTO live_voice_runs VALUES(?,?,?)").run(
			runId,
			row.id,
			row.input_version,
		);
	}
	function offer(
		db: Database,
		run: { id: string; conversationId: string },
		text: string,
		confirmation = false,
	) {
		const linked = db
			.query("SELECT session_id FROM live_voice_runs WHERE run_id=?")
			.get(run.id) as { session_id: string } | null;
		if (!linked) return false;
		assertCurrent(db, run.id);
		if (text.trim()) {
			db.query(
				"INSERT INTO live_voice_outputs(session_id,run_id,text,kind) VALUES(?,?,?,?)",
			).run(linked.session_id, run.id, text, "commentary");
			if (confirmation)
				db.query(
					"INSERT OR IGNORE INTO live_voice_notices VALUES(?,?,?,?,0)",
				).run(
					`confirmation:${run.id}`,
					linked.session_id,
					text,
					"confirmation",
				);
		}
		return true;
	}
	async function announce(
		run: { id: string; conversationId: string; revision?: number },
		text: string,
		signal: AbortSignal,
	): Promise<"full"> {
		const noticeId = `announcement:${run.id}:${run.revision ?? 0}`;
		const sessionId = await store.write((db) => {
			assertCurrent(db, run.id);
			const linked = db
				.query("SELECT session_id FROM live_voice_runs WHERE run_id=?")
				.get(run.id) as { session_id: string };
			db.query(
				"INSERT OR IGNORE INTO live_voice_notices VALUES(?,?,?,?,0)",
			).run(noticeId, linked.session_id, text, "announcement");
			return linked.session_id;
		});
		sendState(sessionId);
		await new Promise<void>((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout>;
			const cleanup = () => {
				clearTimeout(timer);
				waiters.delete(noticeId);
				signal.removeEventListener("abort", abort);
			};
			const abort = () => {
				cleanup();
				reject(new Error("live_delivery_cancelled"));
			};
			waiters.set(noticeId, () => {
				cleanup();
				resolve();
			});
			timer = setTimeout(abort, 30000);
			signal.addEventListener("abort", abort, { once: true });
			const delivered = store.read(
				(db) =>
					db
						.query("SELECT displayed FROM live_voice_notices WHERE id=?")
						.get(noticeId) as { displayed: number } | null,
			);
			if (delivered?.displayed) {
				cleanup();
				resolve();
			} else if (signal.aborted) abort();
		});
		return "full";
	}
	async function displayed(
		id: string,
		noticeId: string,
		onDisplayed?: (db: Database, conversationId: string) => void,
	) {
		await store.write((db) => {
			const row = session(db, id);
			if (!row || row.status !== "active")
				throw new Error("live_session_inactive");
			const n = db
				.query(
					"SELECT kind FROM live_voice_notices WHERE id=? AND session_id=?",
				)
				.get(noticeId, id) as { kind: string } | null;
			if (!n) throw new Error("live_notice_missing");
			onDisplayed?.(db, row.conversation_id);
			db.query("UPDATE live_voice_notices SET displayed=1 WHERE id=?").run(
				noticeId,
			);
		});
		waiters.get(noticeId)?.();
		sendState(id);
	}
	function report(
		db: Database,
		input: { id: string; runId: string; conversationId: string; text: string },
	) {
		const row = active(db, input.conversationId);
		if (!row || row.test || row.status !== "active" || !usable(row.id))
			return false;
		const noticeId = `report:${input.id}`;
		const inserted = db
			.query("INSERT OR IGNORE INTO live_voice_notices VALUES(?,?,?,?,0)")
			.run(noticeId, row.id, input.text, "announcement");
		if (inserted.changes)
			db.query(
				"INSERT INTO live_voice_outputs(session_id,run_id,text,kind) VALUES(?,?,?,'report')",
			).run(row.id, input.runId, input.text);
		return true;
	}
	return { owns, assertCurrent, capture, offer, announce, displayed, report };
}
