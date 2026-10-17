/**
 * The conversation trajectory the prefix-stability metric is measured on (ContextWindow design section 7.2): ten
 * turns of one conversation, materialized on the real services, with the calls a turn makes. It includes memory
 * steps (a kept exchange, a long-term item, a summary, a notice, a recalled exchange), an operation result,
 * a research success and a research failure, and a selection call. Fully deterministic: the same code gives the
 * same assemblies, so a difference between arms is the format's.
 *
 * Offline evaluation only. The calls are returned as product assemblies; an arm renders each of them.
 */
import { estimateTextTokens } from "../../../inference";
import { type RecalledEntry, renderRecallBlock } from "../../../memory";
import type { Run } from "../../contracts";
import { insert } from "../../repository";
import { renderGoalsLayer } from "../../service/goals-layer";
import type { ContextAssembly } from "../../service/context-assembly";
import { compileAssembly } from "../../service/context-compiler";
import type { Seed } from "./case-schema";
import {
	CONVERSATION_ID,
	type SeedWiring,
	type VolatileSeed,
	assembleVolatile,
	dispose,
	runRow,
} from "./materialize";
import { recallMinute } from "./recall-text";

/** What a call adds to the turn's volatile part. A plain `initial` call adds nothing. */
type TrajectoryCall = {
	kind: "initial" | "selection" | "result";
	seed?: VolatileSeed;
};

/** The memory step after a turn's answer: what the steward and the curator publish for the next turn. */
type MemoryStep = {
	/** Turns (1-based) the ledger keeps verbatim from now on. */
	keep?: number[];
	/** A summary written over these turns, which then leave the verbatim history. */
	summary?: { text: string; turns: number[] };
	/** Long-term items saved by this step. */
	longTerm?: NonNullable<Seed["longTerm"]>;
	/** A one-time notice for the next turn. */
	notice?: string;
	/** Earlier exchanges recalled for the next turn (the prefetch). */
	recall?: RecalledEntry[];
};

type TrajectoryTurn = {
	user: string;
	assistant: string;
	calls: TrajectoryCall[];
	after?: MemoryStep;
};

export type Trajectory = {
	/** Goals shown in P for the whole conversation. */
	goals: string[];
	turns: TrajectoryTurn[];
};

const TURN_MINUTE = 60_000;
const START_MS = Date.parse("2026-10-13T09:00:00.000Z");
const turnTime = (n: number) =>
	new Date(START_MS + n * 5 * TURN_MINUTE).toISOString();

const IMAGE_RESULT = {
	id: "4c1d0b52-7a53-4a1e-9b61-0d2f5e3a8c11",
	runId: "r5",
	conversationId: CONVERSATION_ID,
	state: "completed",
	action: "generate",
	title: "夕焼けの海",
	description: "夕方の海岸線と、オレンジ色の空",
	prompt: null,
	width: 1024,
	height: 768,
	format: "png",
	seed: null,
	phase: "completed",
	artifactId: "artifact-1",
	mime: "image/png",
	actualModel: null,
	errorCode: null,
	createdAt: 1_760_000_000_000,
	updatedAt: 1_760_000_060_000,
};

const RECOGNITION_RESULT = {
	action: "read",
	id: "7d0e5f6a-2b1c-4d3e-8f9a-0b1c2d3e4f5a",
	conversationId: CONVERSATION_ID,
	name: "desk.png",
	mime: "image/png",
	state: "completed",
	revision: 3,
	progress: null,
	errorCode: null,
	result: {
		kind: "image",
		model: "eval-detector",
		width: 800,
		height: 600,
		objects: [
			{
				classId: 41,
				label: "マグカップ",
				confidence: 0.91,
				box: [120, 80, 260, 210],
			},
			{
				classId: 63,
				label: "ノートパソコン",
				confidence: 0.88,
				box: [300, 40, 760, 380],
			},
		],
	},
	createdAt: 1_760_000_100_000,
	updatedAt: 1_760_000_160_000,
};

const RESEARCH_REPORT = {
	summary: "来週の京都は晴れの日が多い見込みです。",
	claims: [{ text: "来週前半は晴れ", sourceIds: ["s1"] }],
	sources: [{ id: "s1", kind: "web", url: "https://example.test/weather" }],
};

