import { systemContext } from "../../../infrastructure/system-context";
import type { ContextSections } from "./context-compiler";

type Message = { role: "system" | "user" | "assistant"; content: string };
// Required rules keep reported certainty intact; presentation rules only shape the wording.
const requiredRules = systemContext(
	"dialogue.contexts.research-result-context.required-rules",
	{},
);
const presentation = systemContext(
	"dialogue.contexts.research-result-context.presentation",
	{},
);
// Only for a report that cites World records (sources of kind world_claim): they have no URL and are not external facts.
const worldRules = systemContext(
	"dialogue.contexts.research-result-context.world-rules",
	{},
);
const documentRules = systemContext(
	"dialogue.contexts.research-result-context.document-rules",
	{},
);
const policy = requiredRules + "\n" + presentation;
const failureRules = systemContext(
	"dialogue.contexts.research-result-context.failure-rules",
	{},
);

const citesWorld = (projection: string | undefined, kind = "world_claim") => {
	if (!projection) return false;
	try {
		const { sources } = JSON.parse(projection) as { sources?: unknown };
		return (
			Array.isArray(sources) &&
			sources.some((s) => (s as { kind?: unknown } | null)?.kind === kind)
		);
	} catch {
		return false;
	}
};

/**
 * Keep the current request and report required; remove only optional earlier turns (kept exchanges first,
 * oldest first). The layers keep their places: memory and the summary are never dropped or repeated.
 */
export function researchResultContext(
	sections: Pick<
		ContextSections,
		| "system"
		| "longTerm"
		| "goals"
		| "history"
		| "working"
		| "unprocessed"
		| "input"
	>,
	projection: string | undefined,
	failureCode?: string | null,
) {
	const { input, longTerm, goals, working } = sections;
	// Both lists are oldest first; the kept exchanges are the older part.
	const history = [...sections.history];
	const unprocessed = [...sections.unprocessed];
	const system: Message = {
		...sections.system,
		content:
			sections.system.content +
			"\n" +
			policy +
			(citesWorld(projection) ? "\n" + worldRules : "") +
			(citesWorld(projection, "world_document") ? "\n" + documentRules : "") +
			(failureCode
				? "\n" +
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
					})
				: ""),
	};
	const result: Message = {
		role: "user",
		content: JSON.stringify({
			now: new Date().toISOString(),
			timeZone: "Asia/Tokyo",
			report: projection ? JSON.parse(projection) : null,
			failure: failureCode ?? undefined,
		}),
	};
	// Put host failure authority in the first system message, including for models
	// that give later system messages less weight. Acquired reports stay user data.
	const assemble = () => [
		system,
		// A failed operation is explained from its current result, never old facts.
		// The accepted report (if any) stays below; no semantic input classification.
		...(!failureCode
			? [...longTerm, ...goals, ...history, ...working, ...unprocessed]
			: []),
		result,
		input,
	];
	while (
		history.length + unprocessed.length &&
		Buffer.byteLength(JSON.stringify(assemble())) > 65536
	)
		(history.length ? history : unprocessed).splice(
			0,
			Math.min(2, (history.length ? history : unprocessed).length),
		);
	if (Buffer.byteLength(JSON.stringify(assemble())) > 65536)
		throw new Error("required_context_overflow");
	return assemble();
}
