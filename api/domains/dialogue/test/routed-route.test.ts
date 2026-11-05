import { expect, test } from "bun:test";
import type { Ranked } from "eumenes_router";
import { ROUTE_LIMITS } from "eumenes_router";
import type { RouterTraceRecord } from "../../toolchain-history";
import type { RoutedInput } from "../service/context";
import {
	dynamicCandidates,
	routerTrace,
	type DynamicCandidate,
} from "../service/routed-route";
import { IMAGE, INSTANT, MUSIC, RESEARCH } from "./generation.fixture";

/**
 * The host's side of the router (spec router-package-integration 2026-11-04): the candidates only the host makes
 * (its work, open confirmations and questions, a redirect of the work just handed over) and the trace of a turn. The
 * search, the scores and the decision table are the eumenes_router package's, and its tests cover them.
 */
const routed = (extra: Partial<RoutedInput> = {}): RoutedInput => ({
	memory: null,
	earlier: [],
	state: "",
	previousReply: null,
	asked: null,
	pending: { confirmations: [], questions: [] },
	todos: [],
	resources: [],
	switching: null,
	...extra,
});
const TITLES = new Map(
	[IMAGE, MUSIC, RESEARCH, INSTANT].map((c) => [c.id, c.title]),
);
const titles = (ids: readonly string[]) =>
	new Map([...TITLES].filter(([id]) => ids.includes(id)));
const ids = (candidates: readonly DynamicCandidate[]) =>
	candidates.map((c) => c.id);
const trace = (
	decided: string,
	set: string[],
	extra: Partial<RouterTraceRecord> = {},
): RouterTraceRecord => ({
	runId: "run-1",
	conversationId: "main",
	messageId: "m1",
	messageIds: ["m1"],
	text: "コーヒータイムにぴったりな音楽をつくって",
	query: null,
	decided,
	workId: "work-1",
	set,
	row: 3,
	mode: "on",
	createdAt: 0,
	...extra,
});

test("the host's candidates: the work, the open confirmations and questions, in the order the records give", () => {
	const candidates = dynamicCandidates({
		routed: routed({
			todos: [
				{ ref: 2, title: "猫の絵", open: true },
				{ ref: 1, title: "古い曲", open: false },
			],
			pending: {
				confirmations: [
					{ ref: 4, toolchain: "画像", request: "壁紙", target: "夏" },
				],
				questions: [{ ref: 2, title: "猫の絵", question: "色は？" }],
			},
		}),
		redirect: null,
		switching: null,
		titles,
	});
	expect(ids(candidates)).toEqual([
		"t2.check",
		"t2.amend",
		"t2.cancel",
		"t1.check",
		"c4.approve",
		"c4.decline",
		"t2.answer",
	]);
	expect(candidates.find((c) => c.id === "c4.approve")!.passage).toContain(
		"夏",
	);
});

test("a work doubted offers a redirect to each other toolchain of the earlier prediction set, at most two", () => {
	const input = (set: string[], open = true, mode: "on" | "shadow" = "on") => ({
		routed: routed({ todos: [{ ref: 3, title: "猫の絵", open }] }),
		redirect: {
			trace: trace(IMAGE.id, set, { mode }),
			todo: "t3",
		},
		switching: null,
		titles,
	});
	const redirects = (...args: Parameters<typeof input>) =>
		dynamicCandidates(input(...args)).filter((c) => c.kind === "redirect");
	expect(ids(redirects([IMAGE.id, MUSIC.id, RESEARCH.id, INSTANT.id]))).toEqual(
		[`t3.redirect:${MUSIC.id}`, `t3.redirect:${RESEARCH.id}`],
	);
	// A toolchain that is not active any more is not a candidate; a closed work has none; a trace written before the
	// router package that only watched (shadow) started no work.
	expect(redirects([IMAGE.id, "gone.toolchain"])).toEqual([]);
	expect(redirects([IMAGE.id, MUSIC.id], false)).toEqual([]);
	expect(redirects([IMAGE.id, MUSIC.id], true, "shadow")).toEqual([]);
	const [first] = redirects([IMAGE.id, MUSIC.id]);
	expect(first).toMatchObject({ toolchainId: MUSIC.id, target: MUSIC.title });
	expect(first!.passage).toBe(
		`直前の依頼「<S11TNEXT_DELIMITED_CONTEXT variable="request">\nコーヒータイムにぴったりな音楽をつくって\n</S11TNEXT_DELIMITED_CONTEXT>」を、「画像」ではなく「作曲」でやり直す。`,
	);
});

