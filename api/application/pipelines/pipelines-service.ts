import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { Capabilities } from "../../domains/capabilities";
import type { ToolchainRoutingPort } from "../../domains/dialogue";
import {
	checkPipeline,
	runFixture,
	type PipelineIssue,
	type ToolchainLookup,
} from "../../domains/pipelines";
import type { AdapterRegistry } from "../../domains/tool-runtime";
import type { SqliteStore } from "../../infrastructure/sqlite";
import {
	bundleHostOf,
	type SchemaProvider,
} from "../toolchain/toolchain-adapters";
import {
	pipelineBundle,
	pipelineExamples,
	pipelineFunctionName,
	pipelineToolchainId,
} from "./pipeline-bundle";

export type PipelineCheck =
	| {
			ok: true;
			definition: import("../../domains/capabilities").PipelineDefinition;
	  }
	| { ok: false; issues: PipelineIssue[] };

/**
 * Checking, trying and publishing task pipelines (spec task-pipeline-design 2026-10-22 §7, §8.2, §13.2). A published
 * pipeline is a new revision of an ordinary data-driven toolchain; the candidates find it like any other.
 */
export function createPipelinesService(deps: {
	store: SqliteStore;
	capabilities: Capabilities;
	registry: AdapterRegistry;
	routing: ToolchainRoutingPort;
	schemas: SchemaProvider;
	/** Embeds the new revision's passages for the candidates (in the background). */
	refreshVectors?: () => Promise<void>;
}) {
	const { store, capabilities, routing, schemas } = deps;
	/** The registered toolchains a step may name, with an instant one's argument names. */
	function lookup(db: Database): ToolchainLookup {
		const catalog = routing.catalogInTransaction(db);
		return (id) => {
			const entry = catalog.find((e) => e.id === id);
			if (!entry) return null;
			const binding = capabilities.toolchainBindingInTransaction(
				db,
				entry.revisionId,
			)?.binding.document;
			if (binding?.execution !== "instant")
				return { execution: entry.runtime.execution };
			const schema = schemas.resolveInTransaction(
				db,
				binding.tools[0]!.inputSchemaRef,
			);
			const json = schema
				? (z.toJSONSchema(schema) as { properties?: Record<string, unknown> })
				: {};
			return {
				execution: "instant",
				arguments: Object.keys(json.properties ?? {}),
			};
		};
	}
	function checkInTransaction(db: Database, raw: unknown): PipelineCheck {
		const checked = checkPipeline(raw, lookup(db));
		if (!checked.ok) return checked;
		if (pipelineExamples(checked.value).length < 3)
			return {
				ok: false,
				issues: [{ pointer: "/useWhen", rule: "examples_required" }],
			};
		return { ok: true, definition: checked.value };
	}
	/** The published revision of a pipeline's toolchain, with its definition; null when none is published. */
	function publishedInTransaction(db: Database, toolchainId: string) {
		const active = capabilities
			.toolchainsInTransaction(db)
			.find((t) => t.id === toolchainId);
		const binding = active
			? capabilities.toolchainBindingInTransaction(db, active.revisionId)
					?.binding.document
			: undefined;
		return active && binding?.execution === "pipeline"
			? {
					toolchainRevisionId: active.revisionId,
					functionName: active.functionName!,
					revision: active.revision,
					title: active.title,
					definition: binding.pipeline,
				}
			: null;
	}
	/**
	 * Publishes the definition as the next revision of its toolchain, in the caller's transaction; an unchanged
	 * definition is left as it is. A bundle the registry would refuse comes back as findings, with nothing written.
	 */
	function publishInTransaction(db: Database, raw: unknown) {
		const checked = checkInTransaction(db, raw);
		if (!checked.ok) return checked;
		const d = checked.definition;
		const id = pipelineToolchainId(d);
		const current = publishedInTransaction(db, id);
		// The id may name a toolchain that is not a pipeline (the studio itself is `pipeline.studio`).
		if (
			!current &&
			capabilities.toolchainsInTransaction(db).some((t) => t.id === id)
		)
			return {
				ok: false as const,
				issues: [{ pointer: "/id", rule: "id_reserved" }],
			};
		if (current && JSON.stringify(current.definition) === JSON.stringify(d))
			return {
				ok: true as const,
				toolchainId: id,
				toolchainRevisionId: current.toolchainRevisionId,
				functionName: pipelineFunctionName(d),
				unchanged: true,
			};
		const revision =
			capabilities.latestRevisionInTransaction(db, "toolchain", id) + 1;
		const bundle = pipelineBundle(d, revision);
		const host = bundleHostOf(deps.registry);
		const dry = capabilities.importBundleInTransaction(db, bundle, host, {
			dryRun: true,
		});
		if (dry.issues.length)
			return {
				ok: false as const,
				issues: dry.issues.map((i) => ({
					pointer: `/bundle/${i.path}`,
					rule: i.code,
				})),
			};
		capabilities.importBundleInTransaction(db, bundle, host);
		pendingVectors = true;
		return {
			ok: true as const,
			toolchainId: id,
			toolchainRevisionId: `toolchain:${id}@${revision}`,
			functionName: pipelineFunctionName(d),
			unchanged: false,
		};
	}
	let pendingVectors = false;
	/** After a commit that published: embed the new revision's passages for the candidates. */
	function afterPublish() {
		if (!pendingVectors) return;
		pendingVectors = false;
		void deps.refreshVectors?.();
	}
	/**
	 * The toolchains a step may name, as the studio's agent reads them: id, title, purpose, how it runs, and an instant
	 * one's arguments. Sessions, tasks and other pipelines are left out (a step cannot hand to them).
	 */
	function stepToolchainsInTransaction(db: Database) {
		const look = lookup(db);
		const titles = new Map(
			capabilities.toolchainsInTransaction(db).map((d) => [d.id, d] as const),
		);
		return routing.catalogInTransaction(db).flatMap((e) => {
			const d = titles.get(e.id);
			const found = look(e.id);
			if (
				!d ||
				!found ||
				["session", "task", "pipeline"].includes(found.execution)
			)
				return [];
			return [
				{
					id: e.id,
					title: d.title,
					summary: d.summary.slice(0, 300),
					execution: found.execution,
					...(found.arguments ? { arguments: found.arguments } : {}),
				},
			];
		});
	}
	return {
		checkInTransaction,
		stepToolchainsInTransaction,
		publishedInTransaction,
		publishInTransaction,
		afterPublish,
		/** The published pipelines, for the studio's list. */
		historyInTransaction: (db: Database) =>
			routing
				.catalogInTransaction(db)
				.filter((e) => e.runtime.execution === "pipeline")
				.flatMap((e) => {
					const found = publishedInTransaction(db, e.id);
					return found
						? [
								{
									toolchainId: e.id,
									title: found.title,
									toolchainRevisionId: found.toolchainRevisionId,
								},
							]
						: [];
				}),
		check: (raw: unknown) => store.read((db) => checkInTransaction(db, raw)),
		/** One fixture case run without toolchains: what each step would get, and the expected values. */
		fixture(raw: unknown, index: number) {
			const checked = store.read((db) => checkInTransaction(db, raw));
			if (!checked.ok) return checked;
			if (!checked.definition.tests?.[index])
				return {
					ok: false as const,
					issues: [{ pointer: `/tests/${index}`, rule: "unknown_test" }],
				};
			return {
				ok: true as const,
				outcome: runFixture(checked.definition, index),
			};
		},
		async publish(raw: unknown) {
			const result = await store.write((db) => publishInTransaction(db, raw));
			afterPublish();
			return result;
		},
	};
}
export type PipelinesService = ReturnType<typeof createPipelinesService>;
