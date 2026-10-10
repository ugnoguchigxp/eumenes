import type { LogFields } from "../../../infrastructure/logger";
import { valueType } from "../../../infrastructure/validation-log";
import { bytes } from "../../capabilities";
export const codeOf = (code: string, fallback: string) =>
	/^[a-z_]{1,80}$/.test(code) ? code : fallback;
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
	if (diagnostic.bytes > 12288)
		return {
			action: undefined,
			invalid: true,
			diagnostic: {
				...diagnostic,
				reason: "control_output_too_large",
				limit: 12288,
			},
		};
	const text = value.trim();
	// Decode a whole JSON code block only. Never search prose for a plausible action.
	const wrapped = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(text);
	try {
		const action: unknown = JSON.parse(wrapped?.[1] ?? text);
		if (action && typeof action === "object" && "action" in action) {
			diagnostic.controlAction =
				typeof action.action === "string" &&
				[
					"respond",
					"clarify",
					"discover",
					"timer",
					"select",
					"refine",
					"unavailable",
					"invoke",
					"finish",
				].includes(action.action)
					? action.action
					: "unrecognized";
		}
		return { action, invalid: false, diagnostic };
	} catch (error) {
		// Extract only a numeric parser offset, never the parser's quoted input.
		const offset =
			error instanceof SyntaxError
				? /\bposition (\d+)\b/.exec(error.message)?.[1]
				: undefined;
		const message = error instanceof SyntaxError ? error.message : "";
		const validationCode = /Unexpected (?:EOF|end)/i.test(message)
			? "unexpected_end"
			: /Expected '\}'/.test(message)
				? "expected_object_end"
				: /Expected '\]'/.test(message)
					? "expected_array_end"
					: /Property name must/.test(message)
						? "expected_property_name"
						: /Unexpected identifier/.test(message)
							? "unexpected_identifier"
							: "invalid_json_syntax";
		return {
			action: undefined,
			invalid: true,
			diagnostic: {
				...diagnostic,
				validationCode,
				reason: !text
					? "control_empty_output"
					: text.startsWith("```")
						? "control_markdown_fence"
						: "control_json_syntax",
				...(offset === undefined ? {} : { jsonOffset: Number(offset) }),
			},
		};
	}
}
