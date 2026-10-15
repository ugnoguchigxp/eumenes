import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTRACT_VERSIONS } from "eumenes-memory";
import { applyForget, planForget } from "eumenes-memory/sqlite";
import { planAssertionTransition } from "eumenes-world-model";
import { createContinuityService } from "../domains/continuity";
import {
	CONVERSATION_DEFAULT_PRINCIPAL,
	CONVERSATION_DEFAULT_SCOPE,
	createConversationService,
} from "../domains/conversation";
import { createDialogueService } from "../domains/dialogue";
import { createGoalsService } from "../domains/goals";
import type { Messages } from "../domains/inference/contracts";
import { createInference } from "../domains/inference";
import type { LarmPort } from "../domains/larm";
import { createMemoryService } from "../domains/memory";
import { createQueue } from "../domains/queue";
import { createSettings } from "../domains/settings";
import { createWebResearch } from "../domains/web-research";
import { sourceKeyOf } from "../domains/world";
import { openStore } from "../infrastructure/sqlite";
import { migrations } from "./migrations";
import { createToolchain } from "./toolchain";
import { fit, sourceOf, summaryOf } from "./world-research-readings";
import { createToolchainHostLinks } from "./toolchain-host";
import { createToolchainRouting } from "./toolchain-routing";
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
const SCOPE = {
	principal: CONVERSATION_DEFAULT_PRINCIPAL,
	scopeKey: CONVERSATION_DEFAULT_SCOPE,
};
const NOW = Date.parse("2026-10-09T00:00:00Z");
const CLAIM_TEXT = "10月";

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of open.splice(0).reverse()) await close();
});