/**
 * Ten turns. Turn 4 has a selection call, 5 an operation result, 6 a research success, 7 a research failure,
 * 10 an operation result of another kind. The memory steps put a kept exchange and a long-term item in (after 3),
 * a summary and a notice (after 6) and a recalled exchange (after 8).
 */
export const DEFAULT_TRAJECTORY: Trajectory = {
	goals: ["毎日の夕食を、野菜多めの手作りにする"],
	turns: [
		{
			user: "来月の旅行先を決めたい",
			assistant: "京都はいかがでしょう。",
			calls: [{ kind: "initial" }],
		},
		{
			user: "京都なら、紅葉の時期は混みますか",
			assistant: "十一月後半は特に混みます。",
			calls: [{ kind: "initial" }],
		},
		{
			user: "辛い物が好きなので、食事の候補も知りたい",
			assistant: "辛味の効いた料理を出す店を探せます。",
			calls: [{ kind: "initial" }],
			after: {
				keep: [1],
				longTerm: [
					{ kind: "preference", key: "food.spicy", text: "辛い物が好き" },
				],
			},
		},
		{
			user: "宿は駅の近くがいい",
			assistant: "駅近の宿を前提に考えます。",
			calls: [
				{
					kind: "initial",
					seed: { world: [{ name: "京都駅前のホテル" }] },
				},
				{ kind: "selection" },
			],
		},
		{
			user: "旅行先のイメージ画像を作って",
			assistant: "画像ができました。",
			calls: [
				{ kind: "initial" },
				{
					kind: "result",
					seed: { operation: { kind: "image", result: IMAGE_RESULT } },
				},
			],
		},
		{
			user: "来週の京都の天気を調べて",
			assistant: "来週前半は晴れの見込みです。",
			calls: [
				{ kind: "initial" },
				{
					kind: "result",
					seed: { research: { projection: RESEARCH_REPORT } },
				},
			],
			after: {
				summary: {
					text: "旅行先は京都。紅葉の時期の混雑と、辛い料理の希望を話した。",
					turns: [2, 3],
				},
				notice: "先ほどの旅行の希望は、長期記憶への保存が完了していません。",
			},
		},
		{
			user: "京都の来月の祭りの日程も調べて",
			assistant: "調査が完了しなかったため、日程は確認できませんでした。",
			calls: [
				{ kind: "initial" },
				{
					kind: "result",
					seed: { research: { failureCode: "research_unavailable" } },
				},
			],
		},
		{
			user: "宿の予約はまた今度にする",
			assistant: "承知しました。",
			calls: [{ kind: "initial" }],
			after: {
				recall: [
					{
						at: recallMinute(turnTime(2)),
						user: "京都なら、紅葉の時期は混みますか",
						assistant: "十一月後半は特に混みます。",
					},
				],
			},
		},
		{
			user: "さっき話した紅葉の時期をもう一度教えて",
			assistant: "十一月後半です。",
			calls: [{ kind: "initial" }],
		},
		{
			user: "机の上の写真を見てもらえる？",
			assistant: "マグカップとノートパソコンが見えます。",
			calls: [
				{ kind: "initial" },
				{
					kind: "result",
					seed: {
						operation: { kind: "recognition", result: RECOGNITION_RESULT },
					},
				},
			],
		},
	],
};

export type TrajectoryCallAssembly = {
	/** `t<turn>-<kind>`: stable label of the call. */
	label: string;
	turn: number;
	kind: TrajectoryCall["kind"];
	assembly: ContextAssembly;
};

