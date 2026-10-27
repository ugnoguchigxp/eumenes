/**
 * The conversation trajectories the prefix-stability metric is measured on (the ContextWindow specification, sections
 * 12.4 and 21.2): several generations of one conversation, materialized on the real services and prepared by the
 * production prepare, with what happens between them (a TODO finishing, a memory step, a notice, a long silence).
 * Fully deterministic: the same code gives the same messages, so a difference between two runs is the code's.
 *
 * Offline evaluation only. Each generation is adopted the way the product's settle leaves the log, so the next one
 * sees the log grow at its end, and the re-constructions the window plan calls for (a resumed conversation, a cache
 * taken as lost, a section over its limit) happen where the product would make them.
 */
import { estimateMessageTokens } from "../../../inference";
import type { GenerateInput } from "../../service/context";
import type { Seed, SeedEvent } from "./case-schema";
import { applySeed, publishStep, saveLongTerm } from "./materialize";
import {
	type EvalCard,
	type Generated,
	type Reply,
	type SeedWiring,
	createSession,
} from "./session";

/** What happens before a generation: the log, a TODO, the memory step. */
type Step = {
	events?: SeedEvent[];
	/** A TODO's owner reports; the TODO must be in the trajectory's seed. */
	work?: Array<{
		key: string;
		report:
			| { status: "waiting"; questionId: string; question: string }
			| {
					status: "done";
					outcome:
						| "succeeded"
						| "partial"
						| "failed"
						| "cancelled"
						| "interrupted";
					result: unknown;
			  };
	}>;
	/** State saved after the profile was published (it waits in `state.newMemories`). */
	longTerm?: NonNullable<Seed["longTerm"]>;
	notice?: string;
};

type TrajectoryTurn = {
	/** Minutes after the start of the conversation. */
	minute: number;
	/** The newest utterance; null: the host's fixed text started it, with `trigger`. */
	utterance: string | null;
	trigger?: Record<string, unknown>;
	before?: Step;
	/** TODOs the generation opened (a delegation): they exist when its actions are logged. */
	startWork?: NonNullable<Seed["work"]>;
	reply?: Reply;
};

export type Trajectory = {
	seed: Seed;
	turns: TrajectoryTurn[];
};

const MINUTE = 60_000;
export const TRAJECTORY_START = "2026-10-13T09:00:00.000Z";
const startMs = Date.parse(TRAJECTORY_START);
const timeOf = (minute: number) =>
	new Date(startMs + minute * MINUTE).toISOString();

const SEARCH_ACTION = (query: string, id: string, title: string) => ({
	action: "find_toolchain",
	query,
	candidates: [{ id, title }],
});

/**
 * Twelve generations. Generation 4 follows a memory step (a new State item); 5 hands work over and 6 is the fixed-text
 * generation the TODO finishing starts; 8 is started by a notice and stays silent; 9 follows a silence over the resume
 * gap (a re-construction, where the profile takes in the waiting item); 11 follows an idle over the cache lifetime.
 */
