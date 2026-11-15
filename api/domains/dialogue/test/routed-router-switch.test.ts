import { afterEach, expect, test } from "bun:test";
import type { InferencePort } from "../../inference/contracts";
import { ROUTER } from "./router.fixture";
import { OTHER_REVISION, setup, type Harness } from "./specialist.fixture";

const open: Harness[] = [];
afterEach(async () => {
	for (const h of open.splice(0)) await h.close();
});

test("ambiguous permission holds unsaved work and explicit permission switches to the pending toolchain", async () => {
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
	const seen: Array<{ ref: string; description: string }> = [];
	let approve = false;
	const selectRouter: NonNullable<InferencePort["selectRouter"]> = async (
		prompt,
	) => {
		const { hostActions, latest } = JSON.parse(prompt.user);
		seen.push(...hostActions);
		return JSON.stringify({
			decision: approve
				? { hostAction: { ref: "switch.discard", text: latest } }
				: {
						clarify: {
							question: "未保存の作業を破棄してよいですか？",
							unhandled: [latest],
						},
					},
		});
	};
	Object.assign(h.larm, {
		snapshotInTransaction: () => ({
			general: { agentName: "", userName: "", persona: "butler" },
			router: ROUTER,
		}),
		selectRouter,
	});
	h.state.found = [];
	const unsure = await h.ask("うーん、いいよ");
	expect(h.answerText(unsure.id)).toContain(
		"未保存の作業を破棄してよいですか？",
	);
	expect(seen.at(-1)).toEqual({
		ref: "switch.discard",
		description: "未保存の作業を捨てて、「別の担当」に切り替える。",
	});
	expect((await h.session())!.id).toBe(suspended.id);
	expect(h.state.calledPort).not.toContain("end:discard");
	approve = true;
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
