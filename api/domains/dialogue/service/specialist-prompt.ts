import {
	createCollaborationContract,
	collaborationInstructions,
} from "eumenes-collaboration";
import { systemContext } from "../../../infrastructure/system-context";
import {
	agentControl,
	rejectedOutputMessage,
	type ControlContract,
} from "../../inference";
import type { SpecialistSet } from "../contracts";
import {
	isBriefSpokenReply,
	SPOKEN_REPLY_MAX_CHARS,
	SPOKEN_REPLY_MAX_SENTENCES,
	spokenReplyMeasure,
} from "../../delivery";

export type { SpecialistAction } from "eumenes-collaboration";

/** Common collaboration decisions; delivery limits remain the host's contract. */
const contract = createCollaborationContract({
	maxChars: SPOKEN_REPLY_MAX_CHARS,
	maxSentences: SPOKEN_REPLY_MAX_SENTENCES,
	validate: isBriefSpokenReply,
	measure: spokenReplyMeasure,
	description:
		"短い返答。replyでは必須。invokeでは操作が成功したときの返答（任意）。音声で聞かれるため通常一文、補足込みでも二文・300字以内。制作物や実装内容は読み上げない。",
});

export const parseSpecialistAction = contract.parse;
export const specialistViolations = contract.violations;
export const violationNames = contract.violationNames;

const HOST_RULES = systemContext("dialogue.contexts.specialist-turn.rules", {});
const RULES = [collaborationInstructions.rules, HOST_RULES].join("\n");

/** The binding chooses profile, skills and tools; session execution and authority stay in the host. */
export function specialistControl(
	set: SpecialistSet,
	hostTools: ReadonlyArray<{
		id: string;
		description: string;
		inputSchema: unknown;
	}> = [],
	replyOnly = false,
): ControlContract {
	const schema = contract.outputSchema;
	const outputSchema = replyOnly
		? {
				...schema,
				properties: {
					...schema.properties,
					action: {
						type: "string",
						enum: ["reply"],
						description:
							"既に開始した作業の観測を説明するか、その質問を利用者へ伝える。新規の操作や承認は行わない。",
					},
				},
			}
		: schema;
	return agentControl({
		profile: set.profile,
		skills: set.skills,
		rules: RULES,
		tools: replyOnly
			? []
			: [
					...set.tools.map((tool) => ({
						id: tool.id,
						description: tool.summary,
						inputSchema: tool.schema,
					})),
					...hostTools,
				],
		outputSchema,
	});
}

/** Rejected output remains reference data, followed by the shared repair instruction. */
export const correctionMessage = (
	raw: string,
	violations: ReturnType<typeof specialistViolations>,
	callsLeft: number,
) =>
	rejectedOutputMessage(
		[collaborationInstructions.correction, HOST_RULES].join("\n"),
		raw,
		violations,
		callsLeft,
	);
