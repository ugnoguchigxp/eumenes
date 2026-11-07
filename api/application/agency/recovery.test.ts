import { expect, test } from "bun:test";
import {
	prepareForgetting,
	type LlmPort,
	type LlmRequest,
} from "eumenes-agency";
import { harness, updated, choice, baseSettings } from "./host.fixture";
import { createHostRuntime } from "./runtime";
import { recoverTickets } from "./recovery";
import type { AgencyHostDeps, Conv } from "./host-types";

for (const available of [true, false])
	test(`restart preserves provenance for an independent pending speech (${available ? "persisted" : "unknown delivery"}) after unrelated forgetting`, async () => {
		const h = harness({ start: false });
		const input = { sources: ["uB"], complete: true };
		const llm: LlmPort = {
			async complete<T>(request: LlmRequest<T>) {
				return {
					value: request.schema.parse(
						request.purpose === "update"
							? updated()
							: choice("speak", {
									refs: ["uB"],
									utterance: "Bについての発話です。",
								}),
					),
					model: "fixture",
					inputTokens: 0,
					outputTokens: 0,
					cacheReadTokens: 0,
					latencyMs: 0,
				};
			},
		};
		const config = {
			agency: baseSettings,
			persona: {
				agentName: "Eumenes",
				userName: "",
				persona: "butler" as const,
			},
			now: () => 70_000,
			llm,
			topics: () => [],
			todos: () => [],
			input: () => ({ sources: ["config"], complete: true }),
		};
		const runtime = createHostRuntime(config);
		runtime.observe(
			{
				id: "uB",
				kind: "user.report",
				actor: "user",
				occurredAt: 0,
				text: "独立したBの話です",
			},
			input,
		);
		const { decision } = await runtime.decide(
			{
				id: "op",
				at: 70_000,
				trigger: "turn_end",
				presence: "quiet",
				foregroundBusy: false,
				playerBusy: false,
				speechAllowed: true,
			},
			new AbortController().signal,
		);
		const ticket = decision.ticket!;
		expect(ticket.action).toBe("speak");
		const restored = createHostRuntime({
			...config,
			restore: prepareForgetting(runtime.snapshot(), ["unrelated-A"])
				.checkpoint,
		});
		expect(restored.snapshot().continuity?.issued).toHaveLength(1);
		if (available)
			await h.conversation.append({
				id: `agency:scopeB:${ticket.id}`,
				conversationId: "B",
				role: "assistant",
				text: "実際に保存した発話",
				createdAt: new Date().toISOString(),
				runId: null,
			});
		const deps = {
			store: h.store,
			conversation: h.conversation,
			memory: {
				status: () => ({ enabled: true, healthy: true }),
				list: () => [],
			},
		} as unknown as AgencyHostDeps;
		const conv = {
			id: "B",
			scope: "scopeB",
			epoch: 0,
			runtime: restored,
		} as Conv;
		await recoverTickets(deps, conv, 80_000);
		const snapshot = restored.snapshot();
		expect(
			snapshot.state.attempts.find((a) => a.id === ticket.id)?.status,
		).toBe(available ? "succeeded" : "outcome_unknown");
		expect(snapshot.provenance?.entries.every(([, i]) => i.complete)).toBe(
			true,
		);
		expect(
			snapshot.provenance?.entries.some(
				([key, i]) =>
					key.startsWith("observation:") && i.sources.includes("uB"),
			),
		).toBe(true);
		expect(h.conversation.get("B").messages).toHaveLength(available ? 1 : 0);
		expect(h.calls).toEqual({ update: 0, select: 0, respond: 0 });
	});
