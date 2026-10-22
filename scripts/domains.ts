/**
 * `tier` is the explicit layer of a domain. A domain may depend (api, web or
 * test) only on domains in a strictly lower tier, so lower domains can never
 * reference upper ones. scripts/boundaries.ts enforces this next to the
 * allow-list in `depends`; raising a dependency means raising `tier` here.
 */
export const domains = {
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
			api: ["capabilities", "inference", "larm", "queue", "tool-runtime"],
			web: [],
			test: [],
		},
	},
	ocr: {
		tier: 3,
		backend: "api/domains/ocr",
		web: "web/src/domains/ocr",
		components: "packages/design-system/src/components/OcrWorkspace",
		depends: { api: ["capabilities", "inference", "queue"], web: [], test: [] },
	},
	"object-recognition": {
		tier: 1,
		backend: "api/domains/object-recognition",
		web: "web/src/domains/object-recognition",
		components: null,
		depends: { api: ["capabilities", "queue"], web: [], test: [] },
	},
	compute: {
		tier: 1,
		backend: "api/domains/compute",
		web: "web/src/domains/compute",
		components: "packages/design-system/src/components/ComputeWorkspace",
		depends: { api: ["queue"], web: [], test: [] },
	},
	model3d: {
		tier: 1,
		backend: "api/domains/model3d",
		web: "web/src/domains/model3d",
		components: "packages/design-system/src/components/Model3dWorkspace",
		depends: { api: ["queue"], web: [], test: [] },
	},
	browser: {
		tier: 1,
		backend: "api/domains/browser",
		web: "web/src/domains/browser",
		components: "packages/design-system/src/components/BrowserWorkspace",
		depends: { api: ["queue"], web: [], test: [] },
	},
	kanban: {
		tier: 1,
		backend: "api/domains/kanban",
		web: "web/src/domains/kanban",
		components: null,
		depends: { api: ["capabilities"], web: [], test: [] },
	},
	"codex-tasks": {
		tier: 1,
		backend: "api/domains/codex-tasks",
		web: "web/src/domains/codex-tasks",
		components: null,
		depends: { api: ["coding"], web: [], test: [] },
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
			api: ["capabilities", "inference", "larm", "queue", "tool-runtime"],
			web: [],
			test: [],
		},
	},
	"ui-compositions": {
		tier: 3,
		backend: "api/domains/ui-compositions",
		web: "web/src/domains/ui-compositions",
		components: null,
		depends: {
			api: [],
			web: [],
			test: [],
		},
	},
	music: {
		tier: 3,
		backend: "api/domains/music",
		web: "web/src/domains/music",
		components: "web/src/components/domains/music",
		depends: {
			api: ["capabilities", "inference", "larm", "queue", "tool-runtime"],
			web: [],
			test: [],
		},
	},
	dots: {
		tier: 1,
		backend: "api/domains/dots",
		web: null,
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
	"coding-supervision": {
		tier: 3,
		backend: "api/domains/coding-supervision",
		web: null,
		components: null,
		depends: {
			api: ["coding", "inference", "queue", "task-reports", "tasks"],
			web: [],
			test: [],
		},
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
		depends: { api: [], web: [], test: [] },
	},
	pipelines: {
		tier: 1,
		backend: "api/domains/pipelines",
		web: "web/src/domains/pipelines",
		components: "packages/design-system/src/components/PipelineStudio",
		depends: { api: ["capabilities"], web: [], test: [] },
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
			api: ["capabilities", "inference", "pipelines", "queue", "tool-runtime"],
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
		depends: { api: ["queue"], web: [], test: [] },
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
		depends: {
			api: [],
			web: [],
			test: [],
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
		depends: { api: ["delivery"], web: ["avatar", "delivery"], test: [] },
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
		web: null,
		components: null,
		depends: { api: ["queue"], web: [], test: [] },
	},
	timers: {
		tier: 2,
		backend: "api/domains/timers",
		web: "web/src/domains/timers",
		components: "web/src/components/domains/timers",
		depends: { api: ["queue", "scheduler"], web: [], test: [] },
	},
	dialogue: {
		tier: 5,
		backend: "api/domains/dialogue",
		web: "web/src/domains/dialogue",
		components: null,
		depends: {
			api: [
				"agent-runtime",
				"capabilities",
				"conversation",
				"delivery",
				"inference",
				"memory",
				"queue",
				"scheduler",
				"toolchain-history",
				"tool-runtime",
			],
			web: ["conversation"],
			test: ["world"],
		},
	},
	"voice-dialogue": {
		tier: 6,
		backend: "api/domains/voice-dialogue",
		web: "web/src/domains/voice-dialogue",
		components: null,
		depends: {
			api: ["delivery", "dialogue", "inference", "settings"],
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
