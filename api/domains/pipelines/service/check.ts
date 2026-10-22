import {
	pipelineDefinitionV1,
	type PipelineDefinition,
	type ToolchainRuntimeMeta,
} from "../../capabilities";
import { parseReference, references } from "./template";

/**
 * One finding of the pipeline check (spec task-pipeline-design 2026-10-22 §7): where (a JSON Pointer into the
 * definition) and which rule. Never the value itself: the definition may hold the user's words.
 */
export type PipelineIssue = { pointer: string; rule: string };

/** What the check needs to know of the toolchains a step names: their execution, and an instant one's arguments. */
export type ToolchainLookup = (id: string) => {
	execution: ToolchainRuntimeMeta["execution"];
	/** The argument names of an instant toolchain's function. */
	arguments?: readonly string[];
} | null;

/** Executions a step may hand to: one-shot work. A session needs the user; a task or pipeline would nest runs. */
const STEP_EXECUTIONS = new Set<ToolchainRuntimeMeta["execution"]>([
	"command",
	"instant",
	"research",
	"music-create",
	"music-playback",
	"image",
	"excalidraw",
]);

/**
 * Names the first round's call takes for itself (the analysis and the notice): an input of the same name would be
 * read as the analysis, so it is not allowed (dialogue's test pins this list to its schema).
 */
export const RESERVED_INPUT_NAMES = [
	"kind",
	"freshness",
	"impact",
	"approved",
	"announcement",
] as const;

const pointer = (path: PropertyKey[]) =>
	"/" +
	path.map((p) => String(p).replace(/~/g, "~0").replace(/\//g, "~1")).join("/");

/** The definition checked whole: the format first, then references, toolchains, inputs and fixture cases. */
export function checkPipeline(
	raw: unknown,
	lookup: ToolchainLookup,
):
	| { ok: true; value: PipelineDefinition }
	| { ok: false; issues: PipelineIssue[] } {
	const parsed = pipelineDefinitionV1.safeParse(raw);
	if (!parsed.success)
		return {
			ok: false,
			issues: parsed.error.issues
				.slice(0, 32)
				.map((i) => ({ pointer: pointer(i.path), rule: i.code })),
		};
	const issues = semanticIssues(parsed.data, lookup);
	return issues.length
		? { ok: false, issues }
		: { ok: true, value: parsed.data };
}

function semanticIssues(d: PipelineDefinition, lookup: ToolchainLookup) {
	const issues: PipelineIssue[] = [];
	const issue = (path: PropertyKey[], rule: string) =>
		issues.push({ pointer: pointer(path), rule });
	for (const [name, input] of Object.entries(d.inputs)) {
		const at = ["inputs", name];
		if ((RESERVED_INPUT_NAMES as readonly string[]).includes(name))
			issue(at, "reserved_input_name");
		if (
			input.minimum !== undefined &&
			input.maximum !== undefined &&
			input.minimum > input.maximum
		)
			issue([...at, "minimum"], "range_invalid");
		if (input.default !== undefined && !fitsType(input.type, input.default))
			issue([...at, "default"], "default_type");
		if (
			input.enum &&
			typeof input.default === "string" &&
			!input.enum.includes(input.default)
		)
			issue([...at, "default"], "default_type");
	}
	const kinds = new Map(d.steps.map((s) => [s.id, s.kind]));
	const position = new Map(d.steps.map((s, i) => [s.id, i]));
	const checkTemplate = (
		template: string,
		at: PropertyKey[],
		index: number,
	) => {
		for (const { ref } of references(template)) {
			if (!ref) issue(at, "unknown_reference");
			else if (ref.kind === "input") {
				const input = Object.hasOwn(d.inputs, ref.name)
					? d.inputs[ref.name]
					: undefined;
				if (!input) issue(at, "unknown_reference");
				// An input the user may leave out has a value only when it has a default.
				else if (!input.required && input.default === undefined)
					issue(at, "optional_input_referenced");
			} else if (!kinds.has(ref.step)) issue(at, "unknown_reference");
			else if (position.get(ref.step)! >= index) issue(at, "forward_reference");
			else if ((kinds.get(ref.step) === "extract") !== (ref.field === "value"))
				issue(at, "field_mismatch");
		}
	};
	d.steps.forEach((step, i) => {
		const at = ["steps", i];
		if (step.kind === "extract") {
			step.from.forEach((t, j) => checkTemplate(t, [...at, "from", j], i));
			const s = step.schema;
			if (
				s.minimum !== undefined &&
				s.maximum !== undefined &&
				s.minimum > s.maximum
			)
				issue([...at, "schema", "minimum"], "range_invalid");
			if (s.enum && s.type !== "string")
				issue([...at, "schema", "enum"], "enum_type");
			return;
		}
		checkTemplate(step.request, [...at, "request"], i);
		for (const [key, value] of Object.entries(step.arguments ?? {}))
			if (typeof value === "string")
				checkTemplate(value, [...at, "arguments", key], i);
		step.uses?.forEach((id, j) => {
			if (kinds.get(id) !== "toolchain" || position.get(id)! >= i)
				issue([...at, "uses", j], "unknown_step");
		});
		step.materials?.forEach((material, j) => {
			const path = [...at, "materials", j];
			if (material.kind === "reference") {
				if (!parseReference(material.reference))
					issue([...path, "reference"], "unknown_reference");
				else
					checkTemplate(`\${${material.reference}}`, [...path, "reference"], i);
			} else if (material.kind === "result") {
				if (
					!position.has(material.stepId) ||
					position.get(material.stepId)! >= i
				)
					issue([...path, "stepId"], "forward_reference");
			} else if (material.kind === "prompt") {
				if (
					kinds.get(material.stepId) !== "toolchain" ||
					position.get(material.stepId)! > i
				)
					issue([...path, "stepId"], "unknown_prompt");
			}
		});
		const found = lookup(step.toolchain);
		if (!found) return issue([...at, "toolchain"], "unknown_toolchain");
		if (!STEP_EXECUTIONS.has(found.execution))
			return issue([...at, "toolchain"], "unsupported_toolchain");
		if (found.execution === "instant") {
			if (step.materials?.length)
				issue([...at, "materials"], "instant_materials_unsupported");
			if (!step.arguments) issue([...at, "arguments"], "arguments_required");
			for (const key of Object.keys(step.arguments ?? {}))
				if (!found.arguments?.includes(key))
					issue([...at, "arguments", key], "unknown_argument");
		} else if (step.arguments)
			issue([...at, "arguments"], "arguments_unexpected");
	});
	if (d.answer) checkTemplate(d.answer, ["answer"], d.steps.length);
	d.tests?.forEach((test, i) => {
		const at = ["tests", i];
		for (const name of Object.keys(test.inputs))
			if (!Object.hasOwn(d.inputs, name))
				issue([...at, "inputs", name], "unknown_input");
		for (const id of Object.keys(test.stepResults))
			if (!kinds.has(id)) issue([...at, "stepResults", id], "unknown_step");
		for (const path of Object.keys(test.expect)) {
			const ref = parseReference(path);
			if (!ref || (ref.kind === "step" && !kinds.has(ref.step)))
				issue([...at, "expect", path], "unknown_reference");
		}
	});
	return issues.slice(0, 32);
}

function fitsType(type: string, value: unknown) {
	return type === "integer"
		? Number.isInteger(value)
		: type === "number"
			? typeof value === "number" && Number.isFinite(value)
			: typeof value === type;
}
