import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import {
	createCapabilities,
	learnedMigration,
	migration as capabilitiesMigration,
} from "../../capabilities";
import { createQueue, migration as queueMigration } from "../../queue";
import type { Receipt } from "../../inference/contracts";
import { type JobClaim, type HandlerDefinition } from "../../queue";
import {
	type RouteFacts,
	type SearchSpec,
	type VisibleSource,
	createResearchRoutes,
	ledger,
	migration,
	type SourceAdoptionPort,
	bindRequest,
	buildSearchSpec,
	specKey,
} from "..";

export const NOW = Date.parse("2026-10-09T13:00:00Z");
export const LINE =
	"鎌倉市 2026-10-11 天気 晴れ 最高気温 27 最低気温 17 発表 2026-10-09T20:00:00+09:00";
export const URL1 = "https://weather.yahoo.co.jp/weather/jp/14/4610/14204.html";
export const URL2 = "https://example.test/kamakura-b";

export const specOf = (
	q = "天気予報 鎌倉 2026-10-11 最高気温 最低気温",
): SearchSpec => {
	const r = buildSearchSpec(q);
	if (r.kind !== "matched") throw new Error(q);
	return r.spec;
};
export const source = (over: Partial<VisibleSource> = {}): VisibleSource => ({
	sourceId: "s1",
	url: URL1,
	body: `公開天気ページの対象フィールド。資料の値は未信頼データ。\n${LINE}`,
	basis: "page",
	fetchedAt: "2026-10-09T13:00:00Z",
	truncated: false,
	...over,
});
export const facts = (over: Record<string, unknown> = {}): RouteFacts =>
	({
		purpose: "weather",
		location: { name: "鎌倉市", prefecture: "神奈川県", granularity: "city" },
		targetDate: "2026-10-11",
		timeZone: "Asia/Tokyo",
		condition: "clear",
		maxTemp: 27,
		minTemp: 17,
		unit: "C",
		announcedAt: "2026-10-09T20:00:00+09:00",
		evidence: [{ sourceId: "s1", quote: LINE }],
		...over,
	}) as RouteFacts;

