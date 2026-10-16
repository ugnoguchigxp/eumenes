import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { SpecialistSet } from "../../domains/dialogue";
import type { AdapterRegistry } from "../../domains/tool-runtime";
import { createSpecialistPort } from "./specialist-port";

const db = {} as Database;
const recent = Array.from({ length: 50 }, (_, i) => ({
	ref: `item-${i}`,
	label: `項目${i}`,
}));
const set = {
	adapterRef: "adapter:fake@1",
	targetSchemaRef: "builtin:fakeTarget",
	tools: [],
} as unknown as SpecialistSet;
const port = createSpecialistPort({
	routing: {},
	registry: {
		get: (ref: string) =>
			ref === "adapter:fake@1"
				? {
						choicesInTransaction: () => recent,
						session: {
							hasTargetInTransaction: (_d: Database, ref: string) =>
								ref === "item-old",
						},
					}
				: undefined,
		all: () => [],
	} as unknown as AdapterRegistry,
	schemas: { get: () => undefined },
	clock: () => "2026-10-17T00:00:00.000Z",
});

test("the choices are the adapter's most recent items, at most 50", () => {
	expect(port.targetChoicesInTransaction(db, set)).toEqual(recent);
});

test("an item on screen that is older than the recent ones is offered first and the oldest makes room", () => {
	const offered = port.targetChoicesInTransaction(db, set, "item-old");
	expect(offered).toHaveLength(50);
	expect(offered[0]).toEqual({ ref: "item-old", label: "item-old" });
	expect(offered.at(-1)!.ref).toBe("item-48");
});

test("an item the adapter does not confirm, or one already offered, changes nothing", () => {
	expect(port.targetChoicesInTransaction(db, set, "item-9")).toEqual(recent);
	expect(port.targetChoicesInTransaction(db, set, "missing")).toEqual(recent);
});
