import { estimateJsonTokens } from "../../inference";
import { analysisTools, type TaskOffer } from "./initial-decision";

/** The model needs host refs and small labels; identities, hashes and full results stay with the host. */
export function taskOfferProjection(tasks: TaskOffer) {
	return {
		references: tasks.references.map((ref) => ({
			ref: ref.ref,
			kind: ref.kind,
			label: ref.label,
			preview: ref.preview.slice(0, 120),
		})),
		works: tasks.works.map((work) => ({
			workRef: work.id,
			revision: work.revision,
			status: work.status,
			purpose: work.request.slice(0, 120),
			question: work.question
				? {
						id: work.question.id,
						prompt: work.question.prompt.slice(0, 200),
						inputSchema: work.question.inputSchema,
					}
				: null,
			resultRefs: work.result?.refs.slice(0, 4) ?? [],
		})),
	};
}
/** Additional definitions and work references together fit P0's 1,024-token control allowance. */
export function fitTaskOffer(tasks: TaskOffer): TaskOffer {
	const fitted = {
		...tasks,
		references: [...tasks.references],
		works: [...tasks.works],
	};
	const base = estimateJsonTokens(
		analysisTools([], new Set(), true, undefined, false),
	);
	const used = () =>
		estimateJsonTokens(taskOfferProjection(fitted)) +
		estimateJsonTokens(analysisTools([], new Set(), true, fitted, false)) -
		base;
	while (used() > 1024 && fitted.works.length > 1) fitted.works.pop();
	while (used() > 1024 && fitted.references.length) fitted.references.pop();
	if (used() > 1024) throw new Error("execution_context_capacity");
	return fitted;
}
