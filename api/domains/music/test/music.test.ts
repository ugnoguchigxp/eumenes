import { delegatedTaskRules } from "../../inference";
import { expect, test } from "bun:test";
import { musicContext } from "../service/context";
import {
	bundleFiles,
	type Definition,
	type Prepared,
} from "../../capabilities";
const bundle = bundleFiles().find(
	(f) => f.name === "music-routing.bundle.json",
)!.raw as { definitions: Definition[] };
const created = bundle.definitions.filter(
	(d) =>
		d.id === "music.create" && d.revision === (d.kind === "profile" ? 2 : 3),
);
const prepared = {
	package: created.find((d) => d.kind === "package")!,
	dependencies: created
		.filter((d) => d.kind !== "package")
		.map((d) => ({ ...d, revisionId: `${d.kind}:${d.id}@${d.revision}` })),
} as Prepared;
test("music context carries the original theme as data and the registered skill as instructions", () => {
	const request = {
		question: "雨の日の読書に合う音楽を45秒",
		originalRequest: "雨の日の読書に合う音楽を45秒",
	};
	const c = musicContext(prepared, request);
	expect(c.control.instructions).toContain(delegatedTaskRules);
	expect(c.messages).toHaveLength(2);
	expect(JSON.parse(c.messages[1]!.content)).toEqual(request);
	expect(c.control.instructions).toContain("指定秒数は小数も含めそのまま");
	expect(c.control.instructions).not.toContain(request.question);
	expect(c.control.outputSchema.properties).toHaveProperty("prompt");
	expect(() =>
		musicContext({ ...prepared, dependencies: [] }, request),
	).toThrow("required_context_missing");
});
