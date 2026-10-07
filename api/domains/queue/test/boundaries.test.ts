import { expect, test } from "bun:test";
import { closure, domains } from "../../../../scripts/domains";

test("queue and scheduler declare only their real dependencies", () => {
	expect(domains.queue.depends).toEqual([]);
	expect(domains.scheduler.depends).toEqual(["queue"]);
	expect(closure("queue")).toEqual(["queue"]);
	expect(closure("scheduler")).toEqual(["queue", "scheduler"]);
	expect(domains.dialogue.depends).toContain("queue");
	expect(domains.dialogue.depends).toContain("scheduler");
	expect(closure("voice-dialogue")).toContain("queue");
});

test("a dependency cycle stops with an explicit error", () => {
	const cyclic = {
		queue: { depends: ["scheduler"] },
		scheduler: { depends: ["queue"] },
	};
	expect(() => closure("queue", cyclic)).toThrow("domain_dependency_cycle");
});
