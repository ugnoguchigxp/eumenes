import { expect, test } from "bun:test";
import { estimateJsonTokens } from "../../inference";
import { generationTools, parseCall } from "../service/generation-tools";

test("the fixed tool definitions stay within the 2,000 estimated-token allowance (section 6.1)", () => {
	expect(estimateJsonTokens(generationTools)).toBeLessThanOrEqual(2000);
	expect(generationTools.map((tool) => tool.function.name)).toEqual([
		"memory",
		"find_toolchain",
		"delegate",
		"work",
	]);
});

test("the compact definitions leave each mode's required fields to the host's check", () => {
	const call = (name: string, args: unknown) => ({
		id: "c1",
		name,
		arguments: JSON.stringify(args),
	});
	expect(() =>
		parseCall(call("delegate", { mode: "approve", toolchain: "x" })),
	).toThrow();
	expect(() => parseCall(call("memory", { operation: "request" }))).toThrow();
	expect(
		parseCall(
			call("delegate", {
				mode: "execute",
				toolchain: "fake.image",
				request: "猫の絵",
				impact: "create",
				announcement: "描きます。",
			}),
		).name,
	).toBe("delegate");
});

test("the native delegate definition asks for impact; a call without it is taken (the host fills it), approve may carry it", () => {
	const delegate = generationTools.find((t) => t.function.name === "delegate")!;
	expect(delegate.function.parameters.required).toEqual(["mode", "impact"]);
	const call = (args: unknown) => ({
		id: "c1",
		name: "delegate",
		arguments: JSON.stringify(args),
	});
	expect(
		parseCall(
			call({
				mode: "execute",
				toolchain: "fake.image",
				request: "猫の絵",
			}),
		).name,
	).toBe("delegate");
	// The request itself is still required.
	expect(() =>
		parseCall(call({ mode: "execute", toolchain: "fake.image" })),
	).toThrow();
	expect(
		parseCall(call({ mode: "approve", confirmation: "c1", impact: "create" }))
			.name,
	).toBe("delegate");
});
