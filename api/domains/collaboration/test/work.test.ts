import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
	createCollaborationWorks,
	migrations,
	type ChildView,
	type Ports,
	type Source,
} from "..";

const opened: Database[] = [];
afterEach(() => {
	for (const db of opened.splice(0)) db.close();
});
function rig() {
	const db = new Database(":memory:");
	opened.push(db);
	db.exec("PRAGMA foreign_keys=ON");
	for (const migration of migrations) db.exec(migration.sql);
	const sources = new Map<string, Source>();
	for (const [id, request] of [
		["r1", "二つの作業の手順を作る"],
		["r2", "この手順で実行して"],
		["r3", "この質問への回答です"],
	])
		sources.set(id!, {
			runId: id!,
			messageId: `m-${id}`,
			conversationId: "c1",
			request: request!,
			digest: `digest-${id}`,
			specialistSessionId: "s1",
			specialistEpoch: 0,
		});
	let epoch = 0,
		active = true,
		starts = 0,
		answers = 0;
	const children = new Map<string, ChildView>(),
		notices: unknown[] = [],
		cancelled: string[] = [];
	const works = createCollaborationWorks(() => 10);
	const ports: Ports = {
		source: (_db, id) => sources.get(id) ?? null,
		authority: () => ({ conversationId: "c1", epoch, active }),
		available: () => true,
		context: () => ({ cards: [] }),
		forget() {},
		check: (_db, kind, value, source) =>
			kind === "interact" ||
			(value as { request?: unknown })?.request === source.request
				? { ok: true, value }
				: {
						ok: false,
						issues: [{ path: "request", rule: "original_required" }],
					},
		start(_db, _kind, input) {
			starts++;
			expect(input.history.length).toBeGreaterThan(0);
			const child: ChildView = { id: "child", status: "running", revision: 1 };
			children.set(child.id, child);
			return child;
		},
		view: (_db, _kind, _source, id) => children.get(id) ?? null,
		answer(_db, _kind, _source, _response, child) {
			answers++;
			const next: ChildView = {
				id: child.id,
				status: "running",
				revision: child.revision + 1,
			};
			children.set(child.id, next);
			return next;
		},
		cancel(_db, _kind, source, id) {
			expect(source.conversationId).toBe("c1");
			cancelled.push(id);
			children.set(id, { id, status: "cancelled", revision: 100 });
		},
		notify(_db, input) {
			notices.push(input);
			return true;
		},
	};
	works.configure(ports);
	const work = works.open(db, "pipeline", "s1", null);
	const change = <T>(fn: () => T) => db.transaction(fn)();
	const begin = (runId: string) =>
		change(() => works.begin(db, work.workRef, runId));
	const release = (runId: string) =>
		change(() => works.release(db, work.workRef, runId));
	const bound = { workRef: work.workRef, sessionId: "s1" };
	const launch = () =>
		works.start(db, {
			...bound,
			runId: "r2",
			expectedRevision: 1,
			requestId: "start-1",
		});
	const draft = () => {
		begin("r1");
		change(() =>
			works.commit(db, {
				...bound,
				runId: "r1",
				baseRevision: 0,
				value: { request: sources.get("r1")!.request, steps: [] },
			}),
		);
		release("r1");
	};
	return {
		db,
		works,
		work,
		change,
		begin,
		release,
		bound,
		launch,
		draft,
		sources,
		children,
		notices,
		cancelled,
		revokeEpoch: () => epoch++,
		suspend: () => (active = false),
		counts: () => ({ starts, answers }),
	};
}

test("a draft keeps its source and revision; only a separate real user turn can launch it, with idempotent receipt", () => {
	const r = rig();
	r.draft();
	r.begin("r1");
	expect(() =>
		r.change(() =>
			r.works.start(r.db, {
				...r.bound,
				runId: "r1",
				expectedRevision: 1,
				requestId: "premature",
			}),
		),
	).toThrow("collaboration_confirmation_required");
	r.release("r1");
	r.begin("r2");
	expect(r.change(r.launch).status).toBe("running");
	expect(r.change(r.launch).id).toBe("child");
	expect(r.counts().starts).toBe(1);
	expect(r.works.receipt(r.db, "start-1", "interact")).toBeNull();
	expect(r.works.view(r.db, "pipeline", "another", r.work.workRef)).toBeNull();
	expect(() =>
		r.change(() =>
			r.works.commit(r.db, {
				...r.bound,
				runId: "r2",
				baseRevision: 2,
				value: { request: "改変" },
			}),
		),
	).toThrow("work_busy");
});

