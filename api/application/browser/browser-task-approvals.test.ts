import { afterEach, expect, test } from "bun:test";
import { WEB } from "../../domains/browser/test/fakes";
import {
	approvalRows,
	begin,
	cleanup,
	clickGo,
	ended,
	finish,
	invoke,
	observation,
	OWNER,
	POST_FORM,
	setup,
	start,
	tag,
	typeInto,
} from "./browser-task-kit";

afterEach(cleanup);

test("an operation the model declares as commit is held by the host: the task asks the user, says what it would do and keeps the pending approval", async () => {
	for (const [stop, action, typed] of [
		[clickGo("commit"), "click", false],
		[
			typeInto("ワイヤレスイヤホン", "ワイヤレスイヤホン", {
				submit: true,
				effect: "commit",
			}),
			"type",
			true,
		],
		[
			invoke("browser.page.press", { key: "Tab", effect: "commit" }),
			"press",
			false,
		],
	] as const) {
		const s = await setup([stop, finish("届かない")]);
		const { taskId } = await start(s);
		await ended(s, taskId);
		const status = s.service.taskStatus(OWNER, taskId);
		expect(status.state).toBe("needs_input");
		// The element (or key), the action and the page origin are named; nothing from the page body.
		expect(status.resultSummary).toContain(WEB);
		expect(status.resultSummary).toContain(
			action === "click"
				? "「Goボタン」をクリックします"
				: action === "press"
					? "キー「Tab」を押します"
					: "「検索ボックス」に「ワイヤレスイヤホン」を入力して送信します",
		);
		expect(status.resultSummary).not.toContain("button");
		expect(s.driver.calls.filter((c) => c.startsWith("act:"))).toEqual([]);
		expect(s.typed).toEqual([]);
		expect(s.model.state.calls).toHaveLength(1);
		// A typed value is pending too, so the follow-up task can type what the user was shown.
		expect(approvalRows(s).map((r) => [r.kind, r.status, r.action])).toEqual(
			typed
				? [
						["operation", "pending", "type"],
						["input_value", "pending", "input_value"],
					]
				: [["operation", "pending", action]],
		);
	}
});

test("the host judges the form itself: a POST submit is held without any declaration, a GET search and a plain button run", async () => {
	const held = await setup([clickGo("navigate"), finish("届かない")]);
	held.driver.targetInfo = POST_FORM;
	const first = await start(held);
	await ended(held, first.taskId);
	expect(held.service.taskStatus(OWNER, first.taskId).state).toBe(
		"needs_input",
	);
	expect(held.driver.calls.filter((c) => c.startsWith("act:"))).toEqual([]);

	const free = await setup([clickGo("navigate"), finish("検索しました。")]);
	free.driver.targetInfo = { ...POST_FORM, formMethod: "get" };
	const second = await start(free);
	await ended(free, second.taskId);
	expect(free.service.taskStatus(OWNER, second.taskId).state).toBe("completed");
	expect(free.driver.calls.filter((c) => c.startsWith("act:"))).toEqual([
		"act:click",
	]);
});

test("the user's approval reaches the follow-up task, which shows it to the model and runs the held operation once", async () => {
	const s = await setup([
		clickGo("navigate"),
		// The follow-up task: the approved operation is in REFERENCE, then it is done once.
		(messages) => {
			const reference = tag(messages[1]!.content, "REFERENCE");
			expect(reference.approved).toEqual([
				expect.objectContaining({
					kind: "operation",
					action: "click",
					element: "Goボタン",
					place: `${WEB}/`,
				}),
			]);
			return clickGo("navigate")(messages, 2);
		},
		clickGo("navigate"),
	]);
	s.driver.targetInfo = POST_FORM;
	const first = await start(s);
	await ended(s, first.taskId);
	expect(s.service.taskStatus(OWNER, first.taskId).state).toBe("needs_input");

	const second = await begin(s, first.tabRef, {
		request: "はい、送信して",
		brief: "Goボタンを押して送信する",
		continueFrom: first.taskId,
		approvePending: true,
	});
	await ended(s, second);
	// The approval is used once: the same operation asked again is held again.
	const status = s.service.taskStatus(OWNER, second);
	expect(s.driver.calls.filter((c) => c.startsWith("act:"))).toEqual([
		"act:click",
	]);
	expect(status.state).toBe("needs_input");
	expect(approvalRows(s).map((r) => r.status)).toEqual(["consumed", "pending"]);
});

