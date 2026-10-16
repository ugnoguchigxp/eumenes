import { expect, test } from "bun:test";
import { Hono } from "hono";
import { errorStatus, registerCapabilities } from "..";
import {
	action,
	artifact,
	bundle,
	fixture,
	lines,
} from "./standalone-artifacts.fixture";

test("launcher artifacts are published without a toolchain, with the final entry shape", async () => {
	await fixture(async ({ store, caps, load }) => {
		const result = await load(
			bundle([
				artifact("notes.hub", 1),
				artifact("notes.view", 1, {
					fields: [],
					launcher: undefined,
				}),
			]),
		);
		expect(result.issues).toEqual([]);
		store.read((db) => {
			expect(caps.artifactsInTransaction(db)).toEqual([
				{
					artifactId: "notes.hub",
					artifactRevisionId: "artifact:notes.hub@1",
					title: "画面 notes.hub 1",
					toolchainId: null,
					toolchainRevisionId: null,
					adapterRef: null,
					adapterRefs: ["adapter:notes@1"],
					launcher: { label: "notes.hub", group: "g", order: 1 },
				},
			]);
		});
	});
});

test("a newer revision switches the published pointer, an old one is a rollback, and re-import keeps the choice", async () => {
	await fixture(async ({ store, caps, load, published }) => {
		await load(bundle([artifact("notes.hub", 1)]));
		await load(bundle([artifact("notes.hub", 2, { fields: [] })]));
		expect(await published()).toEqual(["artifact:notes.hub@2"]);
		const publish = (revisionId: string) =>
			store.write((db) =>
				caps.publishArtifactRevisionInTransaction(db, "notes.hub", revisionId),
			);
		await publish("artifact:notes.hub@1");
		expect(await published()).toEqual(["artifact:notes.hub@1"]);
		// Registering the same bundle again does not flip the pointer back.
		const again = await load(
			bundle([artifact("notes.hub", 2, { fields: [] })]),
		);
		expect(again.registered).toEqual([]);
		expect(await published()).toEqual(["artifact:notes.hub@1"]);
		await publish("artifact:notes.hub@2");
		expect(await published()).toEqual(["artifact:notes.hub@2"]);
		await expect(publish("artifact:notes.hub@9")).rejects.toThrow(
			"capability_not_found",
		);
		await expect(
			store.write((db) =>
				caps.publishArtifactRevisionInTransaction(
					db,
					"notes.other",
					"artifact:notes.hub@1",
				),
			),
		).rejects.toThrow("capability_not_found");
		// A revision without a launcher takes the artifact off the list and cannot be published.
		await load(
			bundle([artifact("notes.hub", 3, { launcher: undefined, fields: [] })]),
		);
		expect(await published()).toEqual([]);
		await expect(publish("artifact:notes.hub@3")).rejects.toThrow(
			"invalid_capability",
		);
		await publish("artifact:notes.hub@2");
		expect(await published()).toEqual(["artifact:notes.hub@2"]);
	});
});

test("fields are checked against the adapter that owns the document", async () => {
	await fixture(async ({ load }) => {
		const field = (over: Record<string, unknown>) => ({
			...(artifact("a", 1).fields![0] as object),
			...over,
		});
		const check = async (over: Record<string, unknown>, extra = {}) =>
			lines(
				await load(
					bundle([artifact("a", 1, { fields: [field(over)], ...extra })]),
					true,
				),
			);
		expect(await check({})).toEqual([]);
		expect(await check({ document: "document:nothing@1" })).toEqual([
			"unknown_reference:artifacts/0/fields/0/document",
		]);
		expect(await check({ path: "$.general.other" })).toEqual([
			"invalid_format:artifacts/0/fields/0/path",
		]);
		expect(
			await check({ path: "$.items[id=$target].voice", target: undefined }),
		).toEqual(["invalid_format:artifacts/0/fields/0/target"]);
		expect(await check({ target: "notes-items" })).toEqual([
			"invalid_format:artifacts/0/fields/0/target",
		]);
		expect(
			await check({ path: "$.items[id=$target].voice", target: "nothing" }),
		).toEqual(["unknown_reference:artifacts/0/fields/0/target"]);
		expect(
			await check({
				optionsSource: "query:other.document@1",
				options: undefined,
			}),
		).toEqual(["unregistered_query:artifacts/0/fields/0/optionsSource"]);
		expect(await check({ visibleWhen: "condition:nothing@1" })).toEqual([
			"unknown_reference:artifacts/0/fields/0/visibleWhen",
		]);
		expect(await check({ visibleWhen: "condition:notes-voice@1" })).toEqual([]);
		// A document of another adapter is fine when that adapter registers it.
		expect(await check({ document: "document:other@1" })).toEqual([]);
	});
});

