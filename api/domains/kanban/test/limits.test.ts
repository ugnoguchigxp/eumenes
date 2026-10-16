import { expect, test } from "bun:test";
import { KANBAN_PROMPT_MAX, WORK_ONLY_INSTRUCTION } from "..";
import {
	FOLLOWUP_QUOTED_NOTE_MAX,
	followupBody,
	taskBody,
} from "../service/text";
import { openKanban } from "./kanban.fixture";

let req = 0;
const rid = () => `limit-req-${++req}`;
const BOARD = { origin: "board" as const, runnable: true };

test("the longest card prompt plus the work instruction fits one request", () => {
	expect(taskBody("あ".repeat(KANBAN_PROMPT_MAX)).length).toBeLessThanOrEqual(
		8000,
	);
	expect(KANBAN_PROMPT_MAX).toBe(7850);
});

test("add and edit refuse a prompt that could not be run, and save nothing", async () => {
	const { store, kanban } = openKanban();
	const tooLong = "あ".repeat(KANBAN_PROMPT_MAX + 1);
	await expect(
		store.write((tx) =>
			kanban.addInTransaction(tx, { title: "T", prompt: tooLong }, rid()),
		),
	).rejects.toThrow("kanban_prompt_too_long");
	expect(kanban.board({ runnable: true }).cards).toEqual([]);
	const card = (
		await store.write((tx) =>
			kanban.addInTransaction(tx, { title: "T", prompt: "短い" }, rid()),
		)
	).receipt;
	await expect(
		store.write((tx) =>
			kanban.editInTransaction(
				tx,
				{ cardId: card.cardId, expectedRevision: 1, prompt: tooLong },
				rid(),
			),
		),
	).rejects.toThrow("kanban_prompt_too_long");
	expect(kanban.board({ runnable: true }).cards[0]).toMatchObject({
		revision: 1,
		prompt: "短い",
	});
});

const card = { title: "あ".repeat(40), prompt: "元", lastReport: "報告" };

test("a follow-up whose note fits is accepted whatever the earlier prompt and report quote to", () => {
	const awkward = `"\\\n`.repeat(400);
	const body = followupBody({
		...card,
		prompt: awkward,
		lastReport: awkward,
		note: "続き",
	});
	expect(body.length).toBeLessThanOrEqual(8000);
	expect(body.endsWith(WORK_ONLY_INSTRUCTION)).toBe(true);
	expect(body).toContain(`追加の依頼: ${JSON.stringify("続き")}`);
});

test("the note's quoted length decides: the largest allowed note passes, one more is refused", () => {
	const withQuoted = (quoted: number) =>
		// A note of plain characters quotes to two more characters.
		followupBody({ ...card, note: "あ".repeat(quoted - 2) });
	expect(withQuoted(FOLLOWUP_QUOTED_NOTE_MAX).length).toBeLessThanOrEqual(8000);
	expect(() => withQuoted(FOLLOWUP_QUOTED_NOTE_MAX + 1)).toThrow(
		"kanban_prompt_too_long",
	);
	// The screen limits the note to 6500 quoted characters; that always fits.
	expect(FOLLOWUP_QUOTED_NOTE_MAX).toBeGreaterThanOrEqual(6500);
	// Escaped characters count double: the same raw length no longer fits.
	expect(() =>
		followupBody({ ...card, note: "\n".repeat(FOLLOWUP_QUOTED_NOTE_MAX / 2) }),
	).toThrow("kanban_prompt_too_long");
});

test("a follow-up that cannot fit is refused at the operation, before anything is queued", async () => {
	const { store, kanban } = openKanban();
	const created = (
		await store.write((tx) =>
			kanban.addInTransaction(tx, { title: "T", prompt: "依頼" }, rid()),
		)
	).receipt;
	const run = await store.write((tx) =>
		kanban.runInTransaction(
			tx,
			{ cardId: created.cardId, expectedRevision: 1 },
			rid(),
			BOARD,
		),
	);
	await store.write((tx) =>
		kanban.finishRunInTransaction(tx, {
			runId: run.receipt.runId!,
			state: "completed",
			lastReport: "報告",
			files: [],
		}),
	);
	const revision = kanban.board({ runnable: true }).cards[0]!.revision;
	await expect(
		store.write((tx) =>
			kanban.followupInTransaction(
				tx,
				{
					cardId: created.cardId,
					expectedRevision: revision,
					note: "\n".repeat(4000),
				},
				rid(),
				BOARD,
			),
		),
	).rejects.toThrow("kanban_prompt_too_long");
	const after = kanban.board({ runnable: true });
	expect(after.cards[0]).toMatchObject({ column: "finished", revision });
	expect(after.runs.filter((r) => r.state === "waiting_turn")).toEqual([]);
});
