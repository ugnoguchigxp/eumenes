import {
	callsOf,
	candidatesOf,
	isNoticeRound,
	utteranceOf,
	isUtteranceRound,
	searchThenDelegate,
} from "../toolchain/conversation-script.fixture";
import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTRACT_VERSIONS } from "eumenes-memory";
import { applyForget, planForget } from "eumenes-memory/sqlite";
import { planAssertionTransition } from "eumenes-world-model";
import { createContinuityService } from "../../domains/continuity";
import {
	CONVERSATION_DEFAULT_PRINCIPAL,
	CONVERSATION_DEFAULT_SCOPE,
	createConversationService,
} from "../../domains/conversation";
import { createDialogueService } from "../../domains/dialogue";
import { testConversationAgent } from "../../domains/dialogue/test/conversation-agent.fixture";
import { createGoalsService } from "../../domains/goals";
import type { Messages } from "../../domains/inference/contracts";
import { createInference } from "../../domains/inference";
import type { LarmPort } from "../../domains/larm";
import { createMemoryService } from "../../domains/memory";
import { createQueue } from "../../domains/queue";
import { createSettings } from "../../domains/settings";
import { createWebResearch } from "../../domains/web-research";
import { sourceKeyOf } from "../../domains/world";
import { openStore } from "../../infrastructure/sqlite";
import { migrations } from "../migrations";
import { createToolchain } from "../toolchain/toolchain";
import { createToolchainHostLinks } from "../toolchain/toolchain-host";
import { createToolchainRouting } from "../toolchain/toolchain-routing";
import { fixtureDiscovery } from "../toolchain/discovery.fixture";
import {
	createWorldAssembly,
	defaultWorldJournalPath,
	manualAccess,
	resolveWorldCursorSecret,
} from "./world";

/**
 * The World investigation, end to end on the real assembly (store, queue, World ON, the data-driven
 * toolchain and the dialogue run). Fixture-grade: the conversation model and the research sub-agent
 * are scripted inference ports; the sub-agent is shown only what the host's reads return.
 */
export const SCOPE = {
	principal: CONVERSATION_DEFAULT_PRINCIPAL,
	scopeKey: CONVERSATION_DEFAULT_SCOPE,
};
export const NOW = Date.parse("2026-10-09T00:00:00Z");
export const CLAIM_TEXT = "10月";

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of open.splice(0).reverse()) await close();
});

export type Packet = {
	task: Record<string, unknown>;
	originalRequest: string;
	/** The last rejected control output of this task, when this step is a repair. */
	lastResult?: {
		code: string;
		issues: Array<{ validationPath?: string; validationCode?: string }>;
	};
	operations: Array<{
		tool: string;
		state: string;
		notes?: Record<string, any>;
		failures?: Array<{ url: string; code: string }>;
	}>;
	observations: Array<{
		basis: string;
		title: string;
		origin?: string;
		excerpts: Array<{ reference: string; quote: string }>;
	}>;
};
export type Step = (packet: Packet, hooks: Hooks) => unknown | Promise<unknown>;
type Hooks = Awaited<ReturnType<typeof boot>>["hooks"];

function workerPacket(messages: Messages): Packet {
	const data = JSON.parse(
		messages.filter((m) => m.role === "user").at(-1)!.content,
	);
	const untrusted = messages.find((m) =>
		m.content.startsWith("UNTRUSTED_MATERIALS"),
	);
	if (untrusted)
		Object.assign(
			data,
			JSON.parse(untrusted.content.slice(untrusted.content.indexOf("=") + 1)),
		);
	return data;
}
export const invoke = (tool: string, args: unknown) => ({
	action: "invoke",
	tool,
	arguments: args,
});
export const finish = (packet: Packet, keyword: string) => {
	const reference = packet.observations
		.flatMap((o) => o.excerpts)
		.find((e) => e.quote.includes(keyword))?.reference;
	if (!reference) throw new Error("expected_evidence_missing");
	return {
		action: "finish",
		report: {
			outcome: "answered",
			summary: "音声サービスの提供開始は10月と記録されています。",
			claims: [{ text: "音声サービスの提供開始は10月", evidence: [reference] }],
			limitations: [],
		},
	};
};

