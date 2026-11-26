import { describe, expect, test } from "bun:test";
import { withDrafts } from "../../../scripts/nl-acceptance/drafts";
import { loadFrozen } from "../../../scripts/nl-acceptance/frozen";
import { createHostReader } from "../../../scripts/nl-acceptance/host";
import { judge } from "../../../scripts/nl-acceptance/judge";
import type {
	HostKanbanCard,
	HostKanbanRun,
	HostMessage,
	HostSnapshot,
	HostTimer,
	RunEvidence,
} from "../../../scripts/nl-acceptance/types";

const frozen = loadFrozen().set!;
const runnable = withDrafts(frozen);
const TIMER_CASE = "timer-question-continuation-01";
const KANBAN_CASE = "kanban-conversation-ambiguous-target-01";
const criteriaOf = (caseId: string) =>
	runnable.set.criteria.get(runnable.set.cases.get(caseId)!.criteriaRef)!;

describe("unfrozen drafts", () => {
	test("the two question cases are runnable and outside the frozen set", () => {
		expect([...runnable.draftCaseIds].sort()).toEqual([
			KANBAN_CASE,
			TIMER_CASE,
		]);
		expect(frozen.cases.has(TIMER_CASE)).toBe(false);
		expect(frozen.cases.has(KANBAN_CASE)).toBe(false);
		expect(
			Object.keys(frozen.digests).some((f) => f.startsWith("drafts/")),
		).toBe(false);
		expect(Object.keys(runnable.set.digests)).toContain(
			`drafts/timer/cases/${TIMER_CASE}.json`,
		);
		expect(runnable.set.pilot).toEqual(frozen.pilot);
	});

	test("drafts that need other flows stay listed as not runnable", () => {
		const skipped = runnable.skipped.map((s) => s.caseId);
		expect(skipped).toContain("kanban-conversation-run-01");
		expect(skipped).not.toContain(KANBAN_CASE);
		for (const s of runnable.skipped) expect(s.reason).not.toBe("");
	});

	test("the criteria no longer name the removed interaction reads or checks", () => {
		for (const id of [TIMER_CASE, KANBAN_CASE]) {
			const text = JSON.stringify(criteriaOf(id));
			expect(text).not.toMatch(/interaction|waiting_input|receiptRef/);
		}
	});
});

const T0 = 1_700_000_000_000;
const msg = (
	id: string,
	role: HostMessage["role"],
	text: string,
): HostMessage => ({
	id,
	role,
	text,
	createdAt: new Date(T0).toISOString(),
});
const timer = (id: string, durationSeconds = 180): HostTimer => ({
	id,
	revision: 0,
	state: "active",
	label: "タイマー",
	durationSeconds,
	dueAt: new Date(T0 + 200_000).toISOString(),
	remainingSeconds: durationSeconds,
	originRunId: "run-1",
});
type Frame = {
	messages: HostMessage[];
	timers?: HostTimer[];
	cards?: HostKanbanCard[];
	runs?: HostKanbanRun[];
};
function evidence(caseId: string, frames: Frame[]): RunEvidence {
	const hostSeries: HostSnapshot[] = frames.map((f, i) => ({
		seq: i + 1,
		atMs: T0 + i * 1000,
		serverNowMs: T0 + i * 1000,
		timers: f.timers ?? [],
		messages: f.messages,
		...(f.cards ? { kanban: { cards: f.cards, runs: f.runs ?? [] } } : {}),
	}));
	return {
		caseId,
		hostSeries,
		receipts: [],
		screens: [{ seq: 1, atMs: T0, text: "チャット" }],
		reloads: [],
		faultsTriggered: [],
		termination: { reason: "done" },
	};
}
const byId = (r: ReturnType<typeof judge>, id: string) =>
	r.criteria.find((c) => c.id === id)!;

const ask = msg("m1", "user", "タイマーを開始して");
const question = msg("m2", "assistant", "何分のタイマーにしますか？");
const answer = msg("m3", "user", "3分");
const report = msg("m4", "assistant", "3分のタイマーを開始しました。");
function timerRun(overrides: Partial<{ frames: Frame[] }> = {}): RunEvidence {
	return evidence(
		TIMER_CASE,
		overrides.frames ?? [
			{ messages: [] },
			{ messages: [ask] },
			{ messages: [ask, question] },
			{ messages: [ask, question, answer] },
			{ messages: [ask, question, answer, report], timers: [timer("t1")] },
		],
	);
}

