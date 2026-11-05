import { afterEach, expect, test } from "bun:test";
import type { RouteInput } from "../../inference/contracts";
import { ROUTER, weigh } from "./router.fixture";
import { OTHER_REVISION, setup, type Harness } from "./specialist.fixture";

/**
 * The router and a hand-over that waits for the user's word on unsaved work (spec router-package-integration
 * 2026-11-04 §1 #10): the word that lets the work go is a candidate the host makes, and above the approval line it
 * hands the waiting request over again with that word.
 */
const open: Harness[] = [];
afterEach(async () => {
	for (const h of open.splice(0)) await h.close();
});

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
	let score = 0.55;
	Object.assign(h.larm, {
		snapshotInTransaction: () => ({
			general: { agentName: "", userName: "", persona: "butler" },
			router: ROUTER,
		}),
		route: (input: RouteInput, signal: AbortSignal) => {
			asked.push(input);
			return weigh({ "switch.discard": score })(input, signal);
		},
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
	score = 0.95;
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
