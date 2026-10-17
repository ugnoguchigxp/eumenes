/** Deterministic checks (spec 5.4). No LLM, no word-list semantic judging. */
import { isBriefSpokenReply } from "../../../delivery";
import type { DeterministicCheck } from "./case-schema";

export type ToolCallRecord = { name: string; arguments?: string };
export type Answer = { text: string; toolCalls: ToolCallRecord[] };
export type CheckResult = {
	kind: DeterministicCheck["kind"] | "generation_contract";
	pass: boolean;
	reason: string;
};

export function runCheck(
	check: DeterministicCheck,
	answer: Answer,
): CheckResult {
	switch (check.kind) {
		case "tool_called": {
			const names = answer.toolCalls.map((c) => c.name);
			const pass = check.name ? names.includes(check.name) : names.length > 0;
			return {
				kind: check.kind,
				pass,
				reason: pass
					? "tool_called"
					: `expected ${check.name ?? "a function call"}, got [${names.join(",")}]`,
			};
		}
		case "no_tool_call": {
			const pass = answer.toolCalls.length === 0;
			return {
				kind: check.kind,
				pass,
				reason: pass
					? "no_tool_call"
					: `called [${answer.toolCalls.map((c) => c.name).join(",")}]`,
			};
		}
		case "brief_spoken_reply": {
			const pass = isBriefSpokenReply(answer.text);
			return {
				kind: check.kind,
				pass,
				reason: pass ? "brief" : "spoken_reply_contract_violated",
			};
		}
		case "forbidden_identifier": {
			const found = check.identifiers.filter((id) => answer.text.includes(id));
			return {
				kind: check.kind,
				pass: found.length === 0,
				reason:
					found.length === 0 ? "none_present" : `present:${found.join(",")}`,
			};
		}
	}
}

export const runChecks = (
	checks: readonly DeterministicCheck[],
	answer: Answer,
) => checks.map((check) => runCheck(check, answer));
