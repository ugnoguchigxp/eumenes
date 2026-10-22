import { z } from "zod";

/**
 * A task pipeline (spec task-pipeline-design 2026-10-22 §4): a fixed procedure of existing toolchains, carried
 * whole by its versioned `execution:"pipeline"` binding. The host runs the steps in order; the model only picks the
 * pipeline, fills its inputs from the request, and works each step as that toolchain's own single task.
 */

export const PIPELINE_MAX_STEPS = 8;
const name = z.string().regex(/^[a-z][a-z0-9_]{0,30}$/);
/** A step id: also the name its values are referenced by (`${steps.<id>.summary}`). */
const stepId = z
	.string()
	.regex(/^[a-z][a-z0-9_]{0,30}$/)
	.refine((v) => v !== "inputs" && v !== "steps", "reserved step id");
/** Text with `${...}` references to the inputs and earlier steps; checked by the pipelines domain. */
const template = (max: number) => z.string().trim().min(1).max(max);

/** A typed input the first round fills from the user's request. `<name>_quote` is reserved for its quote. */
const pipelineInput = z
	.strictObject({
		type: z.enum(["string", "integer", "number", "boolean"]),
		description: z.string().trim().min(1).max(200),
		required: z.boolean(),
		default: z.union([z.string().max(500), z.number(), z.boolean()]).optional(),
		enum: z.array(z.string().min(1).max(100)).min(1).max(16).optional(),
		minimum: z.number().optional(),
		maximum: z.number().optional(),
		maxLength: z.number().int().min(1).max(500).optional(),
	})
	.refine((i) => !(i.required && i.default !== undefined), {
		message: "a required input has no default",
		path: ["default"],
	})
	.refine((i) => !i.enum || i.type === "string", {
		message: "enum is for strings",
		path: ["enum"],
	});
export type PipelineInput = z.infer<typeof pipelineInput>;

/** The one value an extract step takes out of text. */
export const pipelineValueSchema = z.strictObject({
	type: z.enum(["string", "integer", "number", "boolean"]),
	enum: z.array(z.string().min(1).max(100)).min(1).max(16).optional(),
	minimum: z.number().optional(),
	maximum: z.number().optional(),
	/** An extract call is short (its output is bounded): a value of up to 500 characters. */
	maxLength: z.number().int().min(1).max(500).optional(),
});
export type PipelineValueSchema = z.infer<typeof pipelineValueSchema>;

/**
 * A step handed to an existing toolchain as a child of the run. `request` is the request it gets; an instant
 * toolchain gets `arguments` (each a template or a literal). `uses` passes earlier steps' results as references.
 * `require` names the paths of the step's result (`summary`, `output.<key>…`) that must be present.
 */
const toolchainStep = z.strictObject({
	id: stepId,
	kind: z.literal("toolchain"),
	title: z.string().trim().min(1).max(40),
	toolchain: z.string().regex(/^[a-z][a-z0-9._-]{0,100}$/),
	request: template(2000),
	arguments: z
		.record(name, z.union([template(500), z.number(), z.boolean()]))
		.optional(),
	uses: z.array(stepId).max(PIPELINE_MAX_STEPS).optional(),
	require: z
		.array(z.string().regex(/^(summary|output(\.[A-Za-z0-9_-]{1,64}){0,6})$/))
		.max(8)
		.optional(),
});
/** A step that takes one typed value out of earlier text (the host checks it against `schema`). */
const extractStep = z.strictObject({
	id: stepId,
	kind: z.literal("extract"),
	title: z.string().trim().min(1).max(40),
	from: z.array(template(500)).min(1).max(4),
	instruction: z.string().trim().min(1).max(500),
	schema: pipelineValueSchema,
});
export const pipelineStep = z.discriminatedUnion("kind", [
	toolchainStep,
	extractStep,
]);
export type PipelineStep = z.infer<typeof pipelineStep>;

const json = z.union([z.string(), z.number(), z.boolean(), z.null()]);
/** A fixture case: an utterance, the inputs it should give, fake step results, and the values to expect. */
const pipelineTest = z.strictObject({
	utterance: z.string().trim().min(1).max(500),
	inputs: z.record(name, json),
	stepResults: z.record(
		stepId,
		z.strictObject({
			state: z.enum(["completed", "failed"]).optional(),
			summary: z.string().max(2000).optional(),
			output: z.unknown().optional(),
			value: json.optional(),
		}),
	),
	expect: z.record(z.string().max(200), json),
});

export const pipelineDefinitionV1 = z
	.strictObject({
		formatVersion: z.literal(1),
		/** Short enough for its function name, `pipeline_<id>` (41 characters at most). */
		id: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),
		title: z.string().trim().min(1).max(60),
		summary: z.string().trim().min(1).max(400),
		useWhen: z.array(z.string().trim().min(1).max(200)).min(1).max(8),
		avoidWhen: z.array(z.string().trim().min(1).max(200)).max(8),
		inputs: z
			.record(name, pipelineInput)
			.refine((r) => Object.keys(r).length <= 8, "at most 8 inputs")
			.refine(
				(r) => Object.keys(r).every((k) => !k.endsWith("_quote")),
				"`_quote` names the quote of an input",
			),
		steps: z.array(pipelineStep).min(2).max(PIPELINE_MAX_STEPS),
		answer: template(1000).optional(),
		tests: z.array(pipelineTest).max(8).optional(),
	})
	.refine((d) => new Set(d.steps.map((s) => s.id)).size === d.steps.length, {
		message: "step ids are unique",
		path: ["steps"],
	});
export type PipelineDefinition = z.infer<typeof pipelineDefinitionV1>;

/** The user's own edit of the studio's draft on the screen: the whole text, checked like the specialist's. */
export const pipelineSourceApply = z.strictObject({
	workRef: z.uuid(),
	expectedRevision: z.number().int().min(0),
	text: z.string().min(1).max(65_536),
});
/** Publishing the studio's draft; the screen names the draft revision it showed. */
export const pipelineWorkStep = z.strictObject({
	workRef: z.uuid(),
	expectedRevision: z.number().int().min(0),
});
/** A published pipeline a studio session may start from (host-issued: its toolchain id). */
export const pipelineTargetRef = z.strictObject({
	target: z.string().regex(/^pipeline\.[a-z][a-z0-9-]{1,30}$/),
});
