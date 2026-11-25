import { expect, test } from "bun:test";
import { parseCall } from "../service/generation-tools";

test("the argument schemas leave each tool's required fields to the host's check", () => {
	const call = (name: string, args: unknown) => ({
		id: "c1",
		name,
		arguments: JSON.stringify(args),
	});
	// `delegate` names its toolchain; the retired confirmation arguments are not accepted.
	expect(() => parseCall(call("delegate", { request: "猫の絵" }))).toThrow();
	expect(() =>
		parseCall(
			call("delegate", { mode: "execute", toolchain: "x", request: "猫の絵" }),
		),
	).toThrow();
	expect(() =>
		parseCall(call("delegate", { toolchain: "x", announcement: "描きます。" })),
	).toThrow();
	expect(() => parseCall(call("memory", { operation: "request" }))).toThrow();
	expect(
		parseCall(call("delegate", { toolchain: "fake.image", request: "猫の絵" }))
			.name,
	).toBe("delegate");
});

test("a delegate call without the request is taken (the host checks it): an instant toolchain needs only its inputs", () => {
	const call = (args: unknown) => ({
		id: "c1",
		name: "delegate",
		arguments: JSON.stringify(args),
	});
	expect(
		parseCall(call({ toolchain: "fake.image", request: "猫の絵" })).name,
	).toBe("delegate");
	// The host refuses it for any toolchain but an instant one.
	expect(parseCall(call({ toolchain: "fake.image" })).name).toBe("delegate");
	expect(
		parseCall(call({ toolchain: "fake.clock", inputs: { city: "東京" } })).name,
	).toBe("delegate");
});

test("the memory tool takes the marks of a record: sensitive, and whose it is", () => {
	const call = (memory: Record<string, unknown>) => ({
		id: "c1",
		name: "memory",
		arguments: JSON.stringify({
			operation: "request",
			kind: "remember",
			what: "妹の好み",
			quote: "妹は猫が好き",
			memory: {
				kind: "personal_fact",
				semanticKey: "sister.likes",
				text: "妹は猫が好き",
				...memory,
			},
		}),
	});
	expect(parseCall(call({ subject: "other", sensitive: true })).name).toBe(
		"memory",
	);
	expect(parseCall(call({ subject: "self" })).name).toBe("memory");
	expect(() => parseCall(call({ subject: "pet" }))).toThrow();
	expect(() => parseCall(call({ sensitive: "yes" }))).toThrow();
});
