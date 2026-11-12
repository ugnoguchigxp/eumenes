import { createRouterExport } from "./toolchain/router-export";
import type { Services } from "./server-services";
import { registerDots } from "./work/dots-http";

export function appServices(s: Services, secrets: readonly string[] = []) {
	return {
		agency: s.agency,
		knowledge: s.knowledge,
		capabilities: s.toolchain.capabilities,
		searchCheck: s.searchCheck,
		agents: s.toolchain.agents,
		attitudeDataset: s.attitudeDataset,
		conversation: s.conversation,
		dialogue: s.dialogue,
		voice: s.voice,
		liveVoice: s.liveVoice,
		larm: s.inference,
		queue: s.queue,
		scheduler: s.scheduler,
		settings: s.settings,
		inference: s.inference,
		connectionModels: s.connectionModels,
		googleAccounts: s.googleAccounts,
		memory: s.memory,
		steward: s.steward,
		webResearch: s.webResearch,
		changes: s.changes,
		serviceTests: s.serviceTests,
		monitoring: s.monitoring,
		music: s.music,
		image: s.image,
		docling: s.docling,
		canvas: s.canvas,
		markdown: s.markdown,
		excalidraw: s.excalidraw,
		drawingOperations: s.drawingOperations,
		objectRecognition: s.objectRecognition,
		ocr: s.ocr,
		model3d: s.model3d,
		scratch: s.scratch,
		compute: s.compute,
		browser: s.browser.service,
		tasks: s.delegated.tasks,
		dotsModule: {
			mount: (app: import("hono").Hono) =>
				registerDots(app, s.dots, s.dotsEvents, undefined, s.dotsMessages),
		},
		toolchainHistory: s.toolchain.history,
		routerExport: createRouterExport(s.store, secrets),
		routerMemory: s.toolchain.importRouterMemory,
		timers: s.timers,
		resources: s.resources,
		shell: s.toolchain.shell,
		terminals: s.toolchain.terminals,
		kanban: s.toolchain.kanban,
		toolchainActions: s.toolchain.actionRequests,
		// With World OFF nothing is assembled and the routes do not exist.
		...(s.world
			? {
					worldDocuments: {
						documents: s.world.documents,
						context: s.world.claimsContext,
					},
				}
			: {}),
	};
}
