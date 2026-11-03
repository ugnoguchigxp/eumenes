import { getLogger } from "../../../infrastructure/logger";
import { systemContext } from "../../../infrastructure/system-context";
import {
	routeCriterionName,
	routeQuestionName,
	type RouteCriterion,
	type RouteFieldsAnswer,
	type RouteFieldsInput,
} from "../../inference/contracts";
import { lineText } from "./input-text";
import { askBack, type Step } from "./routed-actions";
import {
	MEMORY_KINDS,
	MEMORY_REQUEST,
	NEW_TARGET,
	fillMessages,
	fillSchema,
} from "./routed-choice";
import type { RouteCandidate } from "./routed-route";
import type { ActiveRouter } from "./routed-router";
import { reasonOf } from "./routed-router";
import { styleOf } from "./routed-search";
import type { Turn } from "./routed-turn";

const log = getLogger("dialogue");

/**
 * The chosen candidate's fields (spec toolchain-router-redesign §3.4): the enumerated ones are choices of the router's
 * second call, the free ones one extraction, a session's target a choice of `new` and its saved items. A candidate
 * whose fields it cannot fill (the call is not served, it failed, or a required field came back empty) is filled by
 * the one-candidate call of the conversation model: the only model call a router turn may still make.
 */
export type Filled = { fields: Record<string, unknown> } | { step: Step };

type Target =
	Extract<RouteCandidate, { kind: "toolchain" | "read" }> | "memory";

type Plan = {
	input: Pick<RouteFieldsInput, "choices" | "extract">;
	/** The fields from the answer; null when a required one is missing. */
	assemble(answer: RouteFieldsAnswer): Record<string, unknown> | null;
};

/** The longest label of a saved item as a criterion. */
const LABEL_CHARS = 100;
/** The kinds of a memory request, as the router reads them. */
const KIND_PASSAGES = {
	forget: "dialogue.contexts.local.router-kind-forget",
	remember: "dialogue.contexts.local.router-kind-remember",
	correct: "dialogue.contexts.local.router-kind-correct",
	goal: "dialogue.contexts.local.router-kind-goal",
	withdraw: "dialogue.contexts.local.router-kind-withdraw",
} as const;
/** The extraction's own question name (LARM's). */
const EXTRACT_QUESTION = "fields";

type Property = { type?: unknown; enum?: unknown; description?: unknown };
const EXTRACTED = {
	string: "string",
	number: "number",
	integer: "number",
	boolean: "boolean",
} as const;

const memoryPlan = (): Plan => ({
	input: {
		choices: {
			kind: {
				instructions: systemContext(
					"dialogue.contexts.local.router-field-memory-kind",
					{},
				),
				criteria: MEMORY_KINDS.map((kind) => ({
					name: kind,
					description: systemContext(KIND_PASSAGES[kind], {}),
				})),
			},
		},
		extract: {
			instructions: systemContext(
				"dialogue.contexts.local.router-field-extract-memory",
				{},
			),
			schema: {
				type: "object",
				required: ["what"],
				properties: {
					what: {
						type: "string",
						description: systemContext(
							"dialogue.contexts.local.router-field-memory-what",
							{},
						),
					},
					detail: {
						type: "string",
						description: systemContext(
							"dialogue.contexts.local.router-field-memory-detail",
							{},
						),
					},
				},
			},
		},
	},
	assemble(answer) {
		const kind = answer.choices.kind;
		const what = answer.values?.what;
		const detail = answer.values?.detail;
		if (!MEMORY_KINDS.some((k) => k === kind)) return null;
		if (typeof what !== "string" || !what.trim()) return null;
		return {
			kind,
			what,
			...(typeof detail === "string" && detail.trim() ? { detail } : {}),
		};
	},
});

