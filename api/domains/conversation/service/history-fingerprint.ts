import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
	historySearchInput,
	historyReadInput,
	type HistoryOwner,
} from "../contracts/history";
import { revision } from "../repository";
import type { HistoryPosition } from "./history-scan";
const sha = (v: unknown) =>
	createHash("sha256").update(JSON.stringify(v)).digest("hex");
export function historyFingerprint(
	db: Database,
	owner: HistoryOwner,
	raw: unknown,
	kind: string,
	{
		cursors,
		messages,
		resolve,
	}: {
		cursors: Map<string, HistoryPosition>;
		messages: Map<
			string,
			{ session: string; messageId: string; offset: number }
		>;
		resolve: (db: Database, owner: HistoryOwner, id: string) => unknown;
	},
) {
	if (kind === "history.search") {
		const input = historySearchInput.parse(raw);
		const position = input.cursor ? cursors.get(input.cursor) : undefined;
		if (input.cursor) {
			if (!position || position.purpose !== "search")
				throw new Error("history_ref_invalid");
			resolve(db, owner, position.session);
		}
		return sha([
			kind,
			owner.conversationId,
			revision(db, owner.conversationId),
			{ ...input, cursor: undefined },
			position?.messageId ?? null,
			position?.offset ?? 0,
		]);
	}
	const input = historyReadInput.parse(raw),
		ref = messages.get(input.messageRef);
	if (!ref) throw new Error("history_ref_invalid");
	resolve(db, owner, ref.session);
	const position = input.cursor ? cursors.get(input.cursor) : undefined;
	if (input.cursor && (!position || position.messageRef !== input.messageRef))
		throw new Error("history_ref_invalid");
	return sha([
		kind,
		ref.session,
		ref.messageId,
		position?.offset ?? ref.offset,
		input.before,
		input.after,
	]);
}
