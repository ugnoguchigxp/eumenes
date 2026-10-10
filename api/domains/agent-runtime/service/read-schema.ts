import type { Source } from "../../tool-runtime";
import type { JSONSchema } from "zod/v4/core";
import { evidenceExcerpts } from "./evidence-excerpts";
type Schema = JSONSchema.JSONSchema;
function argumentsSchema(
	id: string,
	input: Schema | null,
	refs: string[],
	urls: string[],
): Schema {
	if (!input) return {};
	if (id === "web.read" && input.properties && urls.length)
		return {
			...input,
			properties: {
				...input.properties,
				url: { ...(input.properties.url as Schema), enum: urls },
			},
		};
	const reference = input.properties?.sourceRef;
	const scoped: Schema =
		reference && typeof reference !== "boolean" && refs.length
			? {
					...input,
					properties: {
						...input.properties,
						sourceRef: { ...reference, enum: refs },
					},
				}
			: input;
	if (id !== "web.read_saved" || !scoped.properties) return scoped;
	const { cursor, start, ...shared } = scoped.properties;
	return {
		oneOf: [
			{
				...scoped,
				properties: { ...shared, cursor: cursor ?? {} },
				required: ["sourceRef", "cursor"],
			},
			{
				...scoped,
				properties: { ...shared, start: start ?? {} },
				required: ["sourceRef"],
			},
		],
	};
}
function evidenceSchema(branch: Schema, visible: Source[]): Schema {
	if (
		branch.properties?.action &&
		typeof branch.properties.action !== "boolean" &&
		branch.properties.action.const !== "finish"
	)
		return branch;
	const choices: Schema[] = visible
		.filter((s) => s.viewId)
		.map((s) => ({
			type: "object",
			properties: {
				sourceId: { type: "string", const: s.sourceId },
				viewId: { type: "string", const: s.viewId },
				excerptId: {
					type: "string",
					enum: evidenceExcerpts(s.body).map((e) => e.excerptId),
				},
			},
			required: ["sourceId", "viewId", "excerptId"],
			additionalProperties: false,
		}));
	const report = branch.properties?.report as Schema | undefined;
	const claims = report?.properties?.claims as Schema | undefined;
	const claim = claims?.items as Schema | undefined;
	const evidence = claim?.properties?.evidence as Schema | undefined;
	if (!choices.length || !report || !claims || !claim || !evidence)
		return branch;
	return {
		...branch,
		properties: {
			...branch.properties,
			report: {
				...report,
				properties: {
					...report.properties,
					claims: {
						...claims,
						items: {
							...claim,
							properties: {
								...claim.properties,
								evidence: {
									...evidence,
									items: { oneOf: choices },
								},
							},
						},
					},
				},
			},
		},
	};
}
/** Reflect each granted tool's input in the control schema; refs remain host-issued data. */
export function readSchema(
	schema: Schema,
	contracts: Array<{ id: string; inputSchema: Schema | null }>,
	visible: Source[],
	urls: string[] = [],
): Schema {
	const refs = [
		...new Set(visible.flatMap((s) => (s.sourceRef ? [s.sourceRef] : []))),
	];
	const key = schema.oneOf ? "oneOf" : "anyOf";
	if (!schema[key]) return evidenceSchema(schema, visible);
	return {
		...schema,
		[key]: schema[key]!.flatMap<Schema>((branch) => {
			if (typeof branch === "boolean") return [branch];
			const action = branch.properties?.action;
			if (!action || typeof action === "boolean" || action.const !== "invoke")
				return [evidenceSchema(branch, visible)];
			return contracts.map<Schema>((tool) => {
				return {
					...branch,
					properties: {
						...branch.properties,
						executionRef: { type: "string", const: tool.id },
						arguments: argumentsSchema(tool.id, tool.inputSchema, refs, urls),
					},
				};
			});
		}),
	};
}
