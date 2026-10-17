import { afterEach, expect, test } from "bun:test";
import {
	BINDING,
	PACKAGE,
	ADAPTER,
	until,
	open,
	setup,
} from "./command-interactions.fixture";
afterEach(async () => {
	for (const close of open.splice(0).reverse()) await close();
});
test("an earlier mistaken answer does not enter the next toolchain choice", async () => {
	const h = setup({
		// The first request is answered from hand; the second goes to the toolchains.
		analyses: [{ kind: "knowledge", next: "answer" }],
	});
	const first = await h.run("操作を実行して");
	await until(() => h.status(first.id) === "completed");
	h.state.commands.push({
		action: "invoke",
		tool: "fake.start",
		arguments: { seconds: 60 },
	});
	h.state.outcome = {
		state: "saved",
		adapterRef: ADAPTER,
		operationId: "op-history",
		digest: "digest-history",
	};
	await h.run("先ほどの操作を実行して");
	await until(() => h.started.length === 1);
	const selection = h.conversationCalls[1]!;
	expect(selection.tools.map((t) => t.function.name)).toEqual([
		"fake_op",
		"report_unavailable",
	]);
	const reference = selection.history.find((m) =>
		m.content.startsWith("referenceContext"),
	)!;
	expect(
		JSON.parse(reference.content.slice(reference.content.indexOf("=") + 1)),
	).toBe("操作を実行して");
	expect(selection.history.map((m) => m.content)).toContain(
		"先ほどの操作を実行して",
	);
	expect(selection.history.some((m) => m.role === "assistant")).toBe(false);
	expect(h.started).toHaveLength(1);
});
test("an answer from hand retains the full exchange as the main session", async () => {
	const h = setup({
		analyses: [
			{ kind: "knowledge", next: "answer" },
			{ kind: "knowledge", next: "answer" },
		],
	});
	const first = await h.run("前の話を覚えておいて");
	await until(() => h.status(first.id) === "completed");
	const second = await h.run("その話の続きは？");
	await until(() => h.status(second.id) === "completed");
	const answer = h.conversationCalls.at(-1)!;
	// The adopted exchange is the history a resumed session starts from; the system prompt is the one instruction.
	expect(answer.session).toEqual({
		sessionRole: "main",
		context: { instructionCount: 1, historyCount: 2 },
	});
	expect(answer.tools).toHaveLength(0);
	expect(
		answer.history.some(
			(m) => m.role === "assistant" && m.content === "了解しました",
		),
	).toBe(true);
});
test("the offer comes from the catalog: bound chains by adapter availability, the rest by host capability", async () => {
	const offered = async (available: boolean) => {
		const h = setup({ available });
		await h.run("偽の操作を開始して");
		await until(() => h.routed.length > 0);
		return [...h.routed[0]!].sort();
	};
	// The research chain needs agents (present); the dots chain needs the delegation port (absent).
	expect(await offered(true)).toEqual(["fake.manage", "research.web"]);
	expect(await offered(false)).toEqual(["research.web"]);
});
test("a command chain without a binding or with an unknown backend is refused before any execution", async () => {
	for (const backend of ["timer", "something-new", undefined]) {
		const h = setup({ bound: false, backend });
		const run = await h.commandRun();
		await until(() => h.status(run.id) === "failed");
		expect(h.dialogue.get(run.id)?.error).toBe("adapter_unavailable");
		expect(h.started).toHaveLength(0);
		expect(h.commandPrompts).toHaveLength(0);
	}
});
test("a bound chain runs through the generic action route with the binding's adapter and operation", async () => {
	const h = setup();
	h.state.commands.push({
		action: "invoke",
		tool: "fake.start",
		arguments: { seconds: 90 },
	});
	const run = await h.commandRun();
	await until(() => h.started.length === 1);
	const start = h.started[0]!;
	expect(start.input.kind).toBe("action");
	expect(start.input.command).toEqual({
		bindingRevisionId: BINDING,
		adapterRef: ADAPTER,
		packageRevisionId: PACKAGE,
		toolRevisionId: "tool:fake.start@1",
		operationName: "fake.start",
		input: { seconds: 90 },
	});
	expect(start.actionCapability).toEqual({ package: { revisionId: PACKAGE } });
	expect(start.rootRunId).toBe(run.id);
	// The sub-agent was offered the binding's tools and the adapter snapshot, nothing else.
	const prompt = JSON.stringify(h.commandPrompts[0]);
	expect(prompt).toContain("fake.start");
	expect(prompt).toContain("snapshot");
	// No interaction exists for an operation that needed no question.
	expect(h.interaction()).toBeUndefined();
});
test("arguments that the binding's schema rejects never reach the agent runtime", async () => {
	const h = setup();
	h.state.commands.push({
		action: "invoke",
		tool: "fake.start",
		arguments: { seconds: "三分" },
	});
	const run = await h.commandRun();
	await until(() => h.status(run.id) === "failed");
	expect(h.dialogue.get(run.id)?.error).toBe(
		"toolchain_command_invalid_arguments",
	);
	expect(h.started).toHaveLength(0);
});
test("an operation without an interaction carries no frozen stamp", async () => {
	const h = setup();
	h.state.commands.push({
		action: "invoke",
		tool: "fake.start",
		arguments: { seconds: 5 },
	});
	await h.commandRun();
	await until(() => h.started.length === 1);
	expect(h.started[0]!.input.command).not.toHaveProperty("stamp");
});
test("the command sub-agent runs as a sub-agent of its run, on LARM unless a sub-agent resource is saved", async () => {
	const h = setup();
	h.state.commands.push({ action: "clarify", question: "どれ" });
	const first = await h.commandRun();
	await until(() => h.commandSessions.length === 1);
	expect(h.commandCaptures[0]!.route).toBe("larm-only");
	expect(h.commandSessions[0]).toEqual({
		sessionRole: "subagent",
		taskId: first.id,
	});
	// The command is one call: its session is released as the call ends.
	await until(() => h.releasedSessions.includes(first.id));
	const resourceId = crypto.randomUUID();
	h.state.subagentResourceId = resourceId;
	h.state.commands.push({ action: "clarify", question: "どれ" });
	const second = await h.commandRun("別の操作を開始して");
	await until(() => h.commandSessions.length === 2);
	expect(h.commandCaptures[1]!.route).toEqual({ resourceId });
	expect(h.commandSessions[1]).toEqual({
		sessionRole: "subagent",
		taskId: second.id,
	});
});
