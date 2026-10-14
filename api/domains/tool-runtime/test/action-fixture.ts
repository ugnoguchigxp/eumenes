import type { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { openStore } from "../../../infrastructure/sqlite";
import type { ArtifactDefinitionV1 } from "../../capabilities";
import {
	createAdapterRegistry,
	migrations,
	type AdapterResult,
	type DomainAdapter,
	type ToolchainActionEventV1,
} from "..";
import { createActionRequests } from "../service/action-requests";
import type { CapabilityReads } from "../service/action-types";

export const ADAPTER_REF = "adapter:fake@1";
export const ARTIFACT_ID = "artifact:fake.workspace@1";
export const OTHER_REF = "adapter:other@1";
export const HUB_ID = "artifact:fake.hub@1";
export const SCOPE = "default";

export const artifact: ArtifactDefinitionV1 = {
	kind: "artifact",
	id: "fake.workspace",
	revision: 1,
	title: "Fake workspace",
	variants: [{ id: "standard", label: "標準", definition: {} }],
	defaultVariant: "standard",
	sourceBindings: [
		{
			source: "setup",
			adapterRef: ADAPTER_REF,
			query: "query:fake.setup@1",
			target: "none",
		},
		{
			source: "item",
			adapterRef: ADAPTER_REF,
			query: "query:fake.current@1",
			target: "required",
		},
		{
			source: "records",
			adapterRef: ADAPTER_REF,
			query: "query:fake.records@1",
			target: "none",
			paramsSchemaRef: "builtin:fakeParams",
		},
	],
	actionBindings: [
		{
			actionId: "start",
			eventAction: "fake-start",
			source: "setup",
			operationId: "fake.start",
			inputSchemaRef: "builtin:fakeHms",
			inputAdapterRef: "input:fake-hms@1",
			effect: "write",
		},
		{
			actionId: "cancel",
			eventAction: "fake-cancel",
			source: "item",
			operationId: "fake.cancel",
			inputSchemaRef: "builtin:fakeEmpty",
			effect: "write",
		},
		{
			actionId: "clock",
			eventAction: "fake-clock",
			source: "setup",
			inputSchemaRef: "builtin:fakeEmpty",
			effect: "local",
		},
		{
			actionId: "answer",
			eventAction: "fake-answer",
			source: "setup",
			answer: true,
			inputSchemaRef: "builtin:fakeEmpty",
			effect: "write",
		},
		{
			actionId: "mismatch",
			eventAction: "fake-mismatch",
			source: "setup",
			operationId: "fake.read",
			inputSchemaRef: "builtin:fakeEmpty",
			effect: "write",
		},
		{
			actionId: "open",
			eventAction: "fake-open",
			source: "setup",
			inputSchemaRef: "builtin:fakeEmpty",
			effect: "navigate",
			navigateTo: { artifactId: "fake.hub" },
		},
		{
			actionId: "edit",
			eventAction: "fake-edit",
			source: "setup",
			inputSchemaRef: "builtin:fakeEmpty",
			effect: "draft",
			draftAction: "edit",
			draftDocument: "document:fake@1",
		},
		{
			actionId: "apply",
			eventAction: "fake-apply",
			source: "setup",
			operationId: "fake.apply",
			inputSchemaRef: "builtin:fakeApply",
			effect: "write",
			draftDocument: "document:fake@1",
			confidentialFields: ["token"],
		},
	],
};

/** A standalone launcher artifact (no toolchain) reading two adapters. */
export const hub: ArtifactDefinitionV1 = {
	kind: "artifact",
	id: "fake.hub",
	revision: 1,
	title: "Fake hub",
	launcher: { label: "Hub", group: "manage", order: 1 },
	variants: [{ id: "standard", label: "標準", definition: {} }],
	defaultVariant: "standard",
	sourceBindings: [
		{
			source: "setup",
			adapterRef: ADAPTER_REF,
			query: "query:fake.setup@1",
			target: "none",
		},
		{
			source: "others",
			adapterRef: OTHER_REF,
			query: "query:other.list@1",
			target: "none",
		},
	],
	actionBindings: [],
};

export const schemas: Record<string, z.ZodType> = {
	"builtin:fakeHms": z.strictObject({
		hours: z.string(),
		minutes: z.string(),
		seconds: z.string(),
	}),
	"builtin:fakeEmpty": z.strictObject({}),
	"builtin:fakeStart": z.strictObject({
		durationSeconds: z.number().int().min(1).max(86400),
	}),
	"builtin:fakeParams": z.strictObject({
		offset: z.number().int().min(0).max(1000),
		limit: z.number().int().min(1).max(50),
		search: z.string().max(40).optional(),
	}),
	"builtin:fakeApply": z.strictObject({
		expectedRevision: z.number().int(),
		changes: z.array(
			z.strictObject({ fieldId: z.string(), value: z.unknown() }),
		),
		token: z.string().min(1).optional(),
	}),
	"builtin:fakeTarget": z.strictObject({
		itemId: z.string(),
		expectedRevision: z.number().int(),
	}),
};

export function makeHarness(
	options: {
		now?: () => number;
		available?: () => boolean;
		secretKey?: () => Uint8Array | undefined;
	} = {},
) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-actions-"));
	const store = openStore(join(dir, "db"), [
		...migrations,
		{
			id: "test/0001-fake-domain",
			sql: "CREATE TABLE fake_effects(request_id TEXT PRIMARY KEY,operation TEXT NOT NULL,input_json TEXT NOT NULL,issued_at TEXT NOT NULL);",
			after: [migrations[migrations.length - 1]!.id],
		},
	]);
	const items = new Map<string, number>([["item-1", 3]]);
	const calls = { afterCommit: 0 };
	const sourceParams: unknown[] = [];
	const invoked: Array<{
		requestId: string;
		issuedAt: string;
		operationName: string;
		input: unknown;
		origin: unknown;
	}> = [];
	let available = options.available ?? (() => true);
	const resultOf = (db: Database, requestId: string): AdapterResult => {
		const row = db
			.query("SELECT * FROM fake_effects WHERE request_id=?")
			.get(requestId) as { operation: string; input_json: string } | null;
		if (!row) throw new Error("operation_expired");
		return {
			receipt: { operation: row.operation, input: JSON.parse(row.input_json) },
			receiptRef: {
				owner: "fake",
				operationId: `op-${requestId}`,
				digest: `digest-${requestId}`,
			},
			resultRefs: [
				{
					owner: "fake",
					kind: "item",
					id: "item-1",
					schemaRef: "domain:fake.item@1",
				},
			],
			replay: false,
		};
	};
	const adapter: DomainAdapter = {
		ref: ADAPTER_REF,
		describe: () => ({
			owner: "fake",
			operations: new Map([
				[
					"fake.start",
					{ inputSchemaRef: "builtin:fakeStart", effect: "write" as const },
				],
				[
					"fake.cancel",
					{ inputSchemaRef: "builtin:fakeTarget", effect: "write" as const },
				],
				[
					"fake.apply",
					{ inputSchemaRef: "builtin:fakeApply", effect: "write" as const },
				],
				[
					"fake.read",
					{ inputSchemaRef: "builtin:fakeTarget", effect: "read" as const },
				],
			]),
			queries: new Set([
				"query:fake.setup@1",
				"query:fake.current@1",
				"query:fake.records@1",
			]),
			inputAdapters: new Map([
				[
					"input:fake-hms@1",
					(raw: Record<string, unknown>) => {
						const parts = [raw.hours, raw.minutes, raw.seconds].map(String);
						const bad = ["hours", "minutes", "seconds"].filter(
							(_, i) => !/^\d{1,5}$/.test(parts[i]!),
						);
						if (bad.length)
							return {
								ok: false as const,
								errors: bad.map((field) => ({
									field,
									message: "digits_required",
								})),
							};
						const [h, m, s] = parts.map(Number) as [number, number, number];
						return {
							ok: true as const,
							value: { durationSeconds: h * 3600 + m * 60 + s },
						};
					},
				],
			]),
			projections: new Set(),
			availability: "availability:fake@1",
		}),
		availableInTransaction: () => available(),
		snapshotInTransaction: () => ({}),
		invokeInTransaction(tx, request) {
			invoked.push({
				requestId: request.requestId,
				issuedAt: request.issuedAt,
				operationName: request.operationName,
				input: request.input,
				origin: request.origin,
			});
			tx.query(
				"INSERT INTO fake_effects(request_id,operation,input_json,issued_at) VALUES(?,?,?,?)",
			).run(
				request.requestId,
				request.operationName,
				// The owning domain never keeps a secret in its receipt.
				JSON.stringify({ ...(request.input as object), token: undefined }),
				request.issuedAt,
			);
			const seconds = (request.input as { durationSeconds?: number })
				.durationSeconds;
			if (seconds === 999) throw new Error("revision_conflict");
			if (seconds === 998) throw new Error("Unexpected failure with spaces");
			return resultOf(tx, request.requestId);
		},
		readInTransaction: (tx, operationId) =>
			tx
				.query("SELECT 1 FROM fake_effects WHERE request_id=?")
				.get(operationId.replace(/^op-/, ""))
				? resultOf(tx, operationId.replace(/^op-/, ""))
				: null,
		sourceInTransaction: (_tx, query, targetRef, params) => {
			if (query === "query:fake.records@1") {
				sourceParams.push(params);
				return { revision: 2, data: { rows: [], params } };
			}
			if (query === "query:fake.setup@1")
				return { revision: 0, data: { defaults: [0, 0, 90] } };
			const revision = targetRef ? items.get(targetRef) : undefined;
			return revision === undefined
				? null
				: { revision, data: { id: targetRef, state: "active" } };
		},
		targetInput: (_query, targetRef, revision) => ({
			itemId: targetRef,
			expectedRevision: revision,
		}),
		afterCommit: () => {
			calls.afterCommit++;
		},
	};
	let otherAvailable = true;
	const other: DomainAdapter = {
		...adapter,
		ref: OTHER_REF,
		describe: () => ({
			owner: "other",
			operations: new Map(),
			queries: new Set(["query:other.list@1"]),
			inputAdapters: new Map(),
			projections: new Set(),
			availability: "availability:other@1",
		}),
		availableInTransaction: () => otherAvailable,
		sourceInTransaction: () => ({ revision: 1, data: { rows: [] } }),
	};
	let hubActive = true;
	let active = true;
	let key: Uint8Array | undefined = new Uint8Array(32).fill(7);
	const capabilities: CapabilityReads = {
		artifactsInTransaction: () => [
			...(active
				? [
						{
							toolchainId: "fake.manage",
							toolchainRevisionId: "toolchain:fake.manage@1",
							artifactRevisionId: ARTIFACT_ID,
							title: "Fake workspace",
							adapterRef: ADAPTER_REF,
						},
					]
				: []),
			...(hubActive
				? [
						{
							toolchainId: null,
							toolchainRevisionId: null,
							artifactRevisionId: HUB_ID,
							title: "Fake hub",
							adapterRef: null,
							launcher: hub.launcher,
						},
					]
				: []),
		],
		documentInTransaction: (_db, id) =>
			id === ARTIFACT_ID || id === HUB_ID
				? {
						revisionId: id,
						digest: "a".repeat(64),
						document: id === HUB_ID ? hub : artifact,
					}
				: null,
		schemaInTransaction: (_db, ref) => schemas[ref] ?? null,
	};
	const time = {
		value: options.now?.() ?? Date.parse("2026-10-13T00:00:00.000Z"),
	};
	const now = options.now ?? (() => time.value);
	const service = createActionRequests({
		store,
		capabilities,
		registry: createAdapterRegistry([adapter, other]),
		now,
		scope: SCOPE,
		secretKey: options.secretKey ?? (() => key),
	});
	const event = (
		patch: Partial<ToolchainActionEventV1> = {},
	): ToolchainActionEventV1 => ({
		version: 1,
		eventId: crypto.randomUUID(),
		eventCreatedAt: new Date(now()).toISOString(),
		eventExpiresAt: new Date(now() + 3_600_000).toISOString(),
		artifactId: "tab-1",
		artifactRevisionId: ARTIFACT_ID,
		source: "setup",
		sourceRevision: 0,
		actionId: "start",
		scopeRef: service.scopeRef,
		input: { hours: "0", minutes: "1", seconds: "30" },
		...patch,
	});
	const effects = () =>
		(
			store.read((db) =>
				db.query("SELECT COUNT(*) AS n FROM fake_effects").get(),
			) as { n: number }
		).n;
	const ledger = () =>
		(
			store.read((db) =>
				db.query("SELECT COUNT(*) AS n FROM tool_action_requests").get(),
			) as { n: number }
		).n;
	return {
		store,
		service,
		adapter,
		items,
		calls,
		sourceParams,
		invoked,
		time,
		event,
		effects,
		ledger,
		setAvailable: (fn: () => boolean) => {
			available = fn;
		},
		setOtherAvailable: (value: boolean) => {
			otherAvailable = value;
		},
		setHubActive: (value: boolean) => {
			hubActive = value;
		},
		setKey: (value: Uint8Array | undefined) => {
			key = value;
		},
		setActive: (value: boolean) => {
			active = value;
		},
		close: () => store.close(),
	};
}
