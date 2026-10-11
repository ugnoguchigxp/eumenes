import { expect, test } from "bun:test";
import { musicContext } from "../service/context";
import { musicBuiltins } from "../../capabilities";
import type { Prepared } from "../../capabilities";
const prepared = {
	package: musicBuiltins.find((d) => d.kind === "package")!,
	dependencies: musicBuiltins
		.filter((d) => d.kind !== "package")
		.map((d) => ({ ...d, revisionId: `${d.kind}:${d.id}@1` })),
} as Prepared;
test("music context carries the original theme as data and the registered skill as instructions", () => {
	const request = {
		question: "雨の日の読書に合う音楽を45秒",
		originalRequest: "雨の日の読書に合う音楽を45秒",
	};
	const c = musicContext(prepared, request);
	expect(JSON.parse(c.messages[1]!.content)).toEqual(request);
	expect(c.control.instructions).toContain("指定の秒数をそのまま");
	expect(c.control.instructions).not.toContain(request.question);
	expect(c.control.outputSchema.properties).toHaveProperty("prompt");
	expect(() =>
		musicContext({ ...prepared, dependencies: [] }, request),
	).toThrow("required_context_missing");
});