/** The plan for a toolchain's inputs and saved targets; "none" when it takes neither, "fill" when it can not be asked. */
function toolchainPlan(
	turn: Turn,
	target: Exclude<Target, "memory">,
): Plan | "none" | "fill" {
	const { choice, card } = target;
	// The word that lets the suspended unsaved work go is read by the conversation model alone.
	if (turn.routed!.switching === choice.id) return "fill";
	const schema = choice.inputs as
		{ properties?: Record<string, Property>; required?: string[] } | undefined;
	const required = new Set(schema?.required ?? []);
	const choices: RouteFieldsInput["choices"] = {};
	const free: Record<
		string,
		NonNullable<RouteFieldsInput["extract"]>["schema"]["properties"][string]
	> = {};
	for (const [name, property] of Object.entries(schema?.properties ?? {})) {
		if (!routeQuestionName.test(name) || name === EXTRACT_QUESTION)
			return "fill";
		const description =
			typeof property.description === "string"
				? property.description
				: undefined;
		if (Array.isArray(property.enum)) {
			const values = property.enum;
			if (
				!values.every(
					(v): v is string =>
						typeof v === "string" && routeCriterionName.test(v),
				)
			)
				return "fill";
			choices[name] = {
				instructions:
					description ??
					systemContext("dialogue.contexts.local.router-field-choice", {
						field: name,
					}),
				criteria: values.map((value) => ({ name: value, description: value })),
			};
		} else {
			const type = EXTRACTED[property.type as keyof typeof EXTRACTED];
			if (!type) return "fill";
			free[name] = { type, ...(description ? { description } : {}) };
		}
	}
	const targets = choice.targets ?? [];
	if (targets.length) {
		if ("target" in choices || "target" in free) return "fill";
		const criteria: RouteCriterion[] = [
			{
				name: NEW_TARGET,
				description: systemContext(
					"dialogue.contexts.local.router-field-new",
					{},
				),
			},
			...targets.map((t) => ({
				name: t.ref,
				description: systemContext(
					"dialogue.contexts.local.router-field-label",
					{
						label: lineText(t.label).slice(0, LABEL_CHARS) || t.ref,
					},
				),
			})),
		];
		if (!criteria.every((c) => routeCriterionName.test(c.name))) return "fill";
		choices.target = {
			instructions: systemContext(
				"dialogue.contexts.local.router-field-target",
				{},
			),
			criteria,
		};
	}
	const freeNames = Object.keys(free);
	if (!Object.keys(choices).length && !freeNames.length) return "none";
	const hasInputs = !!schema?.properties;
	return {
		input: {
			choices,
			extract: freeNames.length
				? {
						instructions: systemContext(
							"dialogue.contexts.local.router-field-extract",
							{ title: lineText(card.title).slice(0, 30) },
						),
						schema: {
							type: "object",
							required: freeNames.filter((name) => required.has(name)),
							properties: free,
						},
					}
				: null,
		},
		assemble(answer) {
			const inputs: Record<string, unknown> = {};
			for (const [name, question] of Object.entries(choices)) {
				if (name === "target") continue;
				const value = answer.choices[name];
				if (question.criteria.some((c) => c.name === value))
					inputs[name] = value;
				else if (required.has(name)) return null;
			}
			for (const [name, property] of Object.entries(free)) {
				const value = answer.values?.[name];
				if (
					typeof value === property.type &&
					(property.type !== "string" || String(value).trim())
				)
					inputs[name] = value;
				else if (required.has(name)) return null;
			}
			const picked = answer.choices.target;
			return {
				...(hasInputs ? { inputs } : {}),
				...(typeof picked === "string" && picked !== NEW_TARGET
					? { target: picked }
					: {}),
			};
		},
	};
}

/** The fields of the target for `text`: by the router's second call, else by the conversation model's fill. */
export async function fieldsOf(
	turn: Turn,
	router: ActiveRouter,
	text: string,
	target: Target,
	/** The model of the router's answer: one that refused to extract is not asked to again for a while. */
	model: string | null,
): Promise<Filled> {
	const plan = target === "memory" ? memoryPlan() : toolchainPlan(turn, target);
	if (plan === "none") return { fields: {} };
	if (
		plan !== "fill" &&
		router.routeFields &&
		!(plan.input.extract && refused(turn, model))
	) {
		const asked = await askFields(turn, router, text, plan, model);
		if (asked) return { fields: asked };
	}
	return fill(turn, text, target);
}

/** The code of a deployed model that cannot extract (LARM's `route` contract: HTTP 400 `unsupported_question_type`). */
const EXTRACT_UNSUPPORTED = "larm_route_extract_unsupported";
/** How long a model that could not extract is left alone: its deployment does not change within minutes. */
const EXTRACT_REFUSAL_MS = 10 * 60 * 1000;
const extractRefusals = new Map<string, number>();
const refused = (turn: Turn, model: string | null) =>
	(extractRefusals.get(model ?? "") ?? 0) > Date.parse(turn.deps.clock());

/** The router's second call; null when it can not give the fields (the caller fills them). */
async function askFields(
	turn: Turn,
	router: ActiveRouter,
	text: string,
	plan: Plan,
	model: string | null,
): Promise<Record<string, unknown> | null> {
	const routed = turn.routed!;
	const timeout = AbortSignal.timeout(router.settings.timeoutMs);
	try {
		const answer = await router.routeFields!(
			{
				text: text.trim(),
				previousAgent: routed.previousReply,
				previousUser: routed.earlier.at(-1) ?? null,
				...plan.input,
			},
			AbortSignal.any([turn.signal, timeout]),
		);
		return plan.assemble(answer);
	} catch (error) {
		if (turn.signal.aborted) throw error;
		if (error instanceof Error && error.message === EXTRACT_UNSUPPORTED)
			extractRefusals.set(
				model ?? "",
				Date.parse(turn.deps.clock()) + EXTRACT_REFUSAL_MS,
			);
		log.warn("dialogue.router_fields_failed", {
			reason: reasonOf(error, timeout),
		});
		return null;
	}
}

/** The conversation model fills the one candidate's fields (it may also find nothing to ask for, or ask back). */
async function fill(turn: Turn, text: string, target: Target): Promise<Filled> {
	const routed = turn.routed!;
	const candidate = target === "memory" ? MEMORY_REQUEST : target.choice;
	const chosen = await turn.choose(
		fillMessages({ style: styleOf(turn), routed, candidate, utterance: text }),
		fillSchema(candidate, routed),
	);
	log.info("dialogue.choice_made", {
		kind: "fill",
		decision:
			chosen === "cut" || !chosen
				? "unreadable"
				: chosen.choice === "ask"
					? "ask"
					: chosen.choice === "none"
						? "none"
						: "fill",
	});
	if (chosen === "cut" || !chosen || chosen.choice === "none")
		return { step: "talk" };
	if (chosen.choice === "ask")
		return {
			step: askBack(turn, typeof chosen.say === "string" ? chosen.say : ""),
		};
	if (chosen.choice !== (target === "memory" ? MEMORY_REQUEST : target.id))
		return { step: "talk" };
	return { fields: chosen };
}