describe("timer-question-continuation-01 under the assignment flow", () => {
	const criteria = criteriaOf(TIMER_CASE);

	test("a question, its answer, then one 180 s timer is a success", () => {
		const r = judge(criteria, timerRun());
		expect(r.criteria.map((c) => `${c.id}:${c.status}:${c.code}`)).toEqual([
			"C1:met:new_timers_match",
			"C2:met:question_answered_then_result",
			"C3:met:no_extra_side_effects",
		]);
		expect(r.verdict).toBe("success");
	});

	test("a timer made without asking is not a pass", () => {
		const r = judge(
			criteria,
			timerRun({
				frames: [
					{ messages: [] },
					{ messages: [ask] },
					{ messages: [ask, report], timers: [timer("t1")] },
				],
			}),
		);
		expect(byId(r, "C2")).toMatchObject({
			status: "unmet",
			code: "no_question_shown",
		});
		expect(r.verdict).toBe("failure");
	});

	test("a result that is there before the answer did not wait for it", () => {
		const r = judge(
			criteria,
			timerRun({
				frames: [
					{ messages: [] },
					{ messages: [ask, question], timers: [timer("t1")] },
					{ messages: [ask, question, answer], timers: [timer("t1")] },
				],
			}),
		);
		expect(byId(r, "C2")).toMatchObject({
			status: "violated",
			code: "result_before_answer",
		});
	});

	test("more than three questions, or a second timer, is a violation", () => {
		const q = (n: number) => msg(`q${n}`, "assistant", `確認${n}ですか？`);
		const a = (n: number) => msg(`a${n}`, "user", `答え${n}`);
		const chat = [ask, q(1), a(1), q(2), a(2), q(3), a(3), q(4), a(4)];
		const many = judge(
			criteria,
			timerRun({
				frames: [
					{ messages: [] },
					{ messages: chat },
					{ messages: [...chat, report], timers: [timer("t1")] },
				],
			}),
		);
		expect(byId(many, "C2")).toMatchObject({
			status: "violated",
			code: "too_many_questions",
		});
		const twice = judge(
			criteria,
			timerRun({
				frames: [
					{ messages: [] },
					{ messages: [ask, question, answer] },
					{
						messages: [ask, question, answer, report],
						timers: [timer("t1"), timer("t2")],
					},
				],
			}),
		);
		expect(byId(twice, "C1")).toMatchObject({
			status: "violated",
			code: "extra_timers",
		});
	});

	test("an unanswered question leaves the run unmet", () => {
		const r = judge(
			criteria,
			timerRun({
				frames: [{ messages: [] }, { messages: [ask, question] }],
			}),
		);
		expect(byId(r, "C2")).toMatchObject({
			status: "unmet",
			code: "question_unanswered",
		});
	});

	test("a wrong duration is caught as before", () => {
		const r = judge(
			criteria,
			timerRun({
				frames: [
					{ messages: [] },
					{ messages: [ask, question, answer], timers: [] },
					{
						messages: [ask, question, answer, report],
						timers: [timer("t1", 180 * 60)],
					},
				],
			}),
		);
		expect(byId(r, "C1").code).toBe("wrong_duration");
	});
});

const card = (
	id: string,
	title: string,
	column: HostKanbanCard["column"],
	revision = 1,
): HostKanbanCard => ({ id, title, column, revision });
const run = (id: string, cardId: string): HostKanbanRun => ({
	id,
	cardId,
	kind: "task",
	state: "handed",
	origin: "conversation",
});
const readme = (column: HostKanbanCard["column"] = "todo", revision = 1) =>
	card("c1", "README の手順修正", column, revision);
const login = (column: HostKanbanCard["column"] = "todo", revision = 1) =>
	card("c2", "ログイン画面のバグ修正", column, revision);
const kAsk = msg("k1", "user", "あのタスクを実行して");
const kQuestion = msg(
	"k2",
	"assistant",
	"どのタスクですか？「README の手順修正」と「ログイン画面のバグ修正」があります。",
);
const kAnswer = msg("k3", "user", "ログイン画面のバグ修正");
const kDone = msg(
	"k4",
	"assistant",
	"ログイン画面のバグ修正を実行に回しました。",
);

function kanbanRun(after: Frame): RunEvidence {
	const board = [readme(), login()];
	return evidence(KANBAN_CASE, [
		{ messages: [], cards: board },
		{ messages: [kAsk], cards: board },
		{ messages: [kAsk, kQuestion], cards: board },
		{ messages: [kAsk, kQuestion, kAnswer], cards: board },
		after,
	]);
}

