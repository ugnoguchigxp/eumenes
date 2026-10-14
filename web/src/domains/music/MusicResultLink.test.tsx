import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { MusicRecord } from "../../../../api/domains/music/contracts";
import { MusicResultLink } from "./MusicResultLink";

afterEach(cleanup);

const record = (
	id: string,
	runId: string,
	state: MusicRecord["state"],
): MusicRecord => ({
	id,
	runId,
	conversationId: "main",
	state,
	title: id === "chosen" ? "休日の曲" : "別の曲",
	description: "",
	prompt: null,
	durationSeconds: null,
	phase: state,
	jobId: null,
	errorCode: null,
	mime: null,
	actualModel: null,
	createdAt: 1,
	updatedAt: 1,
});

test("a completed result opens the exact saved track for its answer run", () => {
	const open = vi.fn();
	render(
		<MusicResultLink
			runId="run-chosen"
			items={[
				record("latest", "run-other", "completed"),
				record("chosen", "run-chosen", "completed"),
			]}
			onOpen={open}
		/>,
	);
	fireEvent.click(
		screen.getByRole("button", { name: "アーティファクトで再生する" }),
	);
	expect(open).toHaveBeenCalledExactlyOnceWith("chosen");
	expect(screen.queryByText(/https?:\/\//)).toBeNull();
});

test("an unfinished or failed result has no open action", () => {
	const open = vi.fn();
	const { rerender } = render(
		<MusicResultLink
			runId="run-chosen"
			items={[record("chosen", "run-chosen", "generating")]}
			onOpen={open}
		/>,
	);
	expect(screen.queryByRole("button")).toBeNull();
	rerender(
		<MusicResultLink
			runId="run-chosen"
			items={[record("chosen", "run-chosen", "failed")]}
			onOpen={open}
		/>,
	);
	expect(screen.queryByRole("button")).toBeNull();
});
