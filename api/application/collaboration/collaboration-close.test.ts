import { expect, test } from "bun:test";
import { configureLogging } from "../../infrastructure/logger";
import { searchThenDelegate } from "../toolchain/conversation-script.fixture";
import { harness } from "../toolchain/toolchain.fixture";

type Host = Awaited<ReturnType<typeof harness>>;
const draftRequest = "タイマーの手順を一緒に組み立てて";
const taskRequest = "Collaborationで作業結果を確認して";

async function setup() {
	const h = await harness({
		memory: true,
		pipelines: true,
		timers: true,
		discoveryTarget: (query) =>
			query === draftRequest ? "collaborate_pipeline" : "collaborate_task",
		firstRound: (_tools, question, messages) =>
			searchThenDelegate(
				(card) =>
					card.id ===
					(question === draftRequest
						? "collaboration.pipeline"
						: "collaboration.task"),
				question,
				{ announcement: "担当に引き継ぎます。", impact: "create" },
			)(messages),
		specialist: () => ({ action: "reply", text: "確認しました。" }),
	});
	const saved = h.settings.get();
	saved.routes.llm.mode = "larm-preferred";
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: saved.revision,
		settings: saved,
		keys: [],
	});
	return h;
}

async function say(h: Host, conversationId: string, text: string) {
	const run = await h.dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId,
		text,
	});
	const terminal = await h.dialogue.waitForTerminal(run.id, {
		timeoutMs: 7000,
	});
	expect(terminal?.status).toBe("completed");
	return h.dialogue.get(run.id)!;
}

async function open(h: Host, conversationId: string, text: string) {
	const run = await say(h, conversationId, text);
	const session = h.dialogue.specialistSession(conversationId)!;
	expect(run.specialistSessionId).toBe(session.id);
	return { ...session, run };
}

const workOf = (h: Host, workRef: string) =>
	h.store.read((db) =>
		db.query("SELECT * FROM collaboration_works WHERE id=?").get(workRef),
	);

const closeStatus = (h: Host, id: string) =>
	h.store.read((db) =>
		db
			.query(
				`SELECT state, end_reason, closing_reason, close_failures, close_blocked_reason,
			close_blocked_at FROM dialogue_specialist_sessions WHERE id=?`,
			)
			.get(id),
	);

test("expired closing sessions retain a pipeline draft and a completed child across sweeps and recovery", async () => {
	const h = await setup();
	const logs: { event: string; sessionId: string }[] = [];
	try {
		const draft = await open(h, "draft-close", draftRequest);
		const task = await open(h, "task-close", taskRequest);
		expect([draft, task].map((x) => x.toolchainId)).toEqual([
			"collaboration.pipeline",
			"collaboration.task",
		]);
		await h.store.write((db) => {
			// These are synthetic snapshots from the old lifecycle, using real session/source bindings.
			db.query(
				"UPDATE collaboration_works SET revision=1, document_json=? WHERE id=?",
			).run(JSON.stringify({ steps: [{ id: "fixture-step" }] }), draft.workRef);
			const child = {
				id: crypto.randomUUID(),
				status: "completed",
				revision: 3,
			};
			db.query(
				"UPDATE collaboration_works SET revision=5, child_id=?, child_json=? WHERE id=?",
			).run(child.id, JSON.stringify(child), task.workRef);
			const legacy = db.query(`UPDATE dialogue_specialist_sessions
				SET state='closing', closing_reason='restarted', close_failures=12, expires_at=?
				WHERE id=?`);
			for (const session of [draft, task])
				legacy.run("2000-01-01T00:00:00.000Z", session.id);
		});
		const before = [draft, task].map(({ workRef }) => workOf(h, workRef));
		expect(before[0]).toMatchObject({
			revision: 1,
			document_json: expect.any(String),
			source_json: expect.any(String),
		});
		expect(before[1]).toMatchObject({
			revision: 5,
			child_id: expect.any(String),
			source_json: expect.any(String),
		});
		configureLogging({
			level: "warn",
			destination: { write: (line) => void logs.push(JSON.parse(line)) },
		});

		await expect(
			h.store.write((db) => {
				h.dialogue.sweepSpecialistSessionsInTransaction(
					db,
					new Date().toISOString(),
				);
				throw Error("rollback-close-fixture");
			}),
		).rejects.toThrow("rollback-close-fixture");
		const stoppedLogs = () =>
			logs.filter(
				(line) => line.event === "dialogue.specialist_close_retry_stopped",
			);
		expect(stoppedLogs()).toEqual([]);
		expect(closeStatus(h, draft.id)).toMatchObject({
			close_failures: 12,
			close_blocked_reason: null,
		});

		await h.dialogue.sweepSpecialistSessions();
		for (const session of [draft, task]) {
			expect(closeStatus(h, session.id)).toMatchObject({
				state: "closing",
				end_reason: null,
				closing_reason: "restarted",
				close_failures: 13,
				close_blocked_reason: "source_session_expired",
				close_blocked_at: expect.any(String),
			});
		}
		const stopped = [draft, task].map(({ id }) => closeStatus(h, id));
		expect(h.dialogue.specialistSession("draft-close")).toMatchObject({
			state: "closing",
			dirty: true,
		});
		await h.dialogue.recoverSpecialistSessions();
		await h.dialogue.sweepSpecialistSessions();
		await h.dialogue.sweepSpecialistSessions();
		expect(
			await h.dialogue.notifySpecialist({
				sessionId: task.id,
				epoch: task.epoch,
				sourceRunId: task.run.id,
				eventId: "late-child-reply",
				event: { id: "late-child", status: "completed", revision: 4 },
			}),
		).toBe(false);
		expect(
			(await say(h, "draft-close", draftRequest)).specialistSessionId,
		).toBeNull();
		expect([draft, task].map(({ id }) => closeStatus(h, id))).toEqual(stopped);
		expect([draft, task].map(({ workRef }) => workOf(h, workRef))).toEqual(
			before,
		);
		expect(
			stoppedLogs()
				.map(({ sessionId }) => sessionId)
				.sort(),
		).toEqual([draft.id, task.id].sort());
		await h.memory!.forget({
			conversationId: "draft-close",
			itemIds: [],
			messageIds: [draft.run.inputMessageId],
		});
		expect(workOf(h, draft.workRef)).toBeNull();
		expect(workOf(h, task.workRef)).toEqual(before[1]!);
	} finally {
		configureLogging({ level: "silent" });
		await h.close();
	}
});

