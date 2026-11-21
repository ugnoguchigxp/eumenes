import { afterEach, expect, test } from "bun:test";
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
	h.state.found = [];
	h.state.steps.push({ text: "未保存の作業を破棄してよいですか？" });
	const unsure = await h.ask("うーん、いいよ");
	expect(h.answerText(unsure.id)).toContain(
		"未保存の作業を破棄してよいですか？",
	);
	expect(h.state.calls.at(-1)?.tools).toContain("discard_for_pending_switch");
	expect((await h.session())!.id).toBe(suspended.id);
	expect(h.state.calledPort).not.toContain("end:discard");
	h.state.steps.push({
		calls: [
			{
				name: "discard_for_pending_switch",
				args: { request: "別のものを作ってください" },
			},
		],
	});
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
