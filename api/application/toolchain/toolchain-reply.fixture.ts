import type { Messages } from "../../domains/inference/contracts";
import type { HarnessOptions } from "./toolchain-harness-options.fixture";

/** Trusted packet merged with the separate UNTRUSTED_MATERIALS message. */
export function workerPacket(messages: Messages): any {
	const data = JSON.parse(
		messages.filter((m) => m.role === "user").at(-1)!.content,
	);
	const untrusted = messages.find((m) =>
		m.content.startsWith("UNTRUSTED_MATERIALS"),
	);
	if (untrusted)
		Object.assign(
			data,
			JSON.parse(untrusted.content.slice(untrusted.content.indexOf("=") + 1)),
		);
	return data;
}

/** The conversation's answer to a message: the parent agent's reply, a finished action's, or the fixed sentence. */
export async function fixtureParentReply(
	messages: Messages,
	options: HarnessOptions,
	parentContexts: string[],
): Promise<string> {
	parentContexts.push(JSON.stringify(messages));
	if (options.parentAnswer !== undefined) return options.parentAnswer;
	// The analysis asked for a clarification: the answer round carries the question.
	if (options.clarify) return "どの地域の天気を調べますか？";
	if (options.parent) return options.parent(messages);
	const action = messages.find((m) => m.content.startsWith('{"actionResult":'));
	if (action) {
		const result = JSON.parse(action.content).actionResult;
		if (result.kind === "task_result") return result.summary;
		if (result.items[0]?.state === "cancelled")
			return "タイマーを取り消しました";
		if (result.action === "started")
			return `${result.items[0].durationSeconds}秒のタイマーを開始しました`;
		if (result.action === "cancelled") return "タイマーを取り消しました";
		return (
			result.items
				.map(
					(item: any) =>
						`${item.label}: 残り${item.remainingSeconds}秒 (${item.state})`,
				)
				.join("、") || "動いているタイマーはありません"
		);
	}
	const result = messages.find((m) => m.content.includes('"sources":'));
	const projection = result ? JSON.parse(result.content).report : null;
	const source = projection?.sources?.[0];
	const citation = source?.url
		? `\n\nソース：[${new URL(source.url).hostname}](${source.url})`
		: "";
	return messages.some((m) => m.content.includes("250.12"))
		? "調べました。AAPLは250.12米ドル、2026年10月8日の終値でございます。" +
				citation
		: messages.some((m) => m.content.includes("26度"))
			? "調べました。東京は晴れ、最高26度、最低17度、降水確率0％の予報でございます。" +
				citation
			: "かしこまりました。";
}
