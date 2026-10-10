import { afterEach, expect, test } from "bun:test";
import type { InferencePort, Receipt } from "../domains/inference";
import { createDialogueService } from "../domains/dialogue";
import { createDotsDialogue } from "./dots-dialogue";
import { dotsFixture } from "./dots-fixture";
const clean: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const f of clean.splice(0).reverse()) await f();
});
test("conversation uses the LLM operation and phrases its saved receipt without starting another delegation", async () => {
	const f = await dotsFixture();
	clean.push(f.close);
	let calls = 0;
	const messages: Array<Parameters<InferencePort["answer"]>[0]> = [];
	const larm = {
		status: () => ({ state: "connected" }),
		captureInTransaction: () => {},
		requestFor: () => "request",
		executeRequest: async () => {
			throw new Error("unexpected");
		},
		executeStream: async (
			_id: string,
			history: Parameters<InferencePort["answer"]>[0],
			_signal: AbortSignal,
			delta: (s: string) => void,
			_p: unknown,
			tools: unknown,
		) => {
			messages.push(history);
			calls++;
			const r: Receipt = {
				requestId: "request",
				attemptId: String(calls),
				value: "",
			};
			if (calls === 1) {
				expect(JSON.stringify(tools)).toContain("delegate_task");
				r.toolCalls = [
					{
						id: "call",
						name: "delegate_task",
						arguments: JSON.stringify({
							operation: "start",
							projectRef: "project",
							title: "implement",
							request: "Keep every requested condition",
							completionConditions: ["tests pass"],
							operations: ["read", "create_session", "edit", "check"],
						}),
					},
				];
			} else {
				expect(tools).toBeUndefined();
				r.value = "作業を受け付けました。";
				delta(r.value as string);
			}
			return r;
		},
		acceptInTransaction: () => true,
		validateReceiptInTransaction: () => true,
	} as unknown as InferencePort;
	const dialogue = createDialogueService({
		store: f.store,
		conversation: f.conversation,
		larm,
		queue: f.queue,
		delegation: createDotsDialogue({ ...f }),
	});
	clean.push(dialogue.close);
	const run = await dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "conversation",
		text: "プロジェクトの変更を実装してください",
	});
	f.queue.start();
	const done = await dialogue.waitForTerminal(run.id, { timeoutMs: 3000 });
	expect(done).toMatchObject({ status: "completed" });
	expect(calls).toBe(2);
	expect(JSON.stringify(messages[1])).toContain("delegationResult");
	const work = f.tasks.list({ conversationId: "conversation", limit: 50 });
	expect(work.items).toHaveLength(1);
	expect(work.items[0]!.state).toBe("queued");
	expect(work.items[0]!.origin.source).toBe("conversation");
});
test("frozen conversation targets reject changed configuration and unrelated chats", async () => {
	const f = await dotsFixture();
	clean.push(f.close);
	const port = createDotsDialogue({ ...f });
	await f.conversation.append({
		id: "message",
		conversationId: "conversation",
		role: "user",
		text: "依頼",
		createdAt: new Date().toISOString(),
		runId: "run",
	});
	const run = {
		id: "run",
		conversationId: "conversation",
		inputMessageId: "message",
		sourceKind: "manual",
		revision: 0,
	} as Parameters<typeof port.prepareInTransaction>[1];
	const snapshot = f.store.readSnapshot((db) =>
		port.prepareInTransaction(db, run),
	);
	const { revision, ...project } = f.project;
	await f.dots.config.configureProject({
		...project,
		expectedRevision: revision,
		title: "changed",
	});
	await expect(
		f.store.write((db) =>
			port.invokeInTransaction(
				db,
				run,
				{
					operation: "start",
					projectRef: "project",
					title: "t",
					request: "request",
					completionConditions: ["done"],
					operations: ["read"],
					maxSessions: 1,
				},
				snapshot.catalog,
			),
		),
	).rejects.toThrow("dots_stale");
	const current = f.store.readSnapshot((db) =>
		port.prepareInTransaction(db, run),
	);
	await expect(
		f.store.write((db) =>
			port.invokeInTransaction(
				db,
				run,
				{ operation: "inspect", taskRef: "unrelated" },
				current.catalog,
			),
		),
	).rejects.toThrow("dots_stale");
});
test("role and Skill revisions are immutable, CAS protected and revoke an already claimed command", async () => {
	const f = await dotsFixture();
	clean.push(f.close);
	const id = "dots.user." + "a".repeat(32),
		data = {
			id,
			expectedToken: null,
			title: "role",
			summary: "general purpose",
			profile: "Preserve requested constraints",
			skills: [
				{ title: "procedure", body: "Read sources and report evidence" },
			],
			enabled: true,
		};
	const first = await f.capabilities.putDotsPackage(data);
	const { revision, ...project } = f.project;
	await f.dots.config.configureProject({
		...project,
		capabilityRevisionId: first.revisionId,
		expectedRevision: revision,
	});
	const r = await f.tasks.create(f.input()),
		c = f.command(r.taskId);
	await f.dots.claim("dots", {
		commandId: c.commandId,
		leaseId: crypto.randomUUID(),
	});
	await f.dots.bindSchedule(r.taskId, "capability-test-schedule");
	const original = JSON.stringify(c.snapshot.capability);
	await f.capabilities.putDotsPackage({
		...data,
		expectedToken: first.stateToken,
		profile: "Different instructions",
	});
	await expect(
		f.capabilities.putDotsPackage({ ...data, expectedToken: first.stateToken }),
	).rejects.toThrow("capability_revision_conflict");
	expect(original).toContain("Preserve requested constraints");
	expect(original).not.toContain("Different instructions");
	expect(() => f.dots.getCommand("dots", c.commandId)).toThrow(
		"capability_revoked",
	);
	await f.dots.maintenance();
	expect(f.tasks.get(r.taskId).task.state).toBe("stopping");
	expect(f.command(r.taskId, "stop").snapshot.task).toEqual({
		id: r.taskId,
		stopIntent: "pause",
	});
});
test("a long Japanese request keeps its original text without overflowing the task's structured request", async () => {
	const f = await dotsFixture();
	clean.push(f.close);
	const port = createDotsDialogue({ ...f }),
		source = "原文".repeat(4000),
		request = "作業".repeat(4000);
	await f.conversation.append({
		id: "long-source",
		conversationId: "conversation",
		role: "user",
		text: source,
		createdAt: new Date().toISOString(),
		runId: "long-run",
	});
	const run = {
		id: "long-run",
		conversationId: "conversation",
		inputMessageId: "long-source",
		sourceKind: "manual",
		revision: 0,
	} as Parameters<typeof port.prepareInTransaction>[1];
	await f.store.write((db) => {
		const prepared = port.prepareInTransaction(db, run);
		port.invokeInTransaction(
			db,
			run,
			{
				operation: "start",
				projectRef: "project",
				title: "long request",
				request,
				completionConditions: ["done"],
				operations: ["read", "create_session"],
				maxSessions: 1,
			},
			prepared.catalog,
		);
	});
	const t = f.tasks.list({ conversationId: "conversation", limit: 50 })
		.items[0]!;
	expect(t.request).toBe(request);
	expect(f.command(t.id).snapshot.sourceRequest).toBe(source);
});