describe("kanban-conversation-ambiguous-target-01 under the assignment flow", () => {
	const criteria = criteriaOf(KANBAN_CASE);
	const messages = [kAsk, kQuestion, kAnswer, kDone];

	test("the chosen card runs once after the answer: success", () => {
		const r = judge(
			criteria,
			kanbanRun({
				messages,
				cards: [readme(), login("running", 2)],
				runs: [run("r1", "c2")],
			}),
		);
		expect(r.criteria.map((c) => `${c.id}:${c.status}:${c.code}`)).toEqual([
			"C1:met:question_answered_then_result",
			"C2:met:question_offers_labels",
			"C3:met:cards_match",
			"C4:met:no_extra_changes",
		]);
		expect(r.verdict).toBe("success");
	});

	test("running the other card is a violation", () => {
		const r = judge(
			criteria,
			kanbanRun({
				messages,
				cards: [readme("running", 2), login()],
				runs: [run("r1", "c1")],
			}),
		);
		expect(byId(r, "C3").status).toBe("violated");
		expect(byId(r, "C4")).toMatchObject({ code: "other_card_modified" });
		expect(r.verdict).toBe("failure");
	});

	test("two runs, or no run, is caught", () => {
		const two = judge(
			criteria,
			kanbanRun({
				messages,
				cards: [readme(), login("running", 2)],
				runs: [run("r1", "c2"), run("r2", "c2")],
			}),
		);
		expect(byId(two, "C4")).toMatchObject({
			status: "violated",
			code: "extra_runs",
		});
		const none = judge(
			criteria,
			kanbanRun({ messages, cards: [readme(), login()] }),
		);
		expect(byId(none, "C1")).toMatchObject({
			status: "unmet",
			code: "no_result_after_answer",
		});
		expect(byId(none, "C3")).toMatchObject({
			status: "unmet",
			code: "card_not_moved",
		});
	});

	test("a question that names no card does not help the user choose", () => {
		const vague = msg("k2", "assistant", "どのタスクですか？");
		const board = [readme(), login()];
		const r = judge(
			criteria,
			evidence(KANBAN_CASE, [
				{ messages: [], cards: board },
				{ messages: [kAsk, vague, kAnswer], cards: board },
				{
					messages: [kAsk, vague, kAnswer, kDone],
					cards: [readme(), login("running", 2)],
					runs: [run("r1", "c2")],
				},
			]),
		);
		expect(byId(r, "C2")).toMatchObject({
			status: "unmet",
			code: "question_misses_labels",
		});
	});
});

describe("the host reader reads the conversation and the board", () => {
	function reader(paths: string[]) {
		return createHostReader({
			baseUrl: "http://host.test",
			fetchImpl: (async (url: URL | string) => {
				const path = new URL(String(url)).pathname;
				paths.push(path);
				if (path === "/api/conversations/main")
					return Response.json({
						id: "main",
						messages: [
							{
								id: "m1",
								role: "user",
								text: "x".repeat(5000),
								createdAt: "2026-11-26T00:00:00Z",
								runId: null,
							},
						],
					});
				if (path === "/api/toolchain-artifacts")
					return Response.json({
						artifacts: [
							{ artifactRevisionId: "artifact:kanban.board@2" },
							{ artifactRevisionId: "artifact:kanban.board@10" },
							{ artifactRevisionId: "artifact:timer@1" },
						],
					});
				return Response.json({
					revision: 3,
					data: {
						cards: [
							{
								id: "c1",
								title: "A",
								column: "todo",
								revision: 1,
								prompt: "p",
							},
						],
						runs: [
							{
								id: "r1",
								cardId: "c1",
								kind: "task",
								state: "handed",
								origin: "conversation",
							},
						],
					},
				});
			}) as unknown as typeof fetch,
		});
	}

	test("snapshots carry the cut messages and the board of the newest artifact", async () => {
		const paths: string[] = [];
		const snap = await reader(paths).snapshot(1, ["conversation", "kanban"]);
		expect(snap.messages?.[0]?.text).toHaveLength(2000);
		expect(snap.kanban).toEqual({
			cards: [{ id: "c1", title: "A", column: "todo", revision: 1 }],
			runs: [
				{
					id: "r1",
					cardId: "c1",
					kind: "task",
					state: "handed",
					origin: "conversation",
				},
			],
		});
		expect(paths).toContain(
			"/api/toolchain-artifacts/artifact%3Akanban.board%4010/sources/kanban",
		);
		expect(snap.timers).toEqual([]);
	});

	test("only those reads are allowed, and the readonly list still refuses the rest", async () => {
		const host = reader([]);
		await expect(host.get("/api/conversations/other")).rejects.toThrow(
			"host_read_not_allowed",
		);
		await expect(host.get("/api/toolchain-interactions")).rejects.toThrow(
			"host_read_not_allowed",
		);
	});
});
