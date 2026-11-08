import { join } from "node:path";
import { rmSync } from "node:fs";
import type { LlmPort, LlmRequest } from "eumenes-agency";
import { createAgencyHost } from "./host";
import { baseSettings, choice, T0, updated } from "./host.fixture";
import { createAgencyStatePort } from "../../domains/dialogue";
import { createConversationService } from "../../domains/conversation";
import { createContinuityService } from "../../domains/continuity";
import { createMemoryService } from "../../domains/memory";
import { openDialogueStore } from "../../domains/dialogue/test/store.fixture";
import { settle } from "../../infrastructure/wait-for";

/** Real Memory provenance and journal, with only model answers and time controlled. */
export async function continuityHost(
	update: (request: LlmRequest<unknown>) => unknown,
	options: { maxUnanswered?: number } = {},
) {
	const { dir, store } = openDialogueStore("agency-continuity-");
	const conversation = createConversationService(store, {
		requireOutbox: true,
	});
	let now = T0,
		nextTimer = 0;
	const timers = new Map<number, { at: number; fn: () => void }>();
	const memory = createMemoryService(
		store,
		conversation,
		createContinuityService(),
		{
			journalPath: join(dir, "forget.jsonl"),
			clock: () => new Date(now).toISOString(),
		},
	);
	await memory.recover();
	const calls = { update: 0, select: 0, respond: 0 };
	const requests: LlmRequest<unknown>[] = [];
	const llm: LlmPort = {
		async complete(request) {
			if (request.purpose === "think")
				throw new Error("unexpected always-on call in F fixture");
			calls[request.purpose]++;
			requests.push(request);
			return {
				value: request.schema.parse(
					request.purpose === "update" ? update(request) : choice("wait"),
				),
				model: "fixture",
				inputTokens: 10,
				outputTokens: 5,
				cacheReadTokens: 0,
				latencyMs: 1,
			};
		},
	};
	const settings = {
		agency: { ...baseSettings, maxUnanswered: options.maxUnanswered ?? 0 },
		general: { agentName: "Eumenes", userName: "", persona: "butler" as const },
	};
	const state = createAgencyStatePort({ memory, now: () => now });
	const host = createAgencyHost({
		store,
		conversation,
		memory,
		state,
		settings: {
			get: () => settings,
			inTransaction: () => settings,
			onChange: () => () => {},
		},
		inference: { foregroundBusy: () => false },
		conversationBusy: () => false,
		recordSpokeInTransaction: () => {},
		createLlm: () => llm,
		nowMs: () => now,
		setTimer: (fn, ms) => {
			timers.set(++nextTimer, { at: now + ms, fn });
			return nextTimer;
		},
		clearTimer: (id) => {
			timers.delete(id as number);
		},
	});
	memory.registerForgetPurge(
		host.forgetInTransaction,
		host.planForgetInTransaction,
	);
	host.start();
	return {
		host,
		state,
		calls,
		requests,
		memory,
		store,
		conversation,
		async exchange() {
			await store.write((db) => {
				conversation.appendInTransaction(db, {
					id: "u1",
					conversationId: "c1",
					role: "user",
					text: "雲を眺める散歩を続けるのが楽しみです",
					runId: null,
					createdAt: new Date(now).toISOString(),
				});
				memory.referenceInputs.recordRunInTransaction(
					db,
					"r1",
					memory.referenceInputs.captureInTransaction(db, {
						messageIds: ["u1"],
					}),
				);
				conversation.appendInTransaction(db, {
					id: "a1",
					conversationId: "c1",
					role: "assistant",
					text: "雲の変化も楽しめますね",
					runId: "r1",
					createdAt: new Date(now).toISOString(),
				});
			});
			await settle();
		},
		async advance(ms: number) {
			const end = now + ms;
			for (;;) {
				const due = [...timers]
					.filter(([, t]) => t.at <= end)
					.sort((a, b) => a[1].at - b[1].at)[0];
				if (!due) break;
				timers.delete(due[0]);
				now = Math.max(now, due[1].at);
				due[1].fn();
				await settle();
			}
			now = end;
			await settle();
		},
		async close() {
			await host.close();
			await store.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

export const interestUpdate = (request: LlmRequest<unknown>) => {
	const d = JSON.parse(request.prompt);
	return updated({
		interestOps: d.state.interests?.length
			? []
			: [
					{
						op: "interest.add",
						id: null,
						localId: "walk",
						expectedRevision: null,
						status: null,
						topic: "雲の観察",
						origin: "user_relation",
						reason: "継続して楽しんでいること",
						derivedFrom: null,
						evidenceRefs: ["u1"],
					},
				],
	});
};
