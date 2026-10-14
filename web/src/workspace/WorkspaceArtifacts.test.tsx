import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { useArtifactWorkspace } from "../domains/artifact";
import { useOpenMusic, useOpenPlaylist } from "./WorkspaceArtifacts";
afterEach(cleanup);
test("generation and playlist each keep one stable screen with separate identities", () => {
	const view = renderHook(() => {
		const workspace = useArtifactWorkspace();
		return {
			workspace,
			music: useOpenMusic(workspace.open),
			playlist: useOpenPlaylist(workspace.open),
		};
	});
	for (let i = 0; i < 12; i++) {
		act(() => view.result.current.music());
		act(() => view.result.current.playlist());
	}
	expect(
		view.result.current.workspace.tabs.map((tab) => ({
			id: tab.id,
			title: tab.title,
		})),
	).toEqual([
		{ id: "music-generation", title: "楽曲生成" },
		{ id: "music-playlist", title: "音楽プレイリスト" },
	]);
	const definitions = view.result.current.workspace.tabs.map(
		(tab) => tab.kind === "openui" && JSON.parse(tab.definition).source,
	);
	expect(definitions).toEqual(["music-studio", "library-studio"]);
	act(() => view.result.current.workspace.close("music-generation"));
	act(() => view.result.current.music());
	expect(view.result.current.workspace.tabs).toHaveLength(2);
});
