import type { Database } from "bun:sqlite";
import type { ConversationService } from "../../conversation";
import type { Run } from "../contracts";
import type { ChatMessage } from "./context";
import { recentPriorRuns } from "../repository";

/**
 * The wording known World targets are looked for in: this turn's input first, then the previous
 * exchange (its input and, when it completed, its answer). Messages the memory ledger blocked (forgotten or
 * excluded) are never offered.
 */
export function topicTexts(
	tx: Database,
	run: Run,
	conversation: ConversationService,
	blocked: ReadonlySet<string>,
	withoutSpecialist = false,
): string[] {
	const ids = [run.inputMessageId];
	const previous = recentPriorRuns(tx, run, 1, withoutSpecialist)[0];
	if (previous) {
		ids.push(previous.inputMessageId);
		if (previous.status === "completed" && previous.answerMessageId !== null)
			ids.push(previous.answerMessageId);
	}
	const texts: string[] = [];
	for (const id of ids) {
		if (blocked.has(id)) continue;
		const message = conversation.messageInTransaction(tx, id);
		if (message) texts.push(message.message.text);
	}
	return texts;
}

/** Control and format characters (line breaks, zero-width, bidi marks) and line/paragraph separators. */
const CONTROL_CHARS = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;
/** Brackets and quote-like characters: a name must not be able to close or imitate the quoting around it. */
const FRAME_CHARS =
	/[()（）[\]［］{}｛｝<>＜＞「」『』【】〔〕〈〉《》"'`“”„‘’＂＇｢｣]/gu;

/** One name as quoted data: control and bracket characters gone, whitespace collapsed. */
function cleanName(name: string): string {
	return name
		.replace(CONTROL_CHARS, " ")
		.replace(FRAME_CHARS, " ")
		.replace(/\s+/gu, " ")
		.trim();
}

/**
 * The one L4 line naming the known World targets this turn mentions: names only (in the order given, each cleaned
 * and shown as quoted data), no claim content and no ids, so the model knows World has something to look up. It does
 * not name a tool: the lookup goes through whatever research the run is offered. Null when no target is named.
 */
export function worldNamesHint(names: readonly string[]): ChatMessage | null {
	const shown = [
		...new Set(names.map(cleanName).filter((name) => name !== "")),
	].map((name) => `「${name}」`);
	if (shown.length === 0) return null;
	return {
		role: "system",
		content: `Worldに記録がある対象: ${shown.join("、")}（引用した名前のみ。詳しい内容は World の調査で確かめられる）`,
	};
}
