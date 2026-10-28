import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import {
	createSettings,
	migration as settingsMigration,
	epochsMigration as settingsEpochsMigration,
} from "../../settings";
import {
	createInference,
	migration,
	parentsMigration,
	diagnosticsMigration,
	controlMigration,
	migrations as inferenceMigrations,
} from "..";
import type { LarmPort } from "../../larm";
import type { CloudAgentCall, CloudAgents } from "../adapters/cloud-agents";

type CloudAgentResult = Awaited<ReturnType<CloudAgents["run"]>>;

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0)) await close();
});
const messages = [
	{ role: "system" as const, content: "system" },
	{ role: "user" as const, content: "hi" },
	{ role: "assistant" as const, content: "hello" },
	{ role: "user" as const, content: "now" },
];
const tools = [
	{
		type: "function" as const,
		function: {
			name: "fixture_tool",
			description: "Fixture",
			parameters: { type: "object", properties: {} },
		},
	},
];

/** Settings saved as cloud-only on a Codex SDK connection (the conversation's cloud route), the request captured from them. */
async function setup(
	result: CloudAgentResult,
	route: {
		mode?: "cloud-only" | "larm-preferred";
		localStream?: LarmPort["answerStream"];
	} = {},
) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-conversation-reasoning-"));
	const store = openStore(join(dir, "test.db"), [
		settingsMigration,
		migration,
		settingsEpochsMigration,
		parentsMigration,
		diagnosticsMigration,
		controlMigration,
		...inferenceMigrations.slice(4).map((m) => m.sql),
	]);
	const settings = await createSettings(store, {
		dbPath: join(dir, "test.db"),
		env: {},
	});
	const s = settings.get();
	const connectionId = crypto.randomUUID();
	const resourceId = crypto.randomUUID();
	s.connections.push({
		id: connectionId,
		name: "Cloud",
		kind: "codex-sdk",
		baseUrl: "https://example.invalid/v1",
		enabled: true,
		epoch: 0,
		envRef: null,
	});
	s.resources.push({
		id: resourceId,
		connectionId,
		purpose: "llm",
		model: "fixture-model",
		contextWindow: 100_000,
		voice: null,
	});
	s.routes.llm.mode = route.mode ?? "cloud-only";
	s.routes.llm.cloudAllowed = true;
	s.routes.llm.fallbackId = resourceId;
	await settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: 0,
		settings: s,
		keys: [],
	});
	const calls: CloudAgentCall[] = [];
	const port: LarmPort = {
		status: () => ({ state: "unconfigured", capabilities: [] }),
		answerStream: route.localStream,
		connect: async () => {},
		answer: async () => {
			throw new Error("larm_unconfigured");
		},
		transcribe: async () => {
			throw new Error("larm_unconfigured");
		},
		speak: async () => {
			throw new Error("larm_unconfigured");
		},
		close: async () => {},
	};
	const inference = createInference(store, settings, {
		larmFactory: () => port,
		cloudAgents: {
			run: async (call) => {
				calls.push(call);
				return result;
			},
		},
	});
	cleanup.push(async () => {
		await inference.close();
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	// The conversation's capture: the saved cloud route, an exact context policy, as the dialogue sets them.
	const request = () =>
		store.write((db) => {
			const id = inference.captureInTransaction(
				db,
				crypto.randomUUID(),
				"llm",
				Date.now() + 60_000,
			);
			inference.setContextPolicyInTransaction!(db, id, "exact");
			return id;
		});
	return { inference, calls, request };
}

test("a main streamed call on a cloud-only Codex SDK route passes the reasoning as the effort, and gets its tool calls back", async () => {
	const h = await setup({
		text: "",
		toolCalls: [{ id: "c1", name: "fixture_tool", arguments: "{}" }],
	});
	const signal = new AbortController().signal;
	for (const reasoning of ["low", "medium", "high"] as const) {
		const receipt = await h.inference.executeStream(
			await h.request(),
			messages,
			signal,
			() => {},
			undefined,
			tools,
			{
				sessionRole: "main",
				reasoning: { larm: "off", cloud: reasoning },
				context: { instructionCount: 1, historyCount: 2 },
			},
		);
		expect(receipt.toolCalls).toEqual([
			{ id: "c1", name: "fixture_tool", arguments: "{}" },
		]);
		expect(h.calls.at(-1)).toMatchObject({
			kind: "codex-sdk",
			model: "fixture-model",
			reasoningEffort: reasoning,
			tools,
		});
	}
});

test("off sends no effort, and a main call without reasoning sends none either", async () => {
	const h = await setup({ text: "answer" });
	const signal = new AbortController().signal;
	await h.inference.executeStream(
		await h.request(),
		messages,
		signal,
		() => {},
		undefined,
		undefined,
		{ sessionRole: "main", reasoning: { larm: "high", cloud: "off" } },
	);
	await h.inference.executeStream(
		await h.request(),
		messages,
		signal,
		() => {},
		undefined,
		undefined,
		{ sessionRole: "main" },
	);
	expect(h.calls).toHaveLength(2);
	for (const call of h.calls) expect(call.reasoningEffort).toBeUndefined();
});

test("a fallback from LARM to the cloud inside one call gives each attempt the level of its own side", async () => {
	const larm: unknown[] = [];
	const h = await setup(
		{ text: "answer" },
		{
			mode: "larm-preferred",
			localStream: async (_messages, _signal, _onDelta, options) => {
				larm.push(options?.reasoning);
				throw new Error("larm_provider_failed");
			},
		},
	);
	const receipt = await h.inference.executeStream(
		await h.request(),
		messages,
		new AbortController().signal,
		() => {},
		undefined,
		undefined,
		{ sessionRole: "main", reasoning: { larm: "off", cloud: "medium" } },
	);
	expect(receipt.value).toBe("answer");
	expect(larm).toEqual(["off"]);
	expect(h.calls).toHaveLength(1);
	expect(h.calls[0]!.reasoningEffort).toBe("medium");
});
