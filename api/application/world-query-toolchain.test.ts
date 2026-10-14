import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planAssertionTransition } from "eumenes-world-model";
import { createContinuityService } from "../domains/continuity";
import {
	CONVERSATION_DEFAULT_PRINCIPAL,
	CONVERSATION_DEFAULT_SCOPE,
	createConversationService,
} from "../domains/conversation";
import { createDialogueService } from "../domains/dialogue";
import type { Messages } from "../domains/inference/contracts";
import { createInference } from "../domains/inference";
import type { LarmPort } from "../domains/larm";
import { createMemoryService } from "../domains/memory";
import { createQueue } from "../domains/queue";
import { createSettings } from "../domains/settings";
import { createWebResearch } from "../domains/web-research";
import { openStore } from "../infrastructure/sqlite";
import { migrations } from "./migrations";
import { createToolchain } from "./toolchain";
import { createToolchainHostLinks } from "./toolchain-host";
import { createToolchainRouting } from "./toolchain-routing";
import {
	createWorldAssembly,
	defaultWorldJournalPath,
	manualAccess,
	resolveWorldCursorSecret,
} from "./world";

/**
 * The conversation agent's `world_query`, end to end on the real assembly (store, queue, World
 * ON, the data-driven toolchain and the dialogue run). Fixture-grade: the model is a scripted
 * inference port that chooses the tool and answers from what it is shown.
 */
const SCOPE = {
	principal: CONVERSATION_DEFAULT_PRINCIPAL,
	scopeKey: CONVERSATION_DEFAULT_SCOPE,
};
const NOW = Date.parse("2026-10-09T00:00:00Z");

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of open.splice(0).reverse()) await close();
});

