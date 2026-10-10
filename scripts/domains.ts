export const domains = {
	"task-reports": {
		backend: "api/domains/task-reports",
		web: null,
		components: null,
		depends: { api: ["tasks"], web: [], test: [] },
	},
	"coding-supervision": {
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
		backend: "api/domains/coding",
		web: null,
		components: null,
		depends: { api: [], web: [], test: [] },
	},
	artifact: {
		backend: null,
		web: "web/src/domains/artifact",
		components: "web/src/components/domains/artifact",
		depends: { api: [], web: ["conversation"], test: [] },
	},
	tasks: {
		backend: "api/domains/tasks",
		web: null,
		components: null,
		depends: { api: [], web: [], test: [] },
	},
	capabilities: {
		backend: "api/domains/capabilities",
		web: null,
		components: null,
		depends: { api: [], web: [], test: [] },
	},
	"tool-runtime": {
		backend: "api/domains/tool-runtime",
		web: null,
		components: null,
		depends: { api: ["capabilities", "queue"], web: [], test: [] },
	},
	"agent-runtime": {
		backend: "api/domains/agent-runtime",
		web: "web/src/domains/agent-runtime",
		components: null,
		depends: {
			api: ["capabilities", "inference", "queue", "tool-runtime"],
			web: [],
			test: [],
		},
	},
	"research-routes": {
		backend: "api/domains/research-routes",
		web: "web/src/domains/research-routes",
		components: null,
		depends: { api: ["queue"], web: [], test: [] },
	},
	"web-research": {
		backend: "api/domains/web-research",
		web: null,
		components: null,
		depends: { api: ["queue"], web: [], test: [] },
	},
	"attitude-dataset": {
		backend: "api/domains/attitude-dataset",
		web: null,
		components: null,
		depends: { api: ["delivery"], web: [], test: [] },
	},
	"service-tests": {
		backend: "api/domains/service-tests",
		web: "web/src/domains/service-tests",
		components: null,
		depends: { api: ["inference", "larm", "settings"], web: [], test: [] },
	},
	delivery: {
		backend: "api/domains/delivery",
		web: null,
		components: null,
		depends: { api: [], web: [], test: [] },
	},
	avatar: {
		backend: null,
		web: "web/src/domains/avatar",
		components: null,
		depends: { api: [], web: ["delivery"], test: [] },
	},
	settings: {
		backend: "api/domains/settings",
		web: "web/src/domains/settings",
		components: null,
		depends: { api: [], web: ["tts-dictionary"], test: [] },
	},
	inference: {
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
		backend: "api/domains/tts-dictionary",
		web: "web/src/domains/tts-dictionary",
		components: null,
		depends: { api: [], web: [], test: [] },
	},
	conversation: {
		backend: "api/domains/conversation",
		web: "web/src/domains/conversation",
		components: "web/src/components/domains/conversation",
		depends: { api: ["delivery"], web: ["avatar", "delivery"], test: [] },
	},
	continuity: {
		backend: "api/domains/continuity",
		web: null,
		components: null,
		depends: { api: [], web: [], test: [] },
	},
	goals: {
		backend: "api/domains/goals",
		web: null,
		components: null,
		depends: { api: [], web: [], test: [] },
	},
	world: {
		backend: "api/domains/world",
		web: "web/src/domains/world",
		components: "web/src/components/domains/world",
		depends: {
			api: ["conversation", "goals"],
			web: ["conversation"],
			test: ["memory"],
		},
	},
	memory: {
		backend: "api/domains/memory",
		web: null,
		components: null,
		depends: { api: ["continuity", "conversation"], web: [], test: [] },
	},
	larm: {
		backend: "api/domains/larm",
		web: null,
		components: null,
		depends: { api: [], web: [], test: [] },
	},
	audio: {
		backend: null,
		web: "web/src/domains/audio",
		components: null,
		depends: { api: [], web: [], test: [] },
	},
	queue: {
		backend: "api/domains/queue",
		web: null,
		components: null,
		depends: { api: [], web: [], test: [] },
	},
	scheduler: {
		backend: "api/domains/scheduler",
		web: null,
		components: null,
		depends: { api: ["queue"], web: [], test: [] },
	},
	timers: {
		backend: "api/domains/timers",
		web: "web/src/domains/timers",
		components: "web/src/components/domains/timers",
		depends: { api: ["queue", "scheduler"], web: [], test: [] },
	},
	dialogue: {
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
			],
			web: ["conversation"],
			test: ["world"],
		},
	},
	"voice-dialogue": {
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
