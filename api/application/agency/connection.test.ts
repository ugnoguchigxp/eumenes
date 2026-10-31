import { afterEach, expect, test } from "bun:test";
import { agencyOutputContract } from "eumenes-agency";
import { agencyBackgroundSystem } from "./system-context";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { LarmPort } from "../../domains/larm";
import { createConversationService } from "../../domains/conversation";
import { createSettings } from "../../domains/settings";
import { createInference, type Messages } from "../../domains/inference";
import { openDialogueStore } from "../../domains/dialogue/test/store.fixture";
import { waitFor, settle } from "../../infrastructure/wait-for";
import { systemContext } from "../../infrastructure/system-context";
import { assembleAgency } from "./assembly";
import { choice, updated } from "./host.fixture";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanups.splice(0)) await close();
});

type Captured = {
	messages: Messages;
	schema: unknown;
	role?: string;
	session?: unknown;
};

for (const target of ["larm", "cloud"] as const) {
	test(`assembled host reaches ${target} with one exact purpose system, including a retry`, async () => {
		const { dir, store } = openDialogueStore("agency-system-connection-");
		cleanups.push(async () => {
			await store.close();
			rmSync(dir, { recursive: true, force: true });
		});
		const settings = await createSettings(store, {
			dbPath: join(dir, "test.db"),
			env: {},
		});
		const configured = settings.get();
		configured.general.agentName = "ConnectedEumenes";
		configured.agency.emotion = true;
		configured.routes.llm.mode = target === "larm" ? "larm-only" : "cloud-only";
		configured.routes.llm.cloudAllowed = target === "cloud";
		if (target === "cloud") {
			const connectionId = crypto.randomUUID();
			const resourceId = crypto.randomUUID();
			configured.connections.push({
				id: connectionId,
				name: "Test cloud",
				kind: "codex-sdk",
				baseUrl: "https://example.invalid",
				enabled: true,
				epoch: 0,
				envRef: null,
			});
			configured.resources.push({
				id: resourceId,
				connectionId,
				purpose: "llm",
				model: "fixture-model",
				contextWindow: 100_000,
				voice: null,
			});
			configured.routes.llm.fallbackId = resourceId;
		}
		await settings.apply({
			requestId: crypto.randomUUID(),
			expectedRevision: configured.revision,
			settings: configured,
			keys: [],
		});
		const captured: Captured[] = [];
		let failed = false;
		const answer = (
			messages: Messages,
			schema: unknown,
			role?: string,
			session?: unknown,
		) => {
			captured.push({
				messages: structuredClone(messages),
				schema,
				role,
				session,
			});
			// Exercise the core retry, not a model-script-specific production branch.
			if (!failed) {
				failed = true;
				throw new Error("network_unavailable");
			}
			const data = JSON.parse(
				messages.at(-1)!.content.split("## Task\n").at(-1)!,
			);
			return JSON.stringify(
				data.opportunity ? { ...choice("wait"), emotion: null } : updated(),
			);
		};
		const larm: LarmPort = {
			decisionModel: () => null,
			status: () => ({ state: "unconfigured", capabilities: [] }),
			connect: async () => {},
			close: async () => {},
			answer: async (messages, _signal, options) =>
				answer(messages, options?.jsonSchema, options?.sessionRole),
			transcribe: async () => {
				throw new Error("unused");
			},
			speak: async () => {
				throw new Error("unused");
			},
		};
		const inference = createInference(store, settings, {
			larmFactory: () => larm,
			cloudAgents: {
				run: async (call) => ({
					text: answer(
						call.messages,
						call.outputSchema,
						call.session?.role,
						call.session,
					),
				}),
			},
		});
		const conversation = createConversationService(store, {
			requireOutbox: true,
		});
		const tasks: string[] = [];
		const host = assembleAgency(
			{
				store,
				settings,
				inference,
				conversation,
				memory: {
					status: () => ({ enabled: true, healthy: true }),
					list: () => [],
				},
			},
			() => ({
				conversationHasActiveRunInTransaction: () => false,
				recordSpontaneousInTransaction: () => {},
				conversationTaskInTransaction: (_db, _id, task) => {
					tasks.push(task);
					return {
						messages: [
							{ role: "system", content: "NORMAL_SYSTEM_MUST_BE_REPLACED" },
							{ role: "user", content: "MEMORY_SENTINEL" },
							{ role: "assistant", content: "HISTORY_SENTINEL" },
							{ role: "user", content: `## Task\n${task}` },
						],
					};
				},
			}),
		);
		cleanups.unshift(async () => {
			await host.close();
			await inference.close();
		});
		host.start();
		const append = (
			id: string,
			role: "user" | "assistant",
			text: string,
			runId: string | null,
		) =>
			conversation.append({
				id,
				conversationId: "connected",
				role,
				text,
				runId,
				createdAt: new Date().toISOString(),
			});
		await append("u1", "user", "OBSERVATION_SENTINEL", null);
		await append("a1", "assistant", "話しました。", "r1");
		await waitFor(() => captured.length >= 3);
		await settle();
		expect(captured).toHaveLength(3); // update failure, exact retry, select
		expect(captured[0]!.messages).toEqual(captured[1]!.messages);
		for (const call of captured) {
			const systems = call.messages.filter((m) => m.role === "system");
			expect(systems).toHaveLength(1);
			const system = systems[0]!.content;
			const data = JSON.parse(
				call.messages.at(-1)!.content.split("## Task\n").at(-1)!,
			);
			const purpose = data.opportunity ? "select" : "update";
			const outputContract =
				purpose === "update"
					? agencyOutputContract("update", {
							condition: "B1",
							hostTodos: true,
							utteranceEmotion: true,
						})
					: agencyOutputContract("select", {
							condition: "B1",
							hostTodos: true,
							utteranceEmotion: true,
						});
			expect(system).toBe(
				agencyBackgroundSystem(
					purpose,
					{ outputContract },
					configured.general,
					true,
				),
			);
			expect(system).toContain("名前は「ConnectedEumenes」");
			expect(system).toContain(
				systemContext("dialogue.contexts.agency.background", {
					role: "",
					style: "",
				}).split("\n")[0]!,
			);
			for (const sentinel of [
				"NORMAL_SYSTEM_MUST_BE_REPLACED",
				"MEMORY_SENTINEL",
				"HISTORY_SENTINEL",
				"OBSERVATION_SENTINEL",
				"OUTPUT_SCHEMA=",
			])
				expect(system).not.toContain(sentinel);
			expect(
				call.messages
					.slice(1)
					.map((m) => m.content)
					.join("\n"),
			).not.toContain(system);
			expect(call.schema).toMatchObject({ type: "object" });
			if (target === "cloud") expect(call.session).toBeUndefined(); // no persisted conversation session is resumed
			else expect(call.role).toBe("auxiliary");
		}
		expect(captured[2]!.messages[0]!.content).toContain(
			"今回の機会に会話へ参加するか",
		);
		for (const task of tasks)
			expect(JSON.parse(task).observations).toContainEqual(
				expect.objectContaining({ text: "OBSERVATION_SENTINEL" }),
			);
	});
}
