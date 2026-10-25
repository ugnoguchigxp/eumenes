import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { useArtifactWorkspace } from "../domains/artifact";
import { useOpenPlaylist } from "./open-artifacts";
afterEach(cleanup);
test("playlist keeps one stable legacy screen", () => {
	const view = renderHook(() => {
		const workspace = useArtifactWorkspace();
		return {
			workspace,
			playlist: useOpenPlaylist(workspace.open),
		};
	});
	for (let i = 0; i < 12; i++) {
		act(() => view.result.current.playlist());
	}
	expect(
		view.result.current.workspace.tabs.map((tab) => ({
			id: tab.id,
			title: tab.title,
		})),
	).toEqual([{ id: "music-playlist", title: "音楽プレイリスト" }]);
	const definitions = view.result.current.workspace.tabs.map(
		(tab) => tab.kind === "openui" && JSON.parse(tab.definition).source,
	);
	expect(definitions).toEqual(["library-studio"]);
	act(() => view.result.current.workspace.close("music-playlist"));
	act(() => view.result.current.playlist());
	expect(view.result.current.workspace.tabs).toHaveLength(1);
});

test("a playlist id opens that playlist on the same screen, a click event does not", () => {
	const view = renderHook(() => {
		const workspace = useArtifactWorkspace();
		return { workspace, playlist: useOpenPlaylist(workspace.open) };
	});
	const sources = () =>
		view.result.current.workspace.tabs.map(
			(tab) => tab.kind === "openui" && JSON.parse(tab.definition).source,
		);
	act(() => view.result.current.playlist("p1"));
	expect(sources()).toEqual(["library-p1"]);
	act(() => view.result.current.playlist("p2"));
	expect(sources()).toEqual(["library-p2"]);
	act(() => view.result.current.playlist({ type: "click" }));
	expect(sources()).toEqual(["library-studio"]);
	expect(view.result.current.workspace.tabs).toHaveLength(1);
});
