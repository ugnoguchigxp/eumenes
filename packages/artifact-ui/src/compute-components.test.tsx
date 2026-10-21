import { expect, test } from "bun:test";
import { compileArtifact } from "./compiler";
test("registered computation view composes with text and rejects a wrong resource kind", () => {
	const definition = {
		view: "layout",
		direction: "stack",
		children: [
			{
				view: "text-block",
				title: "計算結果",
				body: "CPUの計算結果を表示します。",
			},
			{ view: "compute-workspace", source: "compute", title: "計算" },
		],
	};
	expect(
		compileArtifact(JSON.stringify(definition), {
			compute: { kind: "compute", revision: 1, jobs: [], available: true },
		}).lang,
	).toContain("compute-workspace");
	expect(() => compileArtifact(JSON.stringify(definition), {})).toThrow(
		"source",
	);
});
