import type { ConversationService } from "../../domains/conversation";
import type { InferencePort } from "../../domains/inference";
import type { QueueService } from "../../domains/queue";
import type { TimersService } from "../../domains/timers";
import type { WebResearchService } from "../../domains/web-research";
import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../infrastructure/sqlite";
import type { Notice } from "../../domains/dialogue/contracts";
import { createKanbanSdkHost } from "../work/kanban-sdk-host";
import { join } from "node:path";

import { reportFinishedTasks } from "../work/claude-code-reports";

import { createToolchain } from "./toolchain";
import type { Embed } from "./toolchain-vectors";
import type { InferenceAdapterPorts } from "../settings/inference-adapter";
import type { MemoryAdapterPorts } from "../world/memory-adapter";
import type { RecordsPorts } from "../settings/records-adapter";
import type { ServiceTestsPorts } from "../settings/service-tests-adapter";
import type { SettingsAdapterPorts } from "../settings/settings-adapter";
import { questionReader, type InteractionViews } from "./toolchain-adapters";
import type { TtsDictionaryPorts } from "../settings/tts-dictionary-adapter";
import { createWorldResearchPorts } from "../world/world-research-ports";
import type { WorldAdapterPorts } from "../world/world-adapter";
import type { WorldAssembly } from "../world/world";
import type { UiCompositionsService } from "../../domains/ui-compositions";

type SessionLive = (tx: Database, sessionId: string) => boolean;

/** How many of the person's latest statements a World correction may cite as its reason. */

/**
 * The domain services the data-driven toolchain screens execute through, as the server (and the
 * browser fixture) assembled them before the toolchain. Dialogue is assembled after the
 * toolchain, so its open questions are attached later.
 */
export function createToolchainHostLinks(services: {
	/** The store the World investigation's reads run in (absent: it is not offered). */
	store?: SqliteStore;
	settings: SettingsAdapterPorts & {
		derivedKey(purpose: string): Uint8Array | undefined;
		diagnostics: RecordsPorts["diagnostics"];
	};
	inference: InferenceAdapterPorts & { usagePage: RecordsPorts["usagePage"] };
	conversation: ConversationService;
	googleAccounts?: import("../../domains/google-accounts").GoogleAccounts;
	ttsDictionary?: TtsDictionaryPorts;
	memory?: MemoryAdapterPorts["memory"] &
		Pick<
			import("../../domains/memory").MemoryService,
			"readyInTransaction" | "blockedMessageIdsInTransaction"
		>;
	/** The steward behind the `memory_request` tool (needs `memory`). */
	steward?: import("../../domains/steward").StewardService;
	world?: WorldAssembly;
	/** The adopted goals the World investigation may name for `gaps` (needs `world`). */
	goals?: import("../world/world-research-ports").WorldResearchGoals;
	serviceTests?: ServiceTestsPorts;
	log?: {
		warn(event: string, fields: { reason: string }, error?: unknown): void;
	};
}) {
	const { settings, inference, world } = services;
	let interactions: InteractionViews | undefined;
	let sessionLive: SessionLive | undefined;
	const worldPorts: WorldAdapterPorts | undefined = world && {
		claims: world.claims,
		documents: world.documents,
		context: world.claimsContext,
	};
	const worldResearch =
		world && services.store
			? (runtime: Parameters<typeof createWorldResearchPorts>[0]["runtime"]) =>
					createWorldResearchPorts({
						store: services.store!,
						world: world.service,
						context: world.claimsContext,
						runtime,
						goals: services.goals,
					})
			: undefined;
	return {
		options: {
			conversation: services.conversation,
			settings,
			inference,
			googleAccounts: services.googleAccounts,
			ttsDictionary: services.ttsDictionary,
			memory: services.memory
				? { memory: services.memory, steward: services.steward }
				: undefined,
			steward:
				services.steward && services.memory
					? { service: services.steward, memory: services.memory }
					: undefined,
			blockedMessages: services.memory,
			world: () => worldPorts,
			worldResearch,
			serviceTests: services.serviceTests,
			records: {
				usagePage: inference.usagePage,
				usage: inference.usage as RecordsPorts["usage"],
				larm: inference.inspect as RecordsPorts["larm"],
				diagnostics: settings.diagnostics,
			},
			secretKey: () => settings.derivedKey("tool-runtime.action-digest"),
			interactions: questionReader(() => interactions),
			// Until dialogue is attached no specialist session exists, so none is live.
			specialistSessionLive: (tx: Database, sessionId: string) =>
				sessionLive?.(tx, sessionId) ?? false,
		},
		attachDialogue(dialogue: {
			interactions: InteractionViews;
			specialistSessionLiveInTransaction: SessionLive;
		}) {
			interactions = dialogue.interactions;
			sessionLive = dialogue.specialistSessionLiveInTransaction;
		},
	};
}

/**
 * The server's toolchain: every data-driven screen's adapter wired to the services assembled
 * before it, and the host's fixed set of legacy toolchains.
 */
export async function createHostToolchain(
	s: Parameters<typeof createToolchainHostLinks>[0] & {
		store: SqliteStore;
		dbPath?: string;
		queue: QueueService;
		uiCompositions?: UiCompositionsService;
		ocr?: import("../../domains/ocr").OcrService;
		model3d?: import("../../domains/model3d").Model3dService;
		inference: InferencePort &
			Parameters<typeof createToolchainHostLinks>[0]["inference"];
		webResearch: WebResearchService;
		timers?: TimersService;
		history?: boolean;
		webResearchEnabled?: boolean;
		embed?: Embed;
		/** This server's loopback URL for Claude Code hooks, and the change publisher. */
		terminalHooks?: { baseUrl: string; publish: () => void };
	},
) {
	const links = createToolchainHostLinks(s);
	// Claude Code sessions start in the server's working directory (the repository).
	let loadedCapabilities:
		| import("../../domains/capabilities").Capabilities
		| undefined;
	const sdkHost = createKanbanSdkHost({
		store: s.store,
		settings: s.settings,
		dbPath: s.dbPath ?? join(process.cwd(), "data/eumenes.sqlite3"),
		hooks: s.terminalHooks,
		capabilities: () => {
			if (!loadedCapabilities) throw new Error("capability_unavailable");
			return loadedCapabilities;
		},
	});
	const { terminals, kanban } = sdkHost;
	const kanbanRuns = sdkHost.runs;
	const toolchain = await createToolchain(
		s.store,
		s.queue,
		s.inference,
		s.webResearch,
		{
			timers: s.timers,
			uiCompositions: s.uiCompositions,
			ocr: s.ocr,
			model3d: s.model3d,
			...links.options,
			history: s.history,
			dots: true,
			music: true,
			image: true,
			excalidraw: true,
			objectRecognition: true,
			terminals,
			kanban,
			kanbanSdk: sdkHost,
			webResearch: s.webResearchEnabled,
			weather: {},
			stock: {},
			embed: s.embed,
		},
	);
	loadedCapabilities = toolchain.capabilities;
	return {
		toolchain: { ...toolchain, terminals, kanban, kanbanRuns },
		links: {
			...links,
			attachDialogue(
				dialogue: Parameters<typeof links.attachDialogue>[0] & {
					notify(notice: Notice): Promise<unknown>;
				},
			) {
				links.attachDialogue(dialogue);
				// A finished conversation task is reported in that conversation.
				reportFinishedTasks(terminals, dialogue, s.log);
			},
		},
	};
}
