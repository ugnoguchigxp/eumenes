import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { prepareForgetting, type LlmPort } from "eumenes-agency";
import { researchTools } from "./research";
import { createHostRuntime } from "./runtime";
import { baseSettings, choice, T0, updated } from "./host.fixture";

test("an unpresented capability is not an input dependency of the generic delegation tool", async () => {
	const oldRef = "capability:toolchain:fixture.unused@1";
	const tools = researchTools(
		{ read: (fn) => fn({} as Database) },
		{
			generalActionsAvailable: () => true,
			catalogInTransaction: () => [
				{
					revisionId: oldRef.slice("capability:".length),
					title: "別の担当",
					description: "未提示の情報",
					requiresApproval: false,
					reason: "available",
				},
			],
		},
	);
	let calls = 0;
	const llm: LlmPort = {
		async complete(request) {
			calls++;
			return {
				value: request.schema.parse(
					request.purpose === "update" ? updated() : choice("wait"),
				),
				model: "fixture",
				inputTokens: 1,
				outputTokens: 1,
				cacheReadTokens: 0,
				latencyMs: 1,
			};
		},
	};
	const options = {
		agency: baseSettings,
		now: () => T0,
		persona: { agentName: "Eumenes", userName: "", persona: "butler" as const },
		llm,
		tools,
		topics: () => [],
		todos: () => [],
		input: () => ({ sources: [], complete: true }),
	};
	const initial = createHostRuntime(options);
	const checkpoint = prepareForgetting(initial.snapshot(), [oldRef]).checkpoint;
	const runtime = createHostRuntime({ ...options, restore: checkpoint });
	runtime.observe(
		{
			id: "fresh",
			kind: "exchange.adopted",
			actor: "user",
			occurredAt: T0,
			text: "新しい独立した会話",
		},
		{ sources: ["fresh"], complete: true },
	);
	const result = await runtime.decide(
		{
			id: "o1",
			at: T0,
			trigger: "turn_end",
			presence: "quiet",
			foregroundBusy: false,
			playerBusy: false,
			speechAllowed: false,
		},
		new AbortController().signal,
	);
	expect(calls).toBeGreaterThan(0);
	expect(result.decision?.source).toBe("llm");
	expect(tools.find((t) => t.name === "delegate")?.description).not.toContain(
		"未提示の情報",
	);
	expect(
		tools.find((t) => t.name === "delegate")?.input?.sources,
	).not.toContain(oldRef);
});
