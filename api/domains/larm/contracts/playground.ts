export type TestKind =
	| "llm"
	| "asr"
	| "tts"
	| "embedding"
	| "decision"
	| "image"
	| "music"
	| "unsupported";
export interface LarmTestTarget {
	id: string;
	name: string;
	model: string;
	capability: string;
	protocol: string;
	kind: TestKind;
	mode: "provider" | "service";
	endpoint: string;
	profile: string;
	selector?: string;
	revision: string;
	onDemand: boolean;
	primary: boolean;
}
export interface TestInput {
	text: string;
	comparison?: string;
	voice?: string;
	width?: number;
	height?: number;
	format?: "png" | "webp";
	seed?: number;
	durationSeconds?: number;
	audio?: Uint8Array;
}
export interface TestArtifact {
	id: string;
	path: string;
	mime: string;
	actualModel?: string;
}
export interface TestOutput {
	actualModel?: string;
	text?: string;
	bytes?: Uint8Array;
	mime?: string;
	artifact?: TestArtifact;
}
export type HealthState =
	| "healthy"
	| "busy"
	| "unhealthy"
	| "on-demand"
	| "unknown"
	| "unsupported";
export interface TestHealth {
	state: HealthState;
	reason: string;
	checkedAt: number;
	latencyMs?: number;
}
export interface TestProgress {
	phase: string;
	jobId?: string;
	progress?: number;
	artifact?: TestArtifact;
}
