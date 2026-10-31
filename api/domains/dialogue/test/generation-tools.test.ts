import { expect, test } from "bun:test";
import { parseCall } from "../service/generation-tools";

test("the argument schemas leave each mode's required fields to the host's check", () => {
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

test("a delegate call without impact or the request is taken (the host fills or checks it); approve may carry it", () => {
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
	// Without the request the call is taken too: an instant toolchain needs only its inputs, and the host refuses it
	// for any other toolchain.
	expect(
		parseCall(call({ mode: "execute", toolchain: "fake.image" })).name,
	).toBe("delegate");
	expect(
		parseCall(call({ mode: "approve", confirmation: "c1", impact: "create" }))
			.name,
	).toBe("delegate");
});
