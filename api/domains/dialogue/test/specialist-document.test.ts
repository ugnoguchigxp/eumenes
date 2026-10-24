import { afterEach, expect, test } from "bun:test";
import { DOCUMENT_AGENT, setup, type Harness } from "./specialist.fixture";

const open: Harness[] = [];
afterEach(async () => {
	for (const h of open.splice(0)) await h.close();
});
async function harness(agent = DOCUMENT_AGENT) {
	const h = await setup({ agent });
	open.push(h);
	h.handOver({ request: "ページを作って" });
	h.state.specialist.push({ action: "reply", text: "はじめます" });
	await h.ask("ページを作って");
	return h;
}
const edit = (
	edits: Array<{ old: string; new: string }>,
	text?: string,
	baseRevision = 1,
) => ({
	action: "invoke",
	tool: "doc.edit",
	arguments: { baseRevision, edits },
	...(text ? { text } : {}),
});
const answer = (h: Harness, runId: string) =>
	h.conversation.message(h.dialogue.get(runId)!.answerMessageId!)!.text;
const lastPrompt = (h: Harness) => h.state.specialistPrompts.at(-1)!;
const work = (h: Harness) => h.work()[0]!;

test("the work document is read as its canonical text, and the host offers its document tools", async () => {
	const h = await harness();
	h.state.specialist.push({ action: "reply", text: "はい" });
	await h.ask("見せて");
	const prompt = lastPrompt(h);
	const tools = JSON.parse(
		prompt[0]!.content.split("TOOLS=")[1]!.split("\nOUTPUT_SCHEMA=")[0]!,
	) as Array<{ id: string }>;
	expect(tools.map((t) => t.id)).toEqual([
		"draft.apply",
		"doc.edit",
		"doc.write",
	]);
	expect(prompt[1]!.content).toContain(
		'CURRENT_DOCUMENT path=page.json revision=1\n<<<\n{\n  "view": "page",\n  "items": []\n}\n>>>',
	);
	const reference = JSON.parse(
		prompt[1]!.content.split("REFERENCE=")[1]!.split("\nCURRENT_DOCUMENT")[0]!,
	);
	// The fake work starts at revision 1 with no operation in the course: as if the screen had moved it.
	expect(reference.document).toEqual({
		path: "page.json",
		revision: 1,
		title: "新規",
		changedOnScreen: true,
	});
	expect(reference.currentWork).toBeUndefined();
});

test("a partial edit with its reply makes a revision in one call and is kept in the session's course", async () => {
	const h = await harness();
	const before = h.state.specialistPrompts.length;
	h.state.specialist.push(
		edit(
			[{ old: '"items": []', new: '"items": ["見出し"]' }],
			"見出しを足しました。",
		),
	);
	const run = await h.ask("見出しを足して");
	expect(answer(h, run.id)).toBe("見出しを足しました。");
	expect(h.state.specialistPrompts.length - before).toBe(1);
	expect(work(h).revision).toBe(2);
	expect(JSON.parse(work(h).text)).toEqual({ view: "page", items: ["見出し"] });
	h.state.specialist.push({ action: "reply", text: "はい" });
	await h.ask("次");
	const reference = JSON.parse(
		lastPrompt(h)[1]!
			.content.split("REFERENCE=")[1]!
			.split("\nCURRENT_DOCUMENT")[0]!,
	);
	expect(reference.course.at(-1).steps).toEqual([
		{ tool: "doc.edit", ok: true, revision: 2, size: { edits: 1 } },
	]);
	expect(reference.document.revision).toBe(2);
});

test("an edit whose text is missing or not unique applies nothing and says which edit, for one retry", async () => {
	const h = await harness();
	h.state.specialist.push(
		edit([
			{ old: '"view"', new: '"view"' },
			{ old: "ないもの", new: "x" },
		]),
		edit([{ old: '"', new: "'" }]),
	);
	const run = await h.ask("直して");
	expect(answer(h, run.id)).toBe("反映できませんでした。");
	const results = lastPrompt(h)
		.filter((m) => m.content.startsWith("TOOL_RESULT="))
		.map((m) => JSON.parse(m.content.slice("TOOL_RESULT=".length)));
	expect(results).toEqual([
		{
			ok: false,
			error: "edit_not_found",
			index: 1,
			mismatch: "absent",
			callsLeft: 3,
		},
	]);
	expect(work(h).revision).toBe(1);
	// The second, ambiguous edit is the second refusal: one retry by default, so the turn ends.
	expect(h.state.invocations).toHaveLength(0);
});

test("an edit that changes nothing ends the turn with the host's question", async () => {
	const h = await harness();
	h.state.specialist.push(
		edit([{ old: '"page"', new: '"page"' }], "直しました。"),
	);
	const run = await h.ask("いい感じに");
	expect(answer(h, run.id)).toBe(
		"変更点が分かりませんでした。どこを変えますか。",
	);
	expect(work(h).revision).toBe(1);
});

test("an edit on an old revision is refused with the current one", async () => {
	const h = await harness();
	h.state.specialist.push(
		edit([{ old: '"items": []', new: '"items": [1]' }], undefined, 0),
		{ action: "reply", text: "版が変わっていました" },
	);
	await h.ask("直して");
	expect(lastPrompt(h).at(-1)!.content).toBe(
		'TOOL_RESULT={"ok":false,"error":"revision_conflict","revision":1,"callsLeft":3}',
	);
});