test("an expired session with an invalid stored source keeps retrying until provenance is verified", async () => {
	const h = await setup();
	try {
		const session = await open(h, "invalid-close", draftRequest);
		const before = workOf(h, session.workRef) as { source_json: string };
		await h.store.write((db) => {
			db.query(
				"UPDATE dialogue_specialist_sessions SET expires_at=? WHERE id=?",
			).run("2000-01-01T00:00:00.000Z", session.id);
			db.query(
				"UPDATE collaboration_works SET source_json=json_set(source_json,'$.digest',?) WHERE id=?",
			).run("deliberately-unmatched", session.workRef);
		});
		await h.dialogue.sweepSpecialistSessions();
		await h.dialogue.sweepSpecialistSessions();
		expect(closeStatus(h, session.id)).toMatchObject({
			state: "closing",
			close_failures: 2,
			close_blocked_reason: null,
		});
		await h.store.write((db) => {
			db.query("UPDATE collaboration_works SET source_json=? WHERE id=?").run(
				before.source_json,
				session.workRef,
			);
		});
		await h.dialogue.sweepSpecialistSessions();
		expect(closeStatus(h, session.id)).toMatchObject({
			state: "closing",
			close_failures: 3,
			close_blocked_reason: "source_session_expired",
		});
		expect(workOf(h, session.workRef)).toEqual(before);
	} finally {
		await h.close();
	}
});

test("unexpired closing work retries an actual busy refusal, then ends once its holder clears", async () => {
	const h = await setup();
	try {
		const session = await open(h, "temporary-close", draftRequest);
		await h.store.write((db) => {
			db.query("UPDATE collaboration_works SET busy_run_id=? WHERE id=?").run(
				crypto.randomUUID(),
				session.workRef,
			);
			db.query(
				"UPDATE dialogue_specialist_sessions SET state='closing', closing_reason='returned' WHERE id=?",
			).run(session.id);
		});
		await h.dialogue.sweepSpecialistSessions();
		expect(closeStatus(h, session.id)).toMatchObject({
			state: "closing",
			close_failures: 1,
			close_blocked_reason: null,
		});
		expect(workOf(h, session.workRef)).not.toBeNull();
		expect(h.dialogue.specialistSession("temporary-close")).toMatchObject({
			id: session.id,
			state: "closing",
			dirty: true,
		});
		await h.store.write((db) => {
			db.query(
				"UPDATE collaboration_works SET busy_run_id=NULL WHERE id=?",
			).run(session.workRef);
		});
		await h.dialogue.sweepSpecialistSessions();
		expect(closeStatus(h, session.id)).toMatchObject({
			state: "ended",
			end_reason: "returned",
			close_failures: 1,
		});
		expect(workOf(h, session.workRef)).toBeNull();
	} finally {
		await h.close();
	}
});
