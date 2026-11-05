import { expect, test, afterEach, vi } from "vitest";
import {
	fireEvent,
	render,
	screen,
	cleanup,
	waitFor,
} from "@testing-library/react";
import { ArtifactRenderer, compileArtifact } from "@eumenes/artifact-ui";
import type { ArtifactEvent } from "@eumenes/artifact-ui/contracts";
import {
	selectedInteractCapture,
	interactSnapshot,
	type InteractWorkspace,
} from "../domains/browser/interact/view-model";
import bundle from "../../../api/domains/capabilities/bundles/browser-interact.bundle.json";
const run: NonNullable<InteractWorkspace["selected"]> = {
	runId: "r1",
	conversationId: "main",
	parentExecutionId: null,
	state: "needs_input",
	code: null,
	generation: 1,
	revision: 3,
	calls: 1,
	deadline: Date.now() + 60000,
	question: {
		id: "q1",
		kind: "approval",
		text: "Send this exact operation? " + "label ".repeat(60),
		deadline: Date.now() + 60000,
	},
	answer: null,
	captures: [],
};
const data = (v = run): InteractWorkspace => ({ runs: [v], selected: v });
const definition = JSON.stringify(bundle.artifacts[0]!.variants[0]!.definition);
afterEach(cleanup);
test("the registered JSON composes standard components with valid form fields", () => {
	const snapshot = interactSnapshot(data(), "main", Date.now());
	expect(compileArtifact(definition, snapshot).request.view).toBe("layout");
	expect(snapshot.reply).toMatchObject({
		kind: "form",
		defaults: { questionId: "q1", generation: "1", expectedRevision: "3" },
	});
	expect(JSON.stringify(snapshot)).not.toContain('"approved":true');
	render(
		<ArtifactRenderer
			definition={definition}
			runtime={{ snapshot, dispatch: vi.fn() }}
		/>,
	);
	expect(
		screen.getAllByText("撮影を保存すると、ここに表示します。").length,
	).toBeGreaterThan(0);
	expect(screen.queryByText("画像を生成中です")).toBeNull();
});
test("a new question clears the previous confirmation and binds submission to the new identity", async () => {
	const events: ArtifactEvent[] = [];
	const dispatch = vi.fn(async (e: ArtifactEvent) => {
		events.push(e);
		return { status: "accepted" as const, message: "accepted" };
	});
	const replyDefinition = JSON.stringify({
		view: "form",
		source: "reply",
		title: "確認への回答",
	});
	const view = render(
		<ArtifactRenderer
			definition={replyDefinition}
			runtime={{
				snapshot: interactSnapshot(data(), "main", Date.now()),
				dispatch,
			}}
		/>,
	);
	fireEvent.click(screen.getByRole("radio", { name: "実行する" }));
	expect(screen.getByRole("radio", { name: "実行する" })).toHaveProperty(
		"checked",
		true,
	);
	const next = {
		...run,
		generation: 2,
		revision: 4,
		question: { ...run.question!, id: "q2" },
	};
	view.rerender(
		<ArtifactRenderer
			definition={replyDefinition}
			runtime={{
				snapshot: interactSnapshot(data(next), "main", Date.now()),
				dispatch,
			}}
		/>,
	);
	await waitFor(() =>
		expect(screen.getByRole("radio", { name: "実行する" })).toHaveProperty(
			"checked",
			false,
		),
	);
	fireEvent.click(screen.getByRole("radio", { name: "実行しない" }));
	fireEvent.click(screen.getByRole("button", { name: "選択を送る" }));
	await waitFor(() => expect(events).toHaveLength(1));
	expect(events[0]!.values).toMatchObject({
		questionId: "q2",
		generation: "2",
		expectedRevision: "4",
		decision: "deny",
	});
});
test("parent-owned and expired questions disable the form", () => {
	const v = { ...run, parentExecutionId: "parent" };
	render(
		<ArtifactRenderer
			definition={JSON.stringify({ view: "form", source: "reply" })}
			runtime={{
				snapshot: interactSnapshot(data(v), "main", Date.now()),
				dispatch: vi.fn(),
			}}
		/>,
	);
	expect(screen.getByRole("button", { name: "選択を送る" })).toHaveProperty(
		"disabled",
		true,
	);
	expect(screen.getByRole("radio", { name: "実行する" })).toHaveProperty(
		"disabled",
		true,
	);
	expect(
		interactSnapshot(data(), "main", run.deadline + 1).reply,
	).toMatchObject({ disabled: true });
});
test("selecting a different run clears a previous deletion confirmation", async () => {
	const dispatch = vi.fn(async () => ({
		status: "accepted" as const,
		message: "accepted",
	}));
	const def = JSON.stringify({ view: "form", source: "forget" });
	const view = render(
		<ArtifactRenderer
			definition={def}
			runtime={{
				snapshot: interactSnapshot(data(), "main", Date.now()),
				dispatch,
			}}
		/>,
	);
	fireEvent.click(screen.getByRole("checkbox"));
	expect(screen.getByRole("checkbox")).toHaveProperty("checked", true);
	view.rerender(
		<ArtifactRenderer
			definition={def}
			runtime={{
				snapshot: interactSnapshot(
					data({ ...run, runId: "r2" }),
					"main",
					Date.now(),
				),
				dispatch,
			}}
		/>,
	);
	await waitFor(() =>
		expect(screen.getByRole("checkbox")).toHaveProperty("checked", false),
	);
});

test("an exact resource reference selects its capture rather than the latest image", () => {
	const caps = [
		{
			captureId: "first",
			width: 1,
			height: 1,
			bytes: 10,
			expiresAt: run.deadline,
		},
		{
			captureId: "latest",
			width: 1,
			height: 1,
			bytes: 10,
			expiresAt: run.deadline,
		},
	];
	const value = data({ ...run, captures: caps });
	expect(
		selectedInteractCapture({ ...value, selectedCaptureId: "first" })
			?.captureId,
	).toBe("first");
	expect(selectedInteractCapture(value)?.captureId).toBe("latest");
	expect(
		selectedInteractCapture({ ...value, selectedCaptureId: "unknown" }),
	).toBeUndefined();
});