export const DEFAULT_TRAJECTORY: Trajectory = {
	seed: {
		goals: [{ text: "毎日の夕食を、野菜多めの手作りにする", priority: 50 }],
	},
	turns: [
		{
			minute: 0,
			utterance: "来月の旅行先を決めたい",
			reply: { text: "京都はいかがでしょう。" },
		},
		{
			minute: 1,
			utterance: "京都なら、紅葉の時期は混みますか",
			reply: { text: "十一月後半は特に混みます。" },
		},
		{
			minute: 2,
			utterance: "辛い物が好きなので、食事の候補も知りたい",
			reply: { text: "辛味の効いた料理を出す店を探せます。" },
		},
		{
			minute: 3,
			utterance: "宿は駅の近くがいい",
			before: {
				longTerm: [
					{
						kind: "preference",
						key: "food.spicy",
						text: "辛い物が好き",
						published: false,
					},
				],
			},
			reply: { text: "駅近の宿を前提に考えます。" },
		},
		{
			minute: 4,
			utterance: "旅行先のイメージ画像を作って",
			startWork: [
				{
					key: "image",
					toolchain: "image_studio",
					request: "旅行先のイメージ画像を作る",
					at: timeOf(4.5),
					status: "todo",
				},
			],
			reply: {
				acted: [
					{
						fields: SEARCH_ACTION("画像を作る", "image_studio", "画像制作"),
					},
					{
						fields: {
							action: "delegate",
							toolchain: "image_studio",
							request: "旅行先のイメージ画像を作る",
							todo: "@image",
						},
					},
				],
				text: "画像を作りますね。",
				origin: "announcement",
			},
		},
		{
			minute: 6,
			utterance: null,
			trigger: {
				kind: "todo_changed",
				todos: [{ id: "@image", status: "done" }],
			},
			before: {
				work: [
					{
						key: "image",
						report: {
							status: "done",
							outcome: "succeeded",
							result: {
								asOf: timeOf(5.5),
								claims: [
									{ text: "京都の紅葉を描いた画像ができた", sources: [] },
								],
								limits: "画像は一枚だけ作った",
							},
						},
					},
				],
			},
			reply: {
				acted: [{ fields: { action: "check", todo: "@image" } }],
				text: "画像ができました。",
				origin: "report",
				todoRefs: ["@image"],
			},
		},
		{
			minute: 8,
			utterance: "来週の京都の天気を教えて",
			reply: { text: "お調べしますね。", origin: "announcement" },
		},
		{
			minute: 9,
			utterance: null,
			trigger: { kind: "timer", text: "三分のタイマーが鳴りました" },
		},
		{
			minute: 45,
			utterance: "さっき話した紅葉の時期をもう一度教えて",
			reply: { text: "十一月後半です。" },
		},
		{
			minute: 46,
			utterance: "ありがとう、助かった",
			reply: { text: "どういたしまして。" },
		},
		{
			minute: 56,
			utterance: "宿の予約はまた今度にする",
			reply: { text: "承知しました。" },
		},
		{
			minute: 57,
			utterance: "また明日続きを考えよう",
			reply: { text: "はい、また明日。" },
		},
	],
};

const FILLER =
	"旅程の候補を一つずつ比べながら、行きたい場所と移動の順番を決めていきたいです。";

/**
 * A long run of long exchanges: past the recent conversation's hard limit, the host cuts it to the newest few by its
 * fixed rule.
 */
export const SMALL_WINDOW_TRAJECTORY: Trajectory = {
	seed: { modelWindow: 48_000 },
	turns: Array.from({ length: 20 }, (_, index) => ({
		minute: index * 2,
		utterance: `${index + 1}件目の相談です。${FILLER.repeat(8)}`,
		reply: { text: `${index + 1}件目を承知しました。` },
	})),
};

export const TRAJECTORIES = {
	default: DEFAULT_TRAJECTORY,
	smallWindow: SMALL_WINDOW_TRAJECTORY,
} as const;
export type TrajectoryName = keyof typeof TRAJECTORIES;

export type TrajectoryCall = {
	/** `g<n>`: stable label of the generation. */
	label: string;
	input: GenerateInput;
	/** The cut this generation's prepare moved, if it did. */
	cut: Generated["cut"];
};

/**
 * Plays the trajectory on a fresh store and returns every generation, in order. The caller closes the wiring
 * afterwards.
 */
export async function playTrajectory(
	wiring: SeedWiring,
	trajectory: Trajectory,
	options: { catalog?: readonly EvalCard[] } = {},
): Promise<TrajectoryCall[]> {
	const session = createSession(wiring, options);
	await applySeed(session, trajectory.seed, TRAJECTORY_START);
	const calls: TrajectoryCall[] = [];
	for (const [index, turn] of trajectory.turns.entries()) {
		const at = timeOf(turn.minute);
		wiring.setNow(at);
		const before = turn.before;
		if (before?.events) await session.appendEvents(before.events);
		for (const change of before?.work ?? [])
			await session.reportWork(change.key, at, change.report);
		if (before?.longTerm) await saveLongTerm(session, before.longTerm, at);
		if (before?.notice || before?.longTerm)
			await publishStep(
				session,
				{
					notices: before.notice ? [before.notice] : [],
					// The memory step that saved State asks for the profile to take it in at the next re-construction.
					requestRepublish: !!before.longTerm,
				},
				at,
			);
		const generated = await session.generate({
			at,
			utterance: turn.utterance,
			...(turn.trigger
				? { trigger: session.resolve(turn.trigger) as Record<string, unknown> }
				: {}),
		});
		calls.push({
			label: `g${index + 1}`,
			input: generated.input,
			cut: generated.cut,
		});
		for (const work of turn.startWork ?? []) await session.addWork(work);
		await session.settle(generated, turn.reply);
	}
	return calls;
}

/** The estimated tokens of a call's input (for reports). */
export const documentTokens = (call: TrajectoryCall) =>
	estimateMessageTokens(call.input.messages);