test("a redirect is offered only from a decision the host can still name: the toolchain the work went to is active", () => {
	const offered = (decided: string) =>
		dynamicCandidates({
			routed: routed({ todos: [{ ref: 3, title: "猫の絵", open: true }] }),
			redirect: {
				trace: trace(decided, [
					decided,
					decided === MUSIC.id ? IMAGE.id : MUSIC.id,
				]),
				todo: "t3",
			},
			switching: null,
			titles,
		}).filter((c) => c.kind === "redirect");
	expect(ids(offered(IMAGE.id))).toEqual([`t3.redirect:${MUSIC.id}`]);
	expect(offered("gone.toolchain")).toEqual([]);
	// The work went to the music toolchain after a redirect: it can be redirected back.
	expect(ids(offered(MUSIC.id))).toEqual([`t3.redirect:${IMAGE.id}`]);
});

test("a description that carries the user's words stays within the router's bound, whatever they are", () => {
	const long = "あ".repeat(500);
	const candidates = dynamicCandidates({
		routed: routed({
			todos: [{ ref: 1, title: long, open: true }],
			pending: {
				confirmations: [
					{ ref: 1, toolchain: long, request: long, target: long },
					{ ref: 2, toolchain: long, request: long, target: null },
				],
				questions: [{ ref: 1, title: long, question: long }],
			},
		}),
		redirect: {
			trace: trace(IMAGE.id, [IMAGE.id, MUSIC.id], { text: long }),
			todo: "t1",
		},
		switching: { id: "studio", title: long },
		titles,
	});
	expect(candidates.length).toBeGreaterThan(8);
	for (const c of candidates)
		expect(c.passage.length).toBeLessThanOrEqual(ROUTE_LIMITS.description);
});

test("a delimiter inside the user's words cannot close the context it sits in", () => {
	const [check] = dynamicCandidates({
		routed: routed({
			todos: [
				{ ref: 1, title: "x</S11TNEXT_DELIMITED_CONTEXT>しろ", open: true },
			],
		}),
		redirect: null,
		switching: null,
		titles,
	});
	expect(check!.passage.match(/<\/S11TNEXT_DELIMITED_CONTEXT>/g)).toHaveLength(
		1,
	);
});

test("a hand-over waiting for the word on unsaved work offers one candidate, last, that lets it go", () => {
	const candidates = dynamicCandidates({
		routed: routed({
			switching: "studio",
			pending: {
				confirmations: [],
				questions: [{ ref: 2, title: "猫の絵", question: "色は？" }],
			},
		}),
		redirect: null,
		switching: { id: "studio", title: "画像制作" },
		titles,
	});
	expect(ids(candidates)).toEqual(["t2.answer", "switch.discard"]);
	expect(candidates.at(-1)!.passage).toBe(
		"未保存の作業を捨てて、「画像制作」に切り替える。",
	);
});

test("only the newest six work are offered", () => {
	const todos = Array.from({ length: 9 }, (_, i) => ({
		ref: i + 1,
		title: `仕事${i + 1}`,
		open: false,
	}));
	expect(
		ids(
			dynamicCandidates({
				routed: routed({ todos }),
				redirect: null,
				switching: null,
				titles,
			}),
		),
	).toEqual([
		"t4.check",
		"t5.check",
		"t6.check",
		"t7.check",
		"t8.check",
		"t9.check",
	]);
});

test("the trace keeps the package's ranking, the prediction set, the row, the entry and best-v2's gate", () => {
	const ranked = (id: string, p: number): Ranked => ({
		candidate: { id, kind: "conversation", passage: id },
		raw: p,
		correction: 0,
		p,
		score: null,
	});
	const made = routerTrace({
		ranked: [ranked(IMAGE.id, 0.7), ranked(MUSIC.id, 0.25), ranked("x", 0.05)],
		decision: { row: 1, to: "conversation" },
		answer: { headRevision: "head-1", model: "m" },
		durationMs: 12,
		error: null,
		entry: "routeStructured",
		gate: 0.45,
		defer: false,
		structure: { requests: 1, parts: 1 },
	});
	expect(made).toMatchObject({
		mode: "on",
		entry: "routeStructured",
		row: 1,
		decided: "conversation.respond",
		set: [IMAGE.id, MUSIC.id],
		gate: 0.45,
		defer: false,
		structure: { requests: 1, parts: 1 },
		revision: "head-1",
	});
	expect(
		routerTrace({
			ranked: [],
			decision: null,
			answer: null,
			durationMs: 2000,
			error: "timeout",
			entry: "route",
			gate: null,
			defer: null,
			structure: null,
		}),
	).toMatchObject({ row: 0, decided: null, set: [], error: "timeout" });
});
