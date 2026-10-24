import { afterEach, expect, test } from "bun:test";
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
		h.state.steps.push({
			calls: [{ name: "find_toolchain", args: { query: "偽の操作" } }],
		});
		h.speak("見つかりました。");
		await h.say("偽の操作を開始して");
		const routed = [...h.routed[0]!].sort();
		await h.close();
		h = undefined;
		return routed;
	};
	// The research chain needs agents (present); the dots chain needs the delegation port (absent).
	expect(await offered(true)).toEqual(["fake.manage", "research.web"]);
	expect(await offered(false)).toEqual(["research.web"]);
});

test("a delegation to a command toolchain opens a command TODO and hands the run to the command job", async () => {
	h = await setup();
	h.state.commands.push({ action: "clarify", question: "どれ" });
	h.delegate("偽の操作を開始して");
	h.speak("どれですか。");
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
	h.speak("どれですか。");
	await h.say("偽の操作を開始して");
	// find_toolchain, delegate, and then the speaking generation the question triggers: three calls, no more.
	expect(h.afterHandoverCalls).toEqual([]);
	expect(h.calls).toHaveLength(3);
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
	h.speak("設定しました。");
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
	h.speak("設定しました。");
	await h.commandRun();
	await until(() => h!.started.length === 1);
	expect(h.started[0]!.input.command).not.toHaveProperty("stamp");
});

test("the command sub-agent runs as a sub-agent of its run, on LARM unless a sub-agent resource is saved", async () => {
	h = await setup({ autoStart: false });
	h.state.commands.push({ action: "clarify", question: "どれ" });
	h.speak("どれですか。");
	const first = await h.commandRun();
	await until(() => h!.commandSessions.length === 1);
	expect(h.commandCaptures[0]!.route).toBe("larm-only");
	expect(h.commandSessions[0]).toEqual({
		sessionRole: "subagent",
		taskId: first.id,
	});
	// The command is one call: its session is released as the call ends.
	await until(() => h!.releasedSessions.includes(first.id));
});

test("a saved sub-agent resource routes the command sub-agent's call to it", async () => {
	h = await setup({ autoStart: false });
	const resourceId = crypto.randomUUID();
	h.state.subagentResourceId = resourceId;
	h.state.commands.push({ action: "clarify", question: "どれ" });
	h.speak("どれですか。");
	const second = await h.commandRun("別の操作を開始して");
	await until(() => h!.commandSessions.length === 1);
	expect(h.commandCaptures[0]!.route).toEqual({ resourceId });
	expect(h.commandSessions[0]).toEqual({
		sessionRole: "subagent",
		taskId: second.id,
	});
});