test("a field id is unique across the whole published catalog, but a revision may keep its own", async () => {
	await fixture(async ({ load, published }) => {
		const dup = lines(
			await load(
				bundle([
					artifact("a", 1, { fields: [artifact("x", 1).fields![0]] }),
					artifact("b", 1, { fields: [artifact("x", 1).fields![0]] }),
				]),
				true,
			),
		);
		expect(dup).toEqual(["invalid_format:artifacts/1/fields/0/fieldId"]);
		await load(bundle([artifact("a", 1)]));
		// Another bundle cannot reuse a published field id ...
		expect(
			lines(
				await load(
					bundle(
						[artifact("b", 1, { fields: [artifact("a", 1).fields![0]] })],
						"other",
					),
					true,
				),
			),
		).toEqual(["invalid_format:artifacts/0/fields/0/fieldId"]);
		// ... while a newer revision of the same artifact id carries them over.
		const next = await load(bundle([artifact("a", 2)]));
		expect(next.issues).toEqual([]);
		expect(await published()).toEqual(["artifact:a@2"]);
	});
});

test("draft documents, navigation targets and apply operations must be registered", async () => {
	await fixture(async ({ load }) => {
		const withActions = (actions: unknown[], id = "a") =>
			artifact(id, 1, { fields: [], actionBindings: actions });
		const check = async (actions: unknown[]) =>
			lines(await load(bundle([withActions(actions)]), true));
		expect(
			await check([
				action({
					effect: "draft",
					draftAction: "discard",
					draftDocument: "document:nothing@1",
				}),
			]),
		).toEqual(["unknown_reference:artifacts/0/actionBindings/0/draftDocument"]);
		// An unregistered destination is allowed (the Web shows it disabled); itself is not.
		expect(
			await check([
				action({ effect: "navigate", navigateTo: { artifactId: "nothing" } }),
			]),
		).toEqual([]);
		expect(
			await check([
				action({ effect: "navigate", navigateTo: { artifactId: "a" } }),
			]),
		).toEqual(["invalid_format:artifacts/0/actionBindings/0/navigateTo"]);
		// The source's adapter owns the draft's document and so the apply operation.
		expect(
			await check([
				action({
					effect: "write",
					operationId: "other.apply",
					draftDocument: "document:notes@1",
				}),
			]),
		).toEqual([
			"unregistered_operation:artifacts/0/actionBindings/0/operationId",
		]);
		expect(
			await check([
				action({
					effect: "write",
					operationId: "notes.apply",
					draftDocument: "document:other@1",
				}),
			]),
		).toEqual(["schema_mismatch:artifacts/0/actionBindings/0/draftDocument"]);
		expect(
			await check([
				action({
					effect: "write",
					operationId: "notes.apply",
					draftDocument: "document:notes@1",
				}),
			]),
		).toEqual([]);
		// Navigation may name an artifact of the same bundle ...
		expect(
			lines(
				await load(
					bundle([
						withActions([
							action({ effect: "navigate", navigateTo: { artifactId: "b" } }),
						]),
						withActions([], "b"),
					]),
					true,
				),
			),
		).toEqual([]);
		// ... or one that is already published.
		await load(bundle([withActions([], "b")]));
		expect(
			lines(
				await load(
					bundle(
						[
							artifact("c", 1, {
								fields: [],
								actionBindings: [
									action({
										effect: "navigate",
										navigateTo: { artifactId: "b" },
									}),
								],
							}),
						],
						"c",
					),
					true,
				),
			),
		).toEqual([]);
		// Only draft and navigate actions go without an operation.
		expect(
			await check([
				action({
					effect: "navigate",
					navigateTo: { artifactId: "a" },
					operationId: "notes.apply",
				}),
			]),
		).toContain("invalid_format:artifacts/0/actionBindings/0");
	});
});

