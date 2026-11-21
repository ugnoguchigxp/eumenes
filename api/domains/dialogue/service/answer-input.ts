import { getLogger } from "../../../infrastructure/logger";
import {
	markInput,
	type InputOrigin,
} from "../../../infrastructure/model-input";
import { estimateMessageTokens } from "../../inference";
import type { ChatMessage } from "./context";
import { withLastMessage, type ConversationPrefix } from "./conversation-input";
import { INPUT_HEADINGS, dataText, joinSections, section } from "./input-text";
import { stateText } from "./state-text";

const log = getLogger("dialogue");

/** Draw the answering call's State, notice and latest words, with attribution at the renderer's offsets. */
export function answerMessages(
	prefix: ConversationPrefix,
	input: {
		stateLines: string[];
		askedRequest?: string;
		agencyLines: string[];
		media: readonly { line: string }[];
		diagnostics: readonly { line: string }[];
		notice: readonly string[];
		texts: readonly string[];
		attachments: Pick<ChatMessage, "attachments" | "sourceMessageId">;
		trace?: { nowMs: number; noticeId?: string; origins?: InputOrigin[] };
	},
) {
	const { agencyLines, diagnostics, media, trace } = input;
	const stateLines = [...input.stateLines];
	if (input.askedRequest)
		stateLines.push(
			`- 直前の質問が確認している依頼 ${dataText(input.askedRequest)}`,
		);
	const mediaLines = media.length
		? ["受領した生成画像:", ...media.map(({ line }) => line)]
		: [];
	const diagnosticLines = diagnostics.map(({ line }) => line);
	const state = stateText([
		...stateLines,
		...agencyLines,
		...mediaLines,
		...diagnosticLines,
	]);
	const notice = section(INPUT_HEADINGS.notice, input.notice);
	const words = input.texts.map(dataText);
	const user = section(INPUT_HEADINGS.user, words);
	const sections = [state, notice, user];
	const messages = withLastMessage(prefix, sections, input.attachments);
	if (trace) {
		const last = messages.at(-1)!;
		let from = last.content.length - joinSections(sections).length;
		if (state) {
			markInput(
				last,
				{ kind: "state", at: new Date(trace.nowMs).toISOString() },
				from,
				from + state.length,
			);
			if (agencyLines.length) {
				const start =
					from +
					INPUT_HEADINGS.state.length +
					1 +
					stateLines.reduce((n, line) => n + line.length + 1, 0);
				markInput(
					last,
					{ kind: "agency" },
					start,
					start + agencyLines.join("\n").length,
				);
			}
			from += state.length + 2;
		}
		if (notice) {
			markInput(
				last,
				{ kind: "notice", id: trace.noticeId },
				from,
				from + notice.length,
			);
			from += notice.length + 2;
		}
		if (user) {
			from += INPUT_HEADINGS.user.length + 1;
			for (const [index, word] of words.entries()) {
				markInput(
					last,
					trace.origins?.[index] ?? { kind: "user" },
					from,
					from + word.length,
				);
				from += word.length + 1;
			}
		}
	}
	log.debug("dialogue.context_measured", {
		kind: "estimated_tokens",
		count: estimateMessageTokens(messages),
	});
	return messages;
}
