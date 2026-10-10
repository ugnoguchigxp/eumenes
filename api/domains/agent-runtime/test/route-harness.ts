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
	type CachedSourceAuthorizationPort,
	type ToolAdapter,
} from "../../tool-runtime";
import {
	acquisitionMigration,
	createAgentRuntime,
	migration as agentMigration,
	type AcquisitionBindResult,
	type AcquisitionPlanPort,
	type AcquisitionProposal,
	type Task,
} from "..";

export const URL_A = "https://weather.example.com/kamakura";
export const URL_B = "https://weather.example.org/kamakura";
export const learnedId = `learned.web.${(1).toString(16).padStart(32, "0")}`;
export const learnedPackage = `package:${learnedId}@1`;
const base = { revision: 1, aliases: [], tags: [], useWhen: [], avoidWhen: [] };
export const learnedPair = (): Definition[] => [
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
			"skill:web.research@2",
			`skill:${learnedId}@1`,
			"tool:web.read@1",
		],
		profileRevisionId: "profile:web.research@1",
		requiredSkillRevisionIds: ["skill:web.research@2", `skill:${learnedId}@1`],
		toolRevisionIds: ["tool:web.read@1"],
	},
];
export const coldPackage = "package:web.research@7";
export const directBind = (token = "tok-direct"): AcquisitionBindResult => ({
	kind: "bound",
	bindingToken: token,
	packageRevisionId: learnedPackage,
	initialAction: {
		kind: "direct-invoke",
		toolId: "web.read",
		arguments: { url: URL_A },
		exactUrl: URL_A,
		attemptTimeoutMs: 5000,
	},
});
export const searchBind = (token = "tok-search"): AcquisitionBindResult => ({
	kind: "bound",
	bindingToken: token,
	packageRevisionId: coldPackage,
	initialAction: {
		kind: "host-lookup",
		query: "天気予報 鎌倉",
		language: "ja",
		region: "JP",
	},
});

export async function harness(now = Date.now) {
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
	]);
	const caps = createCapabilities(store);
	await caps.seed();
	// Archived acquisition fixtures keep the pre-view contract; replay tests cover the new revision.
	await store.write((db) =>
		db
			.query("UPDATE capability_items SET active_revision_id=? WHERE key=?")
			.run(coldPackage, "package:web.research"),
	);
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
		prepareSourcesInTransaction: (_db, _inv, result) =>
			result.readings ?? [
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
	const ledger = new Map<string, { urls: Set<string>; owner: string }>();
	const cachedPort: CachedSourceAuthorizationPort = {
		validateInTransaction: (_db, i) => {
			const g = ledger.get(i.bindingToken);
			if (!g || g.owner !== i.owner.taskId || !g.urls.has(i.exactUrl))
				return { status: "rejected", code: "revoked" };
			return { status: "allowed" };
		},
	};
	const tools = createToolRuntime(
		store,
		caps,
		queue,
		adapter,
		Date.now,
		cachedPort,
	);
	const captures: string[] = [];
	const inference = {
		captureControlInTransaction: (_db: unknown, i: { subject: string }) => {
			captures.push(i.subject);
			return `req-${captures.length}`;
		},
		executeControl: async () => ({}),
		acceptInTransaction: () => true,
		rejectControlInTransaction: () => {},
	};
	const proposals: AcquisitionProposal[] = [];
	const binds = new Map<string, AcquisitionBindResult>();
	const portCalls: string[] = [];
	let observation: ReturnType<
		AcquisitionPlanPort["recordObservationInTransaction"]
	> = {
		kind: "valid",
		proofId: "proof-1",
		canonicalReportPatch: {
			summary: "27",
			claims: [
				{
					text: "27",
					evidence: [{ sourceId: "", quote: "SENTINEL_TARGET 27" }],
				},
			],
			limitations: [],
		},
		safeProjection: {
			summary: "値は27",
			claims: [{ text: "27", sourceIds: [] }],
			limitations: [],
		},
		projectionDigest: "d".repeat(64),
	};
	const port: AcquisitionPlanPort = {
		resolveInTransaction: () => {
			portCalls.push("resolve");
			const next = proposals.length > 1 ? proposals.shift()! : proposals[0]!;
			return next;
		},
		bindInTransaction: (_db, i) => {
			const bound = binds.get(i.proposalToken) ?? {
				kind: "rejected" as const,
				code: "unknown_token",
			};
			portCalls.push(`bind:${i.proposalToken}`);
			if (bound.kind === "bound") {
				const urls = new Set<string>([URL_A]);
				ledger.set(bound.bindingToken, { urls, owner: i.childOwner.taskId });
			}
			return bound;
		},
		validateInTransaction: () => ({ kind: "allowed" }),
		recordObservationInTransaction: (_db, i) => {
			portCalls.push(`observe:${JSON.stringify(i.facts)}`);
			const patch = (
				observation as {
					canonicalReportPatch?: {
						claims: { evidence: { sourceId: string }[] }[];
					};
				}
			).canonicalReportPatch;
			const sid = i.visibleSources[0]?.sourceId;
			if (patch && sid)
				for (const c of patch.claims)
					for (const e of c.evidence) e.sourceId = sid;
			const proj = (
				observation as {
					safeProjection?: { claims: { sourceIds: string[] }[] };
				}
			).safeProjection;
			if (proj && sid) for (const c of proj.claims) c.sourceIds = [sid];
			return observation;
		},
		validateAdoptionInTransaction: () => ({ kind: "allowed" }),
		releaseInTransaction: (_db, i) => {
			portCalls.push(`release:${i.bindingToken}`);
			ledger.delete(i.bindingToken);
			return { kind: "released" };
		},
	};
	const agents = createAgentRuntime({
		store,
		capabilities: caps,
		tools,
		inference: inference as never,
		queue,
		acquisition: port,
		now,
		invocationHint: () => ({
			toolId: "web.forecast",
			arguments: { areaCode: "140000" },
		}),
	});
	const task = (id: string) =>
		store.read(
			(db) => db.query("SELECT * FROM agent_tasks WHERE id=?").get(id) as Task,
		);
	const start = (runId: string, question = "天気予報 鎌倉") =>
		store.write((db) =>
			agents.startInTransaction(db, {
				rootRunId: runId,
				input: { question },
				deadline: Date.now() + 120_000,
			}),
		);
	/** Prepare + settle the worker's queued model step with a fabricated model answer. */
	async function runModelStep(
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
		// The model quotes the real visible source id.
		const supplied = action as any;
		const data = JSON.parse(prep.input.messages[1]!.content);
		const real =
			supplied.action === "finish"
				? {
						action: "finish",
						report: {
							outcome: supplied.report.outcome ?? "answered",
							summary: supplied.report.summary,
							claims: supplied.report.claims.map((c: any) => ({
								...c,
								evidence: c.evidence.map((e: any) =>
									typeof e === "string"
										? e
										: (data.evidence.find((r: any) =>
												r.preview.includes(e.quote.slice(0, 12)),
											)?.reference ?? "e999"),
								),
							})),
							limitations: supplied.report.limitations,
						},
					}
				: supplied;

		afterPrepare?.();
		const applied = await store.write((db) =>
			agents.handler.settleInTransaction(db, claim as never, prep.input, {
				type: "success",
				result: { receipt: {} as never, invalid: false, action: real },
			} as never),
		);
		return { prep, applied };
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
		ledger,
		captures,
		proposals,
		binds,
		portCalls,
		task,
		start,
		runModelStep,
		doc,
		setObservation: (o: typeof observation) => (observation = o),
		async close() {
			await agents.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