async function runMemoryStep(
	wiring: SeedWiring,
	step: MemoryStep,
	inputs: Map<number, string>,
	nextSummaryRevision: () => number,
) {
	const { store, memory } = wiring;
	for (const n of step.keep ?? [])
		await dispose(wiring, inputs.get(n)!, "keep");
	for (const item of step.longTerm ?? [])
		await wiring.saveItem({
			conversationId: CONVERSATION_ID,
			messageId: "seed-source",
			quote: null,
			kind: item.kind,
			semanticKey: item.key,
			text: item.text,
		});
	if (step.summary) {
		const covered = step.summary.turns.map((n) => inputs.get(n)!);
		const written = await store.write((db) =>
			memory.writeSummaryInTransaction(db, {
				conversationId: CONVERSATION_ID,
				text: step.summary!.text,
				included: covered,
				expectedRevision: nextSummaryRevision(),
			}),
		);
		if (!written.ok)
			throw new Error(`trajectory_summary_rejected:${written.reason}`);
	}
	const recalled = (step.recall ?? []).map((entry) => ({ ...entry }));
	const recallText = recalled.length ? renderRecallBlock(recalled) : "";
	// A step replaces the prefetch; an empty one clears the previous.
	await store.write((db) =>
		memory.publishWindowInTransaction(db, CONVERSATION_ID, {
			republishLongTerm: (step.longTerm?.length ?? 0) > 0,
			prefetch: {
				text: recallText,
				pins: [],
				tokens: estimateTextTokens(recallText),
			},
			...(step.notice ? { addNotices: [step.notice] } : {}),
		}),
	);
}

/**
 * Plays the trajectory on a fresh store and returns the assembly of every call, in order. The caller closes the
 * wiring afterwards.
 */
export async function materializeTrajectory(
	wiring: SeedWiring,
	trajectory: Trajectory = DEFAULT_TRAJECTORY,
): Promise<TrajectoryCallAssembly[]> {
	const { store, conversation, memory } = wiring;
	wiring.setNow(turnTime(0));
	await store.write((db) =>
		conversation.appendInTransaction(db, {
			id: "seed-source",
			conversationId: CONVERSATION_ID,
			role: "user",
			text: "覚えておいてください",
			createdAt: turnTime(0),
			runId: null,
		}),
	);
	await store.write((db) =>
		memory.publishWindowInTransaction(db, CONVERSATION_ID, {
			republishLongTerm: true,
		}),
	);
	const goals = renderGoalsLayer(
		trajectory.goals.map((text, index) => ({
			goalId: `goal-${index + 1}`,
			priority: 50,
			desiredState: text,
			revision: 1,
		})),
	)?.block;
	const inputs = new Map<number, string>();
	let summaryRevision = 0;
	const calls: TrajectoryCallAssembly[] = [];
	for (const [index, turn] of trajectory.turns.entries()) {
		const n = index + 1;
		const at = turnTime(n);
		wiring.setNow(at);
		const run = {
			id: `r${n}`,
			conversationId: CONVERSATION_ID,
			inputMessageId: `u${n}`,
		} as Run;
		await store.write((db) => {
			conversation.appendInTransaction(db, {
				id: `u${n}`,
				conversationId: CONVERSATION_ID,
				role: "user",
				text: turn.user,
				createdAt: at,
				runId: run.id,
			});
			insert(db, runRow(run.id, n, at, false));
		});
		inputs.set(n, `u${n}`);
		for (const call of turn.calls) {
			const compiled = await store.write((db) =>
				compileAssembly(
					db,
					run,
					conversation,
					{ agentName: "", userName: "", persona: "butler" },
					memory.windowForRunInTransaction(db, CONVERSATION_ID),
					memory,
					goals,
				),
			);
			const assembly = assembleVolatile(
				compiled.assembly,
				call.seed ?? {},
				Date.parse(at),
			);
			calls.push({
				label: `t${n}-${call.kind}`,
				turn: n,
				kind: call.kind,
				assembly:
					call.kind === "selection"
						? { ...assembly, stage: "selection" }
						: assembly,
			});
		}
		await store.write((db) => {
			conversation.appendInTransaction(db, {
				id: `a${n}`,
				conversationId: CONVERSATION_ID,
				role: "assistant",
				text: turn.assistant,
				createdAt: at,
				runId: run.id,
			});
			db.query(
				"UPDATE dialogue_runs SET status='completed', answer_message_id=? WHERE id=?",
			).run(`a${n}`, run.id);
			memory.recordExchangeInTransaction(db, {
				conversationId: CONVERSATION_ID,
				runId: run.id,
				inputMessageId: `u${n}`,
				answerMessageId: `a${n}`,
				outcome: "answered",
			});
		});
		if (turn.after)
			await runMemoryStep(wiring, turn.after, inputs, () => summaryRevision++);
	}
	return calls;
}
