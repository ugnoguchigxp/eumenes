import { systemContext } from "../../../infrastructure/system-context";
import {
	packageRuntimeOf,
	zSchema,
	type Prepared,
	type SchemaKey,
	type ProfileSnapshot,
} from "../../capabilities";
import type { RequirementContract } from "../contracts/requirements";
import { z } from "zod";
import { delegatedTaskRules } from "../../inference";
import {
	researchAction,
	firstResearchAction,
	searchAction,
} from "./research-contract";
import { guidedActionFor, guidedWeb } from "./guided-contract";
import { returnsSearchResults, isQuickWeb } from "./exploration";
export type WorkerTool = {
	executionRef: string;
	replayOnly?: boolean;
	tool: { id: string; schemaKey?: SchemaKey; summary?: string };
};
const requirementPolicy =
	systemContext("agent-runtime.contexts.requirements.policy", {}) + "\n";
const searchPolicy =
	systemContext("agent-runtime.contexts.search.policy", {}) + "\n";
const quickSearchPolicy =
	systemContext("agent-runtime.contexts.quick-search.policy", {}) + "\n";
/** L1: shared by every route and never replaced by a route policy. */
export const commonRules = systemContext(
	"agent-runtime.contexts.worker-control.common-rules",
	{},
);
const policy = systemContext(
	"agent-runtime.contexts.worker-control.policy",
	{},
);
export function createWorkerControl(
	prepared: Prepared,
	tools: WorkerTool[],
	requirements?: {
		profiles: ProfileSnapshot[];
		contract: RequirementContract | null;
	},
) {
	// Results and immutable evidence are re-presented below. A spent tool's
	// replay grant cannot acquire anything new, so do not offer it as a next action.
	const search = returnsSearchResults(prepared);
	const guided = guidedWeb(prepared);
	const required = new Set([
		prepared.package.profileRevisionId,
		...(prepared.package.requiredSkillRevisionIds ?? []),
	]);
	const dependencies = prepared.dependencies.filter((d) =>
		required.has(d.revisionId),
	);
	if (
		dependencies.length !== required.size ||
		dependencies.some((d) => !d.body?.trim())
	)
		throw new Error("required_context_missing");
	const contractsFor = (list: typeof tools) =>
		list.map((t) => {
			const schema = t.tool.schemaKey
				? structuredClone(zSchema(t.tool.schemaKey))
				: null;
			if (schema?.properties)
				for (const key of ["sourceRef", "messageRef"])
					if (key in schema.properties)
						schema.properties[key] = {
							type: "string",
							pattern: "^d[1-9][0-9]*$",
						};
			if (t.tool.schemaKey === "readSaved" && schema?.properties) {
				schema.not = { required: ["cursor", "start"] };
				schema.properties.cursor = {
					...(schema.properties.cursor as Record<string, unknown>),
					description:
						"findのmatches.cursorか資料のnextCursorをそのまま指定する。cursorを使うときstartは省略する。",
				};
				schema.properties.start = {
					...(schema.properties.start as Record<string, unknown>),
					description: "cursorを使わず本文の先頭を読むときだけheadを指定する。",
				};
			}
			return {
				id: t.tool.id,
				description: t.tool.summary,
				inputSchema: schema,
				mode: t.replayOnly ? "replay" : "invoke",
			};
		});
	// A toolchain set loads its own SystemContext: profile and SKILL are the route policy.
	const ownSet =
		guided || packageRuntimeOf(prepared.package.id)?.context === "set";
	// L2: the route policy. L3: the contract, built as values.
	const routePolicy = ownSet
		? dependencies.map((d) => d.body!.trim()).join("\n\n")
		: search
			? isQuickWeb(prepared)
				? quickSearchPolicy
				: searchPolicy
			: policy +
				"\n" +
				requirementPolicy +
				systemContext(
					"agent-runtime.contexts.worker-control.route-policy",
					{},
				) +
				systemContext(
					"agent-runtime.contexts.worker-control.route-policy-2",
					{},
				);
	const outputSchema = z.toJSONSchema(
		guided
			? guidedActionFor(prepared)
			: search
				? searchAction
				: requirements?.contract
					? researchAction
					: firstResearchAction,
	);
	const instructionsFor = (contracts: unknown) =>
		delegatedTaskRules +
		"\n" +
		(search && !guided
			? systemContext(
					"agent-runtime.contexts.worker-control.instructions-for",
					{},
				) + "\n"
			: "") +
		routePolicy +
		"\n" +
		(guided
			? systemContext(
					"agent-runtime.contexts.worker-control.instructions-for-2",
					{},
				)
			: commonRules) +
		(search && !guided
			? systemContext(
					"agent-runtime.contexts.worker-control.instructions-for-3",
					{},
				)
			: "") +
		(ownSet
			? systemContext(
					"agent-runtime.contexts.worker-control.instructions-for-4",
					{},
				)
			: systemContext(
					"agent-runtime.contexts.worker-control.instructions-for-5",
					{},
				)) +
		"\nTOOLS=" +
		JSON.stringify(contracts);
	const controlFor = (contracts: ReturnType<typeof contractsFor>) => {
		const examples = (outputSchema as { examples?: Array<{ action?: string }> })
			.examples;
		const invocable = contracts.find((tool) => tool.mode === "invoke");
		return {
			instructions: instructionsFor(contracts),
			outputSchema:
				search && examples
					? {
							...outputSchema,
							examples: examples.flatMap((example) =>
								example.action === "invoke"
									? invocable
										? [{ ...example, tool: invocable.id }]
										: []
									: [example],
							),
						}
					: outputSchema,
		};
	};
	return { controlFor, contractsFor, dependencies, ownSet, search, guided };
}
