import { capturePrepare, captureSave } from "./interact.fixture";
import { afterEach, expect, test } from "bun:test";
import { getRun, listOperations } from "eumenes-interact/sqlite";
import { createBrowserResourceAdapter } from "..";
import { interactFixture, part, read, done, unmet } from "./interact.fixture";
import { until } from "./fakes";
const clean: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const f of clean.splice(0)) await f();
});
async function fixture(options: Parameters<typeof interactFixture>[0] = {}) {
	const f = await interactFixture(options);
	clean.push(f.close);
	return f;
}

test("queue executes public parts, verifies completion, persists only metadata", async () => {
	const f = await fixture();
	const v = await f.start({
		request: "PRIVATE-REQUEST",
		startUrl: "https://example.com/private?token=PRIVATE-URL",
	});
	const end = await f.wait(v.runId, "completed");
	expect(end.calls).toBe(3);
	expect(end.answer).toBe("確認しました");
	expect(f.calls.map((c) => c.purpose)).toEqual([
		"execute",
		"execute",
		"completion_review",
	]);
	const saved = f.store.read((db) => ({
		run: getRun(db, f.owner, v.runId),
		ops: listOperations(db, f.owner, v.runId),
		jobs: db
			.query("SELECT payload_json FROM queue_jobs WHERE subject_ref=?")
			.all(v.runId),
	}));
	expect(JSON.stringify(saved)).not.toContain("PRIVATE-REQUEST");
	expect(JSON.stringify(saved)).not.toContain("PRIVATE-URL");
	expect(saved.ops[0]!.status).toBe("confirmed");
	expect(saved.run?.coreState).toBeNull();
});
test("idempotent admission is owner/conversation scoped and rejects changed payload", async () => {
	const f = await fixture({ startQueue: false });
	const id = crypto.randomUUID();
	const [a, b] = await Promise.all([f.start({}, id), f.start({}, id)]);
	expect(a.runId).toBe(b.runId);
	await expect(f.start({ request: "changed" }, id)).rejects.toThrow(
		"request_conflict",
	);
	const c = await f.start({ conversationId: "other" }, id);
	expect(c.runId).not.toBe(a.runId);
	expect(() =>
		f.store.read((db) =>
			f.service.statusInTransaction(db, "foreign", "main", a.runId),
		),
	).toThrow("not_found");
	expect(() =>
		f.store.read((db) =>
			f.service.statusInTransaction(db, f.owner, "other", a.runId),
		),
	).toThrow("not_found");
});
test("confirmation is bound to question/revision/generation and consumes exactly once", async () => {
	const f = await fixture({
		responses: [part("item.open", { item: "p1.i1" }), unmet],
	});
	f.driver.targetInfo = { tag: "button", inForm: false, submits: false };
	const v = await f.start();
	const q = await f.wait(v.runId, "needs_input");
	expect(q.question?.kind).toBe("approval");
	expect(f.driver.calls.filter((c) => c === "act:click")).toHaveLength(0);
	const bad = { approved: true, questionId: crypto.randomUUID() };
	await expect(f.answer(v.runId, bad)).rejects.toThrow("stale");
	await f.answer(v.runId, { approved: true });
	await f.wait(v.runId, "failed");
	expect(f.driver.calls.filter((c) => c === "act:click")).toHaveLength(1);
	await expect(
		f.answer(v.runId, {
			approved: true,
			questionId: q.question!.id,
			generation: q.generation,
			expectedRevision: q.revision,
		}),
	).rejects.toThrow("stale");
	expect(f.calls.filter((c) => c.purpose === "execute")).toHaveLength(2);
});
test("denial never sends the pending effect", async () => {
	const f = await fixture({
		responses: [part("item.open", { item: "p1.i1" })],
	});
	f.driver.targetInfo = { tag: "button", inForm: false, submits: false };
	const v = await f.start();
	await f.wait(v.runId, "needs_input");
	await f.answer(v.runId, { approved: false });
	expect(f.status(v.runId).state).toBe("failed");
	expect(f.driver.calls).not.toContain("act:click");
});
test("answers cannot reset the overall model-call budget", async () => {
	const f = await fixture({
		responses: [
			part("ask", { question: "何を読みますか" }),
			part("ask", { question: "次は何ですか" }),
			read,
			done,
		],
	});
	const v = await f.start({ maxModelCalls: 3 });
	await f.wait(v.runId, "needs_input");
	await f.answer(v.runId, { text: "first" });
	await f.wait(v.runId, "needs_input");
	await f.answer(v.runId, { text: "second" });
	await until(() => ["failed", "partial"].includes(f.status(v.runId).state));
	expect(f.status(v.runId).calls).toBeLessThanOrEqual(3);
	expect(f.calls).toHaveLength(3);
});
test("parent-linked answers/forget must use the parent's lifecycle", async () => {
	const f = await fixture({
		responses: [part("ask", { question: "入力を教えてください" }), unmet],
	});
	const v = await f.start({}, undefined, {
		source: { kind: "execution", execution: { executionId: "parent" } },
		executionId: "parent",
	});
	await f.wait(v.runId, "needs_input");
	await expect(f.answer(v.runId, { text: "answer" })).rejects.toThrow(
		"parent_answer_required",
	);
	await expect(
		f.store.write((db) =>
			f.service.forgetInTransaction(db, f.owner, "main", v.runId),
		),
	).rejects.toThrow("parent_forget_required");
	await f.answer(
		v.runId,
		{ text: "answer" },
		{ kind: "execution", execution: { executionId: "parent" }, version: 2 },
	);
	await f.wait(v.runId, "failed");
	await f.store.write((db) =>
		f.service.purgeExecutionInTransaction(db, "parent"),
	);
	expect(() => f.status(v.runId)).toThrow("not_found");
});
test("capture requires explicit approval; resource ownership, WebP and forget propagate", async () => {
	const f = await fixture({
		responses: [capturePrepare, captureSave, done],
	});
	const v = await f.start();
	const q = await f.wait(v.runId, "needs_input");
	expect(q.question?.kind).toBe("capture");
	expect(f.driver.calls).not.toContain("screenshot");
	await f.answer(v.runId, { approved: true });
	const end = await f.wait(v.runId, "completed");
	expect(end.captures).toHaveLength(1);
	const id = end.captures[0]!.captureId;
	const resource = createBrowserResourceAdapter({
		store: f.store,
		owner: f.owner,
		includeInteract: true,
	});
	expect(f.store.read((db) => resource.getInTransaction(db, id))).toMatchObject(
		{ adapterRef: "adapter:browser.interact@1", targetRef: id },
	);
	expect(
		(await f.service.captureContent(f.owner, "main", v.runId, id)).mime,
	).toBe("image/webp");
	await expect(
		f.service.captureContent("foreign", "main", v.runId, id),
	).rejects.toThrow("not_found");
	await f.store.write((db) =>
		f.service.forgetInTransaction(db, f.owner, "main", v.runId),
	);
	f.service.afterCommit();
	await until(() => f.files.final.size === 0);
	expect(f.store.read((db) => resource.getInTransaction(db, id))).toBeNull();
	expect(
		f.store.read((db) =>
			db
				.query("SELECT COUNT(*) AS n FROM interact_operations WHERE run_id=?")
				.get(v.runId),
		),
	).toEqual({ n: 0 });
});
test("unverified or missing completion evidence never becomes completed", async () => {
	const f = await fixture({
		responses: [
			part("done", {
				answer: "done",
				outcome: "achieved",
				basis: "observed",
				evidence: ["invented"],
			}),
		],
	});
	const v = await f.start();
	await f.wait(v.runId, "failed");
	expect(f.calls.every((c) => c.purpose !== "completion_review")).toBe(true);
});
test("review failure yields partial", async () => {
	let step = 0;
	const f = await fixture({
		infer: async (input) => {
			if (input.purpose === "completion_review") throw new Error("unavailable");
			return step++ === 0 ? read : done(input);
		},
	});
	const v = await f.start();
	await f.wait(v.runId, "partial");
	expect(f.status(v.runId).code).toBe("completion_review_unavailable");
});
test("an unknown dispatch is recorded once, never replayed", async () => {
	const f = await fixture({ responses: [unmet] });
	f.driver.actResults = [
		{ ok: false, dispatched: true, code: "transport_lost" },
	];
	const v = await f.start();
	await f.wait(v.runId, "indeterminate");
	expect(f.driver.calls.filter((c) => c === "act:navigate")).toHaveLength(1);
	expect(f.calls).toHaveLength(0);
});
test("cancel during an ignored inference abort releases queue and cannot accept late completion", async () => {
	let release: (raw: string) => void = () => {};
	const gate = new Promise<string>((r) => (release = r));
	const f = await fixture({ infer: async () => gate });
	const v = await f.start();
	await until(() => f.calls.length === 1);
	await f.cancel(v.runId);
	await until(() =>
		f.queue
			.list({ scope: `browser-interact:${f.owner}` })
			.items.every(
				(j) => j.kind !== "browser.interact.step" || j.state !== "running",
			),
	);
	release(unmet);
	await new Promise((r) => setTimeout(r, 15));
	expect(f.status(v.runId).state).toBe("cancelled");
	expect(f.status(v.runId).answer).toBeNull();
});
test("cancel during completion review prevents a completed result", async () => {
	let release: (raw: string) => void = () => {};
	const gate = new Promise<string>((r) => (release = r));
	let n = 0;
	const f = await fixture({
		infer: async (input) =>
			input.purpose === "completion_review"
				? gate
				: n++ === 0
					? read
					: done(input),
	});
	const v = await f.start();
	await until(() => f.calls.some((c) => c.purpose === "completion_review"));
	await f.cancel(v.runId);
	release(JSON.stringify({ outcome: "achieved", explanation: "ready" }));
	await new Promise((r) => setTimeout(r, 15));
	expect(f.status(v.runId).state).toBe("cancelled");
	expect(f.status(v.runId).answer).toBeNull();
});
test("expiry and revoked source end the saved run without adopting output", async () => {
	let now = Date.now();
	let release: (raw: string) => void = () => {};
	const gate = new Promise<string>((r) => (release = r));
	const f = await fixture({ now: () => now, infer: async () => gate });
	const v = await f.start();
	await until(() => f.calls.length === 1);
	now += 600001;
	release(unmet);
	await f.wait(v.runId, "expired");
	expect(f.status(v.runId).answer).toBeNull();
});
test("restart sweeps transient-context runs to failure and never resumes operations", async () => {
	const f = await fixture({ startQueue: false });
	const v = await f.start();
	await f.service.close();
	await f.service.sweep();
	expect(f.status(v.runId).state).toBe("failed");
	f.queue.start();
	await new Promise((r) => setTimeout(r, 20));
	expect(f.driver.calls).toHaveLength(0);
});