type BootOptions = {
	world?: boolean;
	/** Does World's feed consumer run (it tombstones a forget asynchronously)? */
	feed?: boolean;
	/** Extra World content, written after the base target and claim. */
	seed?: (seed: {
		apply: (key: string, operation: unknown) => Promise<unknown>;
		assertion: (
			id: string,
			subjectId: string,
			predicate: string,
			text: string,
		) => Record<string, unknown>;
	}) => Promise<void>;
};

async function forgetFixtureSource(
	store: ReturnType<typeof openStore>,
	conversation: ReturnType<typeof createConversationService>,
	memory: ReturnType<typeof createMemoryService>,
	world: ReturnType<typeof createWorldAssembly>,
	settle: boolean,
) {
	// "Forget this message": the conversation retracts it and Memory forgets its host source in one
	// transaction; World's own tombstone follows from the feed.
	await store.write((db) => {
		conversation.retractInTransaction(db, { messageId: "m1" });
		const access = {
			principal: SCOPE.principal,
			scopeKeys: [SCOPE.scopeKey],
			purpose: "world.test",
			policyRevision: memory.policyRevisionInTransaction(db),
		};
		const planned = planForget(db, {
			contractVersion: CONTRACT_VERSIONS.lifecycle,
			access,
			target: {
				type: "host_source",
				sourceKey: sourceKeyOf({
					namespace: "conversation",
					kind: "message",
					id: "m1",
					representation: "text",
				}),
				scopeKey: SCOPE.scopeKey,
			},
			clock: { atMs: Date.now() },
		});
		if (planned.status !== "planned") throw new Error("plan failed");
		applyForget(db, {
			contractVersion: CONTRACT_VERSIONS.lifecycle,
			entry: planned.plan.entry,
			clock: { atMs: Date.now() },
		});
	});
	if (settle) await world.pump({ full: true });
}