test("a whole write that fails its check is kept as the rejected draft and ends the turn at once; the next turn reads it", async () => {
	const h = await harness();
	const before = h.state.specialistPrompts.length;
	h.state.specialist.push({
		action: "invoke",
		tool: "doc.write",
		arguments: {
			baseRevision: 1,
			title: "新しいページ",
			content: { view: "card" },
		},
		text: "作りました。",
	});
	const run = await h.ask("全部作り直して");
	expect(answer(h, run.id)).toBe(
		"反映できませんでした。作った案はソースで確認できます。",
	);
	expect(h.state.specialistPrompts.length - before).toBe(1);
	expect(work(h).revision).toBe(1);
	expect(work(h).rejected).toMatchObject({
		title: "新しいページ",
		issues: [{ path: "view", rule: "page_only" }],
	});
	h.state.specialist.push({ action: "reply", text: "直します" });
	await h.ask("さっきの案を直して");
	const reference = JSON.parse(
		lastPrompt(h)[1]!
			.content.split("REFERENCE=")[1]!
			.split("\nCURRENT_DOCUMENT")[0]!,
	);
	expect(reference.rejectedDraft).toMatchObject({
		title: "新しいページ",
		issues: [{ path: "view", rule: "page_only" }],
		text: '{\n  "view": "card"\n}',
	});
});

test("a write the domain had to trim says so after the reply", async () => {
	const h = await harness();
	h.state.specialist.push({
		action: "invoke",
		tool: "doc.write",
		arguments: {
			baseRevision: 1,
			title: "ページ",
			content: { view: "page", items: [], dropMe: true },
		},
		text: "作りました。",
	});
	const run = await h.ask("作って");
	expect(answer(h, run.id)).toBe("作りました。表示できない部分は省きました。");
	expect(work(h).revision).toBe(2);
});

test("a document larger than the inline budget is an outline, and doc.view reads its lines", async () => {
	const h = await harness({
		...DOCUMENT_AGENT,
		document: { ...DOCUMENT_AGENT.document!, inlineBytes: 1024 },
	});
	work(h).text = JSON.stringify(
		{ view: "page", items: Array.from({ length: 80 }, (_, i) => `title ${i}`) },
		null,
		2,
	);
	h.state.specialist.push(
		{
			action: "invoke",
			tool: "doc.view",
			arguments: { fromLine: 1, toLine: 3 },
		},
		{ action: "reply", text: "読みました" },
	);
	await h.ask("最初を見て");
	const prompt = lastPrompt(h);
	expect(prompt[0]!.content).toContain('"id":"doc.view"');
	expect(prompt[1]!.content).toContain("revision=1 outline");
	expect(
		JSON.parse(prompt.at(-1)!.content.slice("TOOL_RESULT=".length)),
	).toEqual({
		ok: true,
		result: {
			ok: true,
			revision: 1,
			lines: '1: {\n2:   "view": "page",\n3:   "items": [',
		},
		callsLeft: 3,
	});
});

test("a domain refusal of the commit is data for the next call, and a later screen change is flagged", async () => {
	const h = await harness();
	h.state.commitError = "undo_limit_reached";
	h.state.specialist.push(edit([{ old: '"items": []', new: '"items": [1]' }]), {
		action: "reply",
		text: "保存すると続けられます",
	});
	const run = await h.ask("直して");
	expect(answer(h, run.id)).toBe("保存すると続けられます");
	expect(lastPrompt(h).at(-1)!.content).toBe(
		'TOOL_RESULT={"ok":false,"error":"undo_limit_reached","callsLeft":3}',
	);
	h.state.commitError = null;
	h.state.specialist.push(
		edit([{ old: '"items": []', new: '"items": [1]' }], "直しました。"),
	);
	await h.ask("もう一度");
	expect(work(h).revision).toBe(2);
	// The screen undoes the change: the next turn is told.
	work(h).revision = 3;
	h.state.specialist.push({ action: "reply", text: "はい" });
	await h.ask("見て");
	const reference = JSON.parse(
		lastPrompt(h)[1]!
			.content.split("REFERENCE=")[1]!
			.split("\nCURRENT_DOCUMENT")[0]!,
	);
	expect(reference.document).toMatchObject({
		revision: 3,
		changedOnScreen: true,
	});
});

test("a later change that adds nothing after one that changed the work is reported as the change", async () => {
	const h = await harness();
	h.state.specialist.push(
		edit([{ old: '"items": []', new: '"items": [1]' }]),
		edit([{ old: '"page"', new: '"page"' }], undefined, 2),
	);
	const run = await h.ask("直して");
	expect(answer(h, run.id)).toBe("新規を更新しました。");
	expect(work(h).revision).toBe(2);
});

test("an edit not found says why and gives the document's own lines to copy on the retry", async () => {
	const h = await harness();
	h.state.specialist.push(
		// Two lines with the indentation dropped: the same lines, other spaces.
		edit([
			{
				old: '"view": "page",\n"items": []',
				new: '"view": "page",\n"items": [1]',
			},
		]),
		edit(
			[
				{
					old: '  "view": "page",\n  "items": []',
					new: '  "view": "page",\n  "items": [1]',
				},
			],
			"直しました。",
		),
	);
	const run = await h.ask("直して");
	expect(answer(h, run.id)).toBe("直しました。");
	const result = JSON.parse(
		h.state.specialistPrompts
			.at(-1)!
			.at(-1)!
			.content.slice("TOOL_RESULT=".length),
	);
	expect(result).toEqual({
		ok: false,
		error: "edit_not_found",
		index: 0,
		mismatch: "whitespace",
		near: '  "view": "page",\n  "items": []',
		callsLeft: 3,
	});
	expect(work(h).revision).toBe(2);
});
