import { expect, test } from "bun:test";
import { createReadPorts } from "./research-history-ports";

/** The research history port with fakes: only the blocked-message handling is under test. */
const runRow = {
	id: "root",
	status: "running",
	source_kind: "manual",
	conversation_id: "main",
	input_message_id: "input",
	revision: 1,
};
const db = { query: () => ({ get: () => runRow }) } as never;
const owner = { rootRunId: "root", taskId: "task", cancelEpoch: 0 };
const message = (messageId: string) => ({
	messageId,
	messageRef: `ref-${messageId}`,
	conversationId: "main",
	speaker: "user",
	createdAt: "2026-10-05T00:00:00Z",
	revision: "1",
	digest: "d",
	viewId: `view-${messageId}`,
	viewDigest: "vd",
	start: 0,
	end: 3,
	nextCursor: null,
	text: `text-${messageId}`,
	truncated: false,
});
const scope = { scopeRef: "scope-1" };
function ports(blockedIds: string[]) {
	const conversation = {
		historySearchInTransaction: () => ({
			candidates: [message("kept"), message("forgotten")],
			scope,
			cursor: null,
		}),
		historyReadInTransaction: () => ({
			messages: [message("forgotten"), message("kept")],
			scope,
		}),
		validateHistoryInTransaction: () => true,
	};
	return createReadPorts(
		{ savedBodies: { validate: () => true } } as never,
		conversation as never,
		() => ({ authorizeReadOwnerInTransaction: () => ({ deadline: 1 }) }) as never,
		{
			blockedMessageIdsInTransaction: (_db, ids) =>
				new Set([...ids].filter((id) => blockedIds.includes(id))),
		},
	);
}
const ids = (result: unknown) =>
	(result as { result: { readings: Array<{ messageId: string }> } }).result.readings.map(
		(reading) => reading.messageId,
	);

test("history.search and history.read leave blocked messages out of what the researcher sees", () => {
	const p = ports(["forgotten"]);
	const search = p.localInTransaction!(db, {
		owner,
		tool: { id: "history.search" },
		arguments: {},
	} as never);
	expect(ids(search)).toEqual(["kept"]);
	const read = p.localInTransaction!(db, {
		owner,
		tool: { id: "history.read" },
		arguments: {},
	} as never);
	expect(ids(read)).toEqual(["kept"]);
});

test("without blocked messages every result is passed on", () => {
	const p = ports([]);
	const search = p.localInTransaction!(db, {
		owner,
		tool: { id: "history.search" },
		arguments: {},
	} as never);
	expect(ids(search)).toEqual(["kept", "forgotten"]);
});

test("a report that stands on a message forgotten during the research is not adopted", () => {
	const source = (messageId: string) => ({
		kind: "conversation_source",
		messageId,
		scopeRef: "scope-1",
		viewId: `view-${messageId}`,
		revision: "1",
		digest: "d",
		viewDigest: "vd",
	});
	const adopt = (blockedIds: string[], messageId: string) =>
		ports(blockedIds).validateEvidenceInTransaction!(
			db,
			owner as never,
			[source(messageId)] as never,
			[{ kind: "conversation_source", scopeRef: "scope-1" }] as never,
		);
	expect(adopt(["forgotten"], "kept")).toBe(true);
	expect(adopt(["forgotten"], "forgotten")).toBe(false);
});
