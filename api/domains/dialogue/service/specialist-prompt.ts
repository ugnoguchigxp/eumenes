import { z } from "zod";
import { systemContext } from "../../../infrastructure/system-context";
import { controlInstructions, type ControlContract } from "../../inference";
import type { SpecialistSet } from "../contracts";
import { isBriefSpokenReply, SPOKEN_REPLY_MAX_CHARS } from "../../delivery";

/**
 * The specialist's whole contract: one object whose `action` says what the turn does. A flat object
 * (not a union) so that a model fills one shape; the host checks which fields the action needs.
 */
const outputShape = z
	.object({
		action: z.enum(["reply", "invoke", "return", "discard"]),
		text: z
			.string()
			.trim()
			.max(SPOKEN_REPLY_MAX_CHARS)
			.refine(isBriefSpokenReply)
			.optional(),
		tool: z.string().min(1).max(64).optional(),
		arguments: z.record(z.string(), z.unknown()).optional(),
		forward: z.boolean().optional(),
	})
	.strict()
	.meta({
		examples: [
			{ action: "reply", text: "利用者への説明・質問・完了報告" },
			{ action: "invoke", tool: "TOOLSのid", arguments: {} },
			{ action: "return", forward: false, text: "戻る旨" },
			{ action: "discard", text: "破棄した旨" },
		],
	});

export type SpecialistAction =
	| { kind: "reply"; text: string }
	| { kind: "invoke"; tool: string; arguments: Record<string, unknown> }
	| { kind: "return"; forward: boolean; text?: string }
	| { kind: "discard"; text?: string };

/** The object a model returned, as a typed action; null when it breaks the contract. */
export function parseSpecialistAction(value: unknown): SpecialistAction | null {
	const parsed = outputShape.safeParse(value);
	if (!parsed.success) return null;
	const out = parsed.data;
	const text = out.text || undefined;
	if (out.action === "reply")
		return text && !out.tool && out.forward === undefined
			? { kind: "reply", text }
			: null;
	if (out.action === "invoke")
		return out.tool && !text && out.forward === undefined
			? { kind: "invoke", tool: out.tool, arguments: out.arguments ?? {} }
			: null;
	if (out.action === "return")
		return out.forward !== undefined && !out.tool
			? { kind: "return", forward: out.forward, ...(text ? { text } : {}) }
			: null;
	return !out.tool && out.forward === undefined
		? { kind: "discard", ...(text ? { text } : {}) }
		: null;
}

const RULES = systemContext("dialogue.contexts.specialist-turn.rules", {});
const CORRECTION = systemContext(
	"dialogue.contexts.specialist-turn.correction",
	{},
);

/**
 * The specialist's fixed instructions: the package's profile and SKILL, the generic specialist rules and
 * the tools. No conversation, memory or World layer joins them.
 */
export function specialistControl(set: SpecialistSet): ControlContract {
	const tools = set.tools.map((tool) => ({
		id: tool.id,
		description: tool.summary,
		inputSchema: tool.schema,
	}));
	return {
		instructions:
			set.profile +
			"\n\n" +
			set.skills.join("\n\n") +
			"\n\n" +
			RULES +
			"\nTOOLS=" +
			JSON.stringify(tools),
		outputSchema: z.toJSONSchema(outputShape),
	};
}
export const specialistSystemMessage = (control: ControlContract) => ({
	role: "system" as const,
	content: controlInstructions(control),
});

/** The turn's input as data: the request, the current work and when it is. */
export function specialistInput(input: {
	request: string;
	userUtterance?: string;
	label: string;
	dirty: boolean;
	current: unknown;
	savedRef: string | null;
	viewing: { toolchainId: string; ref: string; label: string } | null;
}) {
	return JSON.stringify({
		request: input.request,
		...(input.userUtterance ? { userUtterance: input.userUtterance } : {}),
		currentWork: input.current,
		savedRef: input.savedRef,
		viewing: input.viewing,
		label: input.label,
		dirty: input.dirty,
		now: new Date().toISOString(),
		timeZone: "Asia/Tokyo",
	});
}

/** The rejected output kept short, as data, with the instruction to answer again. */
export function correctionMessage(raw: string) {
	return {
		role: "user" as const,
		content:
			CORRECTION +
			"\nREJECTED_OUTPUT=" +
			JSON.stringify({ preview: raw.slice(0, 2000) }),
	};
}

/** The tool's result (or the host's refusal code) as the next input of the same turn. */
export function toolResultMessage(result: unknown) {
	const json = JSON.stringify(result);
	return {
		role: "user" as const,
		content:
			"TOOL_RESULT=" +
			(json.length > 24_000
				? JSON.stringify({ truncated: true, preview: json.slice(0, 24_000) })
				: json),
	};
}
