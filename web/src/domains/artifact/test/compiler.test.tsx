import {
	ArtifactRenderer,
	artifactLibrary,
	compileArtifact,
	compileLang,
} from "@eumenes/artifact-ui";
import {
	parseDefinition,
	viewRegistry,
	type Receipt,
	type Snapshot,
} from "@eumenes/artifact-ui/contracts";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";

afterEach(cleanup);
function initial(): Snapshot {
	return {
		c1: { kind: "components", revision: 0 },
		g1: {
			kind: "generated-image",
			revision: 0,
			status: "queued",
			alt: "山と湖のイラスト",
		},
		q1: {
			kind: "question",
			revision: 0,
			status: "open",
			question: {
				prompt: "回答の長さはどのくらいが良いですか？",
				options: ["短く", "詳しく"],
			},
		},
		f1: {
			kind: "form",
			revision: 0,
			fields: [
				{ id: "name", label: "呼び名", type: "text", required: true },
				{ id: "detail", label: "補足", type: "textarea" },
				{
					id: "style",
					label: "回答のスタイル",
					type: "select",
					options: ["簡潔", "詳しく"],
				},
				{ id: "remember", label: "覚えておく", type: "boolean" },
			],
			defaults: { name: "", detail: "", style: "", remember: false },
		},
		m1: {
			kind: "memory",
			revision: 0,
			entries: [
				{
					id: "preference",
					text: "回答は短く、結論から知りたい",
					selected: false,
				},
			],
		},
		s1: {
			kind: "settings",
			revision: 0,
			theme: "light",
			autoSpeak: false,
			volume: 60,
		},
	};
}
const resources = initial();
const dispatch = async (): Promise<Receipt> => ({
	status: "accepted",
	message: "受け付けました",
});
for (const [view, source] of [
	["components", "c1"],
	["generated-image", "g1"],
	["question", "q1"],
	["form", "f1"],
	["memory", "m1"],
	["settings", "s1"],
]) {
	test(`${view}: compact JSON compiles and roundtrips through actual OpenUI parser`, () => {
		const result = compileArtifact(JSON.stringify({ view, source }), resources);
		expect(compileLang(result.lang, resources)).toEqual(result);
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
		expect(() => compileArtifact(input, resources)).toThrow();
	});
for (const lang of [
	'root = Query("x", {})',
	'root = GeneratedImage({"view":"generated-image","source":"g1"})\nx = Mutation("delete", {})',
	'$x = 1\nroot = Components({"view":"components","source":"c1"})',
	'root = Unknown({"view":"components","source":"c1"})',
	'root = SmallForm({"view":"form","source":"f1", "fields":[]})',
])
	test("Lang test mode rejects tool calls, state and extra statements", () =>
		expect(() => compileLang(lang, resources)).toThrow());
test("quoted instructions remain inert text in the SDK renderer", () => {
	const title =
		'額縁")\nroot = Query("secret", {}) <script>INJECTION</script>\u2028';
	const result = compileArtifact(
		JSON.stringify({ view: "components", source: "c1", title }),
		resources,
	);
	render(
		<ArtifactRenderer
			lang={result.lang}
			runtime={{
				snapshot: resources,
				dispatch,
			}}
		/>,
	);
	expect(document.querySelector(".text-2xl")?.textContent).toBe(title);
	expect(document.querySelector("script")).toBeNull();
	expect(Object.keys(artifactLibrary.components).sort()).toEqual(
		[
			...Object.values(viewRegistry).map((view) => view.name),
			"Composition",
		].sort(),
	);
});
test("actual renderer preserves dirty form input when resource snapshot changes", () => {
	const lang = compileArtifact('{"view":"form","source":"f1"}', resources).lang;
	const view = render(
		<ArtifactRenderer
			lang={lang}
			runtime={{ snapshot: resources, dispatch }}
		/>,
	);
	fireEvent.change(screen.getByLabelText("呼び名（必須）"), {
		target: { value: "入力途中" },
	});
	const refreshed = Object.fromEntries(
		Object.entries(resources).map(([key, value]) => [
			key,
			{ ...value, revision: value.revision + 1 },
		]),
	) as Snapshot;
	view.rerender(
		<ArtifactRenderer
			lang={lang}
			runtime={{ snapshot: refreshed, dispatch }}
		/>,
	);
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
				snapshot: resources,
				dispatch,
			}}
		/>,
	);
	expect(screen.getByRole("alert").textContent).toContain(
		"定義または参照データ",
	);
});
