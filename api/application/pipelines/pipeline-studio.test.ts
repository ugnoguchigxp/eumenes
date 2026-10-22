import { expect, test } from "bun:test";
import type { PipelineDefinition } from "../../domains/capabilities";
import { canonicalText } from "../../domains/pipelines";
import type { DomainAdapter } from "../../domains/tool-runtime";
import { harness } from "../toolchain/toolchain.fixture";
import {
	createPipelinesAdapter,
	PIPELINES_ADAPTER_REF,
} from "./pipelines-adapter";
import { createPipelineTrials } from "./pipelines-trials";

const draft: PipelineDefinition = {
	formatVersion: 1,
	id: "timer-pair",
	title: "二つのタイマー",
	summary: "分のタイマーと、続けて秒のタイマーを掛ける",
	useWhen: ["タイマーを続けて二つ掛けたい", "二段階のタイマーを頼みたい"],
	avoidWhen: [],
	inputs: {
		minutes: { type: "integer", description: "分", required: true },
	},
	steps: [
		{
			id: "first",
			kind: "toolchain",
			title: "一つ目",
			toolchain: "timers.manage",
			request: "${inputs.minutes}分のタイマー",
		},
		{
			id: "second",
			kind: "toolchain",
			title: "二つ目",
			toolchain: "timers.manage",
			request: "30秒のタイマー",
			uses: ["first"],
		},
	],
	tests: [
		{
			utterance: "5分のタイマーと、続けてもう一つ掛けて",
			inputs: { minutes: 5 },
			stepResults: { first: { summary: "300秒" }, second: { summary: "30秒" } },
			expect: {},
		},
	],
};

/** Vectors that only tell timer talk from anything else: enough to rank a draft among the toolchains. */
const embed = async (texts: string[]) => ({
	vectors: texts.map((t) => (/タイマー/.test(t) ? [1, 0] : [0, 1])),
	space: {
		modelId: "fixture",
		revision: "1",
		artifactDigest: "x",
		dimension: 2,
	},
});

async function setup() {
	const h = await harness({
		timers: true,
		pipelines: true,
		embed,
		firstRound: (tools) =>
			tools.some((t) => t.function.name === "pipeline_timer_pair")
				? {
						name: "pipeline_timer_pair",
						args: {
							kind: "action",
							freshness: "not_live",
							impact: "create",
							approved: false,
							announcement: "掛けます。",
							minutes: 5,
							minutes_quote: "5分",
						},
					}
				: undefined,
	});
	// The registered adapter also checks that the dialogue session is live; these works have no dialogue session.
	const adapter: DomainAdapter = createPipelinesAdapter(
		() => h.toolchain.agents,
		() => h.pipelines,
	);
	const work = await h.store.write((db) =>
		adapter.session!.openInTransaction(db, {
			sessionId: crypto.randomUUID(),
			targetRef: null,
		}),
	);
	const ui = { kind: "ui" as const, scope: "default", actionRequestId: "a" };
	const invoke = (operationName: string, input: unknown) =>
		h.store.write((db) =>
			adapter.invokeInTransaction(db, {
				operationName,
				input,
				requestId: crypto.randomUUID(),
				issuedAt: new Date().toISOString(),
				origin: ui,
			}),
		);
	const studio = () =>
		h.store.read(
			(db) =>
				adapter.sourceInTransaction(db, "query:pipelines.studio@1", undefined)!
					.data as any,
		);
	return { h, adapter, work, invoke, studio };
}

test("the specialist writes the draft by the work document; the screen shows its text, flow and full check by line", async () => {
	const { h, adapter, work, studio } = await setup();
	try {
		const runId = crypto.randomUUID();
		const broken = structuredClone(draft) as any;
		broken.steps[1].toolchain = "timers.gone";
		await h.store.write((db) => {
			adapter.session!.beginTurnInTransaction(db, work.workRef, runId);
			adapter.session!.document!.commitInTransaction(db, work.workRef, {
				baseRevision: 0,
				value: broken,
				origin: {
					kind: "specialist",
					sessionId: "s",
					runId,
					conversationId: "main",
					workRef: work.workRef,
				},
			});
			adapter.session!.endTurnInTransaction(db, work.workRef, runId);
		});
		const shown = studio();
		expect(shown.work.revision).toBe(1);
		expect(shown.work.source).toBe(canonicalText(broken));
		expect(
			shown.work.flow.steps.map((s: any) => [s.id, s.reads, s.inputs]),
		).toEqual([
			["first", [], ["minutes"]],
			["second", ["first"], []],
		]);
		// The full check names the step's toolchain with the line it sits on in the source.
		const issue = shown.work.issues[0];
		expect(issue).toMatchObject({
			pointer: "/steps/1/toolchain",
			rule: "unknown_toolchain",
		});
		expect(shown.work.source.split("\n")[issue.line - 1]).toContain(
			'"toolchain": "timers.gone"',
		);
		// The agent reads the toolchains a step may name and the same findings.
		const state = h.store.read((db) =>
			adapter.session!.stateInTransaction(db, work.workRef),
		)!;
		const current = state.context as {
			toolchains: Array<{ id: string }>;
			issues: unknown[];
		};
		expect(current.toolchains.some((t) => t.id === "timers.manage")).toBe(true);
		expect(current.toolchains.some((t) => t.id.startsWith("pipeline."))).toBe(
			false,
		);
		expect(current.issues).toHaveLength(1);
		expect(state.dirty).toBe(true);
	} finally {
		await h.close();
	}
});

