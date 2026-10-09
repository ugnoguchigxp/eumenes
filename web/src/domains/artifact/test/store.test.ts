import { expect, test } from "vitest";
import {
	type ArtifactTab,
	emptyArtifactWorkspace,
	maxArtifactTabs,
	reduceArtifactWorkspace,
} from "..";

const tab = (id: string, content = id): ArtifactTab => ({
	id,
	title: id,
	kind: "markdown",
	content,
});

test("open activates a tab and replaces content of an existing id", () => {
	let state = reduceArtifactWorkspace(emptyArtifactWorkspace(), {
		type: "open",
		tab: tab("a"),
	});
	state = reduceArtifactWorkspace(state, { type: "open", tab: tab("b") });
	state = reduceArtifactWorkspace(state, {
		type: "open",
		tab: tab("a", "new"),
	});
	expect(state.tabs.map((t) => t.id)).toEqual(["a", "b"]);
	expect(state.tabs[0]?.kind === "markdown" && state.tabs[0].content).toBe(
		"new",
	);
	expect(state.activeTabId).toBe("a");
});

test("closing the active tab selects the last remaining tab, then none", () => {
	let state = emptyArtifactWorkspace();
	for (const id of ["a", "b", "c"])
		state = reduceArtifactWorkspace(state, { type: "open", tab: tab(id) });
	state = reduceArtifactWorkspace(state, { type: "close", tabId: "c" });
	expect(state.activeTabId).toBe("b");
	state = reduceArtifactWorkspace(state, { type: "close", tabId: "a" });
	expect(state.activeTabId).toBe("b");
	state = reduceArtifactWorkspace(state, { type: "close", tabId: "b" });
	expect(state).toEqual(emptyArtifactWorkspace());
});

test("select ignores unknown ids and tab count is capped", () => {
	let state = emptyArtifactWorkspace();
	for (let i = 0; i < maxArtifactTabs + 3; i++)
		state = reduceArtifactWorkspace(state, {
			type: "open",
			tab: tab(`t${i}`),
		});
	expect(state.tabs).toHaveLength(maxArtifactTabs);
	expect(reduceArtifactWorkspace(state, { type: "select", tabId: "zz" })).toBe(
		state,
	);
});
