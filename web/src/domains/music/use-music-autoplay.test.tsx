import { renderHook, cleanup, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { requestPlayback } from "@eumenes/design-system";
import { useMusicAutoplay } from "./use-music-autoplay";
vi.mock("@eumenes/design-system", () => ({
	requestPlayback: vi.fn(async () => {}),
}));
afterEach(() => {
	cleanup();
	vi.mocked(requestPlayback).mockReset();
});
type Items = Parameters<typeof useMusicAutoplay>[1];
const item = (id: string, state: string) => ({ id, state });
function setup(items: ReturnType<typeof item>[] | undefined, selectedId = "a") {
	const initialProps = {
		items,
		selectedId,
		audioId: undefined as string | undefined,
		conversationId: "main",
	};
	const hook = renderHook(
		(props: typeof initialProps) =>
			useMusicAutoplay(
				props.conversationId,
				props.items as Items,
				props.selectedId,
				props.audioId,
			),
		{ initialProps },
	);
	return {
		...hook,
		update: (props: Partial<typeof initialProps>) =>
			hook.rerender({ ...initialProps, ...props }),
	};
}
test("waits for authenticated audio and requests playback once across refreshes", async () => {
	const r = setup([item("a", "planning")]);
	r.update({ items: [item("a", "generating")] });
	r.update({ items: [item("a", "completed")] });
	expect(requestPlayback).not.toHaveBeenCalled();
	r.update({ items: [item("a", "completed")], audioId: "a" });
	await waitFor(() => expect(requestPlayback).toHaveBeenCalledWith("a", 0));
	r.update({ items: [item("a", "completed")], audioId: "a" });
	expect(requestPlayback).toHaveBeenCalledTimes(1);
});
test("history and selecting another saved track do not autoplay", () => {
	const items = [item("a", "completed"), item("b", "completed")];
	const r = setup(undefined);
	r.update({ items, audioId: "a" });
	r.update({ items, selectedId: "b", audioId: "b" });
	expect(requestPlayback).not.toHaveBeenCalled();
});
test("a new generation can finish between list polls and still autoplay", () => {
	const r = setup([]);
	r.update({ items: [item("a", "completed")], audioId: "a" });
	expect(requestPlayback).toHaveBeenCalledTimes(1);
});
test.each(["cancelled", "failed"])(
	"%s generations discard their playback intent",
	(state) => {
		const r = setup([item("a", "generating")]);
		r.update({ items: [item("a", state)] });
		r.update({ items: [item("a", "completed")], audioId: "a" });
		expect(requestPlayback).not.toHaveBeenCalled();
	},
);
test("finishing an unselected track does not replay it on a later history selection", () => {
	const r = setup([item("a", "generating"), item("b", "completed")]);
	const items = [item("a", "completed"), item("b", "completed")];
	r.update({ items, selectedId: "b", audioId: "b" });
	r.update({ items, audioId: "a" });
	expect(requestPlayback).not.toHaveBeenCalled();
});
test("changing conversations resets observation and a rejected start is not retried", async () => {
	vi.mocked(requestPlayback).mockRejectedValueOnce(
		new DOMException("blocked", "NotAllowedError"),
	);
	const r = setup([item("a", "generating")]);
	r.update({ items: [item("a", "completed")], audioId: "a" });
	await waitFor(() => expect(requestPlayback).toHaveBeenCalledTimes(1));
	r.update({ items: [item("a", "completed")], audioId: "a" });
	r.update({
		conversationId: "other",
		items: [item("b", "completed")],
		selectedId: "b",
		audioId: "b",
	});
	expect(requestPlayback).toHaveBeenCalledTimes(1);
});
