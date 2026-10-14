import type { ConversationService } from "../domains/conversation";
import type { InferencePort } from "../domains/inference";
import type { QueueService } from "../domains/queue";
import type { TimersService } from "../domains/timers";
import type { WebResearchService } from "../domains/web-research";
import type { SqliteStore } from "../infrastructure/sqlite";
import type { Notice } from "../domains/dialogue/contracts";
import { createTerminals } from "../domains/terminals";
import { reportFinishedTasks } from "./claude-code-reports";
import { createToolchain } from "./toolchain";
import type { Embed } from "./toolchain-vectors";
import type { InferenceAdapterPorts } from "./inference-adapter";
import type { MemoryAdapterPorts } from "./memory-adapter";
import type { RecordsPorts } from "./records-adapter";
import type { ServiceTestsPorts } from "./service-tests-adapter";
import type { SettingsAdapterPorts } from "./settings-adapter";
import { questionReader, type InteractionViews } from "./toolchain-adapters";
import type { TtsDictionaryPorts } from "./tts-dictionary-adapter";
import type { WorldAdapterPorts } from "./world-adapter";
import type { WorldAssembly } from "./world";
import type { UiCompositionsService } from "../domains/ui-compositions";

/** How many of the person's latest statements a World correction may cite as its reason. */
const REASON_MESSAGES = 20;

/**
 * The domain services the data-driven toolchain screens execute through, as the server (and the
 * browser fixture) assembled them before the toolchain. Dialogue is assembled after the
 * toolchain, so its open questions are attached later.
 */
export function createToolchainHostLinks(services: {
	settings: SettingsAdapterPorts & {
		derivedKey(purpose: string): Uint8Array | undefined;
		diagnostics: RecordsPorts["diagnostics"];
	};
	inference: InferenceAdapterPorts & { usagePage: RecordsPorts["usagePage"] };
	conversation: ConversationService;
	ttsDictionary?: TtsDictionaryPorts;
	memory?: MemoryAdapterPorts["memory"];
	continuity?: MemoryAdapterPorts["continuity"];
	world?: WorldAssembly;
	serviceTests?: ServiceTestsPorts;
	log?: {
		warn(event: string, fields: { reason: string }, error?: unknown): void;
	};
}) {
	const { settings, inference, world } = services;
	let interactions: InteractionViews | undefined;
	const worldPorts: WorldAdapterPorts | undefined = world && {
		claims: world.claims,
		context: world.claimsContext,
		resumeForget: (forgetId) => world.lifecycle.resumeForget(forgetId),
		reasonMessages: () =>
			services.conversation
				.get("main")
				.messages.filter((m) => m.role === "user")
				.slice(-REASON_MESSAGES)
				.reverse()
				.map((m) => ({ id: m.id, text: m.text })),
		onForgetAdvanceFailed: (error) =>
			services.log?.warn(
				"world.forget_advance_failed",
				{ reason: "forget_advance_failed" },
				error,
			),
	};
	return {
		options: {
			conversation: services.conversation,
			settings,
			inference,
			ttsDictionary: services.ttsDictionary,
			memory:
				services.memory && services.continuity
					? { memory: services.memory, continuity: services.continuity }
					: undefined,
			world: () => worldPorts,
			serviceTests: services.serviceTests,
			records: {
				usagePage: inference.usagePage,
				usage: inference.usage as RecordsPorts["usage"],
				larm: inference.inspect as RecordsPorts["larm"],
				diagnostics: settings.diagnostics,
			},
			secretKey: () => settings.derivedKey("tool-runtime.action-digest"),
			interactions: questionReader(() => interactions),
		},
		attachDialogue(dialogue: { interactions: InteractionViews }) {
			interactions = dialogue.interactions;
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
		queue: QueueService;
		uiCompositions?: UiCompositionsService;
		ocr?: import("../domains/ocr").OcrService;
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
	const terminals = createTerminals({
		cwd: process.cwd(),
		hookBaseUrl: s.terminalHooks?.baseUrl,
		onChange: s.terminalHooks?.publish,
	});
	const toolchain = await createToolchain(
		s.store,
		s.queue,
		s.inference,
		s.webResearch,
		{
			timers: s.timers,
			uiCompositions: s.uiCompositions,
			ocr: s.ocr,
			...links.options,
			history: s.history,
			dots: true,
			music: true,
			image: true,
			excalidraw: true,
			objectRecognition: true,
			terminals,
			webResearch: s.webResearchEnabled,
			embed: s.embed,
		},
	);
	return {
		toolchain: { ...toolchain, terminals },
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
