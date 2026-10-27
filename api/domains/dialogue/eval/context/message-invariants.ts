/**
 * What every generation's messages keep (the conversation input specification, sections 3, 3.2, 5, 6 and 7),
 * checked on the output of the production prepare. A case that breaks one stops `prepare` before any model call: it
 * would measure a prompt the product must never send.
 *
 *  1. The messages are `[system, (user ## Memory), ...recent conversation, user(last)]`: no tool message, no tool
 *     call, and no two messages of one role in a row.
 *  2. The last message holds `## State`, then `## Host notice` and/or `## User` (the pending utterances, or a host
 *     notice when none waits); each input heading once, and only in its own place.
 *  3. No tag, event number or time of an utterance from the earlier layout reaches the input.
 *  4. `## Memory` and `## State` stay within their bounds.
 */
import { estimateTextTokens } from "../../../inference";
import type { GenerateInput } from "../../service/context";
import { MEMORY_TOKENS } from "../../service/conversation-input";
import { INPUT_HEADINGS } from "../../service/input-text";

/** `## State` stays within this (section 7.1). */
const STATE_TOKENS = 600;

/** The text of one `## ` section of a message, without its heading; null when it has none. */
function sectionOf(content: string, heading: string): string | null {
	const at = content.indexOf(`${heading}\n`);
	if (at < 0) return null;
	const start = at + heading.length + 1;
	const next = content.slice(start).search(/\n\n## /);
	return next < 0 ? content.slice(start) : content.slice(start, start + next);
}

/** What breaks the invariants in `input`; empty when the messages are acceptable. */
export function messageIssues(input: GenerateInput): string[] {
	const issues: string[] = [];
	const { messages, final } = input;
	const [system, ...rest] = messages;
	const last = messages.at(-1);
	if (system?.role !== "system") issues.push("first_message_not_system");
	if (last?.role !== "user" || messages.length < 2)
		issues.push("last_message_not_user");
	if (messages.some((m) => m.role === "tool" || m.tool_calls?.length))
		issues.push("tool_exchange_in_prepared_messages");
	for (let i = 1; i < messages.length; i++)
		if (messages[i]!.role === messages[i - 1]!.role)
			issues.push(`same_role_in_a_row:${i}`);
	const body = last?.content ?? "";
	const state = sectionOf(body, INPUT_HEADINGS.state);
	if (state === null) issues.push("no_state_section");
	else if (!state.startsWith("今: ")) issues.push("state_without_now_line");
	const user = sectionOf(body, INPUT_HEADINGS.user);
	const notice = sectionOf(body, INPUT_HEADINGS.notice);
	if (final.kind === "utterances" && user === null)
		issues.push("pending_utterances_without_user_section");
	if (final.kind === "fixed" && notice === null)
		issues.push("no_utterance_and_no_host_notice");
	if (user !== null && !body.endsWith(user))
		issues.push("user_section_not_last");
	const headings = [...body.matchAll(/^## (.+)$/gm)].map((m) => `## ${m[1]}`);
	const own = new Set<string>([
		INPUT_HEADINGS.memory,
		INPUT_HEADINGS.state,
		INPUT_HEADINGS.notice,
		INPUT_HEADINGS.user,
	]);
	for (const heading of headings)
		if (!own.has(heading)) issues.push(`unknown_heading:${heading}`);
	if (new Set(headings).size !== headings.length)
		issues.push("heading_twice_in_last_message");
	for (const message of rest.slice(0, -1))
		if (/^## (State|User|Host notice)$/m.test(message.content))
			issues.push("input_heading_outside_last_message");
	const all = messages.map((m) => m.content).join("\n");
	for (const [pattern, issue] of [
		[/^<\/?(memory|history|log|state|now)>$/m, "earlier_layout_tag"],
		[/^e\d+ \d\d:\d\d /m, "event_number_line"],
	] as const)
		if (pattern.test(all)) issues.push(issue);
	// Its own message before the recent conversation, or the head of the last message when none follows it.
	const memory = rest
		.slice(0, -1)
		.find((m) => m.content.startsWith(`${INPUT_HEADINGS.memory}\n`));
	const memoryText = memory?.content ?? sectionOf(body, INPUT_HEADINGS.memory);
	if (memoryText && estimateTextTokens(memoryText) > MEMORY_TOKENS)
		issues.push("section_over_limit:memory");
	if (state && estimateTextTokens(state) > STATE_TOKENS)
		issues.push("section_over_limit:state");
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
