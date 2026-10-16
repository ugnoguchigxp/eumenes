import {
	WORK_ONLY_INSTRUCTION,
	type BlockerReason,
	type KanbanRunFinish,
	type NoticeKind,
	type QueueState,
} from "../contracts";

/* Wording and request text of the Kanban domain (plan §3.8, §3.9, §3.12). */

/** The longest text one terminals request carries. */
export const MAX_BODY = 8000;
/** How much of the earlier request and report a follow-up repeats at most (only a fallback summary). */
const CONTEXT_CHARS = [1000, 500, 250, 100];
/** Characters kept for the file list of a commit request. */
const FILES_CHARS = 5000;

const quote = (text: string) => JSON.stringify(text);
const clip = (text: string, max: number) =>
	text.length <= max ? text : `${text.slice(0, max)}…`;

function fit(body: string): string {
	if (body.length > MAX_BODY) throw new Error("kanban_prompt_too_long");
	return body;
}

/** The card's prompt plus the fixed work instruction (no commit, no push). */
export const taskBody = (prompt: string) =>
	fit(`${prompt}\n\n${WORK_ONLY_INSTRUCTION}`);

const FOLLOWUP_HEAD = (title: string) =>
	`タスク『${title}』の続きです。追加の依頼: `;
const FOLLOWUP_TAIL = `\n\n${WORK_ONLY_INSTRUCTION}`;
const SUMMARY_LEAD = "\n\n前の会話を再開できない場合のための要約です。";
/** Card titles are at most 40 characters (the typed input). */
const TITLE_MAX = 40;

/**
 * The longest JSON-quoted follow-up note that is always accepted: the rest of the request is the
 * title, the fixed words and the work instruction (the fallback summary is dropped to make room).
 */
export const FOLLOWUP_QUOTED_NOTE_MAX =
	MAX_BODY - FOLLOWUP_HEAD("x".repeat(TITLE_MAX)).length - FOLLOWUP_TAIL.length;

/**
 * The fallback summary of the earlier request and report, quoted as JSON strings so they never
 * read as instructions. It shrinks (and finally disappears) to fit the room the note leaves.
 */
function summaryOf(
	card: { prompt: string; lastReport: string | null },
	room: number,
): string {
	for (const chars of CONTEXT_CHARS) {
		const parts = [
			`元の依頼: ${quote(clip(card.prompt, chars))}`,
			...(card.lastReport
				? [`前回の報告: ${quote(clip(card.lastReport, chars))}`]
				: []),
		];
		const summary = `${SUMMARY_LEAD}${parts.join("。")}。`;
		if (summary.length <= room) return summary;
	}
	return "";
}

/**
 * A follow-up on the card's own conversation. Refused (`kanban_prompt_too_long`) when the note
 * alone does not fit; the earlier request and report only fill the room that is left.
 */
export function followupBody(card: {
	title: string;
	prompt: string;
	lastReport: string | null;
	note: string;
}): string {
	const head = `${FOLLOWUP_HEAD(card.title)}${quote(card.note)}`;
	const room = MAX_BODY - head.length - FOLLOWUP_TAIL.length;
	if (room < 0) throw new Error("kanban_prompt_too_long");
	return fit(`${head}${summaryOf(card, room)}${FOLLOWUP_TAIL}`);
}

/** The request to commit and push what the task changed (only from the board's button). */
export function commitPushBody(card: {
	title: string;
	files: readonly string[];
}): string {
	const kept: string[] = [];
	let size = 0;
	for (const file of card.files) {
		size += file.length + 4;
		if (size > FILES_CHARS) break;
		kept.push(file);
	}
	const omitted = card.files.length - kept.length;
	const files = `${JSON.stringify(kept)}${omitted > 0 ? `（ほか${omitted}件の記録があります。変更全体を確認してください）` : ""}`;
	return fit(
		`タスク『${card.title}』で変更した内容を commit して push してください。このタスクで変更を記録したファイル: ${files}。記録の無い変更や、ほかのタスクの変更と区別できない変更が作業ディレクトリにある場合は、commit も push もせずに、どのファイルを含めるか尋ねて止まってください。push に失敗した場合は原因を報告して止まってください（強制 push はしない）。`,
	);
}

export const BLOCKER_TEXT: Record<BlockerReason, string> = {
	interrupted: "途中で止まりました",
	ended: "作業担当が終了しました",
	unknown: "実行状況を確認できません",
	restarted: "Eumenes の再起動で実行状況を確認できなくなりました",
	tracking_lost: "状態を追えません（フックが届いていません）",
	cancelled: "送る前に取り消しました",
	send_failed: "送信に失敗しました",
	stopped_by_person: "利用者が止めました",
	resume_failed: "前の会話を再開できませんでした",
};

export const QUEUE_PAUSED_TEXT: Record<
	Extract<QueueState, { state: "paused" }>["reason"],
	string
> = {
	tracking_lost: "状態を追えないため止めました",
	stop_unconfirmed: "止めたタスクの終了を確認できていません",
	restarted: "再起動で実行状況を確認できなくなったため止めました",
};

export function noticeText(
	kind: NoticeKind,
	title: string,
	reason?: string,
): string {
	switch (kind) {
		case "done":
			return `タスク『${title}』が終わりました`;
		case "blocker":
			return `タスク『${title}』が止まりました: ${reason ?? ""}`;
		case "waiting":
			return `タスク『${title}』が許可を待っています`;
		case "commit_push":
			return `タスク『${title}』の commit & push の報告があります`;
		case "git_completed":
			return `タスク『${title}』のGit工程を確認しました: ${reason ?? ""}`;
		case "stopped":
			return `タスク『${title}』を止めました`;
		case "queue_paused":
			return `実行キューが止まりました: ${reason ?? ""}`;
	}
}

/** The card's blocker reason for a final request that did not complete. */
export function blockerReason(
	finish: Pick<KanbanRunFinish, "state" | "reason">,
): BlockerReason {
	switch (finish.state) {
		case "interrupted":
			return "interrupted";
		case "ended":
			if (finish.reason === "stopped_by_person") return "stopped_by_person";
			return finish.reason === "resume_failed" ? "resume_failed" : "ended";
		case "unknown":
			if (finish.reason === "restarted") return "restarted";
			if (finish.reason === "tracking_lost") return "tracking_lost";
			if (finish.reason === "stopped_by_person") return "stopped_by_person";
			return "unknown";
		default:
			if (finish.reason === "restarted") return "restarted";
			if (finish.reason === "send_failed") return "send_failed";
			return "cancelled";
	}
}

/** Reasons that stop the queue: nothing can be trusted about the runs that follow. */
export const pausesQueue = (reason: BlockerReason): boolean =>
	reason === "tracking_lost" || reason === "restarted";

/** The person did it themselves: no notice (the board already shows the result). */
export const quietReason = (reason: BlockerReason): boolean =>
	reason === "stopped_by_person" || reason === "cancelled";
