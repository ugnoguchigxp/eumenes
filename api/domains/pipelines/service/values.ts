import type {
	PipelineDefinition,
	PipelineStep,
	PipelineValueSchema,
} from "../../capabilities";
import {
	expand,
	expandValue,
	parseReference,
	valueOf,
	type PipelineScope,
} from "./template";

/** The JSON Schema of an extract step's one value, as its function takes it. */
export function valueSchemaJson(s: PipelineValueSchema) {
	return {
		type: s.type,
		...(s.enum ? { enum: s.enum } : {}),
		...(s.minimum !== undefined ? { minimum: s.minimum } : {}),
		...(s.maximum !== undefined ? { maximum: s.maximum } : {}),
		...(s.maxLength !== undefined ? { maxLength: s.maxLength } : {}),
	};
}

/** Why a value does not fit its schema, or null. */
export function valueFault(s: PipelineValueSchema, v: unknown): string | null {
	if (s.type === "string") {
		if (typeof v !== "string" || !v.trim()) return "invalid_type";
		if (v.length > (s.maxLength ?? 500)) return "too_big";
		if (s.enum && !s.enum.includes(v)) return "invalid_value";
		return null;
	}
	if (s.type === "boolean")
		return typeof v === "boolean" ? null : "invalid_type";
	if (typeof v !== "number" || !Number.isFinite(v)) return "invalid_type";
	if (s.type === "integer" && !Number.isInteger(v)) return "invalid_type";
	if (s.minimum !== undefined && v < s.minimum) return "too_small";
	if (s.maximum !== undefined && v > s.maximum) return "too_big";
	return null;
}

/**
 * Whether a toolchain step's settled result passes (spec §6.3): it completed, and the paths it requires are there.
 * Meaning is never judged here.
 */
export function stepFault(
	step: Extract<PipelineStep, { kind: "toolchain" }>,
	result: { state: string; summary?: string; output?: unknown },
): string | null {
	if (result.state !== "completed") return "pipeline_step_failed";
	const scope: PipelineScope = {
		inputs: {},
		steps: { [step.id]: { summary: result.summary, output: result.output } },
	};
	for (const path of step.require ?? []) {
		const ref = parseReference(`steps.${step.id}.${path}`);
		const found = ref ? valueOf(scope, ref) : undefined;
		if (found === undefined || found === null || found === "")
			return "pipeline_step_output_missing";
	}
	return null;
}

/** The steps as one short line for the candidate card: "調べる→タイマー→曲". */
export function stepOutline(d: PipelineDefinition) {
	return d.steps
		.filter((s) => s.kind === "toolchain")
		.map((s) => s.title)
		.join("→");
}

/** The inputs a run starts from: the given ones, and the defaults of the rest. */
export function startInputs(
	d: PipelineDefinition,
	given: Record<string, unknown>,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [name, input] of Object.entries(d.inputs)) {
		const v = given[name] ?? input.default;
		if (v !== undefined) out[name] = v;
	}
	return out;
}

export type FixtureOutcome = {
	passed: boolean;
	/** What each step would be handed: the expanded request (toolchain) or source text (extract). */
	steps: Array<{
		id: string;
		request?: string;
		arguments?: unknown;
		fault?: string;
	}>;
	answer?: string;
	failures: Array<{
		path: string;
		code: string;
		expected?: unknown;
		actual?: unknown;
	}>;
};

/**
 * One fixture case run without any toolchain (spec §8.2 試験運転): the fake results stand for the steps, the
 * templates are expanded as the host would, and the expected values are compared.
 */
export function runFixture(
	d: PipelineDefinition,
	index: number,
): FixtureOutcome {
	const test = d.tests?.[index];
	if (!test) throw new Error("pipeline_test_not_found");
	const scope: PipelineScope = {
		inputs: startInputs(d, test.inputs),
		steps: {},
	};
	const out: FixtureOutcome = { passed: true, steps: [], failures: [] };
	const fail = (path: string, code: string, extra = {}) => {
		out.passed = false;
		out.failures.push({ path, code, ...extra });
	};
	for (const step of d.steps) {
		const fake = test.stepResults[step.id];
		try {
			if (step.kind === "toolchain") {
				const request = expand(step.request, scope);
				const args = step.arguments
					? Object.fromEntries(
							Object.entries(step.arguments).map(([k, v]) => [
								k,
								expandValue(v, scope),
							]),
						)
					: undefined;
				if (!fake) {
					out.steps.push({
						id: step.id,
						request,
						arguments: args,
						fault: "step_result_missing",
					});
					fail(`steps.${step.id}`, "step_result_missing");
					break;
				}
				const result = {
					state: fake.state ?? "completed",
					summary: fake.summary,
					output: fake.output,
				};
				const fault = stepFault(step, result);
				out.steps.push({
					id: step.id,
					request,
					arguments: args,
					...(fault ? { fault } : {}),
				});
				if (fault) {
					fail(`steps.${step.id}`, fault);
					break;
				}
				scope.steps[step.id] = {
					summary: result.summary,
					output: result.output,
				};
			} else {
				const source = step.from.map((t) => expand(t, scope)).join("\n");
				const fault = fake
					? valueFault(step.schema, fake.value)
					: "step_result_missing";
				out.steps.push({
					id: step.id,
					request: source,
					...(fault ? { fault } : {}),
				});
				if (fault) {
					fail(`steps.${step.id}.value`, fault);
					break;
				}
				scope.steps[step.id] = { value: fake!.value };
			}
		} catch (error) {
			const code =
				error instanceof Error ? error.message : "pipeline_reference_missing";
			out.steps.push({ id: step.id, fault: code });
			fail(`steps.${step.id}`, code);
			break;
		}
	}
	if (out.passed && d.answer)
		try {
			out.answer = expand(d.answer, scope);
		} catch {
			fail("answer", "pipeline_reference_missing");
		}
	for (const [path, expected] of Object.entries(test.expect)) {
		const ref = parseReference(path);
		const actual = ref ? valueOf(scope, ref) : undefined;
		if (actual !== expected)
			fail(path, "unexpected_value", { expected, actual: actual ?? null });
	}
	return out;
}