test("a refused bundle publishes nothing", async () => {
	await fixture(async ({ load, published }) => {
		await load(bundle([artifact("a", 1)]));
		await expect(
			load(
				bundle([
					artifact("a", 2),
					artifact("b", 1, {
						fields: [
							{ ...(artifact("b", 1).fields![0] as object), path: "$.nope" },
						],
					}),
				]),
			),
		).rejects.toThrow("invalid_capability_bundle");
		expect(await published()).toEqual(["artifact:a@1"]);
	});
});

test("a navigate-by-value map is checked for every target, and a default value stays display-only", async () => {
	await fixture(async ({ load }) => {
		const nav = (artifacts: Record<string, string>) =>
			artifact("a", 1, {
				fields: [],
				actionBindings: [
					action({
						effect: "navigate",
						navigateTo: { byValue: "section", artifacts },
					}),
				],
			});
		expect(
			lines(
				await load(
					bundle([
						nav({ voice: "b", display: "b" }),
						artifact("b", 1, { fields: [] }),
					]),
					true,
				),
			),
		).toEqual([]);
		expect(
			lines(
				await load(
					bundle([
						nav({ voice: "b", display: "nothing" }),
						artifact("b", 1, { fields: [] }),
					]),
					true,
				),
			),
		).toEqual([]);
		expect(
			lines(await load(bundle([nav({ voice: "b", display: "a" })]), true)),
		).toEqual([
			"invalid_format:artifacts/0/actionBindings/0/navigateTo/artifacts/display",
		]);
		const check = async (over: Record<string, unknown>) =>
			lines(
				await load(
					bundle([
						artifact("a", 1, {
							fields: [{ ...(artifact("a", 1).fields![0] as object), ...over }],
						}),
					]),
					true,
				),
			);
		expect(await check({ defaultValue: "light" })).toEqual([]);
		expect(await check({ defaultValue: "dark" })).toEqual([
			"invalid_format:artifacts/0/fields/0/defaultValue",
		]);
		expect(await check({ defaultValue: "light", confidential: true })).toEqual([
			"invalid_format:artifacts/0/fields/0/defaultValue",
		]);
		const number = {
			path: "$.general.volume",
			control: "number",
			options: undefined,
			min: 1,
			max: 5,
		};
		expect(await check({ ...number, defaultValue: "3" })).toEqual([]);
		expect(await check({ ...number, defaultValue: "9" })).toEqual([
			"invalid_format:artifacts/0/fields/0/defaultValue",
		]);
		expect(await check({ ...number, defaultValue: "x" })).toEqual([
			"invalid_format:artifacts/0/fields/0/defaultValue",
		]);
		expect(await check({ ...number, defaultValue: "2.5" })).toEqual([
			"invalid_format:artifacts/0/fields/0/defaultValue",
		]);
		const text = {
			path: "$.general.name",
			control: "text",
			options: undefined,
		};
		expect(await check({ ...text, defaultValue: "x" })).toEqual([]);
		expect(await check({ ...text, defaultValue: "x".repeat(21) })).toEqual([
			"invalid_format:artifacts/0/fields/0/defaultValue",
		]);
		const toggle = {
			path: "$.general.enabled",
			control: "toggle",
			options: undefined,
		};
		expect(await check({ ...toggle, defaultValue: "true" })).toEqual([]);
		expect(await check({ ...toggle, defaultValue: "yes" })).toEqual([
			"invalid_format:artifacts/0/fields/0/defaultValue",
		]);
	});
});

