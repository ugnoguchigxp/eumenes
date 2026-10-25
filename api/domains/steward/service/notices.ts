import type { Database } from "bun:sqlite";
import { jstSeconds } from "../../../infrastructure/jst-time";
import type { StewardDeps } from "./types";

/** What the user is told when a memory request ends without being carried out. */
export const REQUEST_FAILED_NOTICE =
	"記憶の依頼を処理できませんでした。もう一度お願いします。";
export const FORGET_LIMIT_NOTICE =
	"一度に忘れられる件数を超えているため、忘れる依頼を実行できませんでした。件数を減らしてもう一度お願いします。";
export const NOTHING_TO_FORGET_NOTICE =
	"忘れる依頼に当てはまる記憶が見つからなかったため、何も忘れていません。";
export const WITHDRAWN_NOTICE =
	"まだ実行していなかった記憶の依頼を取り下げました。";
export const NOTHING_TO_WITHDRAW_NOTICE =
	"取り下げられる記憶の依頼はありませんでした。すでに実行した依頼は元に戻せません。";

/**
 * Tells the conversation what became of a memory request: one event of its log (`memory.notice`), read once like
 * every other event (the ContextWindow layout specification, section 4.3). `key` makes it once per cause.
 */
export function noticeInTransaction(
	deps: Pick<StewardDeps, "continuity" | "clock">,
	db: Database,
	conversationId: string,
	text: string,
	key: string,
) {
	deps.continuity.events.appendInTransaction(db, {
		conversationId,
		at: jstSeconds(Date.parse(deps.clock())),
		type: "acted",
		by: "host",
		fields: { action: "memory.notice", text },
		dedupeKey: `memory-notice:${key}`,
	});
}
