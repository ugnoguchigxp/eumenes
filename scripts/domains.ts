export const domains = {
	"task-reports": {
		backend: "api/domains/task-reports",
		web: null,
		components: null,
		depends: ["tasks"],
	},
	"coding-supervision": {
		backend: "api/domains/coding-supervision",
		web: null,
		components: null,
		depends: ["tasks", "coding", "task-reports", "queue", "inference"],
	},
	coding: {
		backend: "api/domains/coding",
		web: null,
		components: null,
		depends: [],
	},
	artifact: {
		backend: null,
		web: "web/src/domains/artifact",
		components: "web/src/components/domains/artifact",
		depends: ["conversation"],
	},
	tasks: {
		backend: "api/domains/tasks",
		web: null,
		components: null,
		depends: [],
	},
	capabilities: {
		backend: "api/domains/capabilities",
		web: null,
		components: null,
		depends: [],
	},
	"tool-runtime": {
		backend: "api/domains/tool-runtime",
		web: null,
		components: null,
		depends: ["capabilities", "queue"],
	},
	"agent-runtime": {
		backend: "api/domains/agent-runtime",
		web: "web/src/domains/agent-runtime",
		components: null,
		depends: ["capabilities", "tool-runtime", "inference", "queue"],
	},
	"research-routes": {
		backend: "api/domains/research-routes",
		web: "web/src/domains/research-routes",
		components: null,
		depends: ["capabilities", "inference", "queue"],
	},
	"web-research": {
		backend: "api/domains/web-research",
		web: null,
		components: null,
		depends: ["queue"],
	},
	"attitude-dataset": {
		backend: "api/domains/attitude-dataset",
		web: null,
		components: null,
		depends: ["delivery"],
	},
	"service-tests": {
		backend: "api/domains/service-tests",
		web: "web/src/domains/service-tests",
		components: null,
		depends: ["settings", "larm", "inference"],
	},
	delivery: {
		backend: "api/domains/delivery",
		web: null,
		components: null,
		depends: [],
	},
	avatar: {
		backend: null,
		web: "web/src/domains/avatar",
		components: null,
		depends: ["delivery"],
	},
	settings: {
		backend: "api/domains/settings",
		web: "web/src/domains/settings",
		components: null,
		depends: ["tts-dictionary"],
	},
	inference: {
		backend: "api/domains/inference",
		web: null,
		components: null,
		depends: ["settings", "larm", "delivery", "attitude-dataset"],
	},
	"tts-dictionary": {
		backend: "api/domains/tts-dictionary",
		web: "web/src/domains/tts-dictionary",
		components: null,
		depends: [],
	},
	conversation: {
		backend: "api/domains/conversation",
		web: "web/src/domains/conversation",
		components: "web/src/components/domains/conversation",
		depends: ["avatar", "delivery"],
	},
	continuity: {
		backend: "api/domains/continuity",
		web: null,
		components: null,
		depends: [],
	},
	goals: {
		backend: "api/domains/goals",
		web: null,
		components: null,
		depends: [],
	},
	world: {
		backend: "api/domains/world",
		web: null,
		components: null,
		depends: ["conversation", "goals", "memory"],
	},
	memory: {
		backend: "api/domains/memory",
		web: null,
		components: null,
		depends: ["conversation", "continuity"],
	},
	larm: {
		backend: "api/domains/larm",
		web: null,
		components: null,
		depends: [],
	},
	audio: {
		backend: null,
		web: "web/src/domains/audio",
		components: null,
		depends: [],
	},
	queue: {
		backend: "api/domains/queue",
		web: null,
		components: null,
		depends: [],
	},
	scheduler: {
		backend: "api/domains/scheduler",
		web: null,
		components: null,
		depends: ["queue"],
	},
	timers: {
		backend: "api/domains/timers",
		web: "web/src/domains/timers",
		components: "web/src/components/domains/timers",
		depends: ["queue", "scheduler"],
	},
	dialogue: {
		backend: "api/domains/dialogue",
		web: "web/src/domains/dialogue",
		components: null,
		depends: [
			"agent-runtime",
			"conversation",
			"inference",
			"queue",
			"scheduler",
			"delivery",
			"settings",
			"memory",
			"world",
		],
	},
	"voice-dialogue": {
		backend: "api/domains/voice-dialogue",
		web: "web/src/domains/voice-dialogue",
		components: null,
		depends: [
			"audio",
			"inference",
			"dialogue",
			"settings",
			"delivery",
			"avatar",
		],
	},
} as const;
export type Domain = keyof typeof domains;
export function isDomain(value: string): value is Domain {
	return value in domains;
}
export function closure(
	domain: Domain,
	graph: Record<string, { depends: readonly string[] }> = domains,
): Domain[] {
	const visited = new Set<Domain>();
	const visiting = new Set<Domain>();
	function visit(name: Domain) {
		if (visiting.has(name)) throw new Error(`domain_dependency_cycle:${name}`);
		if (visited.has(name)) return;
		visiting.add(name);
		for (const dep of (graph[name]?.depends ?? []) as readonly Domain[])
			visit(dep);
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
