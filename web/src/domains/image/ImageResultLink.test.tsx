import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { ImageRecord } from "../../../../api/domains/image/contracts";
import { ImageResultLink } from "./ImageResultLink";

afterEach(cleanup);

const record = (
	runId: string,
	state: ImageRecord["state"],
	artifactId: string | null,
): ImageRecord => ({
	id: crypto.randomUUID(),
	runId,
	conversationId: "main",
	state,
	action: "generate",
	title: "画像",
	description: "",
	prompt: null,
	width: 512,
	height: 512,
	format: "webp",
	seed: 0,
	artifactId,
	phase: state,
	mime: "image/webp",
	actualModel: null,
	errorCode: null,
	createdAt: 1,
	updatedAt: 1,
});

test("only the completed image for this answer opens its saved artifact", () => {
	const open = vi.fn();
	render(
		<ImageResultLink
			runId="run-chosen"
			items={[
				record("run-other", "completed", "other-image"),
				record("run-chosen", "completed", "chosen-image"),
			]}
			onOpen={open}
		/>,
	);
	fireEvent.click(
		screen.getByRole("button", { name: "アーティファクトで画像を確認する" }),
	);
	expect(open).toHaveBeenCalledExactlyOnceWith("chosen-image");
	expect(screen.queryByText(/https?:\/\//)).toBeNull();
});

test("unfinished and unsaved images have no result action", () => {
	const open = vi.fn();
	const view = render(
		<ImageResultLink
			runId="run-chosen"
			items={[record("run-chosen", "generating", null)]}
			onOpen={open}
		/>,
	);
	expect(screen.queryByRole("button")).toBeNull();
	view.rerender(
		<ImageResultLink
			runId="run-chosen"
			items={[record("run-chosen", "completed", null)]}
			onOpen={open}
		/>,
	);
	expect(screen.queryByRole("button")).toBeNull();
});
