import { afterEach, expect, spyOn, test } from "bun:test";
import {
	ADAPTER,
	BINDING,
	PACKAGE,
	REVISION,
	resumedJobs,
	setup,
	until,
	type Harness,
} from "./command-interactions.fixture";

let h: Harness | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

test("the offer comes from the catalog: bound chains by adapter availability, the rest by host capability", async () => {
	const offered = async (available: boolean) => {
		h = await setup({ available });
		h.state.steps.push(
			{
				calls: [
					{ name: "find_toolchain", args: { query: "偽の操作を開始する" } },
				],
			},
			{ text: "候補を確認しました。" },
		);
		await h.say("偽の操作を開始して");
		const routed = h.routed.at(-1)!.sort();
		await h.close();
		h = undefined;
		return routed;
	};
	// Research has an available host capability and the other unbound command does not.
	expect(await offered(true)).toContain("fake.manage");
	expect(await offered(true)).toContain("research.web");
	const unavailable = await offered(false);
	expect(unavailable).toContain("research.web");
	expect(unavailable).not.toContain("fake.manage");
	expect(unavailable).not.toContain("needs.unknown");
});

test("a delegation to a command toolchain opens a command TODO and hands the run to the command job", async () => {
	h = await setup();
	h.state.commands.push({ action: "clarify", question: "どれ" });
	h.delegate("偽の操作を開始して");
	const run = await h.say("偽の操作を開始して");
	expect(
		h.rows(
			"SELECT execution, toolchain_revision_id, run_id FROM dialogue_work",
		),
	).toEqual([
		{ execution: "command", toolchain_revision_id: REVISION, run_id: run.id },
	]);
	expect(resumedJobs(h)).toHaveLength(1);
	// The command sub-agent was given the request the conversation handed over, and the user's own words.
	const prompt = JSON.stringify(h.commandPrompts[0]);
	expect(prompt).toContain("偽の操作を開始して");
});

test("a delegation ends the generation: the model is not called again after the work was handed over", async () => {
	h = await setup();
	h.state.commands.push({ action: "clarify", question: "どれ" });
	h.delegate("偽の操作を開始して");
	await h.say("偽の操作を開始して");
	// The router handed it over with no model call: the question the sub-agent asks is the agent's to say on its own
	// opportunity.
	expect(h.calls).toHaveLength(2);
	expect(h.state.steps).toEqual([]);
});

test("a command chain without a binding or with an unknown backend is refused before any execution", async () => {
	for (const backend of ["timer", "something-new", undefined]) {
		h = await setup({ bound: false, backend, autoStart: false });
		const run = await h.commandRun();
		await until(() => h!.status(run.id) === "failed");
		expect(h.dialogue.get(run.id)?.error).toBe("adapter_unavailable");
		expect(h.started).toHaveLength(0);
		expect(h.commandPrompts).toHaveLength(0);
		await h.close();
		h = undefined;
	}
});

test("a bound chain runs through the generic action route with the binding's adapter and operation", async () => {
	h = await setup({ autoStart: false });
	h.state.commands.push({
		action: "invoke",
		tool: "fake.start",
		arguments: { seconds: 90 },
	});
	const run = await h.commandRun();
	await until(() => h!.started.length === 1);
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
	h = await setup({ autoStart: false });
	h.state.commands.push({
		action: "invoke",
		tool: "fake.start",
		arguments: { seconds: "三分" },
	});
	const run = await h.commandRun();
	await until(() => h!.status(run.id) === "failed");
	expect(h.dialogue.get(run.id)?.error).toBe(
		"toolchain_command_invalid_arguments",
	);
	expect(h.started).toHaveLength(0);
});

test("an operation without an interaction carries no frozen stamp", async () => {
	h = await setup({ autoStart: false });
	h.state.commands.push({
		action: "invoke",
		tool: "fake.start",
		arguments: { seconds: 5 },
	});
	await h.commandRun();
	await until(() => h!.started.length === 1);
	expect(h.started[0]!.input.command).not.toHaveProperty("stamp");
});

test("the command sub-agent uses one call with low cloud reasoning and releases its session", async () => {
	h = await setup({ autoStart: false });
	const executeControl = spyOn(h.larm, "executeControl");
	h.state.commands.push({ action: "clarify", question: "どれ" });
	const first = await h.commandRun();
	await until(() => h!.commandSessions.length === 1);
	expect(executeControl.mock.calls[0]?.[3]).toMatchObject({
		reasoningEffort: "low",
	});
	expect(h.commandSessions[0]).toEqual({
		sessionRole: "subagent",
		taskId: first.id,
		agentSession: { conversationId: "main", agentId: first.id },
	});
	// The command is one call: its session is released as the call ends.
	await until(() => h!.releasedSessions.includes(first.id));
});
