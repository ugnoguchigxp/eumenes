import { expect, test } from "bun:test";
import { compileArtifact } from "./compiler";
test("dots messaging composes with registered views and requires its own source", () => {
	const definition = {
		view: "layout",
		direction: "stack",
		children: [
			{ view: "text-block", title: "接続後の返答と要約" },
			{ view: "dots-messaging", source: "dots", title: "dots メッセージ" },
		],
	};
	const source = {
		kind: "dots-messaging" as const,
		revision: 1,
		connections: [],
		connectionRef: "",
		enabled: false,
		subscribed: false,
		confirmed: false,
		busy: false,
		canSend: false,
		items: [],
	};
	expect(
		compileArtifact(JSON.stringify(definition), { dots: source }).lang,
	).toContain("dots-messaging");
	expect(() => compileArtifact(JSON.stringify(definition), {})).toThrow(
		"source",
	);
});
