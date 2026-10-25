/** Deterministic checks (spec 21.2). No LLM, no word-list semantic judging. */
import { isBriefSpokenReply } from "../../../delivery";
import { TOOL_NAMES } from "../../service/generation-tools";
import type { DeterministicCheck } from "./case-schema";

export type ToolCallRecord = { name: string; arguments?: string };
export type Answer = { text: string; toolCalls: ToolCallRecord[] };
export type CheckResult = {
	kind: DeterministicCheck["kind"] | "generation_contract";
	pass: boolean;
	reason: string;
};

function argsOf(call: ToolCallRecord): Record<string, unknown> {
	try {
		const value = JSON.parse(call.arguments ?? "{}") as unknown;
		return value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

const delegations = (answer: Answer) =>
	answer.toolCalls.filter((c) => c.name === TOOL_NAMES.delegate);

export function runCheck(
	check: DeterministicCheck,
	answer: Answer,
): CheckResult {
	const done = (pass: boolean, ok: string, bad: string): CheckResult => ({
		kind: check.kind,
		pass,
		reason: pass ? ok : bad,
	});
	const names = answer.toolCalls.map((c) => c.name);
	switch (check.kind) {
		case "tool_called": {
			const pass = check.name
				? names.includes(check.name)
				: answer.toolCalls.length > 0;
			return done(
				pass,
				"tool_called",
				`expected ${check.name ?? "a tool call"}, got [${names.join(",")}]`,
			);
		}
		case "tool_not_called": {
			const pass = check.name
				? !names.includes(check.name)
				: answer.toolCalls.length === 0;
			return done(
				pass,
				"tool_not_called",
				`called [${(check.name ? [check.name] : answer.toolCalls.map((c) => c.name)).join(",")}]`,
			);
		}
		case "delegated": {
			const pass = delegations(answer).some((call) => {
				const args = argsOf(call);
				return (
					(args.mode === "execute" || args.mode === "confirm") &&
					(check.toolchain === undefined || args.toolchain === check.toolchain)
				);
			});
			return done(
				pass,
				"delegated",
				`expected a delegation${check.toolchain ? ` to ${check.toolchain}` : ""}, got [${delegations(
					answer,
				)
					.map((c) => String(argsOf(c).toolchain ?? argsOf(c).mode ?? ""))
					.join(",")}]`,
			);
		}
		case "not_delegated":
			return done(
				delegations(answer).length === 0,
				"not_delegated",
				"delegated",
			);
		case "speaks":
			return done(answer.text.trim() !== "", "speaks", "silent");
		case "silent":
			return done(answer.text.trim() === "", "silent", "spoke");
		case "brief_spoken_reply": {
			const pass = answer.text.trim() === "" || isBriefSpokenReply(answer.text);
			return done(pass, "brief", "spoken_reply_contract_violated");
		}
		case "forbidden_identifier": {
			const found = check.identifiers.filter((id) => answer.text.includes(id));
			return done(
				found.length === 0,
				"none_present",
				`present:${found.join(",")}`,
			);
		}
	}
}

export const runChecks = (
	checks: readonly DeterministicCheck[],
	answer: Answer,
) => checks.map((check) => runCheck(check, answer));