test("a field must agree with what the document schema says about its path", async () => {
	await fixture(async ({ load }) => {
		const check = async (over: Record<string, unknown>, extra = {}) =>
			lines(
				await load(
					bundle([
						artifact("a", 1, {
							fields: [{ ...(artifact("a", 1).fields![0] as object), ...over }],
							...extra,
						}),
					]),
					true,
				),
			);
		const at = "artifacts/0/fields/0";
		const volume = {
			path: "$.general.volume",
			options: undefined,
			control: "number",
		};
		const text = {
			path: "$.general.name",
			options: undefined,
			control: "text",
		};
		expect(await check(volume)).toEqual([]);
		// Control against kind.
		expect(await check({ ...volume, control: "toggle" })).toEqual([
			`schema_mismatch:${at}/control`,
		]);
		expect(await check({ ...text, control: "number" })).toEqual([
			`schema_mismatch:${at}/control`,
		]);
		expect(
			await check({ path: "$.general.tags", control: "select" }),
		).toContain(`schema_mismatch:${at}/control`);
		expect(
			await check({
				path: "$.general.tags",
				control: "multiple",
				options: [{ value: "a", label: "A" }],
			}),
		).toEqual([]);
		expect(
			await check({
				path: "$.general.name",
				control: "select",
				options: undefined,
				optionsSource: undefined,
			}),
		).toEqual([`invalid_format:${at}/options`]);
		// Fixed options must be values of the enum.
		expect(await check({ options: [{ value: "blue", label: "青" }] })).toEqual([
			`schema_mismatch:${at}/options`,
		]);
		// Limits stay inside the schema's.
		expect(await check({ ...volume, min: -1 })).toEqual([
			`schema_mismatch:${at}/min`,
		]);
		expect(await check({ ...volume, max: 11 })).toEqual([
			`schema_mismatch:${at}/max`,
		]);
		expect(await check({ ...volume, min: 5, max: 2 })).toEqual([
			`schema_mismatch:${at}/min`,
		]);
		expect(await check({ ...volume, min: 1, max: 9, step: 1 })).toEqual([]);
		expect(await check({ ...text, min: 1 })).toEqual([
			`invalid_format:${at}/min`,
		]);
		expect(await check({ ...text, maxLength: 21 })).toEqual([
			`schema_mismatch:${at}/maxLength`,
		]);
		expect(await check({ ...text, maxLength: 20 })).toEqual([]);
		expect(await check({ ...volume, maxLength: 3 })).toEqual([
			`invalid_format:${at}/maxLength`,
		]);
		// An empty input may only mean what the schema allows.
		expect(await check({ ...text, unset: "null" })).toEqual([]);
		expect(await check({ ...text, unset: "delete-key" })).toEqual([]);
		expect(await check({ ...text, unset: "empty-string" })).toEqual([]);
		expect(await check({ ...volume, unset: "null" })).toEqual([
			`schema_mismatch:${at}/unset`,
		]);
		expect(await check({ ...volume, unset: "empty-string" })).toEqual([
			`schema_mismatch:${at}/unset`,
		]);
		expect(await check({ unset: "delete-key" })).toEqual([
			`schema_mismatch:${at}/unset`,
		]);
		// A path used by another field is refused, whatever the field id.
		expect(
			await check(
				{},
				{
					fields: [
						artifact("a", 1).fields![0],
						{ ...(artifact("a", 1).fields![0] as object), fieldId: "a.other" },
					],
				},
			),
		).toEqual([`invalid_format:artifacts/0/fields/1/fieldId`]);
		// A target path lists its targets with the adapter's own query.
		expect(await check({ target: "notes-doc" })).toEqual([
			`invalid_format:${at}/target`,
		]);
		const voice = artifact("a", 1).fields![1] as { target: string };
		expect(voice.target).toBe("notes-items");
		expect(
			lines(
				await load(
					bundle([
						artifact("a", 1, {
							sourceBindings: artifact("a", 1).sourceBindings.map((s) =>
								s.source === "notes-items"
									? { ...s, query: "query:notes.choices@1" }
									: s,
							),
						}),
					]),
					true,
				),
			),
		).toEqual(["schema_mismatch:artifacts/0/fields/1/target"]);
	});
});

