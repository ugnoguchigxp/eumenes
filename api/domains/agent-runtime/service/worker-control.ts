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
const searchPolicy = systemContext("agent-runtime.contexts.search.policy", {});
const quickSearchPolicy = systemContext(
	"agent-runtime.contexts.quick-search.policy",
	{},
);
/** L1: shared by every route except the guided one, and never replaced by a route policy. */
export const commonRules = systemContext(
	"agent-runtime.contexts.worker-control.common-rules",
	{},
);
/** The guided route's own SKILL carries its procedure; only the shared boundary is added. */
const guidedRules = systemContext(
	"agent-runtime.contexts.worker-control.guided-rules",
	{},
);
/** Reply contract of the routes that return source-linked findings (`report: "search"`). */
const searchRules = systemContext(
	"agent-runtime.contexts.worker-control.search-rules",
	{},
);
/** Role, requirement procedure and prohibitions of the requirement-graded research route. */
const researchPolicy = systemContext(
	"agent-runtime.contexts.worker-control.research-policy",
	{},
);
const documentRef = {
	sourceRef: "資料操作の対象。documentの短い参照（d1など）を指定する。",
	messageRef:
		"会話記録の参照。documentの短い参照（d1など）を指定する。報告には会話記録のspeakerとcreatedAtを添え、過去のAssistant発言を現在の事実保証にしない。",
} as const;
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
				for (const key of ["sourceRef", "messageRef"] as const)
					if (key in schema.properties)
						schema.properties[key] = {
							type: "string",
							pattern: "^d[1-9][0-9]*$",
							description: documentRef[key],
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
			: researchPolicy;
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
		routePolicy +
		"\n" +
		(search && !guided ? searchRules + "\n" : "") +
		(guided ? guidedRules : commonRules) +
		"\nTOOLS=" +
		JSON.stringify(contracts);
	const controlFor = (contracts: ReturnType<typeof contractsFor>) => {
		const examples = (outputSchema as { examples?: Array<{ action?: string }> })
			.examples;
		const invocable = contracts.find((tool) => tool.mode === "invoke");
		return {
			instructions: instructionsFor(contracts),
			outputSchema: examples
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
