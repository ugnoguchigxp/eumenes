import { dirname, resolve } from "node:path";
import type { GoogleProvider } from "../domains/google-accounts";
import { CONVERSATION_DEFAULT_PRINCIPAL } from "../domains/conversation/contracts";
import { createContinuityService } from "../domains/continuity";
import { createDialogueService } from "../domains/dialogue";
import {
	REFERENCE_WINDOW_TOKENS,
	contextBudgets,
	createConnectionModels,
} from "../domains/inference";
import { createMemoryService } from "../domains/memory";
import { createOcr } from "../domains/ocr";
import { createScheduler } from "../domains/scheduler";
import { createTimers } from "../domains/timers";
import { createUiCompositions } from "../domains/ui-compositions";
import { createVoiceDialogue } from "../domains/voice-dialogue";
import type { Capabilities } from "../domains/capabilities";
import { getLogger } from "../infrastructure/logger";
import type { Config } from "../infrastructure/config";
import { createDotsDialogue } from "./work/dots-dialogue";
import { createSavedEmbedder } from "./world/larm-embedder";
import {
	createMonitoring,
	createLarmCollector,
	createLarmRepository,
} from "../domains/monitoring";
import { buildCore, buildWebResearch } from "./server-core";
import { buildMedia, buildModel3d } from "./server-media";
import { buildTasks } from "./server-tasks";
import { assembleCuration } from "./server-world";
import { createTimerAnnouncements } from "./timers/timer-announcements";
import { createSpecialistPort } from "./toolchain/specialist-port";
import { buildBrowser } from "./browser/browser-composition";
import { createToolchainRouting } from "./toolchain/toolchain-routing";
import { createHostToolchain } from "./toolchain/toolchain-host";

const log = getLogger("server");

/**
 * Constructs every service. Nothing is recovered, started or listening yet, and
 * the process environment is not read: all values come from `config`.
 */