type Packet = {
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
type Step = (packet: Packet, hooks: Hooks) => unknown | Promise<unknown>;
type Hooks = Awaited<ReturnType<typeof boot>>["hooks"];

function workerPacket(messages: Messages): Packet {
	const data = JSON.parse(messages.find((m) => m.role === "user")!.content);
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
const invoke = (tool: string, args: unknown) => ({
	action: "invoke",
	tool,
	arguments: args,
});
const finish = (packet: Packet, keyword: string) => {
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

async function boot(steps: Step[], options: BootOptions = {}) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-world-research-"));
	const dbPath = join(dir, "db.sqlite3");
	const store = openStore(dbPath, migrations);
	const conversation = createConversationService(store, {
		requireOutbox: true,
	});
	const settings = await createSettings(store, { dbPath });
	const packets: Packet[] = [];
	const workerMessages: string[] = [];
	const parentMessages: string[] = [];
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
			if (callOptions?.tools?.length) {
				offered.push(JSON.stringify(callOptions.tools));
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
			if (system.includes("TOOLS=")) {
				workerMessages.push(JSON.stringify(messages));
				const packet = workerPacket(messages);
				packets.push(packet);
				const step = steps[position++];
				if (!step) throw new Error("replay_extra_model_call");
				return JSON.stringify(await step(packet, hooks));
			}
			parentMessages.push(JSON.stringify(messages));
			return "調べた結果をお伝えします。";
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
	async function forgetSource(settle: boolean) {
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
		toolchain.embedQuery,
		toolchain.registry,
		toolchain.schemas,
		toolchain.worldAvailable,
	);
	const dialogue = createDialogueService({
		store,
		conversation,
		larm: inference,
		queue,
		agents: toolchain.agents,
		postAnswer: toolchain.postAnswer,
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
		dialogue,
		routing,
		ask,
		packets,
		workerMessages,
		parentMessages,
		offered,
		hooks,
	};
}

const QUESTION = "音声サービスの提供開始はいつ？";
const happy: Step[] = [
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

test("a World question delegates to route world: the sub-agent finds the target, reads claims as sources and the report is projected", async () => {
	const h = await boot(happy);
	expect(
		h.store.read((db) =>
			h.routing.catalogInTransaction(db).map((c) => c.runtime.route),
		),
	).toContain("world");
	const { run, done } = await h.ask(QUESTION);
	expect(done?.status).toBe("completed");
	expect(h.offered.join("")).toContain("world_query");
	// The worker input is only the question, the detail and the original request: no URL.
	const first = h.packets[0]!;
	expect(Object.keys(first.task).sort()).toEqual(["detail", "question"]);
	expect(first.originalRequest).toBe(QUESTION);
	expect(first.task.urls).toBeUndefined();
	// world.find lists the target (by id and name) and the matching adopted goal in its notes.
	const found = h.packets[1]!.operations[0]!;
	expect(found.tool).toBe("world.find");
	expect(found.notes!.entities).toEqual([
		{ id: "svc-1", name: "音声サービス", aliases: ["ボイス"] },
	]);
	expect(found.notes!.goals).toHaveLength(1);
	expect(found.notes!.goals[0]).toMatchObject({
		desiredState: "音声サービスを10月に公開する",
	});
	// world.query readings are world claims written with the target's name.
	const reading = h.packets[2]!.observations.find((o) => o.basis === "world")!;
	expect(reading.title).toBe("Worldの記録（本人の報告）");
	expect(reading.origin).toBe("user_report");
	expect(reading.excerpts.map((e) => e.quote).join("")).toContain(
		"対象: 音声サービス",
	);
	expect(h.packets[2]!.operations[1]!.notes).toMatchObject({
		mode: "snapshot",
		completeness: "complete",
	});
	// The conversation model sees the projection of the saved report, not the reading.
	const projected = h.parentMessages.find((m) => m.includes("world_claim"));
	expect(projected).toBeDefined();
	// Only the source id, kind and origin cross to the parent: no claim id or revision.
	expect(projected).toContain("sourceId");
	expect(projected).toContain("user_report");
	expect(projected).not.toContain("claim-1");
	expect(projected).not.toContain("sourceRef");
	expect(projected).not.toContain("svc-1");
	expect(projected).not.toContain("launch_month");
	expect(h.dialogue.answerText(run.id)).toContain("調べた結果");
	const report = h.store.read(
		(db) =>
			db.query("SELECT report_json FROM agent_reports").get() as {
				report_json: string;
			},
	);
	expect(JSON.parse(report.report_json).sources[0]).toMatchObject({
		kind: "world_claim",
		sourceRef: "claim-1",
		sourceRevision: "2",
		basis: "world",
		scopeRef: SCOPE.scopeKey,
	});
});

test("a claim retracted while the research ran keeps the report from being adopted", async () => {
	const h = await boot([
		happy[0]!,
		happy[1]!,
		async (packet, hooks) => {
			const report = finish(packet, CLAIM_TEXT);
			await hooks.retractClaim();
			return report;
		},
	]);
	const { done } = await h.ask(QUESTION);
	expect(done?.status).toBe("completed");
	expect(
		h.store.read((db) =>
			db.query("SELECT error_code FROM agent_tasks WHERE kind='worker'").get(),
		),
	).toEqual({ error_code: "evidence_invalidated" });
	// No accepted report: the conversation model never sees the projection.
	expect(
		h.parentMessages.find((m) => m.includes("world_claim")),
	).toBeUndefined();
	expect(
		h.store.read(
			(db) =>
				(
					db.query("SELECT COUNT(*) AS n FROM agent_reports").get() as {
						n: number;
					}
				).n,
		),
	).toBe(0);
});

test("a target World does not know is reported as not found, with no readings", async () => {
	const h = await boot([
		() => invoke("world.find", { names: ["存在しない対象"] }),
		(packet) => {
			expect(packet.operations[0]!.notes!.entities).toEqual([]);
			return {
				action: "finish",
				report: {
					outcome: "not_found",
					summary: "Worldにその対象の記録はありません。",
					claims: [],
					limitations: [],
				},
			};
		},
	]);
	const { done } = await h.ask("存在しない対象について教えて");
	expect(done?.status).toBe("completed");
	expect(h.packets[1]!.observations).toEqual([]);
});

test("World off: the World investigation is not offered", async () => {
	const h = await boot([], { world: false });
	expect(
		h.store.read((db) =>
			h.routing.catalogInTransaction(db).map((c) => c.runtime.route),
		),
	).not.toContain("world");
});

test("a query the World refuses comes back as a machine failure code, not as a reading", async () => {
	const h = await boot([
		() => invoke("world.query", { mode: "relevance", entityId: "unknown-id" }),
		(packet) => {
			const op = packet.operations[0]!;
			expect(op.state).toBe("succeeded");
			expect(op.failures).toEqual([{ url: "world", code: "not_available" }]);
			return {
				action: "finish",
				report: {
					outcome: "not_found",
					summary: "照会できませんでした。",
					claims: [],
					limitations: [],
				},
			};
		},
	]);
	const { done } = await h.ask("謎の対象に関係の深いものは？");
	expect(done?.status).toBe("completed");
	expect(h.packets[1]!.observations).toEqual([]);
});

test("a snapshot given one entityId (the live mistake) reads that single start point", async () => {
	const h = await boot([
		() => invoke("world.query", { mode: "snapshot", entityId: "svc-1" }),
		(packet) => {
			expect(packet.operations[0]!.failures).toEqual([]);
			return finish(packet, CLAIM_TEXT);
		},
	]);
	const { done } = await h.ask(QUESTION);
	expect(done?.status).toBe("completed");
	expect(
		h.packets[1]!.observations.some((o) => o.basis === "world"),
	).toBeTrue();
});

test("an input that does not fit the mode comes back as invalid_input with the fields to repair", async () => {
	const h = await boot([
		() => invoke("world.query", { mode: "influence", entityIds: ["svc-1"] }),
		(packet) => {
			const op = packet.operations[0]!;
			expect(op.state).toBe("succeeded");
			expect(op.failures).toEqual([{ url: "world", code: "invalid_input" }]);
			expect(op.notes!.invalidFields.length).toBeGreaterThan(0);
			return {
				action: "finish",
				report: {
					outcome: "failed",
					summary: "照会できませんでした。",
					claims: [],
					limitations: ["照会の入力が合わなかった"],
				},
			};
		},
	]);
	const { done } = await h.ask("音声サービスを変えると何に影響する？");
	expect(done?.status).toBe("completed");
	expect(h.packets[1]!.observations).toEqual([]);
});

test("a finish whose claims omit evidence is rejected and repaired: the references e1.. were offered and the skill says how to cite them", async () => {
	// The live failure shape: the sub-agent read the World, then finished with claims that carry no evidence.
	let rejected: Packet["lastResult"];
	let offered: unknown;
	const h = await boot([
		happy[0]!,
		happy[1]!,
		(packet) => {
			offered = {
				evidence: (packet as unknown as { evidence?: unknown }).evidence,
				references: packet.observations.flatMap((o) =>
					o.excerpts.map((e) => e.reference),
				),
			};
			return {
				action: "finish",
				report: {
					outcome: "answered",
					summary: "音声サービスの提供開始は10月と記録されています。",
					claims: [{ text: "音声サービスの提供開始は10月" }],
					limitations: [],
				},
			};
		},
		(packet) => {
			rejected = packet.lastResult;
			return finish(packet, CLAIM_TEXT);
		},
	]);
	const { done } = await h.ask(QUESTION);
	expect(done?.status).toBe("completed");
	// The readings were offered as references the claim could cite.
	expect(offered).toMatchObject({ references: ["e1"] });
	// The rejection names the missing field, and the repair step is accepted with the reference.
	expect(rejected?.issues).toContainEqual(
		expect.objectContaining({
			validationPath: "report.claims.0.evidence",
			validationCode: "invalid_type",
		}),
	);
	expect(workerError(h)).toEqual({ error_code: null });
	expect(readReport(h).sources[0]).toMatchObject({ kind: "world_claim" });
	// The skill the sub-agent was given tells it to cite excerpt references and what to do without any.
	const instructions = h.workerMessages[2]!;
	expect(instructions).toContain("evidence を省かない");
	expect(instructions).toContain(
		"claims を空の配列 [] にして outcome を not_found",
	);
	expect(instructions).toContain(
		"dN は資料の番号であり、根拠参照 (eN) ではない",
	);
});

test("a query that returns no readings: the sub-agent has no references and finishes with not_found and no claims", async () => {
	const h = await boot(
		[
			() => invoke("world.find", { names: ["静かな機器"] }),
			(packet) =>
				invoke("world.query", {
					mode: "snapshot",
					entityIds: [packet.operations[0]!.notes!.entities[0].id],
					depth: 0,
				}),
			(packet) => {
				expect(packet.observations).toEqual([]);
				expect(
					(packet as unknown as { evidence?: unknown[] }).evidence ?? [],
				).toEqual([]);
				return {
					action: "finish",
					report: {
						outcome: "not_found",
						summary: "Worldにその対象についての記録はありません。",
						claims: [],
						limitations: ["対象は記録されているが、主張がまだ無い"],
					},
				};
			},
		],
		{
			seed: async ({ apply }) => {
				await apply("quiet-1", {
					kind: "entity.register",
					entity: {
						id: "quiet-1",
						displayName: "静かな機器",
						aliases: [],
						externalRefs: [],
					},
				});
			},
		},
	);
	const { done } = await h.ask("静かな機器について何が分かっている？");
	expect(done?.status).toBe("completed");
	expect(workerError(h)).toEqual({ error_code: null });
	expect(h.packets[2]!.operations[1]!.notes).toMatchObject({
		mode: "snapshot",
	});
});

const readReport = (h: Awaited<ReturnType<typeof boot>>) =>
	JSON.parse(
		(
			h.store.read(
				(db) =>
					db.query("SELECT report_json FROM agent_reports").get() as {
						report_json: string;
					},
			) as { report_json: string }
		).report_json,
	) as { coverage: string; sources: Array<Record<string, unknown>> };
const workerError = (h: Awaited<ReturnType<typeof boot>>) =>
	h.store.read((db) =>
		db.query("SELECT error_code FROM agent_tasks WHERE kind='worker'").get(),
	);

test("a claim revised (disputed) while the research ran keeps the report from being adopted", async () => {
	const h = await boot([
		happy[0]!,
		happy[1]!,
		async (packet, hooks) => {
			const report = finish(packet, CLAIM_TEXT);
			await hooks.reviseClaim();
			return report;
		},
	]);
	const { done } = await h.ask(QUESTION);
	expect(done?.status).toBe("completed");
	expect(workerError(h)).toEqual({ error_code: "evidence_invalidated" });
	expect(
		h.parentMessages.find((m) => m.includes("world_claim")),
	).toBeUndefined();
});

test("a source forgotten while the research ran keeps the report from being adopted, even before World's tombstone is written", async () => {
	// The feed does not run: the forget is accepted (conversation retraction, Memory exclusion) and World's
	// tombstone is still to come. Only the source-resolving re-read can see it.
	const h = await boot(
		[
			happy[0]!,
			happy[1]!,
			async (packet, hooks) => {
				const report = finish(packet, CLAIM_TEXT);
				await hooks.forgetSource(false);
				return report;
			},
		],
		{ feed: false },
	);
	const { done } = await h.ask(QUESTION);
	expect(done?.status).toBe("completed");
	expect(workerError(h)).toEqual({ error_code: "evidence_invalidated" });
	expect(
		h.parentMessages.find((m) => m.includes("world_claim")),
	).toBeUndefined();
});

test("a forgotten source whose World tombstone is already written keeps the report from being adopted", async () => {
	const h = await boot(
		[
			happy[0]!,
			happy[1]!,
			async (packet, hooks) => {
				const report = finish(packet, CLAIM_TEXT);
				await hooks.forgetSource(true);
				return report;
			},
		],
		{ feed: false },
	);
	const { done } = await h.ask(QUESTION);
	expect(done?.status).toBe("completed");
	expect(workerError(h)).toEqual({ error_code: "evidence_invalidated" });
});

test("a snapshot cut by World's own budget: the readings stay within the cap, every reading says the read was partial and the report's coverage is partial", async () => {
	const h = await boot(
		[
			() => invoke("world.find", { names: ["音声サービス"] }),
			(packet) =>
				invoke("world.query", {
					mode: "snapshot",
					entityIds: [packet.operations[0]!.notes!.entities[0].id],
					depth: 0,
				}),
			(packet) => {
				const reference = packet.observations.flatMap((o) => o.excerpts)[0]!
					.reference;
				expect(
					packet.observations.filter((o) => o.basis === "world").length,
				).toBeLessThanOrEqual(24);
				const notes = packet.operations.at(-1)!.notes!;
				expect(notes.completeness).toBe("partial");
				return {
					action: "finish",
					report: {
						outcome: "answered",
						summary: "音声サービスには多くの記録があります。",
						claims: [
							{ text: "音声サービスの記録は多数ある", evidence: [reference] },
						],
						limitations: ["一部しか読めていない"],
					},
				};
			},
		],
		{
			seed: async ({ apply, assertion }) => {
				for (let i = 0; i < 60; i++)
					await apply(`bulk-${i}`, {
						kind: "assertion.register",
						assertion: assertion(`bulk-${i}`, "svc-1", `p${i}`, `v`),
					});
			},
		},
	);
	const { done } = await h.ask(QUESTION);
	expect(done?.status).toBe("completed");
	const report = readReport(h);
	expect(report.coverage).toBe("partial");
	expect(report.sources.every((s) => s.acquisitionTruncated === true)).toBe(
		true,
	);
});

test("more than 20 matching targets: world.find lists a few within its byte budget and says it is truncated", async () => {
	const h = await boot(
		[
			() => invoke("world.find", { names: ["音声機器"] }),
			(packet) => {
				const notes = packet.operations[0]!.notes!;
				expect(notes.entities.length).toBeGreaterThan(0);
				expect(notes.entities.length).toBeLessThanOrEqual(20);
				expect(notes.truncated).toBe(true);
				expect(
					new TextEncoder().encode(JSON.stringify(notes)).length,
				).toBeLessThanOrEqual(1500);
				return {
					action: "finish",
					report: {
						outcome: "clarification_required",
						summary: "対象が多く、絞れません。",
						claims: [],
						limitations: [],
					},
				};
			},
		],
		{
			seed: async ({ apply }) => {
				for (let i = 0; i < 30; i++)
					await apply(`dev-${i}`, {
						kind: "entity.register",
						entity: {
							id: `dev-${i}`,
							displayName: `音声機器${i}号`,
							aliases: [
								`ボイス機器${i}`,
								`マイク${i}`,
								`スピーカー${i}`,
								`別名${i}`,
							],
							externalRefs: [],
						},
					});
			},
		},
	);
	const { done } = await h.ask("音声機器について教えて");
	expect(done?.status).toBe("completed");
});

test("a one-character name identifies nothing: world.find lists no target for it", async () => {
	const h = await boot([
		() => invoke("world.find", { names: ["音"] }),
		(packet) => {
			expect(packet.operations[0]!.notes!.entities).toEqual([]);
			return {
				action: "finish",
				report: {
					outcome: "not_found",
					summary: "Worldにその対象の記録はありません。",
					claims: [],
					limitations: [],
				},
			};
		},
	]);
	const { done } = await h.ask("音について教えて");
	expect(done?.status).toBe("completed");
});

// --- the readings, without the assembly -----------------------------------

const claim = (over: Record<string, unknown> = {}) =>
	({
		id: "c1",
		revision: 1,
		subjectId: "a",
		predicate: "launch_month",
		origin: "user_report",
		status: "active",
		freshness: "fresh",
		refutations: [],
		condition: { kind: "unspecified" },
		value: { kind: "string", value: "10月" },
		...over,
	}) as never;
const NAMES: Record<string, string> = { a: "音声サービス", b: "LARM" };
const nameOf = (id: string) => NAMES[id];

test("a relation reading says the relation in plain words and never the stored identifier", () => {
	const source = sourceOf(
		claim({
			relation: { kind: "depends_on", objectId: "b" },
			value: undefined,
		}),
		"scope",
		"2026-10-09T00:00:00Z",
		nameOf,
	)!;
	expect(source.body).toContain("依存している");
	expect(source.body).toContain("LARM");
	expect(source.body).not.toContain("depends_on");
	expect(source.truncated).toBe(false);
	expect(source.acquisitionTruncated).toBeUndefined();
});

test("a reading whose target has no resolvable name is not written", () => {
	expect(
		sourceOf(
			claim({ subjectId: "zzz" }),
			"scope",
			"2026-10-09T00:00:00Z",
			nameOf,
		),
	).toBeUndefined();
});

test("a reading whose value was clipped says so, and its digest is stable", () => {
	const long = claim({ value: { kind: "string", value: "あ".repeat(500) } });
	const a = sourceOf(long, "scope", "2026-10-09T00:00:00Z", nameOf)!;
	const b = sourceOf(long, "scope", "2026-10-09T00:00:00Z", nameOf)!;
	expect(a.truncated).toBe(true);
	expect(a.acquisitionTruncated).toBe(true);
	expect(a.viewDigest).toBe(b.viewDigest);
});

test("an incomplete read marks its readings as truncated even when their text is whole", () => {
	const source = sourceOf(
		claim(),
		"scope",
		"2026-10-09T00:00:00Z",
		nameOf,
		true,
	)!;
	expect(source.acquisitionTruncated).toBe(true);
});

test("gap kinds and dependency states are written in plain words, and unnamed targets are left out and counted", () => {
	const gaps = summaryOf(
		{
			mode: "gaps",
			gaps: {
				gaps: [
					{
						kind: "RESOURCE_STATE_UNKNOWN",
						subjectId: "a",
						edgeId: "e1",
						confirmWith: { kind: "entity", id: "b" },
						blocksGoal: true,
					},
					{
						kind: "CONDITION_UNKNOWN",
						subjectId: "zzz",
						edgeId: "e2",
						confirmWith: { kind: "entity", id: "b" },
						blocksGoal: false,
					},
				],
			},
		} as never,
		nameOf,
		(id) => id,
	);
	const text = JSON.stringify(gaps.summary);
	expect(text).toContain("使えるかどうかが分かっていない");
	expect(text).not.toContain("RESOURCE_STATE_UNKNOWN");
	expect(gaps.dropped).toBe(1);
	const dependencies = summaryOf(
		{
			mode: "dependencies",
			dependencies: {
				entityId: "a",
				outcome: "unknown",
				reasonCode: "NO_DEPENDENCIES_KNOWN",
				dependencies: [
					{
						entityId: "b",
						depth: 1,
						state: "unavailable",
						viaEdgeId: "e1",
						reasonCode: "CONDITION_UNKNOWN",
					},
				],
				unsatisfied: ["b"],
				unknown: [],
			},
		} as never,
		nameOf,
		(id) => id,
	);
	const deps = JSON.stringify(dependencies.summary);
	expect(deps).toContain("使えない");
	expect(deps).not.toMatch(
		/unavailable|CONDITION_UNKNOWN|NO_DEPENDENCIES_KNOWN/,
	);
});

test("a summary over its budget is cut and says so", () => {
	const big = {
		related: Array.from({ length: 200 }, (_, i) => ({
			name: `対象${i}`,
			distance: 1,
		})),
	};
	const fitted = fit(big);
	expect(fitted.truncated).toBe(true);
	expect(
		new TextEncoder().encode(JSON.stringify(fitted.summary)).length,
	).toBeLessThanOrEqual(2600);
	expect((fitted.summary as { truncated?: boolean }).truncated).toBe(true);
	expect(fit({ related: [] }).truncated).toBe(false);
});

test("a result summary points at readings as `document` / `documents`, never as `claims` (the report's own field)", () => {
	const influence = summaryOf(
		{
			mode: "influence",
			influence: {
				direction: "forward",
				entityId: "a",
				paths: [
					{
						nodes: ["a", "b"],
						edges: [{ id: "c1" }],
						effect: "decreases",
						confirmed: false,
					},
				],
				skipped: [],
			},
		} as never,
		nameOf,
		(id) => id,
	);
	const path = (influence.summary as { paths: Array<Record<string, unknown>> })
		.paths[0]!;
	expect(path.documents).toEqual(["c1"]);
	expect(JSON.stringify(influence.summary)).not.toContain('"claim');
});
