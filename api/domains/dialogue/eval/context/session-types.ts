import type { SqliteStore } from "../../../../infrastructure/sqlite";
import type { ToolchainCard } from "../../../capabilities";
import type { ContinuityService } from "../../../continuity";
import type { ConversationService } from "../../../conversation";
import type { MemoryService } from "../../../memory";
import type { GenerateInput } from "../../service/context";

export const CONVERSATION_ID = "main";
/** The user message every State item of a seed stands on (no run owns it, so no history shows it). */
export const SEED_SOURCE_MESSAGE = "seed-source";
/** The earliest time a seed uses when it names none. */
export const DEFAULT_START = "2026-10-13T00:00:00.000Z";

/** What the session needs from the host: real services on a temp store. */
export interface SeedWiring {
	store: SqliteStore;
	conversation: ConversationService;
	continuity: ContinuityService;
	memory: MemoryService;
	/** Moves the clock of the services: items, notes, work and runs carry the time the seed says. */
	setNow(iso: string): void;
	now(): string;
	close(): Promise<void>;
}

/** A toolchain as the eval shows it where the product would read its registered card. */
export type EvalCard = Pick<ToolchainCard, "id" | "title" | "summary"> & {
	useWhen: string[];
};

export type Persona = {
	agentName: string;
	userName: string;
	persona: "butler" | "maid" | "strategist" | "sage";
};

export type Reconstruction = { version: number; reason: string | null };

export type Generated = {
	runId: string;
	input: GenerateInput;
	/** The window version before this generation's prepare and the one it left (a re-construction moved it). */
	reconstruction: Reconstruction | null;
};

/** What a generation left in the log once it was adopted (the settle step of the product, in outline). */
export type Reply = {
	/** Facts the generation's actions wrote before it spoke (`acted` events). */
	acted?: Array<{ fields: Record<string, unknown>; by?: "agent" | "host" }>;
	text?: string;
	origin?: "reply" | "report" | "announcement" | "confirmation";
	todoRefs?: string[];
	about?: string[];
	heard?: "full" | "partial" | "none";
	deliveredText?: string;
};
