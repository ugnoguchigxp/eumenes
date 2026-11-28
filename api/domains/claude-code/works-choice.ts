import type { Database } from "bun:sqlite";
import type { Host, Work, WorksChoice } from "./contracts";
import { closeQuestion, newId } from "./lifecycle";
import { worksAuthorization } from "./works-authorization";

const response = (index: number) => `作品 ${index + 1}`;

export function questionForWorks(
	choices: readonly WorksChoice[],
	expiresAt: number,
) {
	return {
		id: newId(),
		expiresAt,
		prompt:
			"作業するWorks作品を選んでください。\n" +
			choices
				.map((choice, index) => `${response(index)} — ${choice.label}`)
				.join("\n") +
			"\n選んだ番号を「作品 1」の形式で返信してください。",
		inputSchema: {
			type: "string",
			enum: choices.map((_, index) => response(index)),
		},
	};
}

export function answerWorksChoice(
	db: Database,
	host: Host,
	work: Work,
	original: string,
	now: number,
) {
	const selection = work.worksChoice;
	const choice = selection?.candidates.find(
		(_, index) => response(index) === original.trim(),
	);
	if (!selection || !choice || !host.works?.pick)
		throw new Error("invalid_answer");
	const target = host.works.pick(choice);
	const authorization = worksAuthorization(target, work.deadline);
	work.works = target;
	work.supervision = {
		authorization,
		toolchainRevisionId: selection.toolchainRevisionId,
	};
	delete work.worksChoice;
	closeQuestion(db, host, work);
	work.status = "queued";
	work.observedAt = now;
	work.summary = `「${choice.label}」で作業します。`;
	work.notice = newId();
}
