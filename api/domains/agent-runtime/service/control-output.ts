import type { LogFields } from "../../../infrastructure/logger";
import { valueType } from "../../../infrastructure/validation-log";
import { bytes } from "../../capabilities";
import { LlmJsonError, parseLlmJson } from "../../../infrastructure/llm-json";
export const codeOf = (code: string, fallback: string) =>
	/^[a-z_]{1,80}$/.test(code) ? code : fallback;
/** Rejection codes after which the sub-agent gets its one repair; the same codes decide when the repair notice applies. */
export const controlRepairCodes: ReadonlySet<string> = new Set([
	"invalid_control_json",
	"invalid_tool_input",
	"invalid_evidence",
	"invalid_report",
	"invalid_requirement_report",
	"invalid_requirement_contract",
	"invalid_requirement_schema",
	"invalid_requirement_verification",
	"tool_url_out_of_scope",
]);
export const safeCode = (e: unknown) =>
	e instanceof Error && /^[a-z_]{1,80}$/.test(e.message)
		? e.message
		: "agent_failed";
export function parseControlOutput(value: unknown): {
	action: unknown;
	invalid: boolean;
	diagnostic: LogFields;
} {
	const diagnostic: LogFields = { outputType: valueType(value) };
	if (typeof value !== "string")
		return {
			action: undefined,
			invalid: true,
			diagnostic: { ...diagnostic, reason: "control_non_text" },
		};
	diagnostic.bytes = bytes(value);
	diagnostic.outputCharacters = value.length;
	if (diagnostic.bytes > 32768)
		return {
			action: undefined,
			invalid: true,
			diagnostic: {
				...diagnostic,
				reason: "control_output_too_large",
				limit: 32768,
			},
		};
	const text = value.trim();
	const body = text;
	try {
		const action = parseLlmJson(body, 32768);
		if (action && typeof action === "object" && "action" in action) {
			diagnostic.controlAction =
				typeof action.action === "string" &&
				["invoke", "finish"].includes(action.action)
					? action.action
					: "unrecognized";
		}
		return { action, invalid: false, diagnostic };
	} catch (error) {
		const repairCode =
			error instanceof LlmJsonError &&
			!["llm_json_invalid_syntax", "llm_json_incomplete"].includes(error.code)
				? error.code
				: undefined;
		// Retain the existing safe native-parser classification after correction
		// fails. The native message is examined locally and never logged.
		let parserError = error;
		try {
			JSON.parse(body);
		} catch (nativeError) {
			parserError = nativeError;
		}
		// Extract only a numeric parser offset, never the parser's quoted input.
		const offset =
			!repairCode && parserError instanceof SyntaxError
				? /\bposition (\d+)\b/.exec(parserError.message)?.[1]
				: undefined;
		const message =
			parserError instanceof SyntaxError ? parserError.message : "";
		const validationCode =
			repairCode ??
			(/Unexpected (?:EOF|end)/i.test(message)
				? "unexpected_end"
				: /Expected '\}'/.test(message)
					? "expected_object_end"
					: /Expected '\]'/.test(message)
						? "expected_array_end"
						: /Property name must/.test(message)
							? "expected_property_name"
							: /Unexpected identifier/.test(message)
								? "unexpected_identifier"
								: error instanceof LlmJsonError
									? error.code
									: "invalid_json_syntax");
		return {
			action: undefined,
			invalid: true,
			diagnostic: {
				...diagnostic,
				validationCode,
				reason: !body
					? "control_empty_output"
					: body.startsWith("```")
						? "control_markdown_fence"
						: "control_json_syntax",
				...(offset === undefined ? {} : { jsonOffset: Number(offset) }),
			},
		};
	}
}
