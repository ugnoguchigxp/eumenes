import type { PipelineDefinition } from "../../domains/capabilities";
import { stepOutline } from "../../domains/pipelines";
import { PIPELINES_ADAPTER_REF } from "./pipelines-adapter";

/** The run's bound: the whole procedure, its slowest steps (a song, a 3D model) included. */
const TIME_LIMITS = { runMs: 1_800_000, turnMs: 900_000, inferenceMs: 600_000 };

/** The toolchain id and function name a pipeline is published under. */
export const pipelineToolchainId = (d: Pick<PipelineDefinition, "id">) =>
	`pipeline.${d.id}`;
export const pipelineFunctionName = (d: Pick<PipelineDefinition, "id">) =>
	`pipeline_${d.id.replace(/-/g, "_")}`;

/**
 * The examples the candidate index embeds: the fixture utterances and the situations it is for. A toolchain needs
 * three (docs/toolchain-extension.md §3), so a pipeline with fewer is not published.
 */
export function pipelineExamples(d: PipelineDefinition) {
	return [
		...new Set(
			[...(d.tests ?? []).map((t) => t.utterance), ...d.useWhen].map((e) =>
				e.slice(0, 200),
			),
		),
	];
}

/**
 * A pipeline as a capability bundle (spec task-pipeline-design 2026-10-22 §13.2): profile, SKILL, a package without
 * tools, the `execution:"pipeline"` binding that carries the definition, and the toolchain the candidates find. All
 * five take the same new revision; earlier revisions stay as they are.
 */
export function pipelineBundle(d: PipelineDefinition, revision: number) {
	const id = pipelineToolchainId(d);
	const ref = (kind: string) => `${kind}:${id}@${revision}`;
	const common = { aliases: [], tags: [], dependencies: [] as string[] };
	const steps = d.steps
		.map((s, i) =>
			s.kind === "toolchain"
				? `${i + 1}. ${s.title}（${s.toolchain}）: ${s.request}`
				: `${i + 1}. ${s.title}（値の取り出し）: ${s.instruction}`,
		)
		.join("\n");
	return {
		formatVersion: 1 as const,
		bundleId: id,
		pins: [],
		definitions: [
			{
				kind: "profile",
				id,
				revision,
				title: d.title,
				summary: d.summary,
				...common,
				useWhen: [],
				avoidWhen: [],
				body: `決まった手順「${d.title}」。${d.summary}。手順は仕組み側が定義どおりに順に実行し、各手順はその担当が一つの作業として行う。`,
			},
			{
				kind: "skill",
				id,
				revision,
				title: `${d.title}の手順`,
				summary: stepOutline(d),
				...common,
				useWhen: [],
				avoidWhen: [],
				body: steps,
			},
			{
				kind: "package",
				id,
				revision,
				title: d.title,
				summary: d.summary,
				...common,
				useWhen: d.useWhen,
				avoidWhen: d.avoidWhen,
				dependencies: [ref("profile"), ref("skill")],
				profileRevisionId: ref("profile"),
				requiredSkillRevisionIds: [ref("skill")],
				toolRevisionIds: [],
			},
			{
				kind: "toolchain",
				id,
				revision,
				title: d.title,
				summary: d.summary,
				...common,
				useWhen: d.useWhen,
				avoidWhen: d.avoidWhen,
				dependencies: [ref("package")],
				examples: pipelineExamples(d),
				packageRevisionId: ref("package"),
				redirects: [],
				bindingRevisionId: ref("binding"),
				functionName: pipelineFunctionName(d),
			},
		],
		bindings: [
			{
				kind: "binding" as const,
				id,
				revision,
				execution: "pipeline" as const,
				adapterRef: PIPELINES_ADAPTER_REF,
				availabilityRef: "availability:pipelines@1",
				tools: [],
				timeLimits: TIME_LIMITS,
				pipeline: d,
			},
		],
		artifacts: [],
		schemas: [],
	};
}
