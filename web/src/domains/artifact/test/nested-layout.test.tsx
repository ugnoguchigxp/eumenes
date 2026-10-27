import {
	ArtifactRenderer,
	compileArtifact,
	definitionRequests,
	parseDefinition,
	type Snapshot,
} from "@eumenes/artifact-ui";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";

afterEach(cleanup);
const text = (title: string) => ({ view: "text-block", title });
const layout = (children: unknown[], extra: object = {}) => ({
	view: "layout",
	direction: "stack",
	children,
	...extra,
});
const nest = (depth: number): unknown =>
	depth <= 1 ? layout([text("葉")]) : layout([nest(depth - 1)]);
const snapshot: Snapshot = {};

test("layouts nest to four levels and render recursively with tokens", () => {
	const definition = JSON.stringify(
		layout(
			[
				text("見出し"),
				layout([text("内側の説明")], { gap: "compact", width: "narrow" }),
				{ view: "text-block", title: "強調", emphasis: "strong" },
			],
			{ gap: "relaxed", width: "wide", title: "外側" },
		),
	);
	expect(compileArtifact(definition, snapshot).lang).toContain("Composition");
	const { container } = render(
		<ArtifactRenderer
			definition={definition}
			runtime={{
				snapshot,
				dispatch: async () => ({ status: "accepted", message: "" }),
			}}
		/>,
	);
	expect(screen.getByText("内側の説明")).toBeTruthy();
	const outer = container.querySelector('[data-gap="relaxed"]');
	expect(outer?.getAttribute("data-width")).toBe("wide");
	const inner = container.querySelector('[data-gap="compact"]');
	expect(inner?.getAttribute("data-width")).toBe("narrow");
	expect(container.querySelector('[data-emphasis="strong"]')).toBeTruthy();
	// A nested layout's title heads its section; the outermost one only names the composition.
	expect(screen.queryByRole("heading", { name: "外側" })).toBeNull();
});

test("a titled nested layout shows its title as the section heading", () => {
	render(
		<ArtifactRenderer
			definition={JSON.stringify(
				layout([layout([text("本文")], { title: "特徴", direction: "grid" })]),
			)}
			runtime={{
				snapshot,
				dispatch: async () => ({ status: "accepted", message: "" }),
			}}
		/>,
	);
	expect(screen.getByRole("heading", { name: "特徴" })).toBeTruthy();
});

test("depth is limited to six including the root, and one definition holds at most 240 views", () => {
	expect(() => parseDefinition(JSON.stringify(nest(5)))).not.toThrow();
	expect(() => parseDefinition(JSON.stringify(nest(6)))).toThrow();
	// 5 layouts of 48 text blocks plus the root: 1 + 5 * 49 = 246 views.
	const wide = layout(
		Array.from({ length: 5 }, () =>
			layout(Array.from({ length: 48 }, (_, i) => text(`t${i}`))),
		),
	);
	expect(() => parseDefinition(JSON.stringify(wide))).toThrow();
	const ok = layout(
		Array.from({ length: 4 }, () =>
			layout(Array.from({ length: 48 }, (_, i) => text(`t${i}`))),
		),
	);
	expect(() => parseDefinition(JSON.stringify(ok))).not.toThrow();
});

test("sources inside nested layouts are checked against the snapshot", () => {
	const definition = JSON.stringify(
		layout([layout([{ view: "form", source: "f" }])]),
	);
	expect(() => compileArtifact(definition, snapshot)).toThrow();
	const withForm: Snapshot = {
		f: { kind: "form", revision: 1, fields: [], defaults: {} },
	};
	expect(() => compileArtifact(definition, withForm)).not.toThrow();
	expect(
		definitionRequests(parseDefinition(definition)).map((r) => r.view),
	).toEqual(["form"]);
});

test("existing definitions and unknown tokens keep their behaviour", () => {
	expect(() =>
		parseDefinition(JSON.stringify(layout([text("a")], { gap: "huge" }))),
	).toThrow();
	expect(() =>
		parseDefinition(
			JSON.stringify({ view: "text-block", title: "a", emphasis: "loud" }),
		),
	).toThrow();
	expect(parseDefinition(JSON.stringify(layout([text("a")]))).view).toBe(
		"layout",
	);
});
