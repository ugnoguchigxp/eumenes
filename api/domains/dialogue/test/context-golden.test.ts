/**
 * Golden tests of the model-visible context (the evaluation design's section 4.3): for each combination, the
 * message lists the real dialogue handler sends to a fake inference port, plus the session split and the position
 * of the current request, are stored as fixtures (`*.golden`, JSON) in `context-golden/`. A change of the context's assembly or format
 * must either reproduce them byte for byte (a refactoring) or update them deliberately: run with
 * `UPDATE_GOLDEN=1` and review the fixture diff.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setup, type Harness } from "./specialist.fixture";
import {
	SCENARIOS,
	normalizeMessages,
	runScenario,
} from "./context-golden.fixture";

const DIR = join(import.meta.dir, "context-golden");
const UPDATE = process.env.UPDATE_GOLDEN === "1";

function check(name: string, actual: unknown) {
	const path = join(DIR, `${name}.golden`);
	const text = JSON.stringify(actual, null, "\t") + "\n";
	if (UPDATE) {
		mkdirSync(DIR, { recursive: true });
		writeFileSync(path, text);
		return;
	}
	if (!existsSync(path)) throw new Error(`golden fixture missing: ${name}`);
	expect(JSON.parse(text)).toEqual(JSON.parse(readFileSync(path, "utf8")));
}

for (const [name, scenario] of Object.entries(SCENARIOS))
	test(`golden: ${name}`, async () => {
		const {
			assembly: _assembly,
			ledgerMessageIds: _ids,
			...golden
		} = await runScenario(scenario);
		check(name, golden);
	}, 30_000);

// The specialist records come from the real specialist port wiring, so they run through its fixture.
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
const ret = (forward: boolean, text?: string) => ({
	action: "return",
	forward,
	...(text ? { text } : {}),
});
const sentOf = (h: Harness, from: number) =>
	h.state.mainCalls.slice(from).map((call) => ({
		messages: normalizeMessages(call.history),
		tools: call.tools.map((t) => t.function.name),
	}));
async function startDirty(h: Harness) {
	h.startCall({ request: "アンケートを作って" });
	h.state.specialist.push(invoke("アンケート"), reply("作りました"));
	await h.ask("アンケートを作って");
}

test("golden: specialist-work (a suspended work is recorded for the main agent)", async () => {
	const h = await harness();
	await startDirty(h);
	h.state.specialist.push(ret(false, "会話担当へ戻ります"));
	await h.ask("会話に戻って");
	h.state.main.push("天気は晴れです");
	const from = h.state.mainCalls.length;
	await h.ask("今日の天気は？");
	check("specialist-work", sentOf(h, from));
}, 30_000);

test("golden: specialist-handoff (a request outside the specialist's scope)", async () => {
	const h = await harness();
	await startDirty(h);
	h.state.specialist.push(ret(true));
	h.state.main.push("明日は雨です");
	const from = h.state.mainCalls.length;
	await h.ask("明日の天気を教えて");
	check("specialist-handoff", sentOf(h, from));
}, 30_000);

test("golden: specialist-viewing (the saved item on screen)", async () => {
	const h = await harness();
	h.state.main.push("見ています");
	await h.ask("これは何？", {
		viewing: {
			artifactRevisionId: "artifact:fake.studio@1",
			targetRef: "item-1",
		},
	});
	check("specialist-viewing", sentOf(h, 0));
}, 30_000);

test("golden: specialist-ended (an ended session is recorded once)", async () => {
	const h = await harness();
	h.startCall({ request: "相談したい" });
	h.state.specialist.push(reply("どんな内容ですか"));
	await h.ask("相談したい");
	h.state.specialist.push(ret(false, "戻ります"));
	await h.ask("やっぱり戻って");
	h.state.main.push("はい");
	const from = h.state.mainCalls.length;
	await h.ask("こんにちは");
	check("specialist-ended", sentOf(h, from));
}, 30_000);
