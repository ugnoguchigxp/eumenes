import { expect, test } from "vitest";
import { compileArtifact } from "./compiler";
test("work menu/result compose with an existing activity view and reject wrong source kinds", () => {
	const definition = JSON.stringify({
		view: "layout",
		direction: "stack",
		children: [
			{ view: "work-menu", source: "jobs" },
			{ view: "work-result", source: "work" },
			{ view: "activity-timeline", source: "activity" },
		],
	});
	const snapshot = {
		jobs: { kind: "work-menu" as const, revision: 0, items: [] },
		work: { kind: "work-result" as const, revision: 0 },
		activity: {
			kind: "activity-timeline" as const,
			revision: 0,
			entries: [],
			connected: false,
		},
	};
	expect(compileArtifact(definition, snapshot).request.view).toBe("layout");
	expect(() =>
		compileArtifact(definition, { ...snapshot, jobs: snapshot.work }),
	).toThrow();
});