export async function buildServices(
	config: Config,
	dependencies: { googleProvider?: GoogleProvider } = {},
) {
	const { dbPath } = config;
	const core = await buildCore(config, dependencies);
	const {
		store,
		changes,
		conversation,
		settings,
		googleAccounts,
		ttsDictionary,
		inference,
		serviceTests,
		queue,
	} = core;
	const webResearch = buildWebResearch(config, core);
	const scheduler = createScheduler(store, queue);
	const timers = createTimers(
		store,
		{ scheduler, queue },
		{
			publish: () => changes.publish(),
			onElapsedInTransaction: createTimerAnnouncements(conversation),
		},
	);
	const tasks = await buildTasks(config, {
		core,
		scheduler,
		capabilities: () => toolchain.capabilities,
	});
	const { delegated } = tasks;
	// One embedder on the saved LARM connection serves both the toolchain routing and the memory turn vectors.
	const embedder = createSavedEmbedder(
		config,
		settings,
		core.activity.embedding,
	);
	const continuity = createContinuityService(store);
	const memoryJournalPath = resolve(config.memoryJournalPath);
	const memory = createMemoryService(store, conversation, continuity, {
		journalPath: memoryJournalPath,
		embed: () => embedder,
		// Half of the saved model's window, at most 128k tokens (256k is assumed while the window is not known).
		historyBudgetTokens: () =>
			contextBudgets(
				inference.savedLlmContextWindow?.() ?? REFERENCE_WINDOW_TOKENS,
			).memoryHistory,
	});
	// Forgetting revokes agent calls still running on what was forgotten (a no-op when replayed at startup).
	memory.registerForgetPurge(inference.revokeAgentAttemptsInTransaction);
	const { stewardAssembly, steward, goals, world } = assembleCuration(config, {
		store,
		memory,
		conversation,
		continuity,
		queue,
		inference,
		dbPath,
		memoryJournalPath,
		worldResourceId: () => settings.get().world.curationResourceId,
	});
	const uiCompositions = createUiCompositions();
	let ocrCapabilities: Capabilities | null = null;
	const ocr = createOcr({
		store,
		queue,
		connection: () => settings.ocrCredentials(),
		inference,
		capabilities: () => ocrCapabilities,
	});
	const model3d = buildModel3d(config, { core, conversation });
	let browserCapabilities: Capabilities | null = null;
	const browser = buildBrowser(config, {
		core,
		settings,
		conversation,
		inference,
		capabilities: () => browserCapabilities,
	});
	const { toolchain, links } = await createHostToolchain({
		dbPath,
		store,
		queue,
		uiCompositions,
		ocr,
		model3d,
		browser,
		inference,
		webResearch,
		settings,
		conversation,
		googleAccounts,
		ttsDictionary,
		memory,
		steward,
		world,
		goals: goals.goals,
		serviceTests,
		timers,
		log,
		history: config.historyToolsEnabled,
		webResearchEnabled: config.webResearchToolsEnabled,
		embed: embedder,
		terminalHooks: {
			baseUrl: `http://${config.host}:${config.port}`,
			publish: () => changes.publish(),
		},
	});
	ocrCapabilities = toolchain.capabilities;
	browserCapabilities = toolchain.capabilities;
	const enabled = config.toolchainEnabled;
	const media = buildMedia(config, {
		core,
		capabilities: toolchain.capabilities,
		dialogue: () => dialogue,
	});
	const toolchains = enabled
		? createToolchainRouting(
				toolchain.capabilities,
				toolchain.history,
				toolchain.embedQuery,
				toolchain.registry,
				toolchain.schemas,
				toolchain.worldAvailable,
			)
		: undefined;
	const dialogue = createDialogueService({
		logFile: () => config.logFile,
		objectRecognition: enabled
			? media.objectRecognition.port(CONVERSATION_DEFAULT_PRINCIPAL)
			: undefined,
		music: enabled ? media.music : undefined,
		image: enabled ? media.image : undefined,
		excalidraw: enabled ? media.drawingOperations : undefined,
		store,
		conversation,
		larm: inference,
		queue,
		memory,
		steward,
		goals: goals.dialoguePort,
		agents: enabled ? toolchain.agents : undefined,
		delegation: createDotsDialogue({
			store,
			tasks: delegated.tasks,
			conversation,
			capabilities: toolchain.capabilities,
		}),
		...(world ? { worldContext: world.context } : {}),
		...(toolchains
			? {
					toolchains,
					specialist: createSpecialistPort({
						routing: toolchains,
						registry: toolchain.registry,
						schemas: toolchain.schemas,
						clock: () => new Date().toISOString(),
					}),
				}
			: {}),
	});
	links.attachDialogue(dialogue);
	stewardAssembly.attachDialogue(dialogue);
	const voice = createVoiceDialogue(store, dialogue, inference);
	const monitoring = createMonitoring({
		remote: createLarmCollector({
			config: () => ({
				baseUrl: settings.get().larm.baseUrl,
				token: config.larmToken,
			}),
			onChange: settings.onChange,
			repository: createLarmRepository(store),
		}),
		settings,
		larmStatus: () => inference.status(),
		attempts: inference.attemptActivity,
		image: media.image.activity,
		music: media.music.activity,
		embedding: core.activity.embedding,
		judge: core.activity.judge,
		queue,
		dataDir: dirname(resolve(dbPath)),
	});
	scheduler.registerTarget(dialogue.promptTarget);
	return {
		store,
		changes,
		unsubscribeCommits: core.unsubscribeCommits,
		unsubscribeStatus: core.unsubscribeStatus,
		conversation,
		googleAccounts,
		ttsDictionary,
		datasetStore: core.datasetStore,
		attitudeDataset: core.attitudeDataset,
		inference,
		connectionModels: createConnectionModels(settings, config.env, { store }),
		serviceTests,
		excalidraw: media.excalidraw,
		drawingOperations: media.drawingOperations,
		image: media.image,
		uiCompositions,
		objectRecognition: media.objectRecognition,
		ocr,
		model3d,
		browser,
		music: media.music,
		queue,
		webResearch,
		scheduler,
		timers,
		...tasks,
		continuity,
		memory,
		steward,
		settings,
		world,
		toolchain,
		dialogue,
		voice,
		monitoring,
	};
}
export type Services = Awaited<ReturnType<typeof buildServices>>;