test("a screen edit that fails the format check is kept as the rejected draft; a good one is the next revision and publishes", async () => {
	const { h, work, invoke, studio } = await setup();
	try {
		const rejected = await invoke("pipelines.source.apply", {
			workRef: work.workRef,
			expectedRevision: 0,
			text: "{ not json",
		});
		expect(rejected.receipt).toMatchObject({ state: "rejected", revision: 0 });
		expect(studio().work.rejected.issues).toEqual([
			{ path: "/", rule: "invalid_json" },
		]);
		const applied = await invoke("pipelines.source.apply", {
			workRef: work.workRef,
			expectedRevision: 0,
			text: JSON.stringify(draft),
		});
		expect(applied.receipt).toMatchObject({ state: "drafted", revision: 1 });
		expect(studio().work.rejected).toBeNull();
		expect(studio().work.issues).toEqual([]);
		await expect(
			invoke("pipelines.publish", {
				workRef: work.workRef,
				expectedRevision: 0,
			}),
		).rejects.toThrow("revision_conflict");
		const published = await invoke("pipelines.publish", {
			workRef: work.workRef,
			expectedRevision: 1,
		});
		expect(published.receipt).toMatchObject({
			state: "published",
			toolchainId: "pipeline.timer-pair",
		});
		const shown = studio();
		expect(shown.work.dirty).toBe(false);
		expect(shown.work.published.toolchainRevisionId).toBe(
			"toolchain:pipeline.timer-pair@1",
		);
		expect(shown.history).toEqual([
			{
				toolchainId: "pipeline.timer-pair",
				title: "二つのタイマー",
				toolchainRevisionId: "toolchain:pipeline.timer-pair@1",
			},
		]);
		// A published pipeline is a target a later session may start from.
		const choices = h.store.read((db) =>
			h.toolchain.registry.get(PIPELINES_ADAPTER_REF)!.choicesInTransaction!(
				db,
				"builtin:pipelineTargetRef",
			),
		);
		expect(choices).toEqual([
			{ ref: "pipeline.timer-pair", label: "二つのタイマー" },
		]);
	} finally {
		await h.close();
	}
});

test("trials read the work's draft: the probe ranks it among the toolchains, the selection test runs the first round only", async () => {
	const { h, work, invoke } = await setup();
	try {
		await invoke("pipelines.source.apply", {
			workRef: work.workRef,
			expectedRevision: 0,
			text: JSON.stringify(draft),
		});
		await h.toolchain.refreshVectors();
		const trials = createPipelineTrials({
			store: h.store,
			capabilities: h.toolchain.capabilities,
			routing: h.routing,
			inference: h.inference,
			service: h.pipelines,
			embedPassages: h.toolchain.embedPassages,
		});
		const probe = await trials.probe(
			work.workRef,
			"タイマーを二つ",
			new AbortController().signal,
		);
		expect(probe.ok).toBe(true);
		const ranked = probe as Extract<typeof probe, { candidates: unknown }>;
		const mine = ranked.candidates.find((c) => c.draft)!;
		expect(mine).toMatchObject({
			toolchainId: "pipeline.timer-pair",
			similarity: 1,
		});
		// Tied with the timer toolchain at the top, within what a discovery offers the first round.
		expect(ranked.candidates[0]!.similarity).toBe(1);
		expect(mine.rank).toBeLessThanOrEqual(4);
		expect(ranked.passages[0]).toEqual({
			text: "二つのタイマー: 分のタイマーと、続けて秒のタイマーを掛ける",
			similarity: 1,
		});
		const selection = await trials.select(
			work.workRef,
			"5分のタイマーを掛けて、続けてもう一つタイマーを",
			new AbortController().signal,
		);
		expect(selection).toEqual({
			ok: true,
			chosen: "pipeline_timer_pair",
			matched: true,
			next: "pipeline",
			inputs: { minutes: 5 },
			code: null,
		});
		// Nothing was run.
		expect(
			h.store.read((db) => db.query("SELECT COUNT(*) AS n FROM timers").get()),
		).toEqual({ n: 0 });
		expect(trials.fixture(work.workRef, 0)).toMatchObject({
			ok: true,
			outcome: { passed: true },
		});
	} finally {
		await h.close();
	}
});
