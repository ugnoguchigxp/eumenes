import { buildVisualPerception } from "./media/visual-perception";
import { registerCaptureLibrary } from "./media/capture-library";
import type { Database } from "bun:sqlite";
import type { Capabilities } from "../domains/capabilities";
import type { DialogueService } from "../domains/dialogue";
import {
	createExcalidraw,
	registerDrawingOperations,
} from "../domains/excalidraw";
import { createImage } from "../domains/image";
import type { ConversationService } from "../domains/conversation";
import { createModel3d } from "../domains/model3d";
import { createLarmPlayground, createLocalServices } from "../domains/larm";
import { createMusic } from "../domains/music";
import {
	createObjectRecognition,
	type ObjectRecognitionService,
} from "../domains/object-recognition";
import type { Config } from "../infrastructure/config";
import type { Core } from "./server-core";

/**
 * Music, image, drawing and object recognition. Their jobs report into the
 * dialogue that is built after them, hence the lazy `dialogue`.
 */
export function buildMedia(
	config: Config,
	deps: {
		core: Pick<Core, "store" | "queue" | "inference" | "settings">;
		capabilities: Capabilities;
		agents?: import("../domains/agent-runtime").AgentRuntime;
		dialogue: () => DialogueService;
	},
) {
	const { store, queue, inference, settings } = deps.core;
	const mediaGateway = () => {
		const s = settings.get();
		return createLarmPlayground({
			baseUrl: s.larm.baseUrl ?? undefined,
			token: config.larmToken,
			profile: s.larm.profile,
			audience: s.larm.audience,
			providerHosts: config.larmProviderHosts,
		});
	};
	const mediaDependencies = {
		validateExecutionInTransaction:
			deps.agents?.executions.authorizeChildInTransaction,
		store,
		queue,
		inference,
		capabilities: deps.capabilities,
		gateway: mediaGateway,
		onJob: (db: Database, runId: string, jobId: string) =>
			deps.dialogue().linkOperationJobInTransaction(db, runId, jobId),
		onFinished: (db: Database, runId: string) =>
			deps.dialogue().finishOperationInTransaction(db, runId),
	};
	const music = createMusic(mediaDependencies);
	const image = createImage(mediaDependencies);
	const excalidraw = createExcalidraw({
		store,
		webOrigin: config.origin,
		connection: () => {
			const saved = settings.excalidrawCredentials(),
				larmUrl = settings.get().larm.baseUrl;
			if (!saved || !larmUrl)
				throw new Error("excalidraw_connection_unconfigured");
			if (
				saved.consumerToken === config.larmToken ||
				saved.appToken === config.larmToken
			)
				throw new Error("excalidraw_credential_roles_invalid");
			return {
				version: `${larmUrl}:${saved.revision}`,
				gatewayUrl: saved.gatewayUrl,
				gatewayOrigin: saved.gatewayOrigin,
				leaseEndpoint: saved.leaseEndpoint,
				appToken: saved.appToken,
				client: createLocalServices({
					baseUrl: larmUrl,
					token: saved.consumerToken,
				}),
			};
		},
	});
	const drawingOperations = registerDrawingOperations({
		...mediaDependencies,
		service: excalidraw,
	});
	let objectRecognition!: ObjectRecognitionService;
	const captureSaveInTransaction = registerCaptureLibrary(
		queue,
		image,
		() => objectRecognition,
		() => mediaGateway().imageImports.identity,
	);
	objectRecognition = createObjectRecognition({
		visual: buildVisualPerception(config, settings),
		store,
		queue,
		connection: () => settings.objectRecognitionCredentials(),
		captureSaveInTransaction,
		captureResumeInTransaction: captureSaveInTransaction.resumeInTransaction,
	});
	return {
		gateway: mediaGateway,
		music,
		image,
		excalidraw,
		drawingOperations,
		objectRecognition,
	};
}

/**
 * 3D generation on LARM's mesh service, over the saved Control connection and its Bearer. It is
 * built before the toolchain (its adapter is registered there); finished generations are reported
 * into the asking conversation in the same writer transaction.
 */
export function buildModel3d(
	config: Config,
	deps: {
		core: Pick<Core, "store" | "queue" | "settings">;
		conversation: ConversationService;
	},
) {
	const { store, queue, settings } = deps.core;
	return createModel3d({
		store,
		queue,
		larm: () => {
			const s = settings.get();
			if (!s.larm.baseUrl || !config.larmToken) return null;
			return createLarmPlayground({
				baseUrl: s.larm.baseUrl,
				token: config.larmToken,
				profile: s.larm.profile,
				audience: s.larm.audience,
				providerHosts: config.larmProviderHosts,
			}).meshes;
		},
		announceInTransaction(tx, notice) {
			const id = `model3d-notice:${notice.id}`;
			if (deps.conversation.messageInTransaction(tx, id)) return;
			deps.conversation.appendInTransaction(tx, {
				id,
				conversationId: notice.conversationId,
				role: "assistant",
				text: notice.message,
				createdAt: notice.at,
				runId: null,
			});
		},
	});
}