test("without the user's approval nothing moves: the follow-up task is held again", async () => {
	const s = await setup([clickGo("commit"), clickGo("commit")]);
	const first = await start(s);
	await ended(s, first.taskId);
	const second = await begin(s, first.tabRef, {
		request: "どうなった？",
		continueFrom: first.taskId,
		approvePending: false,
	});
	await ended(s, second);
	expect(s.service.taskStatus(OWNER, second).state).toBe("needs_input");
	expect(s.driver.calls.filter((c) => c.startsWith("act:"))).toEqual([]);
	expect(s.model.state.calls[1]![1]!.content).not.toContain('"approved"');
});

const PAGE_VALUE = "会員番号 MBR-2026-AB12CD";

test("a value read from the page is not typed: the task shows it to the user and the approved value is typed by reference", async () => {
	const s = await setup([
		typeInto(PAGE_VALUE, "会員番号"),
		// The follow-up task: the value is in REFERENCE as a ref and a summary, never as text.
		(messages) => {
			const reference = tag(messages[1]!.content, "REFERENCE");
			expect(reference.approved).toHaveLength(1);
			const typeTool = JSON.parse(
				messages[0]!.content
					.split("\n")
					.find((line) => line.startsWith("TOOLS="))!
					.slice(6),
			).find((tool: { id: string }) => tool.id === "browser.page.type");
			expect(typeTool.inputSchema.properties).toHaveProperty("inputValueRef");
			const [item] = reference.approved;
			expect(item).toMatchObject({ kind: "input_value", purpose: "検索" });
			expect(JSON.stringify(item)).not.toContain("MBR-2026");
			const o = observation(messages);
			return invoke("browser.page.type", {
				observationRef: o.observationRef,
				ref: "e2",
				element: "検索ボックス",
				inputValueRef: item.inputValueRef,
				purpose: "検索",
				submit: false,
			});
		},
		finish("入力しました。"),
	]);
	s.driver.snapshotText = `- generic [ref=e1]:\n  - textbox "メール" [ref=e2]\n  - text: ${PAGE_VALUE}`;
	const first = await start(s);
	await ended(s, first.taskId);
	const status = s.service.taskStatus(OWNER, first.taskId);
	expect(status.state).toBe("needs_input");
	expect(status.resultSummary).toContain("MBR-2026-AB12CD");
	expect(status.resultSummary).toContain("入力してよいですか");
	expect(s.typed).toEqual([]);
	expect(approvalRows(s)).toEqual([
		expect.objectContaining({
			kind: "input_value",
			status: "pending",
			value: PAGE_VALUE,
		}),
	]);

	const second = await begin(s, first.tabRef, {
		request: "はい、入力して",
		brief: "会員番号を入力する",
		continueFrom: first.taskId,
		approvePending: true,
	});
	await ended(s, second);
	expect(s.service.taskStatus(OWNER, second).state).toBe("completed");
	expect(s.typed).toEqual([PAGE_VALUE]);
});

test("a short value, or one that is in the request, is not taken for a page value", async () => {
	const s = await setup([
		typeInto("ワイヤレスイヤホン", "ワイヤレスイヤホン"),
		finish("入力しました。"),
	]);
	// The page shows the same words, but the user said them first.
	s.driver.snapshotText =
		'- generic [ref=e1]:\n  - textbox "検索" [ref=e2]\n  - text: ワイヤレスイヤホン の人気商品';
	const { taskId } = await start(s);
	await ended(s, taskId);
	expect(s.service.taskStatus(OWNER, taskId).state).toBe("completed");
	expect(s.typed).toEqual(["ワイヤレスイヤホン"]);
});

test("a quote that is not in the request gets no grant: the task shows the value to the user instead of asking the model", async () => {
	const s = await setup([typeInto("SECRET", "SECRET"), finish("届かない")]);
	const { taskId } = await start(s);
	await ended(s, taskId);
	const status = s.service.taskStatus(OWNER, taskId);
	expect(status.state).toBe("needs_input");
	expect(status.resultSummary).toContain("SECRET");
	expect(s.typed).toEqual([]);
	expect(s.model.state.calls).toHaveLength(1);
	expect(approvalRows(s).map((r) => r.kind)).toEqual(["input_value"]);
});
