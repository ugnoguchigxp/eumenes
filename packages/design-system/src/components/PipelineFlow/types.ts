/** A finding of the pipeline check: where (JSON Pointer, and its line in the source when known) and which rule. */
export type PipelineFlowIssue = {
	pointer: string;
	rule: string;
	line: number | null;
};

export type PipelineFlowStep = {
	id: string;
	kind: "toolchain" | "extract";
	title: string;
	/** The toolchain a toolchain step hands to; null for an extract step. */
	toolchain: string | null;
	/** Ids of the earlier steps whose values this step reads. */
	reads: string[];
	/** Names of the inputs this step reads. */
	inputs: string[];
};

export type PipelineFlowData = {
	inputs: Array<{ name: string; type: string; required: boolean }>;
	steps: PipelineFlowStep[];
	/** Names of the inputs and ids of the steps the final answer reads. */
	answer: { inputs: string[]; reads: string[] } | null;
};