export async function boot(steps: Step[], options: BootOptions = {}) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-world-research-"));
	const dbPath = join(dir, "db.sqlite3");
	const store = openStore(dbPath, migrations);
	const conversation = createConversationService(store, {
		requireOutbox: true,
	});
	const settings = await createSettings(store, { dbPath });
	const packets: Packet[] = [];
	const workerMessages: string[] = [];
	const offered: string[] = [];
	let position = 0;
	let hooks!: {
		retractClaim(): Promise<void>;
		reviseClaim(): Promise<void>;
		/** The user forgets the utterance the claim stands on; `settle`: World's feed also tombstones it. */
		forgetSource(settle: boolean): Promise<void>;
	};
	const model: LarmPort = {
		status: () => ({ state: "ready", capabilities: ["llm"] }),
		connect: async () => {},
		close: async () => {},
		transcribe: async () => "",
		speak: async () => new Uint8Array(),
		answer: async (messages, _signal, callOptions) => {
			const system = messages[0]!.content;
			if (system.includes("転記された発話の主要な言語"))
				return JSON.stringify({
					status: "identified",
					languages: ["ja"],
					confidence: 0.99,
				});
			if (isUtteranceRound(callOptions) && !isNoticeRound(messages)) {
				// The conversation's round: search for the World query toolchain, then hand the question over.
				const question = utteranceOf(messages);
				const candidates = candidatesOf(messages);
				if (candidates) offered.push(JSON.stringify(candidates));
				const step = searchThenDelegate(
					(candidate) => candidate.id === "world.query",
					question,
					{ announcement: "照会します。", impact: "none" },
				)(messages);
				if (step.calls?.length)
					callOptions!.onToolCalls!(
						callsOf(step, () => crypto.randomUUID()) as never,
					);
				return step.text ?? "";
			}
			if (system.includes("TOOLS=")) {
				workerMessages.push(JSON.stringify(messages));
				const packet = workerPacket(messages);
				packets.push(packet);
				const step = steps[position++];
				if (!step) throw new Error("replay_extra_model_call");
				return JSON.stringify(await step(packet, hooks));
			}
			throw new Error("fixture_unexpected_model_call");
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
			aliases: ["ボイス"],
			externalRefs: [],
		},
	});
	const assertionOf = (
		id: string,
		subjectId: string,
		predicate: string,
		text: string,
	) => ({
		id,
		revision: 1,
		scope: SCOPE,
		subjectId,
		predicate,
		payload: { kind: "value", value: { kind: "string", value: text } },
		evidence: [
			{
				evidenceId: `ev-${id}`,
				kind: "user_statement",
				stance: "supports",
				source,
				rootEvidenceId: `root-${id}`,
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
		rootEvidenceIds: [`root-${id}`],
	});
	const assertion = assertionOf("claim-1", "svc-1", "launch_month", CLAIM_TEXT);
	await apply("r1", { kind: "assertion.register", assertion });
	const transition = async (
		key: string,
		revision: number,
		request: unknown,
	) => {
		const planned = planAssertionTransition({
			contractVersion: 1,
			scope: SCOPE,
			current: {
				id: "claim-1",
				revision,
				scope: SCOPE,
				lifecycle: key === "a1" ? "candidate" : "active",
				origin: "user_report",
			},
			expectedRevision: revision,
			request,
			registeredAdoptionRules: [],
		} as never);
		if (!planned.ok || planned.value.status !== "planned")
			throw new Error("transition_plan_failed");
		const applied = await apply(key, {
			kind: "assertion.transition",
			plan: planned.value.plan,
		});
		if (applied.status !== "applied") throw new Error("transition_refused");
	};
	await transition("a1", 1, {
		action: "adopt",
		adoption: { kind: "explicit", operationId: "op-claim-1" },
		subjectConfirmedByHost: true,
	});
	async function retractClaim() {
		await transition("x1", 2, { action: "retract", reasonSource: source });
	}
	async function reviseClaim() {
		// A dispute is a new revision of the claim that is not an end of it.
		await apply("seed-other", {
			kind: "assertion.register",
			assertion: assertionOf("claim-2", "svc-1", "other", "11月"),
		});
		await transition("d1", 2, {
			action: "dispute",
			contradicts: [{ id: "claim-2", revision: 1 }],
		});
	}
	const forgetSource = (settle: boolean) =>
		forgetFixtureSource(store, conversation, memory, world, settle);

	hooks = { retractClaim, reviseClaim, forgetSource };
	await options.seed?.({ apply, assertion: assertionOf });
	if (options.world === false) await world.service.setEnabled(false);
	const goals = createGoalsService(store);
	await goals.adopt(
		{ principal: SCOPE.principal, scopeKeys: [SCOPE.scopeKey] },
		{
			scopeKey: SCOPE.scopeKey,
			desiredState: "音声サービスを10月に公開する",
			source: { namespace: "conversation", kind: "message", id: "m1" },
		},
	);
	const links = createToolchainHostLinks({
		store,
		settings,
		inference,
		conversation,
		world,
		goals,
	});
	const toolchain = await createToolchain(store, queue, inference, web, {
		...links.options,
		reconcileThrottleMs: 0,
	});
	const routing = createToolchainRouting(
		toolchain.capabilities,
		toolchain.history,
		// The discovery finds the World query, as the fixture's embedding would.
		fixtureDiscovery(store, toolchain.capabilities, () => "world_query"),
		toolchain.registry,
		toolchain.schemas,
		toolchain.worldAvailable,
	);
	const dialogue = createDialogueService({
		conversationAgent: testConversationAgent,
		store,
		continuity: createContinuityService(store),
		conversation,
		larm: inference,
		queue,
		agents: toolchain.agents,
		toolchains: routing,
		worldContext: world.context,
	} as never);
	links.attachDialogue(dialogue);
	toolchain.agents.start();
	queue.start();
	if (options.feed !== false) world.start();
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
	const ask = async (text: string) => {
		const run = await dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text,
		});
		const done = await dialogue.waitForTerminal(run.id, { timeoutMs: 10000 });
		return { run, done };
	};
	return {
		store,
		world,
		dialogue,
		routing,
		ask,
		packets,
		workerMessages,
		/** The results of the conversation's finished TODOs, oldest first: what their notices tell. */
		reported: () =>
			JSON.stringify(
				store
					.read((db) =>
						dialogue.todoPageInTransaction(db, "main", {
							state: "archived",
							pageIndex: 0,
							pageSize: 50,
						}),
					)
					.rows.reverse()
					.map((row) => row.result),
			),
		offered,
		hooks,
	};
}

export const QUESTION = "音声サービスの提供開始はいつ？";
export const happy: Step[] = [
	() => invoke("world.find", { names: ["音声サービス"] }),
	(packet) => {
		const found = packet.operations[0]!.notes!;
		return invoke("world.query", {
			mode: "snapshot",
			entityIds: [found.entities[0].id],
		});
	},
	(packet) => finish(packet, CLAIM_TEXT),
];
