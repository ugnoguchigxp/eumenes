export const domains = {
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
		depends: ["settings", "larm", "delivery"],
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
	dialogue: {
		backend: "api/domains/dialogue",
		web: "web/src/domains/dialogue",
		components: null,
		depends: [
			"conversation",
			"inference",
			"queue",
			"scheduler",
			"delivery",
			"settings",
			"memory",
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
	return [info.backend, info.web, info.components].filter(Boolean) as string[];
}
