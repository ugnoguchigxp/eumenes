import {
	ArtifactRenderer,
	type ArtifactEvent,
	type FormResource,
} from "@eumenes/artifact-ui";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

afterEach(cleanup);
const definition = JSON.stringify({
	view: "form",
	source: "settings",
	title: "設定",
});
const form = (revision: number, name = "保存した値"): FormResource => ({
	kind: "form",
	revision,
	submitLabel: "保存",
	fields: [{ id: "name", label: "名前", type: "text" }],
	defaults: { name, expectedRevision: String(revision) },
});
test("a settled save refreshes the form precondition for a second save", async () => {
	const dispatch = vi.fn(async (_event: ArtifactEvent) => ({
		status: "accepted" as const,
		message: "保存済み",
	}));
	const show = (resource: FormResource) => (
		<ArtifactRenderer
			definition={definition}
			runtime={{ snapshot: { settings: resource }, dispatch }}
		/>
	);
	const h = render(show(form(1)));
	fireEvent.change(await screen.findByLabelText("名前"), {
		target: { value: "一度目" },
	});
	fireEvent.click(screen.getByRole("button", { name: /^保存$/ }));
	await waitFor(() =>
		expect(
			screen.getByRole("button", { name: /^保存$/ }).hasAttribute("disabled"),
		).toBe(false),
	);
	h.rerender(show(form(2, "一度目")));
	await waitFor(() =>
		expect((screen.getByLabelText("名前") as HTMLInputElement).value).toBe(
			"一度目",
		),
	);
	fireEvent.change(screen.getByLabelText("名前"), {
		target: { value: "二度目" },
	});
	fireEvent.click(screen.getByRole("button", { name: /^保存$/ }));
	await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2));
	expect(dispatch.mock.calls[1]?.[0]).toMatchObject({
		values: { name: "二度目", expectedRevision: "2" },
	});
});
test("an external update cannot silently replace the precondition of an edited form", async () => {
	const dispatch = vi.fn(async (_event: ArtifactEvent) => ({
		status: "conflict" as const,
		message: "更新を確認してください",
	}));
	const show = (resource: FormResource) => (
		<ArtifactRenderer
			definition={definition}
			runtime={{ snapshot: { settings: resource }, dispatch }}
		/>
	);
	const h = render(show(form(4)));
	fireEvent.change(await screen.findByLabelText("名前"), {
		target: { value: "編集中" },
	});
	h.rerender(show(form(5, "他の更新")));
	expect((screen.getByLabelText("名前") as HTMLInputElement).value).toBe(
		"編集中",
	);
	fireEvent.click(screen.getByRole("button", { name: /^保存$/ }));
	await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
	expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
		values: { name: "編集中", expectedRevision: "4" },
	});
});