test("a changed capture target asks again before any bytes are saved", async () => {
	const f = await fixture({
		responses: [capturePrepare, captureSave, capturePrepare, captureSave, done],
	});
	const v = await f.start();
	const first = await f.wait(v.runId, "needs_input");
	f.driver.snapshotText = '- heading "Changed page" [ref=e8]';
	await f.answer(v.runId, { approved: true });
	await until(
		() =>
			f.status(v.runId).question?.id !== first.question?.id &&
			f.status(v.runId).state === "needs_input",
	);
	expect(f.files.final.size).toBe(0);
	expect(f.driver.calls).not.toContain("screenshot");
	expect(f.status(v.runId).calls).toBe(4);
	await f.answer(v.runId, { approved: true });
	await f.wait(v.runId, "completed");
	expect(f.files.final.size).toBe(1);
});
test("a revoked source cancels late output", async () => {
	let valid = true,
		release: (v: string) => void = () => {};
	const gate = new Promise<string>((r) => (release = r));
	const f = await fixture({
		sourceValid: () => valid,
		infer: async () => gate,
	});
	const v = await f.start({}, undefined, { source: { kind: "message" } });
	await until(() => f.calls.length === 1);
	valid = false;
	release(unmet);
	await f.wait(v.runId, "cancelled");
	expect(f.status(v.runId).code).toBe("execution_source_invalid");
	expect(f.status(v.runId).answer).toBeNull();
});
test("cancellation during cleanup cannot publish completed", async () => {
	const f = await fixture();
	let closing = false,
		release: () => void = () => {};
	const gate = new Promise<void>((r) => (release = r));
	const disconnect = f.driver.disconnect.bind(f.driver);
	f.driver.disconnect = async () => {
		closing = true;
		await gate;
		await disconnect();
	};
	try {
		const v = await f.start();
		await until(() => closing);
		await f.cancel(v.runId);
		release();
		await until(() => f.status(v.runId).state === "cancelled");
		expect(f.status(v.runId).answer).toBeNull();
	} finally {
		release();
	}
});
test("capture TTL, metadata TTL and orphan cleanup remove their owned records/files", async () => {
	let now = Date.now();
	const f = await fixture({
		now: () => now,
		responses: [capturePrepare, captureSave, done],
	});
	const v = await f.start();
	await f.wait(v.runId, "needs_input");
	await f.answer(v.runId, { approved: true });
	const end = await f.wait(v.runId, "completed");
	expect(end.captures).toHaveLength(1);
	f.files.temp.set("orphan.tmp", new Uint8Array(1));
	f.files.final.set("orphan.webp", new Uint8Array(1));
	now += 7 * 86400000 + 1;
	await f.service.sweep();
	expect(f.files.final.size).toBe(0);
	expect(f.files.temp.size).toBe(0);
	expect(f.status(v.runId).captures).toHaveLength(0);
	now += 24 * 86400000;
	await f.service.sweep();
	expect(() => f.status(v.runId)).toThrow("not_found");
});

test("a read redirected to a forbidden destination is withheld from inference", async () => {
	const f = await fixture();
	f.driver.readText = async () => ({
		url: "http://127.0.0.1:9/private",
		title: "private",
		text: "PRIVATE-BODY",
		charCount: 12,
		truncated: false,
		root: "main",
	});
	const v = await f.start();
	await f.wait(v.runId, "failed");
	expect(JSON.stringify(f.calls)).not.toContain("PRIVATE-BODY");
	expect(f.status(v.runId).answer).toBeNull();
});
test("a capture that navigates during acquisition is never published", async () => {
	const f = await fixture({
		responses: [capturePrepare, captureSave],
	});
	const v = await f.start();
	await f.wait(v.runId, "needs_input");
	f.driver.onScreenshot = () => {
		f.driver.tabs[0]!.url = "http://127.0.0.1:9/private";
	};
	await f.answer(v.runId, { approved: true });
	await f.wait(v.runId, "failed");
	expect(f.status(v.runId).captures).toHaveLength(0);
	expect(f.files.final.size).toBe(0);
});
