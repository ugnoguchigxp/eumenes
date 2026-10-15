import type { Services } from "./server";
import { registerDots } from "./dots-http";

export function appServices(s: Services) {
	return {
		capabilities: s.toolchain.capabilities,
		agents: s.toolchain.agents,
		attitudeDataset: s.attitudeDataset,
		conversation: s.conversation,
		dialogue: s.dialogue,
		voice: s.voice,
		larm: s.inference,
		queue: s.queue,
		scheduler: s.scheduler,
		settings: s.settings,
		inference: s.inference,
		connectionModels: s.connectionModels,
		googleAccounts: s.googleAccounts,
		ttsDictionary: s.ttsDictionary,
		memory: s.memory,
		steward: s.steward,
		continuity: s.continuity,
		webResearch: s.webResearch,
		changes: s.changes,
		serviceTests: s.serviceTests,
		music: s.music,
		image: s.image,
		uiCompositions: s.uiCompositions,
		excalidraw: s.excalidraw,
		drawingOperations: s.drawingOperations,
		objectRecognition: s.objectRecognition,
		ocr: s.ocr,
		tasks: s.delegated.tasks,
		coding: s.codingComposition?.coding,
		codingSupervision: s.supervision,
		taskReports: s.taskReports,
		dotsModule: {
			mount: (app: import("hono").Hono) =>
				registerDots(app, s.dots, s.dotsEvents, s.delegated.tasks),
		},
		toolchainHistory: s.toolchain.history,
		timers: s.timers,
		terminals: s.toolchain.terminals,
		kanban: s.toolchain.kanban,
		toolchainActions: s.toolchain.actionRequests,
		// With World OFF nothing is assembled and the routes do not exist.
		...(s.world
			? {
					worldClaims: {
						claims: s.world.claims,
						context: s.world.claimsContext,
					},
				}
			: {}),
	};
}
