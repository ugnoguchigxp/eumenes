import { afterEach, expect, test } from "bun:test";
import { setup, type Harness } from "./specialist.fixture";

const open: Harness[] = [];
afterEach(async () => {
	for (const h of open.splice(0)) await h.close();
});
async function harness() {
	const h = await setup();
	open.push(h);
	return h;
}
const reply = (text: string) => ({ action: "reply", text });
const invoke = (title: string) => ({
	action: "invoke",
	tool: "draft.apply",
	arguments: { title },
});
/** The enclosed reference data and the current request of the latest specialist call. */
function lastTurn(h: Harness) {
	const prompt = h.state.specialistPrompts.at(-1)!;
	const data = prompt.find((m) => m.content.includes("REFERENCE="))!;
	return {
		reference: JSON.parse(data.content.split("REFERENCE=")[1]!),
		request: prompt
			.filter((m) => m.role === "user" && !m.content.includes("REFERENCE="))
			.at(0)!.content,
		roles: prompt.map((m) => m.role),
	};
}

test("2026-10-18: a draft whose reply broke the contract, an utterance cut off by the next one, and the follow-up all reach the specialist", async () => {
	const h = await harness();
	// The first turn changes the work, then twice breaks the contract with its reply: the host reports the change.
	h.startCall({ request: "ECサイトのデモUIを作る" });
	h.state.specialist.push(
		invoke("デモのECサイト"),
		{ action: "reply" },
		{ action: "reply" },
	);
	const first = await h.ask("ecサイトのデモuiを考えてください");
	expect(first.status).toBe("completed");
	expect(h.conversation.message(first.answerMessageId!)!.text).toBe(
		"デモのECサイトを更新しました。",
	);
	// The second utterance is cut off by the next one while its turn runs.
	let release!: () => void;
	h.state.gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	h.state.specialist.push(reply("カートを外します"));
	const cut = await h.say("カートの中はいらないかな");
	await h.until(() => h.dialogue.get(cut.id)?.status === "running");
	await h.dialogue.cancel(cut.id);
	await h.finished(cut.id);
	expect(h.dialogue.get(cut.id)!.status).toBe("cancelled");
	release();
	h.state.gate = Promise.resolve();
	h.state.specialist.push(reply("カートを外しました"));
	await h.ask("いるとしても相当ひどいですね");
	const turn = lastTurn(h);
	expect(turn.roles).toEqual(["system", "user", "user"]);
	// The utterance cut off belongs to this request, in order, as the user said it.
	expect(turn.request).toBe(
		"カートの中はいらないかな\nいるとしても相当ひどいですね",
	);
	expect(turn.reference.joinsInterrupted).toBe(true);
	// The first turn is in the course: what was asked and handed over, the operation that ran, how it ended.
	expect(turn.reference.course).toEqual([
		{
			utterance: "ecサイトのデモuiを考えてください",
			handedOver: "ECサイトのデモUIを作る",
			steps: [{ tool: "draft.apply", ok: true, revision: 2 }],
			outcome: "completed",
			reply: "デモのECサイトを更新しました。",
		},
	]);
});

test("a failed turn stays in the course with its refused operations and its code", async () => {
	const h = await harness();
	h.startCall({ request: "作って" });
	h.state.specialist.push(reply("はじめます"));
	await h.ask("作って");
	h.state.invokeError = "ui_definition_invalid";
	h.state.specialist.push(
		invoke("案"),
		{ action: "reply" },
		{ action: "reply" },
	);
	const failed = await h.ask("グラフを足して");
	expect(failed).toMatchObject({
		status: "failed",
		error: "specialist_invalid_contract",
	});
	h.state.invokeError = null;
	h.state.specialist.push(reply("どのグラフにしますか"));
	await h.ask("さっきのやつ");
	const { reference, request } = lastTurn(h);
	expect(request).toBe("さっきのやつ");
	expect(reference.joinsInterrupted).toBeUndefined();
	expect(reference.course.at(-1)).toEqual({
		utterance: "グラフを足して",
		steps: [{ tool: "draft.apply", ok: false, error: "ui_definition_invalid" }],
		outcome: "failed",
		error: "specialist_invalid_contract",
	});
});

test("an operation that changes nothing ends the turn with the host's question, without another call", async () => {
	const h = await harness();
	h.startCall({ request: "作って" });
	h.state.specialist.push(reply("はじめます"));
	await h.ask("作って");
	const before = h.state.specialistPrompts.length;
	h.state.invokeError = "no_change";
	h.state.specialist.push(invoke("同じ案"));
	const run = await h.ask("いい感じにして");
	expect(run.status).toBe("completed");
	expect(h.conversation.message(run.answerMessageId!)!.text).toBe(
		"変更点が分かりませんでした。どこを変えますか。",
	);
	expect(h.state.specialistPrompts.length - before).toBe(1);
});
