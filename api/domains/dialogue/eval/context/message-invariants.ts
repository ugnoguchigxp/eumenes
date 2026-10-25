/**
 * What every generation's messages keep (the ContextWindow layout specification, sections 1, 2, 4 and 5), checked
 * on the output of the production prepare. A case that breaks one stops `prepare` before any model call: it would
 * measure a prompt the product must never send.
 *
 *  1. The messages are `[system, user(document), user(<now>), ...newest]`; no assistant message and no tool message.
 *  2. The document is the four tagged sections in their fixed order, each once, and it is the user message that was
 *     measured (`input.document`). The system part does not carry it.
 *  3. The newest messages are the pending utterances (one each), or the host's fixed text alone.
 *  4. Escaping: no `<` or `>` in the document besides the section tags (outside text is made full-width).
 *  5. Each fitted section is within its limit (memory, history, log and `<now>`; `<state>` may use the working
 *     area because the TODOs are never dropped).
 */
import { estimateTextTokens } from "../../../inference";
import type { GenerateInput } from "../../service/context";
import { DOCUMENT_SECTIONS } from "../../service/context-document";
import { FIXED_TRIGGER_TEXT } from "../../service/context-system";

/** What breaks the invariants in `input`; empty when the messages are acceptable. */
export function messageIssues(input: GenerateInput): string[] {
	const issues: string[] = [];
	const { messages, document, final, plan } = input;
	const [system, doc, now, ...newest] = messages;
	if (system?.role !== "system") issues.push("first_message_not_system");
	if (doc?.role !== "user") issues.push("document_message_not_user");
	if (now?.role !== "user" || !/^<now>\n[\s\S]*\n<\/now>$/.test(now.content))
		issues.push("now_message_not_now_block");
	if (messages.some((m) => m.role === "assistant" || m.role === "tool"))
		issues.push("assistant_or_tool_message_in_prepared_messages");
	if (doc) {
		if (doc.content !== document.text)
			issues.push("document_not_the_measured_text");
		const tags = [...doc.content.matchAll(/^<\/?([a-z]+)>$/gm)].map(
			(match) => match[0],
		);
		const expected = DOCUMENT_SECTIONS.flatMap((name) => [
			`<${name}>`,
			`</${name}>`,
		]);
		if (tags.join(",") !== expected.join(","))
			issues.push(`document_sections:${tags.join(",")}`);
		const body = expected.reduce(
			(text, tag) => text.replace(tag, ""),
			doc.content,
		);
		if (/[<>]/.test(body)) issues.push("document_raw_markup_character");
	}
	if (
		system &&
		document.text.length > 0 &&
		system.content.includes("<memory>\n")
	)
		issues.push("document_in_system_message");
	if (newest.length === 0) issues.push("no_newest_message");
	if (newest.some((m) => m.role !== "user")) issues.push("newest_not_user");
	if (final.kind === "fixed") {
		if (newest.length !== 1 || newest[0]?.content !== FIXED_TRIGGER_TEXT)
			issues.push("fixed_text_not_the_only_newest_message");
	} else if (newest.length !== final.messageIds.length)
		issues.push("newest_count_not_the_pending_utterances");
	if (document.sections.memory.tokens > plan.sections.profile)
		issues.push("section_over_limit:memory");
	if (document.sections.history.tokens > plan.sections.episode)
		issues.push("section_over_limit:history");
	if (document.sections.log.tokens > plan.log.cap)
		issues.push("section_over_limit:log");
	if (now && estimateTextTokens(now.content) > plan.sections.now)
		issues.push("section_over_limit:now");
	return issues;
}

/** Throws with every issue when the generation's messages break an invariant. */
export function assertMessageInvariants(
	input: GenerateInput,
	label: string,
): void {
	const issues = messageIssues(input);
	if (issues.length)
		throw new Error(
			`context_eval_message_invariant:${label}:${issues.join(",")}`,
		);
}
