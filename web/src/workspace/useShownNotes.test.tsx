import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { ConversationResourcesResponse } from "../../../api/domains/resources/contracts";
import { useShownNotes } from "./useShownNotes";

afterEach(cleanup);

const resources = (messages: Array<{ messageId: string; uris: string[] }>) =>
	({ resources: [], messages }) as unknown as ConversationResourcesResponse;

test("a note shown after the screen opened opens its document once; older ones and other messages stay closed", () => {
	const open = vi.fn();
	const old = { id: "agency-note:s:run-1:n1" };
	const oldUri = "eumenes://markdown.document/generated-old";
	const hook = renderHook(
		({ messages, data }) => useShownNotes(messages, data, open),
		{
			initialProps: {
				messages: [old] as Array<{ id: string }>,
				data: resources([{ messageId: old.id, uris: [oldUri] }]),
			},
		},
	);
	expect(open).not.toHaveBeenCalled();
	// The message arrives before its resource is listed: nothing opens yet.
	const shown = { id: "agency-note:s:run-2:n2" };
	const uri = "eumenes://markdown.document/generated-new";
	const messages = [old, { id: "answer-2" }, shown];
	hook.rerender({
		messages,
		data: resources([{ messageId: old.id, uris: [oldUri] }]),
	});
	expect(open).not.toHaveBeenCalled();
	const listed = resources([
		{ messageId: old.id, uris: [oldUri] },
		{ messageId: "answer-2", uris: ["eumenes://image/x"] },
		{ messageId: shown.id, uris: [uri] },
	]);
	hook.rerender({ messages, data: listed });
	expect(open).toHaveBeenCalledTimes(1);
	expect(open).toHaveBeenCalledWith(uri);
	hook.rerender({ messages: [...messages], data: listed });
	expect(open).toHaveBeenCalledTimes(1);
});
