import type { ComponentRecord } from "eumenes-pipeline";
import { z } from "zod";
import { checkPipelineDefinition } from "./definition";

const schemaRef = z.string().regex(/^(?:builtin|domain|schema):[^\s]{1,140}$/);
const output = z.strictObject({
	from: z.string().min(1),
	schemaRef,
});
const definitionSchema = z.strictObject({
	version: z.literal(1),
	trigger: z.enum(["manual", "schedule"]),
	input: z.strictObject({ schemaRef, fixed: z.record(z.string(), z.json()) }),
	pipeline: z.unknown(),
	checkpoint: output.optional(),
	publish: z.discriminatedUnion("kind", [
		output.extend({ kind: z.literal("dataset") }),
		output.extend({
			kind: z.literal("markdown"),
			destinationRef: z.string().min(1).max(160),
		}),
	]),
});

/** Completed values are described by the registered adapter, not a command receipt. */
export type WorkflowStepContract = {
	operationRef: string;
	outputSchemaRef: string;
	requestSchemas?: "workflow" | readonly string[];
	acceptedResultSchemas: readonly string[];
	checkpointSchemaRef?: string;
	coverageSchemaRefs?: readonly string[];
};

export type WorkflowCatalog = {
	components: readonly ComponentRecord[];
	schema(ref: string): z.ZodType | null;
	step(revisionId: string): WorkflowStepContract | null;
};

export class WorkflowPipelineError extends Error {
	constructor(
		readonly issues: { path: string; rule: string; detail: string }[],
	) {
		super("workflow_pipeline_invalid");
	}
}

export function checkWorkflowDefinition(
	raw: unknown,
	sourceRequest: string,
	catalog: WorkflowCatalog,
) {
	const definition = definitionSchema.parse(raw);
	const checked = checkPipelineDefinition(
		definition.pipeline,
		catalog.components,
		sourceRequest,
	);
	if (!checked.ok)
		throw new WorkflowPipelineError(
			checked.issues
				.filter((issue) => issue.severity === "error")
				.slice(0, 8)
				.map((issue) => ({
					path: "workflow.pipeline" + (issue.path ? "." + issue.path : ""),
					rule: issue.code,
					detail: issue.message.slice(0, 200),
				})),
		);

	const input = catalog.schema(definition.input.schemaRef);
	if (!(input instanceof z.ZodObject))
		throw new Error("workflow_schema_unavailable");
	for (const [name, value] of Object.entries(definition.input.fixed)) {
		if (
			!Object.hasOwn(input.shape, name) ||
			!input.shape[name].safeParse(value).success
		)
			throw new Error("workflow_fixed_input_invalid");
	}
	if (
		definition.trigger === "schedule" &&
		!input.strict().safeParse(definition.input.fixed).success
	)
		throw new Error("workflow_scheduled_input_incomplete");

	const steps = new Map<string, WorkflowStepContract>();
	const ancestors = new Map<string, Set<string>>();
	const { publish, checkpoint } = definition;
	const pins = checked.plan.steps.map((step) => {
		const contract = catalog.step(step.revisionId);
		if (!contract) throw new Error("workflow_step_unavailable");
		const outputSchemaRef =
			contract.outputSchemaRef === "publish" && step.stepId === publish.from
				? publish.schemaRef
				: contract.outputSchemaRef;
		if (!catalog.schema(outputSchemaRef))
			throw new Error("workflow_step_unavailable");
		if (
			step.from.includes("request") &&
			contract.requestSchemas !== "workflow" &&
			!contract.requestSchemas?.includes(definition.input.schemaRef)
		)
			throw new Error("workflow_step_request_incompatible");
		const sources = step.from.filter((ref) => ref !== "request");
		for (const source of sources) {
			const previous = steps.get(source);
			if (
				!previous ||
				!contract.acceptedResultSchemas.includes(previous.outputSchemaRef)
			)
				throw new Error("workflow_step_result_incompatible");
		}
		steps.set(step.stepId, { ...contract, outputSchemaRef });
		ancestors.set(
			step.stepId,
			new Set(sources.flatMap((ref) => [ref, ...ancestors.get(ref)!])),
		);
		return {
			stepId: step.stepId,
			toolchainRevisionId: step.revisionId,
			operationRef: contract.operationRef,
			outputSchemaRef,
		};
	});
	const publisher = steps.get(publish.from);
	if (
		!checked.plan.output.from.includes(publish.from) ||
		publisher?.outputSchemaRef !== publish.schemaRef
	)
		throw new Error("workflow_publish_incompatible");
	if (publisher.coverageSchemaRefs?.length && !checkpoint)
		throw new Error("workflow_checkpoint_required");
	if (
		checkpoint &&
		(!checked.plan.output.from.includes(checkpoint.from) ||
			!ancestors.get(publish.from)?.has(checkpoint.from) ||
			!catalog.schema(checkpoint.schemaRef) ||
			steps.get(checkpoint.from)?.checkpointSchemaRef !==
				checkpoint.schemaRef ||
			!publisher.coverageSchemaRefs?.includes(checkpoint.schemaRef))
	)
		throw new Error("workflow_checkpoint_incompatible");

	return { definition: { ...definition, pipeline: checked.definition }, pins };
}

export function workflowInputs(
	schema: z.ZodType,
	fixed: Record<string, unknown>,
	provided: Record<string, unknown>,
) {
	if (Object.keys(provided).some((key) => Object.hasOwn(fixed, key)))
		throw new Error("workflow_fixed_input_override");
	if (!(schema instanceof z.ZodObject))
		throw new Error("workflow_schema_unavailable");
	return schema.strict().parse({ ...fixed, ...provided });
}
