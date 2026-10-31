import { SpeechSentences } from "./sentences";
import { spokenText } from "./spoken-text";
import type { Run } from "../../dialogue/contracts";

/** The sentences an on-demand replay speaks, split as a live answer is. */
export const replaySentences = (text: string) =>
	new SpeechSentences().append(spokenText(text), true);

/** A completed handover's adopted announcement is spoken when it has no final-answer message. */
export function replayTextMatches(
	run: Run | null | undefined,
	answer: string | null,
	text: string,
) {
	if (run?.status !== "completed") return false;
	const saved = run.answerMessageId ? answer : run.announcement;
	return replaySentences(saved ?? "").includes(text);
}
