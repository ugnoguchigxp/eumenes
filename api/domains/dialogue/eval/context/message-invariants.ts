/**
 * What every generation's messages keep (the ContextWindow specification sections 5.1 to 5.3 and 7.2, tested in 21.1),
 * checked on the output of the production prepare. A case that breaks one stops `prepare` before any model call: it
 * would measure a prompt the product must never send.
 *
 *  1. The messages are `[system, user(material document), ...newest]`; no assistant message and no tool message.
 *  2. The document is one JSON object whose keys are the document keys in their fixed order, and it is the user
 *     message that was measured (`input.document`). The system part does not carry it.
 *  3. The newest messages are the pending utterances (one each), or the host's fixed text alone.
 *  4. Escaping: no raw `<`, `>`, `&`, and the only `\uXXXX` are those characters and the line separators.
 *  5. Each fitted section is within its limit (the profile, episode, log, active and now sections; `state` may use
 *     the working area because the TODOs are never dropped).
 */
import type { GenerateInput } from "../../service/context";
import { DOCUMENT_KEYS } from "../../service/context-document";
import { FIXED_TRIGGER_TEXT } from "../../service/context-system";

const ALLOWED_ESCAPES = new Set(["003c", "003e", "0026", "2028", "2029"]);

/** What breaks the invariants in `input`; empty when the messages are acceptable. */
export function messageIssues(input: GenerateInput): string[] {
	const issues: string[] = [];
	const { messages, document, final, plan } = input;
	const [system, doc, ...newest] = messages;
	if (system?.role !== "system") issues.push("first_message_not_system");
	if (doc?.role !== "user") issues.push("document_message_not_user");
	if (messages.some((m) => m.role === "assistant" || m.role === "tool"))
		issues.push("assistant_or_tool_message_in_prepared_messages");
	if (doc) {
		if (doc.content !== document.text)
			issues.push("document_not_the_measured_text");
		let parsed: unknown = null;
		try {
			parsed = JSON.parse(doc.content);
		} catch {
			issues.push("document_not_json");
		}
		if (parsed && typeof parsed === "object") {
			const keys = Object.keys(parsed);
			if (keys.join(",") !== DOCUMENT_KEYS.join(","))
				issues.push(`document_keys:${keys.join(",")}`);
		}
		if (/[<>&]/.test(doc.content)) issues.push("document_raw_markup_character");
		for (const match of doc.content.matchAll(/\\u([0-9a-fA-F]{4})/g))
			if (!ALLOWED_ESCAPES.has(match[1]!.toLowerCase()))
				issues.push(`document_escaped_character:${match[1]}`);
	}
	if (
		system &&
		document.text.length > 0 &&
		system.content.includes(`"${DOCUMENT_KEYS[0]}":`)
	)
		issues.push("document_in_system_message");
	if (newest.length === 0) issues.push("no_newest_message");
	if (newest.some((m) => m.role !== "user")) issues.push("newest_not_user");
	if (final.kind === "fixed") {
		if (newest.length !== 1 || newest[0]?.content !== FIXED_TRIGGER_TEXT)
			issues.push("fixed_text_not_the_only_newest_message");
	} else if (newest.length !== final.messageIds.length)
		issues.push("newest_count_not_the_pending_utterances");
	for (const name of ["profile", "episode", "active", "now"] as const)
		if (document.sections[name].tokens > plan.sections[name])
			issues.push(`section_over_limit:${name}`);
	if (document.sections.log.tokens > plan.log.cap)
		issues.push("section_over_limit:log");
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
