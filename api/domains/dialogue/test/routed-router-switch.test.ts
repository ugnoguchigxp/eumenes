import { afterEach, expect, test } from "bun:test";
import type {
	RouteAnswer,
	RouteFieldsAnswer,
	RouteFieldsInput,
	RouteInput,
} from "../../inference/contracts";
import { OTHER_REVISION, setup, type Harness } from "./specialist.fixture";

/**
 * The router and a hand-over that waits for the user's word on unsaved work (spec toolchain-router-redesign 2026-11-01
 * §3.2): the word that lets the work go is a candidate of its own, and above the approval line it hands the waiting
 * request over again with that word.
 */
const open: Harness[] = [];
afterEach(async () => {
	for (const h of open.splice(0)) await h.close();
});

const ROUTER = {
	mode: "on",
	profile: "router-fixture-profile",
	timeoutMs: 2000,
	accept: 0.6,
	low: 0.3,
	margin: 0.15,
	approve: 0.85,
	multi: 0.5,
	feedbackNear: 0.95,
	feedbackWeight: 2,
};

/** A router that answers `discard` this probable and shares the rest over the other criteria. */
function route(discard: number, asked: RouteInput[]) {
	return async (input: RouteInput): Promise<RouteAnswer> => {
		asked.push(input);
		const names = input.criteria.map((c) => c.name);
		const rest = (1 - discard) / (names.length - 1);
		return {
			choice: "switch.discard",
			probabilities: Object.fromEntries(
				names.map((name) => [name, name === "switch.discard" ? discard : rest]),
			),
			scores: null,
			model: "router-fixture-model",
			headRevision: "head-1",
			calibrationRevision: "cal-1",
		};
	};
}

test("the word that lets unsaved work go hands the waiting request over again, to the same item; below the approval line the host asks and does nothing", async () => {
	const h = await setup();
	open.push(h);
	h.handOver({ request: "アンケートを作って" });
	h.state.specialist.push(
		{
			action: "invoke",
			tool: "draft.apply",
			arguments: { title: "アンケート" },
		},
		{ action: "reply", text: "作りました" },
	);
	await h.ask("アンケートを作って");
	h.state.specialist.push({
		action: "return",
		forward: false,
		text: "戻ります",
	});
	await h.ask("会話に戻って");
	const suspended = (await h.session())!;
	h.handOver({ request: "別のものを作って" }, "fake.other");
	h.state.steps.push({ text: "未保存の作業があります。破棄しますか？" });
	await h.ask("別のものを作って");
	expect((await h.session())!.pendingSwitch).toMatchObject({
		toolchainId: "fake.other",
	});
	// From here the router decides.
	const asked: RouteInput[] = [];
	let probability = 0.7;
	Object.assign(h.larm, {
		snapshotInTransaction: () => ({
			general: { agentName: "", userName: "", persona: "butler" },
			router: ROUTER,
		}),
		route: (input: RouteInput) => route(probability, asked)(input),
	});
	h.state.found = [];
	const unsure = await h.ask("うーん、いいよ");
	expect(h.answerText(unsure.id)).toBe(
		"未保存の作業を捨てて「別の担当」に切り替えてよいか、はい、またはいいえで答えてください。",
	);
	expect(asked[0]!.criteria.at(-1)).toEqual({
		name: "switch.discard",
		description: "未保存の作業を捨てて、「別の担当」に切り替える。",
	});
	expect((await h.session())!.id).toBe(suspended.id);
	expect(h.state.calledPort).not.toContain("end:discard");
	probability = 0.9;
	h.state.specialist.push({ action: "reply", text: "別の担当です" });
	const switched = await h.ask("はい破棄して");
	expect(switched.status).toBe("completed");
	const now = (await h.session())!;
	expect(now.id).not.toBe(suspended.id);
	expect(now).toMatchObject({
		toolchainId: "fake.other",
		toolchainRevisionId: OTHER_REVISION,
	});
	expect(h.state.calledPort).toContain("end:discard");
});

test("the names of saved items are offered to the router as data: through the host's template, delimited like the other words of the user's", async () => {
	const h = await setup();
	open.push(h);
	const fieldsAsked: RouteFieldsInput[] = [];
	Object.assign(h.larm, {
		snapshotInTransaction: () => ({
			general: { agentName: "", userName: "", persona: "butler" },
			router: ROUTER,
		}),
		route: async (input: RouteInput): Promise<RouteAnswer> => {
			const names = input.criteria.map((c) => c.name);
			return {
				choice: "fake.studio",
				probabilities: Object.fromEntries(
					names.map((name) => [
						name,
						name === "fake.studio" ? 0.9 : 0.1 / (names.length - 1),
					]),
				),
				scores: null,
				model: "router-fixture-model-labels",
				headRevision: "head-1",
				calibrationRevision: "cal-1",
			};
		},
		routeFields: async (
			input: RouteFieldsInput,
		): Promise<RouteFieldsAnswer> => {
			fieldsAsked.push(input);
			throw new Error("fixture_fields_down");
		},
	});
	h.state.steps.push(
		{ text: "どれにしますか？" },
		{ text: "どれにしますか？" },
	);
	await h.ask("制作担当で作って").catch(() => undefined);
	const target = fieldsAsked[0]?.choices.target;
	expect(target?.criteria.map((c) => c.name)).toEqual([
		"new",
		"item-1",
		"item-2",
	]);
	expect(target?.criteria[1]!.description).toBe(
		'<S11TNEXT_DELIMITED_CONTEXT variable="label">\n保存済み1\n</S11TNEXT_DELIMITED_CONTEXT>',
	);
});
