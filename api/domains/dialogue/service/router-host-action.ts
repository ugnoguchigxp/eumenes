import type { Analyze, SelectionResult, SelectionTurn } from "eumenes_router";
import { systemContext } from "../../../infrastructure/system-context";

type Prompt = Parameters<Analyze>[0];
type Candidate = NonNullable<SelectionTurn["dynamic"]>[number];

export class HostAction extends Error {
	constructor(readonly decision: SelectionResult["decision"]) {
		super("router_host_action");
	}
}

/** The host's finite operations share the package's first structured judgment. */
export function hostActionAnalyzer(
	analyze: Analyze,
	dynamic: readonly Candidate[],
	latest: string,
): Analyze {
	const actions = dynamic.filter(
		(candidate) =>
			!(candidate.kind === "pending" && candidate.operation === "answer") &&
			!(candidate.kind === "work" && candidate.operation === "cancel"),
	);
	if (!actions.length) return analyze;
	const byId = new Map(actions.map((candidate) => [candidate.id, candidate]));
	const instructions = systemContext(
		"dialogue.contexts.local.router-host-action",
		{},
	);
	return async (prompt: Prompt) => {
		const schema = structuredClone(prompt.outputSchema) as {
			properties: { decision: { anyOf: unknown[] } };
		};
		const object = (properties: Record<string, unknown>) => ({
			type: "object",
			properties,
			required: Object.keys(properties),
			additionalProperties: false,
		});
		schema.properties.decision.anyOf.push(
			object({
				hostAction: object({
					ref: { type: "string", enum: [...byId.keys()] },
					text: { type: "string", enum: [latest] },
				}),
			}),
		);
		const raw = await analyze({
			...prompt,
			system: `${prompt.system}\n\n${instructions}`,
			outputSchema: schema,
			user: JSON.stringify({
				...JSON.parse(prompt.user),
				latest,
				hostActions: actions.map(({ id, passage }) => ({
					ref: id,
					description: passage,
				})),
			}),
		});
		if (raw.length > 65536) return raw;
		let value: unknown;
		try {
			value = JSON.parse(raw);
		} catch {
			return raw;
		}
		if (!value || typeof value !== "object" || !("decision" in value))
			return raw;
		const decision = value.decision;
		if (
			!decision ||
			typeof decision !== "object" ||
			!("hostAction" in decision)
		)
			return raw;
		const action = decision.hostAction;
		if (
			Object.keys(value).length !== 1 ||
			Object.keys(decision).length !== 1 ||
			!action ||
			typeof action !== "object" ||
			Object.keys(action).length !== 2 ||
			!("ref" in action) ||
			typeof action.ref !== "string" ||
			!("text" in action) ||
			action.text !== latest
		)
			throw new Error("router_host_action_invalid");
		const candidate = byId.get(action.ref);
		if (!candidate) throw new Error("router_host_action_invalid");
		const row =
			candidate.kind === "pending" ? 5 : candidate.kind === "redirect" ? 6 : 2;
		throw new HostAction({ row, to: "run", candidate, announce: "none" });
	};
}
