/**
 * `tier` is the explicit layer of a domain. A domain may depend (api, web or
 * test) only on domains in a strictly lower tier, so lower domains can never
 * reference upper ones. scripts/boundaries.ts enforces this next to the
 * allow-list in `depends`; raising a dependency means raising `tier` here.
 */
export const domains = {
	scratch: {
		tier: 1,
		backend: "api/domains/scratch",
		web: null,
		components: null,
		depends: { api: ["resources"], web: [], test: [] },
	},
	markdown: {
		tier: 1,
		backend: "api/domains/markdown",
		web: "web/src/domains/markdown",
		components: "packages/design-system/src/components/MarkdownWorkspace",
		integrationTests: [
			"api/application/markdown/markdown-registration.test.ts",
			"api/application/toolchain/capability-seed.test.ts",
		],
		depends: { api: ["queue", "resources"], web: ["resources"], test: [] },
	},
	collaboration: {
		tier: 3,
		backend: "api/domains/collaboration",
		web: "web/src/domains/collaboration",
		components: null,
		depends: { api: [], web: [], test: [] },
	},
	usage: {
		tier: 4,
		backend: "api/domains/usage",
		web: "web/src/domains/usage",
		components: "packages/design-system/src/components/UsageDashboard",
		depends: { api: [], web: [], test: [] },
	},
	docling: {
		tier: 1,
		backend: "api/domains/docling",
		web: "web/src/domains/docling",
		components: "packages/design-system/src/components/ExternalAppLauncher",
		depends: { api: ["larm"], web: [], test: [] },
	},
	"google-accounts": {
		tier: 0,
		backend: "api/domains/google-accounts",
		web: "web/src/domains/google-accounts",
		components: "packages/design-system/src/components/GoogleAccounts",
		depends: { api: [], web: [], test: [] },
	},
	excalidraw: {
		tier: 3,
		backend: "api/domains/excalidraw",
		web: "web/src/domains/excalidraw",
		components: null,
		depends: {
			api: [
				"capabilities",
				"inference",
				"larm",
				"queue",
				"resources",
				"tool-runtime",
			],
			web: ["resources"],
			test: [],
		},
	},
	ocr: {
		tier: 3,
		backend: "api/domains/ocr",
		web: "web/src/domains/ocr",
		components: "packages/design-system/src/components/OcrWorkspace",
		depends: {
			api: ["capabilities", "inference", "queue", "resources", "larm"],
			web: ["resources"],
			test: [],
		},
	},
	"object-recognition": {
		tier: 1,
		backend: "api/domains/object-recognition",
		web: "web/src/domains/object-recognition",
		components: null,
		depends: { api: ["capabilities", "queue", "larm"], web: [], test: [] },
	},
	compute: {
		tier: 1,
		backend: "api/domains/compute",
		web: "web/src/domains/compute",
		components: "packages/design-system/src/components/ComputeWorkspace",
		depends: { api: ["queue", "resources"], web: ["resources"], test: [] },
	},
	model3d: {
		tier: 1,
		backend: "api/domains/model3d",
		web: "web/src/domains/model3d",
		components: "packages/design-system/src/components/Model3dWorkspace",
		depends: {
			api: ["larm", "queue", "resources"],
			web: ["resources"],
			test: [],
		},
	},
	browser: {
		tier: 1,
		backend: "api/domains/browser",
		web: "web/src/domains/browser",
		components: "packages/design-system/src/components/BrowserWorkspace",
		depends: { api: ["queue", "resources"], web: ["resources"], test: [] },
	},
	kanban: {
		tier: 1,
		backend: "api/domains/kanban",
		web: "web/src/domains/kanban",
		components: null,
		depends: {
			api: ["capabilities", "resources"],
			web: ["resources"],
			test: [],
		},
	},
	"codex-tasks": {
		tier: 1,
		backend: "api/domains/codex-tasks",
		web: "web/src/domains/codex-tasks",
		components: null,
		depends: { api: ["coding", "resources"], web: [], test: [] },
	},
	shell: {
		tier: 0,
		backend: "api/domains/shell",
		web: "web/src/domains/shell",
		components: null,
		depends: { api: [], web: [], test: [] },
	},
	terminals: {
		tier: 0,
		backend: "api/domains/terminals",
		web: "web/src/domains/terminals",
		components: null,
		depends: { api: [], web: [], test: [] },
	},
	background: {
		tier: 0,
		backend: null,
		web: "web/src/domains/background",
		components: null,
		depends: { api: [], web: [], test: [] },
	},
	image: {
		tier: 3,
		backend: "api/domains/image",
		web: "web/src/domains/image",
		components: null,
		depends: {
			api: [
				"capabilities",
				"inference",
				"larm",
				"queue",
				"resources",
				"tool-runtime",
			],
			web: ["resources"],
			test: [],
		},
	},
	"app-development": {
		tier: 3,
		backend: "api/domains/app-development",
		integrationTests: [
			"api/application/app-development/app-development.test.ts",
			"api/application/app-development/storage-recovery.test.ts",
			"api/application/app-development/app-storage.test.ts",
		],
		web: null,
		components: null,
		depends: { api: [], web: [], test: [] },
	},
	"git-observation": {
		tier: 0,
		backend: "api/domains/git-observation",
		web: null,
		components: null,
		depends: { api: [], web: [], test: [] },
	},
	"ui-compositions": {
		tier: 3,
		backend: "api/domains/ui-compositions",
		web: "web/src/domains/ui-compositions",
		components: null,
		depends: {
			api: ["resources"],
			web: ["resources"],
			test: [],
		},
	},
	music: {
		tier: 3,
		backend: "api/domains/music",
		web: "web/src/domains/music",
		components: "web/src/components/domains/music",
		depends: {
			api: [
				"capabilities",
				"inference",
				"larm",
				"queue",
				"resources",
				"tool-runtime",
			],
			web: ["resources"],
			test: [],
		},
	},
	dots: {
		tier: 1,
		backend: "api/domains/dots",
		web: "web/src/domains/dots",
		components: null,
		depends: { api: ["queue"], web: [], test: [] },
	},
	"task-reports": {
		tier: 1,
		backend: "api/domains/task-reports",
		web: null,
		components: null,
		depends: { api: ["tasks"], web: [], test: [] },
	},
	coding: {
		tier: 0,
		backend: "api/domains/coding",
		web: null,
		components: null,
		depends: { api: [], web: [], test: [] },
	},
	artifact: {
		tier: 3,
		backend: null,
		web: "web/src/domains/artifact",
		components: "web/src/components/domains/artifact",
		depends: { api: [], web: ["conversation"], test: [] },
	},
	tasks: {
		tier: 0,
		backend: "api/domains/tasks",
		web: null,
		components: null,
		depends: { api: [], web: [], test: [] },
	},
	capabilities: {
		tier: 0,
		backend: "api/domains/capabilities",
		web: null,
		components: null,
		integrationTests: ["api/application/canvas/canvas.test.ts"],
		depends: { api: [], web: [], test: [] },
	},
	pipelines: {
		tier: 1,
		backend: "api/domains/pipelines",
		web: null,
		components: null,
		integrationTests: [
			"api/application/pipelines/pipeline-execution.test.ts",
			"api/application/pipelines/vendor.test.ts",
			"api/application/pipelines/workflow-authoring.test.ts",
		],
		depends: {
			api: [],
			web: [],
			test: ["queue"],
		},
	},
	"tool-runtime": {
		tier: 1,
		backend: "api/domains/tool-runtime",
		web: null,
		components: null,
		depends: { api: ["capabilities", "queue"], web: [], test: [] },
	},
	"agent-runtime": {
		tier: 3,
		backend: "api/domains/agent-runtime",
		web: "web/src/domains/agent-runtime",
		components: null,
		depends: {
			api: [
				"capabilities",
				"inference",
				"pipelines",
				"queue",
				"resources",
				"tool-runtime",
			],
			web: [],
			test: [],
		},
	},
	"toolchain-history": {
		tier: 1,
		backend: "api/domains/toolchain-history",
		web: null,
		components: null,
		depends: { api: ["capabilities"], web: [], test: [] },
	},
	"web-research": {
		tier: 1,
		backend: "api/domains/web-research",
		web: null,
		components: null,
		depends: { api: ["queue", "resources"], web: [], test: [] },
	},
	"attitude-dataset": {
		tier: 1,
		backend: "api/domains/attitude-dataset",
		web: null,
		components: null,
		depends: { api: ["delivery"], web: [], test: [] },
	},
	monitoring: {
		tier: 3,
		backend: "api/domains/monitoring",
		web: "web/src/domains/monitoring",
		components: null,
		depends: {
			api: ["inference", "larm", "queue", "settings"],
			web: ["background"],
			test: [],
		},
	},
	"service-tests": {
		tier: 3,
		backend: "api/domains/service-tests",
		web: "web/src/domains/service-tests",
		components: null,
		depends: { api: ["inference", "larm", "settings"], web: [], test: [] },
	},
	delivery: {
		tier: 0,
		backend: "api/domains/delivery",
		web: null,
		components: null,
		depends: { api: [], web: [], test: [] },
	},
	avatar: {
		tier: 1,
		backend: null,
		web: "web/src/domains/avatar",
		components: null,
		depends: { api: [], web: ["delivery"], test: [] },
	},
	settings: {
		tier: 0,
		backend: "api/domains/settings",
		web: "web/src/domains/settings",
		components: null,
		integrationTests: ["api/application/backup-restore.test.ts"],
		depends: {
			api: [],
			web: [],
			test: [],
		},
	},
	"live-voice": {
		tier: 3,
		backend: "api/domains/live-voice",
		web: "web/src/domains/live-voice",
		components: null,
		depends: {
			api: ["settings"],
			web: ["audio", "settings"],
			test: ["conversation"],
		},
	},
	inference: {
		tier: 2,
		backend: "api/domains/inference",
		web: null,
		components: null,
		depends: {
			api: ["attitude-dataset", "delivery", "larm", "settings"],
			web: [],
			test: [],
		},
	},
	"tts-dictionary": {
		tier: 0,
		backend: "api/domains/tts-dictionary",
		web: null,
		components: null,
		depends: { api: [], web: [], test: [] },
	},
	conversation: {
		tier: 2,
		backend: "api/domains/conversation",
		web: "web/src/domains/conversation",
		components: "web/src/components/domains/conversation",
		depends: {
			api: ["delivery"],
			web: ["avatar", "audio", "delivery"],
			test: [],
		},
	},
	resources: {
		tier: 0,
		backend: "api/domains/resources",
		web: "web/src/domains/resources",
		components: null,
		depends: { api: [], web: [], test: [] },
	},
	continuity: {
		tier: 0,
		backend: "api/domains/continuity",
		web: null,
		components: null,
		depends: { api: [], web: [], test: [] },
	},
	goals: {
		tier: 0,
		backend: "api/domains/goals",
		web: null,
		components: null,
		depends: { api: [], web: [], test: [] },
	},
	world: {
		tier: 4,
		backend: "api/domains/world",
		web: null,
		components: null,
		depends: {
			api: ["conversation", "goals"],
			web: [],
			test: ["memory"],
		},
	},
	memory: {
		tier: 3,
		backend: "api/domains/memory",
		web: null,
		components: null,
		integrationTests: [
			"api/application/backup-restore.test.ts",
			"api/application/memory-host-integration.test.ts",
			"api/application/memory-host.test.ts",
			"api/application/server.test.ts",
		],
		depends: {
			api: ["continuity", "conversation", "tool-runtime"],
			web: [],
			test: [],
		},
	},
	steward: {
		tier: 5,
		backend: "api/domains/steward",
		web: null,
		components: null,
		depends: {
			api: ["continuity", "conversation", "goals", "memory", "world"],
			web: [],
			test: ["queue"],
		},
	},
	larm: {
		tier: 0,
		backend: "api/domains/larm",
		web: null,
		components: null,
		depends: { api: [], web: [], test: [] },
	},
	audio: {
		tier: 0,
		backend: null,
		web: "web/src/domains/audio",
		components: null,
		depends: { api: [], web: [], test: [] },
	},
	queue: {
		tier: 0,
		backend: "api/domains/queue",
		web: null,
		components: null,
		depends: { api: [], web: [], test: [] },
	},
	scheduler: {
		tier: 1,
		backend: "api/domains/scheduler",
		web: "web/src/domains/scheduler",
		components: null,
		depends: { api: ["queue"], web: [], test: [] },
		integrationTests: ["api/application/scheduler/scheduler-toolchain.test.ts"],
	},
	timers: {
		tier: 2,
		backend: "api/domains/timers",
		web: "web/src/domains/timers",
		components: "web/src/components/domains/timers",
		depends: { api: ["queue", "scheduler"], web: ["resources"], test: [] },
	},
	pursuit: {
		tier: 3,
		integrationTests: [
			"api/application/pursuit/document-integration.test.ts",
			"api/application/pursuit/document-registration.test.ts",
			"api/application/pursuit/pursuit-integration.test.ts",
			"api/application/pursuit/vendor.test.ts",
		],
		backend: "api/domains/pursuit",
		web: null,
		components: null,
		depends: {
			api: ["capabilities", "inference", "queue", "resources", "tool-runtime"],
			web: [],
			test: [],
		},
	},
	"web-note": {
		tier: 3,
		integrationTests: [
			"api/application/agency/web-note-research.test.ts",
			"api/application/web-note/codex-web-note.test.ts",
			"api/application/web-note/web-note-integration.test.ts",
		],
		backend: "api/domains/web-note",
		web: null,
		components: null,
		depends: {
			api: ["capabilities", "queue", "tool-runtime"],
			web: [],
			test: [],
		},
	},
	dialogue: {
		tier: 5,
		backend: "api/domains/dialogue",
		web: "web/src/domains/dialogue",
		components: null,
		integrationTests: [
			"api/application/agency/archive-recovery.test.ts",
			"api/application/agency/archive-receipt.test.ts",
			"api/application/agency/checkpoint-sources.test.ts",
			"api/application/agency/catalog-input.test.ts",
			"api/application/agency/forgotten-context.test.ts",
			"api/application/agency/continuity.test.ts",
			"api/application/agency/continuity-actions.test.ts",
			"api/application/agency/routes.test.ts",
			"api/application/agency/always-on.test.ts",
			"api/application/agency/always-on-activity.test.ts",
			"api/application/agency/always-on-heard.test.ts",
			"api/application/agency/always-on-pace.test.ts",
			"api/application/agency/always-on-switch.test.ts",
			"api/application/agency/always-on-authority.test.ts",
			"api/application/agency/always-on-checkpoint.test.ts",
		],
		depends: {
			api: [
				"agent-runtime",
				"capabilities",
				"continuity",
				"conversation",
				"delivery",
				"inference",
				"memory",
				"queue",
				"resources",
				"scheduler",
				"toolchain-history",
				"tool-runtime",
			],
			web: ["conversation"],
			test: ["goals"],
		},
	},
	"voice-dialogue": {
		tier: 6,
		backend: "api/domains/voice-dialogue",
		web: "web/src/domains/voice-dialogue",
		components: null,
		depends: {
			api: ["delivery", "dialogue", "inference"],
			web: ["audio", "avatar", "dialogue", "settings"],
			test: [],
		},
	},
} as const;
export type Domain = keyof typeof domains;
export function isDomain(value: string): value is Domain {
	return value in domains;
}
/** `test` sees every production edge plus the test-only ones. */
export type Layer = "api" | "web" | "test";
export type Depends = Record<Layer, readonly string[]>;
export function dependsOf(
	domain: Domain,
	layer: Layer,
	graph: Record<string, { depends: Depends }> = domains,
): readonly Domain[] {
	const depends = graph[domain]?.depends;
	if (!depends) return [];
	return (
		layer === "test"
			? [...depends.api, ...depends.web, ...depends.test]
			: depends[layer]
	) as readonly Domain[];
}
export function closure(
	domain: Domain,
	layer: Layer = "test",
	graph: Record<string, { depends: Depends }> = domains,
): Domain[] {
	const visited = new Set<Domain>();
	const visiting = new Set<Domain>();
	function visit(name: Domain) {
		if (visiting.has(name)) throw new Error(`domain_dependency_cycle:${name}`);
		if (visited.has(name)) return;
		visiting.add(name);
		for (const dep of dependsOf(name, layer, graph)) visit(dep);
		visiting.delete(name);
		visited.add(name);
	}
	visit(domain);
	return [...visited];
}
export function ownedPaths(domain: Domain): string[] {
	const info = domains[domain];
	return [
		...([info.backend, info.web, info.components].filter(Boolean) as string[]),
		...(domain === "artifact" ? ["packages/artifact-ui/src"] : []),
		...(domain === "coding"
			? ["packages/coding-runner/src", "packages/coding-runner/test"]
			: []),
	];
}
