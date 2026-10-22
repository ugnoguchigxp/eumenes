/**
 * The references of a pipeline's templates (spec task-pipeline-design 2026-10-22 §4.2): `${inputs.<name>}`,
 * `${steps.<id>.summary}`, `${steps.<id>.value}` and `${steps.<id>.output.<key>…}`. No expressions or functions.
 */

/** What a run knows when it expands a template: the inputs, and the values of the steps done so far. */
export type PipelineScope = {
	inputs: Record<string, unknown>;
	steps: Record<string, StepValues>;
};
/** A toolchain step's result (`summary`, `output`) or an extract step's `value`. */
export type StepValues = {
	summary?: string;
	output?: unknown;
	value?: unknown;
};

export type Reference =
	| { kind: "input"; name: string }
	| { kind: "step"; step: string; field: "summary" | "value" }
	| { kind: "step"; step: string; field: "output"; path: string[] };

const REFERENCE = /\$\{([^{}]*)\}/g;

/** Each `${...}` of a template, parsed; `null` for one that is not a reference this format knows. */
export function references(
	template: string,
): Array<{ text: string; ref: Reference | null }> {
	return [...template.matchAll(REFERENCE)].map((m) => ({
		text: m[1]!,
		ref: parseReference(m[1]!),
	}));
}

export function parseReference(text: string): Reference | null {
	const parts = text.trim().split(".");
	if (
		parts[0] === "inputs" &&
		parts.length === 2 &&
		/^[a-z][a-z0-9_]*$/.test(parts[1]!)
	)
		return { kind: "input", name: parts[1]! };
	if (parts[0] !== "steps" || parts.length < 3) return null;
	const step = parts[1]!;
	if (!/^[a-z][a-z0-9_]*$/.test(step)) return null;
	const field = parts[2];
	if ((field === "summary" || field === "value") && parts.length === 3)
		return { kind: "step", step, field };
	if (field !== "output" || parts.length > 9) return null;
	const path = parts.slice(3);
	return path.every((p) => /^[A-Za-z0-9_-]{1,64}$/.test(p))
		? { kind: "step", step, field: "output", path }
		: null;
}

/** The value a reference names in the scope; undefined when the run has none there. */
export function valueOf(scope: PipelineScope, ref: Reference): unknown {
	if (ref.kind === "input") return scope.inputs[ref.name];
	const step = scope.steps[ref.step];
	if (!step) return undefined;
	if (ref.field !== "output") return step[ref.field];
	let value: unknown = step.output;
	for (const key of ref.path) {
		if (
			value === null ||
			typeof value !== "object" ||
			!Object.hasOwn(value, key)
		)
			return undefined;
		value = (value as Record<string, unknown>)[key];
	}
	return value;
}

/** A value as it reads in a request: text as is, anything else as JSON, bounded. */
function text(value: unknown) {
	return (typeof value === "string" ? value : JSON.stringify(value)).slice(
		0,
		2000,
	);
}

/** The template with every reference replaced. A reference the run has no value for stops the run. */
export function expand(template: string, scope: PipelineScope): string {
	return template.replace(REFERENCE, (_, inner: string) => {
		const ref = parseReference(inner);
		const value = ref ? valueOf(scope, ref) : undefined;
		if (value === undefined || value === null)
			throw new Error("pipeline_reference_missing");
		return text(value);
	});
}

/** A template that is exactly one reference keeps the value's own type (an instant toolchain's argument). */
export function expandValue(value: unknown, scope: PipelineScope): unknown {
	if (typeof value !== "string") return value;
	const whole = /^\$\{([^{}]*)\}$/.exec(value.trim());
	if (whole) {
		const ref = parseReference(whole[1]!);
		const found = ref ? valueOf(scope, ref) : undefined;
		if (found === undefined || found === null)
			throw new Error("pipeline_reference_missing");
		return found;
	}
	return expand(value, scope);
}