async function boot(
	command: (messages: Messages) => string,
	parentAnswer: (messages: Messages) => string,
) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-world-query-"));
	const dbPath = join(dir, "db.sqlite3");
	const store = openStore(dbPath, migrations);
	const conversation = createConversationService(store, {
		requireOutbox: true,
	});
	const settings = await createSettings(store, { dbPath });
	const commandContexts: string[] = [];
	const model: LarmPort = {
		status: () => ({ state: "ready", capabilities: ["llm"] }),
		connect: async () => {},
		close: async () => {},
		transcribe: async () => "",
		speak: async () => new Uint8Array(),
		answer: async (messages, _signal, callOptions) => {
			const system = messages[0]!.content;
			if (messages[0]!.content.includes("転記された発話の主要な言語"))
				return JSON.stringify({
					status: "identified",
					languages: ["ja"],
					confidence: 0.99,
				});
			if (callOptions?.tools?.length) {
				callOptions.onToolCalls!([
					{
						id: crypto.randomUUID(),
						name: "world_query",
						arguments: JSON.stringify({
							request: messages.filter((m) => m.role === "user").at(-1)!
								.content,
						}),
					},
				]);
				return "";
			}
			if (system.includes("あなたはこのツールチェーンの操作担当です")) {
				commandContexts.push(JSON.stringify(messages));
				return command(messages);
			}
			return parentAnswer(messages);
		},
	};
	const inference = createInference(store, settings, {
		larmFactory: () => model,
	});
	const queue = createQueue(store, {
		resources: { "inference.llm": 1, "inference.aux": 2, "web.fetch": 2 },
		pollMs: 5,
	});
	const web = createWebResearch({
		store,
		queue,
		acquisition: {
			close: async () => {},
			execute: async () => {
				throw new Error("web_unavailable");
			},
		},
	});
	const memoryJournalPath = join(dir, "memory-forget-journal.jsonl");
	const memory = createMemoryService(
		store,
		conversation,
		createContinuityService(store),
		{ journalPath: memoryJournalPath },
	);
	const world = createWorldAssembly({
		store,
		conversation,
		memory,
		mode: "on",
		journalPath: defaultWorldJournalPath(memoryJournalPath),
		cursorSecret: resolveWorldCursorSecret({ dbPath, env: {} }),
		pollMs: 60_000,
	});
	const recovery = await memory.recover();
	await world.recover({
		feedResyncRequired: recovery.feedResyncRequired === true,
	});
	await world.service.markInitialSyncComplete();
	await world.service.setEnabled(true);
	await conversation.append({
		id: "m1",
		conversationId: "main",
		role: "user",
		text: "音声サービスは9月から利用できる。",
		createdAt: "2026-10-09T00:00:00.000Z",
		runId: null,
	});
	const state = store.read((db) => conversation.sourceInTransaction(db, "m1"));
	if (state.state !== "available") throw new Error("no source m1");
	const source = {
		namespace: "conversation",
		kind: "message",
		id: "m1",
		representation: "text",
		revision: state.revision,
		digest: state.digest,
	};
	const apply = (key: string, operation: unknown) =>
		world.service.apply({
			access: manualAccess(),
			scope: SCOPE,
			operationKey: key,
			clock: NOW,
			operation: operation as never,
		});
	await apply("e1", {
		kind: "entity.register",
		entity: {
			id: "svc-1",
			displayName: "音声サービス",
			aliases: [],
			externalRefs: [],
		},
	});
	const assertion = {
		id: "claim-1",
		revision: 1,
		scope: SCOPE,
		subjectId: "svc-1",
		predicate: "launch_month",
		payload: { kind: "value", value: { kind: "string", value: "10月" } },
		evidence: [
			{
				evidenceId: "ev-1",
				kind: "user_statement",
				stance: "supports",
				source,
				rootEvidenceId: "root-1",
			},
		],
		inputManifest: [source],
		origin: "user_report",
		recordedAt: NOW,
		freshnessPolicy: { maxAgeMs: 86_400_000 },
		condition: { kind: "unspecified" },
		supersedes: [],
		contradicts: [],
		interpretationVersion: "interp-1",
		lifecycle: "candidate",
		rootEvidenceIds: ["root-1"],
	};
	await apply("r1", { kind: "assertion.register", assertion });
	const planned = planAssertionTransition({
		contractVersion: 1,
		scope: SCOPE,
		current: {
			id: "claim-1",
			revision: 1,
			scope: SCOPE,
			lifecycle: "candidate",
			origin: "user_report",
		},
		expectedRevision: 1,
		request: {
			action: "adopt",
			adoption: { kind: "explicit", operationId: "op-claim-1" },
			subjectConfirmedByHost: true,
		},
		registeredAdoptionRules: [],
	} as never);
	if (!planned.ok || planned.value.status !== "planned")
		throw new Error("adopt_plan_failed");
	await apply("a1", { kind: "assertion.transition", plan: planned.value.plan });
	const links = createToolchainHostLinks({
		store,
		settings,
		inference,
		conversation,
		world,
	});
	const toolchain = await createToolchain(store, queue, inference, web, {
		...links.options,
		reconcileThrottleMs: 0,
	});
	const dialogue = createDialogueService({
		store,
		conversation,
		larm: inference,
		queue,
		agents: toolchain.agents,
		postAnswer: toolchain.postAnswer,
		toolchains: createToolchainRouting(
			toolchain.capabilities,
			toolchain.history,
			toolchain.embedQuery,
			toolchain.registry,
			toolchain.schemas,
		),
		worldContext: world.context,
	} as never);
	links.attachDialogue(dialogue);
	toolchain.agents.start();
	queue.start();
	world.start();
	open.push(async () => {
		await toolchain.agents.close();
		await queue.close(100);
		await web.close();
		await dialogue.close();
		await inference.close();
		await world.close();
		await store.close().catch(() => {});
		rmSync(dir, { recursive: true, force: true });
	});
	return { store, dialogue, commandContexts };
}

test("world_query chosen: the run completes, the sub-agent is shown the targets, the answer uses the result", async () => {
	const h = await boot(
		() =>
			JSON.stringify({
				action: "invoke",
				tool: "world.query",
				arguments: { mode: "snapshot", entityIds: ["svc-1"] },
			}),
		(messages) => {
			const action = messages.find((m) =>
				m.content.startsWith('{"actionResult":'),
			);
			if (!action) return "結果が提示されませんでした。";
			const result = JSON.parse(action.content).actionResult;
			const claims = JSON.stringify(result.result);
			return `調べました。${result.mode}の結果では、${claims.includes("10月") ? "音声サービスの提供開始は10月" : "該当なし"}でございます。`;
		},
	);
	const run = await h.dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: "音声サービスについて分かっていることは？",
	});
	const done = await h.dialogue.waitForTerminal(run.id, { timeoutMs: 8000 });
	expect(done?.status).toBe("completed");
	expect(h.dialogue.answerText(run.id)).toContain(
		"音声サービスの提供開始は10月",
	);
	// The sub-agent named the start point by the id the host showed it.
	expect(h.commandContexts.join("")).toContain("svc-1");
	// The ledger keeps the receipt only: no claim text.
	const ledger = h.store.read((db) =>
		JSON.stringify(db.query("SELECT * FROM tool_action_invocations").all()),
	);
	expect(ledger).toContain("world.query");
	expect(ledger).not.toContain("10月");
});
