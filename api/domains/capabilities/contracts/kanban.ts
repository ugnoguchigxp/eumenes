import { z } from "zod";

/*
 * Typed inputs of the Kanban operations (spec/kanban-claude-code-plan-2026-10-14.md §3.8,
 * §3.13). Flat objects, shared by the adapter, the UI input adapters and the conversation tools.
 */
const title = z
	.string()
	.trim()
	.min(1)
	.max(40)
	.describe("作業の短い名前。利用者の依頼の言葉から選び、通知でこの名前を使う。");
/** Leaves room for the work-only instruction appended when the card runs (8000 in total). */
export const KANBAN_PROMPT_MAX = 7850;
const prompt = z
	.string()
	.trim()
	.min(1)
	.max(KANBAN_PROMPT_MAX)
	.describe("作業担当に渡す依頼内容。利用者の指示・対象・条件を省略や言い換えなしで含める。");
const cardId = z.uuid().describe("snapshot に示されたカードの id。");
const expectedRevision = z
	.number()
	.int()
	.min(1)
	.describe("snapshot に示されたそのカードの revision。");
const beforeCardId = z
	.uuid()
	.nullable()
	.describe("この id のカードの前に置く。null は列の末尾。");

export const kanbanAdd = z.strictObject({
	title,
	prompt,
	beforeCardId: beforeCardId.optional(),
});
export const kanbanEdit = z.strictObject({
	cardId,
	expectedRevision,
	title: title.optional(),
	prompt: prompt.optional(),
});
export const kanbanMove = z.strictObject({
	cardId,
	expectedRevision,
	column: z.enum(["todo", "finished"]).describe("移動先。finished に移すと Done。"),
	beforeCardId,
});
export const kanbanCardRef = z.strictObject({ cardId, expectedRevision });
export const kanbanFollowup = z.strictObject({
	cardId,
	expectedRevision,
	note: z
		.string()
		.trim()
		.min(1)
		.max(4000)
		.describe("追加の依頼。利用者の言葉のまま。"),
});
/** The answer of a target question: the card the person chose (`choiceField: cardId`). */
export const kanbanCardAnswer = z.strictObject({ cardId });
export const kanbanList = z.strictObject({});
export const kanbanNoticeRef = z.strictObject({ noticeId: z.uuid() });
