import type { PipelineDefinition, PipelineMaterial } from "../../capabilities";
import { parseReference, valueOf, type PipelineScope } from "./template";

/** Separate data, never appended to the step's instructions or expanded recursively. */
export type ResolvedPipelineMaterial = {
	kind: "value" | "image" | "music";
	label: string;
	value: unknown;
};

export function resolvePipelineMaterials(
	definition: Pick<PipelineDefinition, "steps">,
	materials: PipelineMaterial[] | undefined,
	scope: PipelineScope,
	request: string,
): ResolvedPipelineMaterial[] {
	const resolved = (materials ?? []).map(
		(material): ResolvedPipelineMaterial => {
			switch (material.kind) {
				case "text":
					return { kind: "value", label: "本文", value: material.text };
				case "value":
					return { kind: "value", label: "固定の値", value: material.value };
				case "request":
					return { kind: "value", label: "実行時の依頼文", value: request };
				case "prompt": {
					const step = definition.steps.find((s) => s.id === material.stepId);
					if (step?.kind !== "toolchain")
						throw new Error("pipeline_material_missing");
					return {
						kind: "value",
						label: `${step.title}のプロンプト（原文）`,
						value: step.request,
					};
				}
				case "reference": {
					const ref = parseReference(material.reference);
					const value = ref ? valueOf(scope, ref) : undefined;
					if (value === undefined) throw new Error("pipeline_material_missing");
					return { kind: "value", label: material.reference, value };
				}
				case "result": {
					if (!Object.hasOwn(scope.steps, material.stepId))
						throw new Error("pipeline_material_missing");
					return {
						kind: "value",
						label: `${material.stepId}の結果全体`,
						value: scope.steps[material.stepId],
					};
				}
				case "image":
					return {
						kind: "image",
						label: material.title,
						value: { imageRef: material.id },
					};
				case "music":
					return {
						kind: "music",
						label: material.title,
						value: { trackId: material.id },
					};
			}
		},
	);
	if (new TextEncoder().encode(JSON.stringify(resolved)).length > 16384)
		throw new Error("pipeline_material_capacity");
	return resolved;
}
