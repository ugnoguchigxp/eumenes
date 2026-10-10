import { fixtureResearchOutput, fixtureVerification } from "./research-fixture";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import {
	createCapabilities,
	learnedMigration,
	migration as capMigration,
	type Definition,
} from "../../capabilities";
import { createQueue, migration as queueMigration } from "../../queue";
import {
	createToolRuntime,
	migration as toolMigration,
	routeGrantMigration,
	supersedeMigration,
	readMetadataMigration,
	type AdapterOperation,
	type ToolAdapter,
} from "../../tool-runtime";
import {
	acquisitionMigration,
	requirementsMigration,
	createAgentRuntime,
	migration as agentMigration,
	type Task,
} from "..";

const URL_A = "https://weather.example.com/kamakura";
const learnedId = `learned.web.${(1).toString(16).padStart(32, "0")}`;
const base = { revision: 1, aliases: [], tags: [], useWhen: [], avoidWhen: [] };
const learnedPair = (): Definition[] => [
	{
		...base,
		kind: "skill",
		id: learnedId,
		title: "学習",
		summary: "学習",
		dependencies: [],
		body: "鎌倉の天気を確認する手順",
		discoveryMode: "route-only",
	},
	{
		...base,
		kind: "package",
		id: learnedId,
		title: "学習",
		summary: "学習",
		backend: "web",
		schemaKey: "research",
		discoveryMode: "route-only",
		dependencies: [
			"profile:web.research@1",
			"skill:web.research@5",
			`skill:${learnedId}@1`,
			"tool:web.read@1",
		],
		profileRevisionId: "profile:web.research@1",
		requiredSkillRevisionIds: ["skill:web.research@5", `skill:${learnedId}@1`],
		toolRevisionIds: ["tool:web.read@1"],
	},
];
export async function harness(now = Date.now, luna = false) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-route-"));
	const store = openStore(join(dir, "db"), [
		capMigration,
		learnedMigration,
		queueMigration,
		toolMigration,
		routeGrantMigration,
		supersedeMigration,
		readMetadataMigration,
		agentMigration,
		acquisitionMigration,
		requirementsMigration,
	]);
	const caps = createCapabilities(store);
	await caps.seed();
	await store.write((db) => {
		for (const d of learnedPair()) caps.registerLearnedInTransaction(db, d);
	});
	const queue = createQueue(store);
	const started: Array<{
		toolId: string;
		args: unknown;
		grantedUrl?: string;
		attemptTimeoutMs?: number;
	}> = [];
	const results = new Map<string, AdapterOperation>();
	const adapter: ToolAdapter = {
		prepareSourcesInTransaction: (_db, _inv, result) => ({
			sources: result.readings ?? [
				...result.hits.map((h) => ({
					sourceId: crypto.randomUUID(),
					viewId: crypto.randomUUID(),
					url: h.url,
					title: h.title,
					basis: "snippet" as const,
					fetchedAt: result.observedAt,
					body: h.snippet,
					truncated: true,
				})),
				...result.documents.map((d) => ({
					sourceId: crypto.randomUUID(),
					viewId: crypto.randomUUID(),
					url: d.url,
					title: d.title,
					basis: "page" as const,
					fetchedAt: d.fetchedAt,
					body: d.text,
					truncated: d.truncated,
				})),
			],
		}),
		validateEvidenceInTransaction: () => true,
		startInTransaction: (db, r) => {
			started.push({
				toolId: r.tool.id,
				args: r.arguments,
				grantedUrl: r.grantedUrl,
				attemptTimeoutMs: r.attemptTimeoutMs,
			});
			// A real queue job so the runtime can parent follow-up steps to it.
			const { job } = queue.enqueueInTransaction(db, {
				scope: "agent",
				kind: "agent.step",
				dedupeKey: `web-${started.length}`,
				payload: { taskId: "web", stepId: `web-${started.length}` },
				lane: "background",
				maxAttempts: 1,
			});
			return { operationId: `op${started.length}`, jobId: job.id };
		},
		get: (id) => results.get(id) ?? { state: "pending" },
		cancelInTransaction: () => [],
	};
	const tools = createToolRuntime(store, caps, queue, adapter, now);
	const captures: string[] = [];
	const engines: Array<string | undefined> = [];
	const inference = {
		codexResearchAvailable: () => luna,
		captureControlInTransaction: (
			_db: unknown,
			i: { subject: string; engine?: string },
		) => {
			captures.push(i.subject);
			engines.push(i.engine);
			return `req-${captures.length}`;
		},
		executeControl: async () => ({}),
		acceptInTransaction: () => true,
		rejectControlInTransaction: () => {},
	};
	const agents = createAgentRuntime({
		store,
		capabilities: caps,
		tools,
		inference: inference as never,
		queue,
		now,
	});
	const task = (id: string) =>
		store.read(
			(db) => db.query("SELECT * FROM agent_tasks WHERE id=?").get(id) as Task,
		);
	const start = (
		runId: string,
		question = "天気予報 鎌倉",
		researcher?: "codex_luna",
	) =>
		store.write((db) =>
			agents.startInTransaction(db, {
				rootRunId: runId,
				input: { kind: "web", question, researcher },
				deadline: Date.now() + 120_000,
			}),
		);
	/** Prepare + settle the worker's queued model step with a fabricated model answer. */
	async function runRawModelStep(
		taskId: string,
		action: unknown,
		afterPrepare?: () => void,
	) {
		const t = task(taskId);
		const step = store.read(
			(db) =>
				db
					.query("SELECT id FROM agent_steps WHERE task_id=? AND job_id=?")
					.get(t.id, t.job_id) as { id: string },
		);
		const claim = {
			jobId: t.job_id!,
			payload: { taskId: t.id, stepId: step.id },
			deadlineAtMs: t.deadline,
		};
		const prep = await store.write((db) =>
			agents.handler.prepareInTransaction(db, claim as never),
		);
		if (prep.status !== "ready") return { prep, applied: null };

		afterPrepare?.();
		const applied = await store.write((db) =>
			agents.handler.settleInTransaction(db, claim as never, prep.input, {
				type: "success",
				result: { receipt: {} as never, invalid: false, action },
			} as never),
		);
		return { prep, applied };
	}
	async function runModelStep(
		taskId: string,
		action: unknown,
		afterPrepare?: () => void,
	) {
		const frozen = store.read((db) =>
			db
				.query(
					"SELECT contract_json FROM agent_requirement_contracts WHERE task_id=?",
				)
				.get(taskId),
		) as { contract_json: string } | null;
		const t = task(taskId),
			data = {
				task: JSON.parse(t.input_json!),
				originalRequest:
					JSON.parse(t.input_json!).originalRequest ??
					JSON.parse(t.input_json!).question,
				requirementContract: frozen ? JSON.parse(frozen.contract_json) : null,
			};
		const result = await runRawModelStep(
			taskId,
			JSON.parse(fixtureResearchOutput(data, JSON.stringify(action))),
			afterPrepare,
		);
		if (
			task(taskId).phase === "verify_requirements" &&
			task(taskId).state === "queued"
		) {
			const row = store.read((db) =>
				db
					.query(
						"SELECT draft_json FROM agent_requirement_drafts WHERE task_id=?",
					)
					.get(taskId),
			) as { draft_json: string };
			await runRawModelStep(
				taskId,
				fixtureVerification(JSON.parse(row.draft_json)),
			);
		}
		return result;
	}
	const doc = (text: string, url = URL_A): AdapterOperation => ({
		state: "succeeded",
		result: {
			observedAt: new Date().toISOString(),
			hits: [],
			documents: [
				{
					url,
					title: "INJECTION_TITLE",
					text,
					fetchedAt: new Date().toISOString(),
					truncated: false,
				},
			],
			failures: [],
		},
	});
	return {
		store,
		agents,
		tools,
		caps,
		queue,
		started,
		results,
		captures,
		engines,
		task,
		start,
		runModelStep,
		runRawModelStep,
		doc,
		async close() {
			await agents.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