test("questions and terminal results notify once; a host event cannot answer and stale question revisions are rejected", () => {
	const r = rig();
	r.draft();
	r.begin("r2");
	r.change(r.launch);
	r.release("r2");
	r.children.set("child", {
		id: "child",
		status: "waiting_user",
		revision: 2,
		question: {
			id: "q1",
			prompt: "実行してよいですか",
			approval: true,
			revision: 2,
			expiresAt: 100,
		},
	});
	r.change(() => r.works.refresh(r.db));
	r.change(() => r.works.refresh(r.db));
	expect(r.notices).toHaveLength(1);
	// The watcher retains authority checks while waiting, without another model call.
	expect(r.works.pending(r.db)).toBe(true);
	r.begin("host-event");
	expect(() =>
		r.change(() =>
			r.works.answer(r.db, {
				...r.bound,
				runId: "host-event",
				requestId: "forged",
				questionId: "q1",
				childRevision: 2,
				value: { approved: true },
			}),
		),
	).toThrow("collaboration_answer_invalid");
	r.release("host-event");
	r.begin("r3");
	expect(() =>
		r.change(() =>
			r.works.answer(r.db, {
				...r.bound,
				runId: "r3",
				requestId: "old",
				questionId: "q1",
				childRevision: 1,
				value: { approved: true },
			}),
		),
	).toThrow("collaboration_question_closed");
	r.change(() =>
		r.works.answer(r.db, {
			...r.bound,
			runId: "r3",
			requestId: "valid",
			questionId: "q1",
			childRevision: 2,
			value: { approved: true },
		}),
	);
	r.release("r3");
	expect(r.counts().answers).toBe(1);
	r.children.set("child", {
		id: "child",
		status: "completed",
		revision: 4,
		summary: "完了",
	});
	r.change(() => r.works.refresh(r.db));
	r.change(() => r.works.refresh(r.db));
	expect(r.notices).toHaveLength(2);
	expect(r.works.state(r.db, r.work.workRef)?.dirty).toBe(false);
});

test("epoch withdrawal cancels the owned child and forget of any contributing turn purges work and receipts", () => {
	const r = rig();
	r.draft();
	r.begin("r2");
	r.change(r.launch);
	r.release("r2");
	r.revokeEpoch();
	r.change(() => r.works.refresh(r.db));
	expect(r.cancelled).toEqual(["child"]);
	expect(r.notices).toHaveLength(0);
	r.change(() => r.works.forget(r.db, ["m-r2"]));
	expect(r.works.read(r.db, r.work.workRef)).toBeNull();
	expect(r.works.receipt(r.db, "start-1", "pipeline")).toBeNull();
});

test("a withdrawn originating source is still enough identity to cancel, without authorizing another send", () => {
	const r = rig();
	r.draft();
	r.begin("r2");
	r.change(r.launch);
	r.release("r2");
	r.sources.delete("r1");
	r.change(() => r.works.refresh(r.db));
	expect(r.cancelled).toEqual(["child"]);
	expect(r.works.read(r.db, r.work.workRef)).toBeNull();
	expect(r.counts().starts).toBe(1);
});

test("a start input cannot approve its own question or launch a second child; suspended waiting work is cancelled", () => {
	const r = rig();
	r.draft();
	r.begin("r2");
	r.change(r.launch);
	r.children.set("child", {
		id: "child",
		status: "waiting_user",
		revision: 2,
		question: { id: "q", prompt: "承認しますか", approval: true, revision: 2 },
	});
	expect(() =>
		r.change(() =>
			r.works.answer(r.db, {
				...r.bound,
				runId: "r2",
				requestId: "self-approve",
				questionId: "q",
				childRevision: 2,
				value: { approved: true },
			}),
		),
	).toThrow("collaboration_answer_invalid");
	r.children.set("child", { id: "child", status: "completed", revision: 3 });
	expect(() =>
		r.change(() =>
			r.works.start(r.db, {
				...r.bound,
				runId: "r2",
				requestId: "again",
				expectedRevision: 2,
			}),
		),
	).toThrow("collaboration_confirmation_required");
	r.children.set("child", {
		id: "child",
		status: "waiting_user",
		revision: 4,
		question: { id: "q2", prompt: "承認しますか", approval: true, revision: 4 },
	});
	r.release("r2");
	r.change(() => r.works.refresh(r.db));
	expect(r.works.pending(r.db)).toBe(true);
	r.suspend();
	r.change(() => r.works.refresh(r.db));
	expect(r.cancelled).toEqual(["child"]);
	expect(r.works.pending(r.db)).toBe(false);
	expect(r.works.document(r.db, r.work.workRef)?.revision).toBe(2);
});

test("a different session in the same conversation cannot contribute to this work", () => {
	const r = rig();
	r.draft();
	r.sources.set("r2", {
		...r.sources.get("r2")!,
		specialistSessionId: "foreign",
	});
	expect(() => r.begin("r2")).toThrow("collaboration_source_invalid");
});
