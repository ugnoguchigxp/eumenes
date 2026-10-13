import { afterEach, expect, test } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import {
	ArtifactRenderer,
	compileArtifact,
	type Snapshot,
} from "@eumenes/artifact-ui";
import { timerSetupDefinition } from "./artifact-definition";
afterEach(cleanup);

test("timer workspace composes with a question and rejects a source of the wrong kind", () => {
	const timer = JSON.parse(timerSetupDefinition());
	const snapshot: Snapshot = {
		"timer-setup": { kind: "timer-workspace", revision: 0, state: "setup" },
		q1: {
			kind: "question",
			revision: 0,
			status: "open",
			question: { prompt: "休憩しますか？" },
		},
	};
	const definition = JSON.stringify({
		view: "layout",
		children: [timer, { view: "question", source: "q1" }],
	});
	expect(compileArtifact(definition, snapshot).request.view).toBe("layout");
	render(
		<ArtifactRenderer
			definition={definition}
			runtime={{
				snapshot,
				dispatch: async () => ({ status: "accepted", message: "" }),
			}}
		/>,
	);
	expect(screen.getByRole("heading", { name: "タイマー" })).toBeDefined();
	expect(screen.getByText("休憩しますか？")).toBeDefined();
	expect(() => compileArtifact(definition, {})).toThrow();
	expect(() =>
		compileArtifact(timerSetupDefinition(), {
			"timer-setup": { kind: "form", revision: 0, fields: [], defaults: {} },
		}),
	).toThrow();
});