test("confidential values travel only in declared input properties of every write that applies the document", async () => {
	await fixture(async ({ load }) => {
		const secret = {
			...(artifact("a", 1).fields![0] as object),
			fieldId: "a.key",
			path: "$.general.apiKey",
			control: "text",
			options: undefined,
			confidential: true,
		};
		const apply = (over: Record<string, unknown>) =>
			action({
				actionId: "settings-apply",
				eventAction: "settings-apply",
				effect: "write",
				operationId: "notes.apply",
				draftDocument: "document:notes@1",
				inputSchemaRef: "builtin:answerText",
				...over,
			});
		const check = async (actions: unknown[], fields: unknown[] = [secret]) =>
			lines(
				await load(
					bundle([artifact("a", 1, { fields, actionBindings: actions })]),
					true,
				),
			);
		expect(await check([apply({ confidentialFields: ["text"] })])).toEqual([]);
		expect(await check([apply({ confidentialFields: ["apiKey"] })])).toEqual([
			"schema_mismatch:artifacts/0/actionBindings/0/confidentialFields/0",
		]);
		expect(await check([apply({})])).toEqual([
			"permission:artifacts/0/actionBindings/0/confidentialFields",
		]);
		// Without a confidential field in the catalog the declaration is optional.
		expect(await check([apply({})], [])).toEqual([]);
	});
});

test("source params schemas must resolve", async () => {
	await fixture(async ({ load }) => {
		const sources = (paramsSchemaRef: string) =>
			artifact("a", 1).sourceBindings.map((s, i) =>
				i === 0 ? { ...s, paramsSchemaRef } : s,
			);
		const check = async (ref: string) =>
			lines(
				await load(
					bundle([
						artifact("a", 1, { fields: [], sourceBindings: sources(ref) }),
					]),
					true,
				),
			);
		expect(await check("builtin:emptyInput")).toEqual([]);
		expect(await check("builtin:nothing")).toEqual([
			"unknown_reference:artifacts/0/sourceBindings/0/paramsSchemaRef",
		]);
	});
});

test("revisions of one artifact id inside a bundle may carry the same fields", async () => {
	await fixture(async ({ load }) => {
		const result = await load(
			bundle([artifact("a", 1), artifact("a", 2)]),
			true,
		);
		expect(result.issues).toEqual([]);
	});
});

test("artifact publication over HTTP is compare-and-set", async () => {
	await fixture(async ({ caps, load, published }) => {
		await load(bundle([artifact("notes.hub", 1)]));
		await load(bundle([artifact("notes.hub", 2, { fields: [] })]));
		const app = new Hono();
		app.onError((e, c) =>
			c.json(
				{ error: e.message },
				errorStatus[e.message as keyof typeof errorStatus] ?? 400,
			),
		);
		registerCapabilities(app, caps);
		const publish = (id: string, body: unknown) =>
			app.request(`/api/capabilities/artifacts/${id}/publish`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
		const back = {
			revisionId: "artifact:notes.hub@1",
			expectedActiveRevisionId: "artifact:notes.hub@2",
		};
		expect(
			(await publish("notes.hub", { ...back, expectedActiveRevisionId: null }))
				.status,
		).toBe(409);
		expect((await publish("notes.hub", back)).status).toBe(200);
		expect(published()).toEqual(["artifact:notes.hub@1"]);
		expect((await publish("notes.hub", back)).status).toBe(409);
		expect(
			(
				await publish("notes.hub", {
					revisionId: "artifact:notes.hub@9",
					expectedActiveRevisionId: "artifact:notes.hub@1",
				})
			).status,
		).toBe(404);
		expect(published()).toEqual(["artifact:notes.hub@1"]);
	});
});
