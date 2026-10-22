import {
	pipelineDefinitionV1,
	type PipelineDefinition,
} from "../../capabilities";
import { references } from "./template";

/**
 * The work document of the pipeline studio (spec task-pipeline-design 2026-10-22 §8.1; the work document contract of
 * subagent-task-and-session-agents §7.2): its canonical text, its format check, and where a JSON Pointer sits in it.
 */

/** The same value always gives the same text: keys in schema order, 2-space indent. */
export function canonicalText(d: PipelineDefinition) {
	return JSON.stringify(pipelineDefinitionV1.parse(d), null, 2);
}

/** A finding of the format check: a pointer and a rule, never a value. */
export type DocumentIssue = { path: string; rule: string };

const pointerOf = (path: PropertyKey[]) =>
	"/" +
	path.map((p) => String(p).replace(/~/g, "~0").replace(/\//g, "~1")).join("/");

/** Text read as a definition and checked for its format only; references and toolchains are the full check's. */
export function checkText(
	text: string,
):
	| { ok: true; value: PipelineDefinition; fixes: string[] }
	| { ok: false; code: string; issues: DocumentIssue[]; fixes: string[] } {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return {
			ok: false,
			code: "document_parse_failed",
			issues: [{ path: "/", rule: "invalid_json" }],
			fixes: [],
		};
	}
	const parsed = pipelineDefinitionV1.safeParse(raw);
	return parsed.success
		? { ok: true, value: parsed.data, fixes: [] }
		: {
				ok: false,
				code: "pipeline_invalid",
				issues: parsed.error.issues
					.slice(0, 16)
					.map((i) => ({ path: pointerOf(i.path), rule: i.code })),
				fixes: [],
			};
}

/**
 * The 1-based line each pointer starts on in `JSON.stringify(value, null, 2)`. A pointer the text has no line of
 * (inside a one-line value) resolves to its nearest ancestor's.
 */
export function pointerLines(
	value: unknown,
): (pointer: string) => number | null {
	const lines = new Map<string, number>();
	let line = 1;
	const walk = (v: unknown, pointer: string) => {
		lines.set(pointer || "/", line);
		if (v === null || typeof v !== "object") return;
		const entries = Array.isArray(v)
			? v.map((x, i) => [String(i), x] as const)
			: Object.entries(v).filter(([, x]) => x !== undefined);
		if (!entries.length) return;
		for (const [key, child] of entries) {
			line++;
			walk(child, `${pointer}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`);
		}
		line++;
	};
	walk(value, "");
	return (pointer) => {
		for (let p = pointer; ; p = p.slice(0, p.lastIndexOf("/"))) {
			const found = lines.get(p || "/");
			if (found !== undefined) return found;
			if (!p) return null;
		}
	};
}

/** The definition as a flow for the studio's diagram: what each step reads, and what the answer reads. */
export function flowOf(d: PipelineDefinition) {
	const read = (templates: string[], uses: string[] = []) => {
		const steps = new Set(uses);
		const inputs = new Set<string>();
		for (const t of templates)
			for (const { ref } of references(t))
				if (ref?.kind === "input") inputs.add(ref.name);
				else if (ref) steps.add(ref.step);
		return { reads: [...steps], inputs: [...inputs] };
	};
	return {
		inputs: Object.entries(d.inputs).map(([name, i]) => ({
			name,
			type: i.type,
			required: i.required,
		})),
		steps: d.steps.map((s) => ({
			id: s.id,
			kind: s.kind,
			title: s.title,
			toolchain: s.kind === "toolchain" ? s.toolchain : null,
			...(s.kind === "toolchain"
				? read(
						[
							s.request,
							...(s.materials ?? [])
								.filter((m) => m.kind === "reference")
								.map((m) => `\${${m.reference}}`),
							...Object.values(s.arguments ?? {}).filter(
								(v): v is string => typeof v === "string",
							),
						],
						[
							...(s.uses ?? []),
							...(s.materials ?? [])
								.filter((m) => m.kind === "result")
								.map((m) => m.stepId),
						],
					)
				: read(s.from)),
		})),
		answer: d.answer ? read([d.answer]) : null,
	};
}
