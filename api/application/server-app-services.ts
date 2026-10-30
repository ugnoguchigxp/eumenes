import type { Services } from "./server-services";
import { registerDots } from "./work/dots-http";

export function appServices(s: Services) {
	return {
		capabilities: s.toolchain.capabilities,
		pipelines: s.pipelines,
		pipelineTrials: s.pipelineTrials,
		searchCheck: s.searchCheck,
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
		monitoring: s.monitoring,
		music: s.music,
		image: s.image,
		docling: s.docling,
		excalidraw: s.excalidraw,
		drawingOperations: s.drawingOperations,
		objectRecognition: s.objectRecognition,
		ocr: s.ocr,
		model3d: s.model3d,
		compute: s.compute,
		browser: s.browser.service,
		tasks: s.delegated.tasks,
		coding: s.codingComposition?.coding,
		codingSupervision: s.supervision,
		taskReports: s.taskReports,
		dotsModule: {
			mount: (app: import("hono").Hono) =>
				registerDots(
					app,
					s.dots,
					s.dotsEvents,
					s.delegated.tasks,
					undefined,
					s.dotsMessages,
				),
		},
		toolchainHistory: s.toolchain.history,
		timers: s.timers,
		resources: s.resources,
		shell: s.toolchain.shell,
		terminals: s.toolchain.terminals,
		kanban: s.toolchain.kanban,
		toolchainActions: s.toolchain.actionRequests,
		// With World OFF nothing is assembled and the routes do not exist.
		...(s.world
			? {
					worldClaims: {
						claims: s.world.claims,
						documents: s.world.documents,
						context: s.world.claimsContext,
					},
				}
			: {}),
	};
}
