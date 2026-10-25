import { afterEach, expect, test } from "bun:test";
import { delegationFixture } from "./dots-delegation.fixture";
const close: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const fn of close.splice(0).reverse()) await fn();
});
test("long Japanese source and structured request survive the registered start path", async () => {
	const f = await fixture(),
		source = "原文".repeat(4000),
		request = "作業".repeat(4000);
	await f.conversation.append({
		id: "long-source",
		conversationId: "conversation",
		role: "user",
		text: source,
		runId: "long-run",
		createdAt: new Date().toISOString(),
	});
	await f.invoke("dots.start", { ...f.start, request }, crypto.randomUUID(), {
		...f.origin,
		messageId: "long-source",
		runId: "long-run",
	});
	const task = f.tasks.list({ conversationId: "conversation" }).items[0]!;
	expect(task.request).toBe(request);
	expect(f.command(task.id).snapshot.sourceRequest).toBe(source);
});
async function fixture() {
	const f = await delegationFixture();
	close.push(f.close);
	return f;
}
test("intake stores one owned task with its own work deadline and replays the receipt", async () => {
	const f = await fixture(),
		id = crypto.randomUUID();
	const first = await f.invoke("dots.start", f.start, id),
		second = await f.invoke("dots.start", f.start, id);
	expect(second.receipt).toEqual(first.receipt);
	expect(second.replay).toBe(true);
	expect(f.tasks.list().items).toHaveLength(1);
	const task = f.tasks.list().items[0]!;
	expect(task.origin).toMatchObject({
		source: "conversation",
		conversationId: "conversation",
		messageId: "user-message",
	});
	expect(Date.parse(task.grant.expiresAt) - Date.now()).toBeGreaterThan(
		3500000,
	);
	expect(f.command(task.id).snapshot.sourceRequest).toBe(
		"全ての条件を残して依頼する",
	);
	await expect(
		f.invoke("dots.start", { ...f.start, title: "different" }, id),
	).rejects.toThrow("dots_conflict");
	await f.invoke("dots.start", f.start);
	expect(f.tasks.list().items).toHaveLength(2);
});
test("stale registration, unrelated chat and excess grants are refused; native cloud projects need no relay", async () => {
	const f = await fixture();
	await expect(
		f.invoke("dots.start", { ...f.start, projectRevision: 9 }),
	).rejects.toThrow("dots_stale");
	await expect(
		f.invoke("dots.start", { ...f.start, operations: ["publish"] }),
	).rejects.toThrow("dots_permission_denied");
	await expect(
		f.invoke("dots.start", { ...f.start, maxSessions: 4 }),
	).rejects.toThrow("dots_permission_denied");
	const started = await f.invoke("dots.start", f.start),
		id = (started.receipt as { value: { taskId: string } }).value.taskId;
	await f.conversation.append({
		id: "other-message",
		conversationId: "other-chat",
		role: "user",
		text: "read",
		createdAt: new Date().toISOString(),
		runId: "other-run",
	});
	await expect(
		f.invoke("dots.inspect", { taskRef: id }, crypto.randomUUID(), {
			...f.origin,
			conversationId: "other-chat",
			messageId: "other-message",
			runId: "other-run",
		}),
	).rejects.toThrow("dots_permission_denied");
	expect(
		f.store.readSnapshot((db) =>
			f.adapter.snapshotInTransaction(db, { conversationId: "other-chat" }),
		),
	).toMatchObject({ tasks: [] });
	const { revision, ...project } = f.project;
	await f.dots.config.configureProject({
		...project,
		expectedRevision: revision,
		environment: "cloud",
	});
	expect(f.store.readSnapshot(f.adapter.availableInTransaction)).toBe(true);
	const cloud = await f.invoke("dots.start", {
		...f.start,
		projectRevision: f.project.revision + 1,
	});
	expect(cloud.receipt).toMatchObject({
		operation: "dots.start",
		verification: "registered_in_eumenes",
	});
});
test("questions and stops use existing task fences and cannot accept a stale answer", async () => {
	const f = await fixture(),
		started = await f.invoke("dots.start", f.start),
		id = (started.receipt as { value: { taskId: string } }).value.taskId,
		c = f.command(id);
	await f.dots.claim("dots", {
		commandId: c.commandId,
		leaseId: crypto.randomUUID(),
	});
	await f.dots.report(
		"dots",
		f.report(c, 1, "blocked", {
			question: {
				questionId: "q",
				prompt: "どの対象ですか",
				answerType: "text",
				choices: [],
			},
		}),
	);
	const waiting = f.tasks.get(id).task;
	await expect(
		f.invoke("dots.answer", {
			taskRef: id,
			expectedRevision: waiting.revision - 1,
			questionId: "q",
			answer: "A",
		}),
	).rejects.toThrow("revision_conflict");
	await f.invoke("dots.answer", {
		taskRef: id,
		expectedRevision: waiting.revision,
		questionId: "q",
		answer: "A",
	});
	expect(f.tasks.get(id).question).toBeNull();
	const current = f.tasks.get(id).task;
	await f.invoke("dots.stop", {
		taskRef: id,
		expectedRevision: current.revision,
		intent: "cancel",
	});
	expect(f.tasks.get(id).task.state).toBe("stopping");
	await expect(
		f.dots.report("dots", f.report(c, 2, "completed")),
	).rejects.toThrow();
});