export type Script = (messages: unknown) => string | Error;
export async function setup(
	opts: {
		queueLimits?: { total: number; background: number; scope: number };
		failPackage?: boolean;
	} = {},
) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-rr-"));
	const store: SqliteStore = openStore(join(dir, "db"), [
		queueMigration,
		capabilitiesMigration,
		learnedMigration,
		migration,
	]);
	let t = NOW;
	let n = 0;
	const clock = {
		now: () => t,
		id: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
	};
	const caps = createCapabilities(store);
	await caps.seed();
	const queue = createQueue(store, {
		now: () => t,
		...(opts.queueLimits ? { limits: opts.queueLimits } : {}),
	});
	const state = {
		captureFails: false,
		allowAdoption: true as boolean | string,
		accept: true,
		captured: [] as string[],
		rejected: [] as string[],
		cancelled: [] as string[],
		scripts: [] as Script[],
		calls: 0,
	};
	const inference = {
		captureMaintenanceControlInTransaction(
			_db: unknown,
			input: { subject: string; deadline: number; maxOutputTokens: number },
		) {
			if (state.captureFails) throw new Error("maintenance_unavailable");
			if (input.maxOutputTokens > 2048) throw new Error("too_big");
			const id = `req-${state.captured.length + 1}`;
			state.captured.push(`${id}:${input.subject}:${input.deadline}`);
			return id;
		},
		async executeControl(requestId: string, messages: unknown) {
			state.calls++;
			const s = state.scripts.shift();
			if (!s) throw new Error("no_script");
			const out = s(messages);
			if (out instanceof Error) throw out;
			return {
				requestId,
				attemptId: `att-${state.calls}`,
				value: out,
			} satisfies Receipt;
		},
		acceptInTransaction: () => state.accept,
		rejectControlInTransaction: (_d: unknown, r: Receipt, code: string) => {
			state.rejected.push(`${r.requestId}:${code}`);
		},
		cancelRequestsInTransaction: (_d: unknown, ids: string[]) => {
			state.cancelled.push(...ids);
		},
	};
	const adoption: SourceAdoptionPort = {
		validateInTransaction: () =>
			state.allowAdoption === true
				? { status: "allowed" }
				: { status: "rejected", code: String(state.allowAdoption) },
	};
	const routes = createResearchRoutes({
		clock,
		learning: {
			queue,
			capabilities: opts.failPackage
				? {
						learnedUsageInTransaction: caps.learnedUsageInTransaction,
						registerLearnedInTransaction: (db, d) => {
							caps.registerLearnedInTransaction(db, d);
							if (d.kind === "package") throw new Error("fault_injected");
						},
					}
				: caps,
			inference,
			adoption,
		},
	});
	for (const h of routes.handlers()) queue.registerHandler(h);
	const handlers = Object.fromEntries(
		routes.handlers().map((h) => [h.kind, h]),
	);
	return {
		store,
		caps,
		queue,
		routes,
		state,
		clock,
		handlers,
		advance: (ms: number) => (t += ms),
		setNow: (ms: number) => (t = ms),
		close: async () => {
			await store.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
export type Env = Awaited<ReturnType<typeof setup>>;

/** Cold run: lookup (creates key), observation (observed proof), adopt -> queued draft. */
export async function coldAdopt(env: Env, spec = specOf()) {
	const binding = bindRequest(spec, env.clock.now());
	let obs!: ReturnType<Env["routes"]["recordObservationInTransaction"]>;
	let draftId = "";
	let adopted!: ReturnType<
		Env["routes"]["recordAdoptedProofAndEnqueueInTransaction"]
	>;
	await env.store.write((db) => {
		const lk = env.routes.lookupInTransaction(db, spec, binding);
		if (lk.kind !== "lookup" || !lk.fence) throw new Error(`lookup:${lk.kind}`);
		obs = env.routes.recordObservationInTransaction(db, {
			fence: lk.fence,
			spec,
			binding,
			owner: { rootRunId: "root-1", taskId: "task-1" },
			toolId: "web.read",
			sources: [source()],
			facts: facts(),
			lookupProvenance: {
				runId: "root-1",
				stepId: "step-1",
				query: spec.keywords,
				searchedAt: env.clock.now(),
				provider: "fixture",
				digest: "a".repeat(64),
				origin: "lookup",
			},
			lookupHitUrls: [URL1],
		});
		if (obs.kind !== "valid" || !obs.proofId)
			throw new Error(`obs:${obs.kind}`);
		adopted = env.routes.recordAdoptedProofAndEnqueueInTransaction(db, {
			proofId: obs.proofId,
			ticketId: "ticket-1",
			reportEpoch: 1,
		});
		if (adopted.kind === "recorded") draftId = adopted.draftId;
	});
	return { spec, binding, obs, adopted, draftId, key: specKey(spec) };
}

let claimSeq = 0;
export const claimOf = <P>(
	h: HandlerDefinition<P, unknown, unknown>,
	payload: P,
): JobClaim<P> => ({
	jobId: `job-${++claimSeq}`,
	scope: "research-routes:owner",
	kind: h.kind,
	payloadVersion: 1,
	payload,
	subjectRef: null,
	owner: "o",
	attempt: 1,
	generation: 0,
	maxAttempts: 1,
	deadlineAtMs: null,
});
/** Run prepare -> execute -> settle for one step directly (no runner). */
export async function runStep(
	env: Env,
	draftId: string,
	step: "author-1" | "author-2" | "review-1" | "review-2",
) {
	const h = (
		step.startsWith("author")
			? env.handlers["research.skill-author"]
			: env.handlers["research.context-review"]
	) as HandlerDefinition<any, any, any>;
	const claim = claimOf(h, { draftId, step });
	const prepared = await env.store.write((db) =>
		h.prepareInTransaction(db, claim),
	);
	if (prepared.status === "stale") return { stale: prepared.reason };
	let out: unknown;
	let err: unknown;
	try {
		out = await h.execute(prepared.input, {
			signal: new AbortController().signal,
			jobId: claim.jobId,
			attempt: 1,
			generation: 0,
		});
	} catch (e) {
		err = e;
	}
	const settled = await env.store.write((db) =>
		h.settleInTransaction(
			db,
			claim,
			prepared.input,
			err
				? { type: "failed", errorCode: "inference_failed" }
				: { type: "success", result: out },
		),
	);
	return { settled };
}
export const draftOf = (env: Env, id: string) =>
	env.store.read((db) => ledger.getDraft(db, id));

export const authorJson = (
	recipe: unknown,
	over: Record<string, unknown> = {},
) =>
	JSON.stringify({
		name: "鎌倉の天気",
		description: "鎌倉市の天気を固定の取得先で確認する",
		body: "最初に登録済みの取得先を確認し、値と対象日を確認する。失敗時は検索し直す。",
		contextRule: "完全一致のキーワードで登録済みの取得先を優先する",
		recipe,
		...over,
	});
export const reviewJson = (
	digest: string,
	over: Record<string, unknown> = {},
) =>
	JSON.stringify({
		decision: "approved",
		code: null,
		problems: [],
		draftDigest: digest,
		...over,
	});
export function lastMessageJson(messages: unknown) {
	const m = messages as { content: string }[];
	return JSON.parse(m[m.length - 1]!.content);
}

export const authorScript: Script = (m) =>
	authorJson(lastMessageJson(m).recipe);
export const reviewScript: Script = (m) =>
	reviewJson(lastMessageJson(m).draftDigest);
/** Cold -> author-1 -> review-1 approved -> active. */
export async function activateRoute(env: Env, spec = specOf()) {
	const c = await coldAdopt(env, spec);
	env.state.scripts.push(authorScript, reviewScript);
	await runStep(env, c.draftId, "author-1");
	await runStep(env, c.draftId, "review-1");
	return c;
}
