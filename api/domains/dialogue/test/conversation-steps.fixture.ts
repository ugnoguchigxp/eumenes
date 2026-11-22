import { systemContext } from "../../../infrastructure/system-context";
import type { ToolchainCard } from "../../capabilities";
import type { ChatMessage } from "../service/context";
import type { Step } from "./generation.fixture";

/**
 * The lines of one `## ` section of a message (`## State`, `## User`, `## Memory`…), without its heading; empty when
 * the message has none.
 */
export function sectionLines(content: string, heading: string): string[] {
	const open = `## ${heading}\n`;
	const at = content.startsWith(open) ? 0 : content.indexOf(`\n${open}`);
	if (at < 0) return [];
	const start = content.indexOf(open, at) + open.length;
	const next = content.indexOf("\n\n## ", start);
	return content
		.slice(start, next < 0 ? undefined : next)
		.split("\n")
		.filter((line) => line !== "");
}

function scriptedChoice(step: Step | undefined) {
	if (!step?.text || step.fail || step.calls) return;
	try {
		const value = JSON.parse(step.text);
		return typeof value?.choice === "string" ? value : undefined;
	} catch {
		return;
	}
}

const call = (name: string, args: Record<string, unknown>): Step => ({
	calls: [{ name, args }],
});

/** Run older fixture scripts through the actual conversation tools and argument fill. */
export function conversationSteps(
	steps: Step[],
	cards: readonly ToolchainCard[],
	confirmationDecisions: Record<string, unknown>[] = [],
) {
	let request = "";
	const followUp: Array<(messages: ChatMessage[]) => Step | undefined> = [];
	let fill: Step | undefined;
	function finish(text: string) {
		followUp.push((messages) => {
			const next = steps[0];
			if (next && !scriptedChoice(next)) return steps.shift();
			const last = messages.at(-1);
			try {
				const output = JSON.parse(last?.content ?? "");
				if (output.answered) return { text: output.answer };
				if (
					output.ok === false ||
					output.declined === false ||
					output.delegated === false
				)
					return { text };
			} catch {
				// When a fixture supplies a normal response, use it.
			}
			return { text };
		});
	}
	return (
		id: string,
		messages: ChatMessage[],
		structured: boolean,
	): Step | undefined => {
		if (request !== id) {
			request = id;
			followUp.length = 0;
			fill = undefined;
		}
		if (
			structured &&
			messages[0]?.content ===
				systemContext("dialogue.contexts.local.confirmation-decision", {})
		)
			return {
				text: JSON.stringify(
					confirmationDecisions.shift() ?? { choice: "reply" },
				),
			};
		if (structured) {
			const next = fill ?? steps.shift();
			fill = undefined;
			return next;
		}
		if (followUp.length) return followUp.shift()!(messages);
		const step = steps.shift();
		const value = scriptedChoice(step);
		if (!value) return step;
		const {
			choice,
			confirmation,
			todo,
			operation,
			resolveUnsaved,
			say,
			...fields
		} = value;
		if (choice === "none") return steps.shift();
		if (choice === "ask") return { text: say };
		if (choice === "approve") {
			finish("うまく頼めませんでした。もう一度言ってもらえますか。");
			return call("approve_confirmation", { confirmation });
		}
		if (choice === "decline") {
			finish("わかりました。やめておきます。");
			return call("decline_confirmation", { confirmation });
		}
		if (resolveUnsaved === "discard")
			return call("discard_for_pending_switch", { request: fields.request });
		if (choice === "answer") {
			finish("伝えました。");
			return call("work", { todo, operation: "answer" });
		}
		if (typeof operation === "string") {
			if (operation !== "check") finish(say ?? "承知しました。");
			return call("work", { todo: choice, operation });
		}
		if (choice === "memory.request") {
			finish(say ?? "承知しました。");
			return call("memory", { operation: "request", ...fields });
		}
		if (fields.inputs && !cards.some(({ id }) => id === choice))
			return call(choice, fields.inputs);
		const current = messages
			.filter((message) => message.role === "user")
			.at(-1);
		const utterance = sectionLines(current?.content ?? "", "User").join("\n");
		const task = fields.request ?? utterance;
		if (fields.inputs || fields.target)
			fill = { text: JSON.stringify({ choice, ...fields }) };
		followUp.push(() => call("delegate", { toolchain: choice, request: task }));
		finish("その依頼は今の担当で実行できません。");
		return call("find_toolchain", { query: task });
	};
}
