import {
	ArtifactRenderer,
	artifactLibrary,
	compileArtifact,
	compileLang,
} from "@eumenes/artifact-ui";
import { parseDefinition } from "@eumenes/artifact-ui/contracts";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { createShowcaseFixture } from "..";

afterEach(cleanup);
const fixture = createShowcaseFixture();
for (const [view, source] of [
	["components", "c1"],
	["generated-image", "g1"],
	["question", "q1"],
	["form", "f1"],
	["memory", "m1"],
	["settings", "s1"],
]) {
	test(`${view}: compact JSON compiles and roundtrips through actual OpenUI parser`, () => {
		const result = compileArtifact(
			JSON.stringify({ view, source }),
			fixture.getSnapshot().resources,
		);
		expect(compileLang(result.lang, fixture.getSnapshot().resources)).toEqual(
			result,
		);
	});
}
for (const input of [
	'{"view":"unknown","source":"g1"}',
	'{"view":"generated-image","source":"f1"}',
	'{"view":"generated-image","source":"missing"}',
	'{"view":"generated-image","source":"g1","onClick":"alert(1)"}',
	'{"view":"question"}',
	'{"view":"form","fields":[{"id":"a","label":"A","type":"select"}]}',
	'{"view":"form","fields":[{"id":"a","label":"A","type":"text"},{"id":"a","label":"B","type":"text"}]}',
	JSON.stringify({
		view: "form",
		fields: Array.from({ length: 9 }, (_, i) => ({
			id: `f${i}`,
			label: "F",
			type: "text",
		})),
	}),
	" ".repeat(16385),
])
	test("rejects unregistered, oversized, invalid or unauthorized definitions", () => {
		expect(() =>
			compileArtifact(input, fixture.getSnapshot().resources),
		).toThrow();
	});
for (const lang of [
	'root = Query("x", {})',
	'root = GeneratedImage({"view":"generated-image","source":"g1"})\nx = Mutation("delete", {})',
	'$x = 1\nroot = Components({"view":"components","source":"c1"})',
	'root = Unknown({"view":"components","source":"c1"})',
	'root = SmallForm({"view":"form","source":"f1", "fields":[]})',
])
	test("Lang test mode rejects tool calls, state and extra statements", () =>
		expect(() => compileLang(lang, fixture.getSnapshot().resources)).toThrow());
test("quoted instructions remain inert text in the SDK renderer", () => {
	const title =
		'額縁")\nroot = Query("secret", {}) <script>INJECTION</script>\u2028';
	const result = compileArtifact(
		JSON.stringify({ view: "components", source: "c1", title }),
		fixture.getSnapshot().resources,
	);
	render(
		<ArtifactRenderer
			lang={result.lang}
			runtime={{
				snapshot: fixture.getSnapshot().resources,
				dispatch: fixture.dispatch,
			}}
		/>,
	);
	expect(document.querySelector(".text-2xl")?.textContent).toBe(title);
	expect(document.querySelector("script")).toBeNull();
	expect(Object.keys(artifactLibrary.components)).toHaveLength(6);
});
test("actual renderer preserves dirty form input when resource snapshot changes", () => {
	const lang = compileArtifact(
		'{"view":"form","source":"f1"}',
		fixture.getSnapshot().resources,
	).lang;
	const runtime = () => ({
		snapshot: fixture.getSnapshot().resources,
		dispatch: fixture.dispatch,
	});
	const view = render(<ArtifactRenderer lang={lang} runtime={runtime()} />);
	fireEvent.change(screen.getByLabelText("呼び名（必須）"), {
		target: { value: "入力途中" },
	});
	fixture.refresh();
	view.rerender(<ArtifactRenderer lang={lang} runtime={runtime()} />);
	expect(
		(screen.getByLabelText("呼び名（必須）") as HTMLInputElement).value,
	).toBe("入力途中");
});
test("pure contracts accept inline question without React or runtime fields", () => {
	expect(
		parseDefinition('{"view":"question","question":{"prompt":"呼び名は？"}}')
			.view,
	).toBe("question");
});

test("invalid Lang is isolated at Artifact boundary without invoking a tool", () => {
	render(
		<ArtifactRenderer
			lang={'root = Query("secret", {})'}
			runtime={{
				snapshot: fixture.getSnapshot().resources,
				dispatch: fixture.dispatch,
			}}
		/>,
	);
	expect(screen.getByRole("alert").textContent).toContain(
		"定義または参照データ",
	);
});
