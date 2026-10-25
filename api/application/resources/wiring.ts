import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../infrastructure/sqlite";
import {
	AGENT_REPORT_RESOURCE_PREFIX,
	createAgentReportResourceAdapter,
} from "../../domains/agent-runtime";
import { createBrowserResourceAdapter } from "../../domains/browser";
import type { Capabilities } from "../../domains/capabilities";
import {
	CODEX_RESOURCE_PREFIX,
	createCodexTasksResourceAdapter,
} from "../../domains/codex-tasks";
import { createComputeResourceAdapter } from "../../domains/compute";
import type { EventStore } from "../../domains/continuity";
import { CONVERSATION_DEFAULT_PRINCIPAL } from "../../domains/conversation/contracts";
import { createDrawingResourceAdapter } from "../../domains/excalidraw";
import { createImageResourceAdapter } from "../../domains/image";
import {
	CODE_TASK_RESOURCE_KIND,
	createKanbanResourceAdapter,
	KANBAN_RESOURCE_PREFIX,
} from "../../domains/kanban";
import type { LarmPlayground } from "../../domains/larm";
import { createModel3dResourceAdapter } from "../../domains/model3d";
import { createMusicResourceAdapters } from "../../domains/music";
import { createOcrResourceAdapter } from "../../domains/ocr";
import { createPipelinesResourceAdapter } from "../../domains/pipelines";
import {
	combineKindAdapters,
	type ResourceKind,
} from "../../domains/resources";
import type { ShellService } from "../../domains/shell";
import { createUiCompositionResourceAdapter } from "../../domains/ui-compositions";
import {
	createWebResearchResourceAdapter,
	type WebResearchService,
} from "../../domains/web-research";
import { createResourceAccess } from "./access";
import { createEventResourceAdapter } from "./adapters/event";
import {
	createShellResourceAdapter,
	SHELL_RESOURCE_PREFIX,
} from "./adapters/shell";

/** The only conversation the application holds today (drawings and events are read in it). */
const CONVERSATIONS = ["main"] as const;

/**
 * The resource registry with every owner's adapter (spec resource-uri-implementation-plan-2026-10-25.md §3). A kind with several owners is combined by id prefix.
 */
export function buildResources(deps: {
	store: SqliteStore;
	capabilities: Pick<Capabilities, "resourceKindsInTransaction">;
	gateway: () => LarmPlayground;
	events: Pick<EventStore, "eventInTransaction" | "logInTransaction">;
	webResearch: Pick<WebResearchService, "get">;
	shell?: Pick<ShellService, "runInTransaction" | "recentInTransaction">;
}) {
	const { store } = deps;
	const owner = CONVERSATION_DEFAULT_PRINCIPAL;
	const [track, playlist] = createMusicResourceAdapters({
		store,
		gateway: deps.gateway,
	});
	const codeTasks = combineKindAdapters(CODE_TASK_RESOURCE_KIND, [
		{
			prefix: KANBAN_RESOURCE_PREFIX,
			adapter: createKanbanResourceAdapter({ store }),
		},
		{
			prefix: CODEX_RESOURCE_PREFIX,
			adapter: createCodexTasksResourceAdapter({ store }),
		},
		...(deps.shell
			? [
					{
						prefix: SHELL_RESOURCE_PREFIX,
						adapter: createShellResourceAdapter({ store, shell: deps.shell }),
					},
				]
			: []),
	]);
	const webReport = createWebResearchResourceAdapter({
		store,
		get: (runId) => deps.webResearch.get(runId),
	});
	const reports = combineKindAdapters(webReport.kind, [
		{ prefix: "web-research", adapter: webReport },
		{
			prefix: AGENT_REPORT_RESOURCE_PREFIX,
			adapter: createAgentReportResourceAdapter({ store }),
		},
	]);
	const access = createResourceAccess({
		store,
		kinds: () =>
			store.read((db) =>
				deps.capabilities.resourceKindsInTransaction(db),
			) as ResourceKind[],
		adapters: [
			createImageResourceAdapter({ store }),
			track,
			playlist,
			createModel3dResourceAdapter({ store, owner }),
			createDrawingResourceAdapter({ store, conversationId: CONVERSATIONS[0] }),
			createUiCompositionResourceAdapter({ store }),
			reports,
			createComputeResourceAdapter({ store, owner }),
			createBrowserResourceAdapter({ store, owner }),
			createOcrResourceAdapter({ store }),
			createPipelinesResourceAdapter({ store }),
			codeTasks,
			createEventResourceAdapter({
				store,
				events: deps.events,
				conversationIds: (_db: Database) => CONVERSATIONS,
			}),
		],
	});
	return { access };
}
export type Resources = ReturnType<typeof buildResources>;
