import type { Database } from "bun:sqlite";
import type { AttitudeDataset, VoiceAdoption } from "../../attitude-dataset";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { ActivityRecorder, LarmPort } from "../../larm";
import type {
	SpeechDelivery,
	SpeechPreparation,
} from "../../delivery/contracts";
import type { Connection, Resource, Settings } from "../../settings";
import type { SettingsService } from "../../settings";
import {
	type ControlContract,
	type Messages,
	type SpeechOverride,
} from "../contracts";
import { type RequestRow } from "../repository";
import { type CallSessionRole } from "./attempt-record";
import type { CloudAgents } from "../adapters/cloud-agents";

export type InferenceOptions = {
	codexResearch?: {
		execute(
			messages: Messages,
			signal: AbortSignal,
			control?: ControlContract,
			/** The saved Codex connection's model; absent: Codex's own default. */
			model?: string,
		): Promise<string>;
	};
	/** Agent SDK providers for connections whose kind is not openai-compatible. */
	cloudAgents?: CloudAgents;
	/** Must use the selected model's tokenizer, including message framing. */
	countControlTokens?: (messages: Messages) => number | null;
	token?: string;
	/** Extra hosts that may receive provider credentials (from Config). */
	providerHosts?: readonly string[];
	fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
	larmFactory?: (s: Settings) => LarmPort;
	/** Records attitude judge outcomes of the saved LARM connection (monitoring). */
	judgeActivity?: ActivityRecorder;
	localMs?: number;
	cloudMs?: number;
	decisionMs?: number;
	attitudeDataset?: AttitudeDataset;
	/** Rewrites text just before synthesis (e.g. pronunciation dictionary). */
	speechText?: (text: string) => string;
};
export type Running = {
	controller: AbortController;
	row: RequestRow;
	connection?: Connection;
	done: Promise<void>;
	finish: () => void;
};
export type CollectionAdoption = {
	identity: NonNullable<SpeechPreparation["collection"]>;
	delivery: SpeechDelivery;
	voice?: VoiceAdoption;
};
/** The service-wide state an execution reads and updates. */
export type Env = {
	store: SqliteStore;
	settings: SettingsService;
	options: InferenceOptions;
	active: Map<string, Running>;
	cooldown: Map<string, number>;
	collectionAdoptions: Map<string, CollectionAdoption>;
	port(s: Settings): LarmPort;
	resolve(
		row: RequestRow,
	): { resource: Resource; connection: Connection } | null;
	allowed(db: Database, row: RequestRow, connection?: Connection): boolean;
	prune(): void;
	isClosed(): boolean;
	/** Counts store commits; streaming re-checks authority only when it changes. */
	commitGeneration(): number;
	/** Tells the activity listeners that a request started or ended running. */
	touch?(): void;
};
type Selected = ReturnType<Env["resolve"]>;
export type Input = Messages | string | Uint8Array;
export type Source = "larm" | "cloud" | "codex";
/** Per-request state shared by the larm attempt and a cloud fallback attempt. */
export type Request = {
	voiceOverride?: SpeechOverride;
	tools?: import("../../../infrastructure/chat-stream").NativeTool[];
	toolChoice?: "required";
	outputLimit?: number;
	toolCalls?: import("../../../infrastructure/chat-stream").NativeToolCall[];
	env: Env;
	row: RequestRow;
	input: Input;
	caller: AbortSignal;
	signal: AbortSignal;
	deadline: number;
	selected: Selected;
	running: Running;
	onDelta?: (text: string) => void;
	preparation?: SpeechPreparation;
	control?: ControlContract;
	/** The call's session lifetime (llm only); written on every attempt row and passed to the provider. */
	session?: CallSessionRole;
	/** Why the previous attempt was abandoned (recorded on the next attempt). */
	reason: string | null;
	/** True once any answer text reached the caller: no silent fallback after that. */
	published: boolean;
};
