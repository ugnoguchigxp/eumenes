import { expect, test } from "bun:test";
import { compileArtifact } from "./compiler";
import type { MarkdownResource } from "./markdown-components";
const resource: MarkdownResource = {
	kind: "markdown-workspace",
	revision: 0,
	current: null,
	documents: [],
	library: [],
	archiveAvailable: false,
	sessionState: null,
	busy: false,
};
test("the editor composes with other registered views through ordinary Artifact JSON", () => {
	const definition = {
		view: "layout",
		direction: "stack",
		children: [
			{ view: "text-block", title: "説明", body: "文書を編集します。" },
			{ view: "markdown-workspace", source: "document", title: "文書" },
		],
	};
	const compiled = compileArtifact(JSON.stringify(definition), {
		document: resource,
	});
	expect(compiled.request.view).toBe("layout");
	expect(compiled.lang).toContain('"markdown-workspace"');
	expect(() =>
		compileArtifact(JSON.stringify(definition), {
			document: { kind: "memory", revision: 0, entries: [] },
		}),
	).toThrow("この表示では参照できない source");
});
