import { promptTime } from "../../inference";
import { systemContext } from "../../../infrastructure/system-context";

type Message = { role: "system" | "user" | "assistant"; content: string };
const failureRules = systemContext(
	"dialogue.contexts.research-result-context.failure-rules",
	{},
);

/**
 * The context of an answer to a failed research. It is built apart from the layers, so the answer cannot borrow
 * a past number, source or response shape: the memory layers, the goals and the history are left out, and the host's
 * failure record goes into the first system message (with the rules of the research results the system part
 * already carries), for models that give later system messages less weight. A report the sub-agent left stays
 * user data in the result.
 */
export function researchResultContext(
	sections: { system: Message; input: Message },
	projection: string | undefined,
	failureCode: string,
	nowMs: number,
) {
	const { input } = sections;
	const system: Message = {
		...sections.system,
		content:
			sections.system.content +
			"\n" +
			failureRules +
			"\nCURRENT_RESEARCH_FAILURE=" +
			JSON.stringify({
				code: failureCode,
				...(failureCode.startsWith("codex_research_")
					? {
							component: "research_model",
							detail:
								"調査モデルの処理で失敗しました。code以上の詳細原因は記録されていません。",
						}
					: {}),
			}),
	};
	const result: Message = {
		role: "user",
		content: JSON.stringify({
			...promptTime(nowMs),
			report: projection ? JSON.parse(projection) : null,
			failure: failureCode,
		}),
	};
	// A failed operation is explained from its current result, never old facts.
	return [system, result, input];
}
