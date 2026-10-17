import { expect, test } from "bun:test";
import { z } from "zod";
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

const invocationPort = (schema: z.ZodType) =>
	createSpecialistPort({
		routing: {},
		registry: {
			get: () => undefined,
			all: () => [],
		} as unknown as AdapterRegistry,
		schemas: { get: () => schema },
		clock: () => "2026-10-17T00:00:00.000Z",
	});
const withTool = {
	tools: [
		{
			id: "draft.apply",
			toolRevisionId: "tool:draft.apply@1",
			operationName: "fake.draft.apply",
			inputSchemaRef: "builtin:fakeDraft",
		},
	],
} as unknown as SpecialistSet;

test("an invalid argument reports where, what kind and the expected type, never the input values", () => {
	const port = invocationPort(
		z.object({ title: z.string(), count: z.number().max(3) }).strict(),
	);
	const checked = port.parseInvocation(withTool, "draft.apply", {
		title: 4242,
		count: 9999,
		secretKey: "secret-value",
	});
	expect(checked.ok).toBe(false);
	if (checked.ok) return;
	expect(checked.code).toBe("specialist_invalid_arguments");
	const detail = checked.detail ?? [];
	expect(detail.length).toBeGreaterThan(0);
	expect(
		detail.some((line) => line.includes("title") && line.includes("string")),
	).toBe(true);
	const joined = JSON.stringify(detail);
	for (const value of ["4242", "9999", "secret-value", "secretKey"])
		expect(joined).not.toContain(value);
});

test("the detail holds at most 8 issues of at most 200 characters", () => {
	const key = "k".repeat(300);
	const shape = Object.fromEntries(
		Array.from({ length: 12 }, (_, i) => [
			i === 0 ? key : `field${i}`,
			z.string(),
		]),
	);
	const port = invocationPort(z.object(shape));
	const checked = port.parseInvocation(withTool, "draft.apply", {});
	expect(checked.ok).toBe(false);
	if (checked.ok) return;
	expect(checked.detail).toHaveLength(8);
	for (const line of checked.detail!)
		expect(line.length).toBeLessThanOrEqual(200);
});
