import type { Database } from "bun:sqlite";
import { z } from "zod";
import { toolchainRuntimeOf } from "../../domains/capabilities";
import type {
	Capabilities,
	FixedDefinition,
	ToolchainCard,
} from "../../domains/capabilities";
import type { InstantRun } from "../../domains/dialogue/contracts/toolchains";
import type { AdapterRegistry } from "../../domains/tool-runtime";
import type { SchemaProvider } from "./toolchain-adapters";

/**
 * The host side of the instant-answer toolchains (binding execution "instant"): the arguments their
 * first-round function takes, and the run that turns a call into the adapter's answer.
 */
export function createInstantRouting(deps: {
	capabilities: Capabilities;
	registry: Pick<AdapterRegistry, "get">;
	schemas: SchemaProvider;
	/** Whether this toolchain can take a request now (its runtime and, when bound, its adapter). */
	fallbackAvailable: (db: Database, d: FixedDefinition) => boolean;
}) {
	const { capabilities, registry, schemas } = deps;
	return {
		/**
		 * An instant toolchain's card carries its function's arguments: the binding's tool schema, which the
		 * model's arguments are checked against. A card whose adapter is unavailable now is not offered. Other
		 * cards pass unchanged.
		 */
		card(db: Database, card: ToolchainCard): ToolchainCard[] {
			const found = capabilities.toolchainBindingInTransaction(
				db,
				card.revisionId,
			);
			const binding = found?.binding.document;
			card = {
				...card,
				execution: binding?.execution ?? toolchainRuntimeOf(card.id)?.execution,
			};
			if (binding?.execution !== "instant") return [card];
			const tool = binding.tools[0]!;
			const schema = schemas.resolveInTransaction(db, tool.inputSchemaRef);
			const adapter = registry.get(binding.adapterRef);
			if (!schema || !adapter?.instant) return [];
			const { $schema: _, ...json } = z.toJSONSchema(schema) as Record<
				string,
				unknown
			>;
			if (!adapter.availableInTransaction(db)) return [];
			return [
				{
					...card,
					instant: {
						parameters: json,
						parse(args) {
							const parsed = schema.safeParse(args);
							return parsed.success
								? { ok: true, value: parsed.data as Record<string, unknown> }
								: { ok: false };
						},
					},
				},
			];
		},
		/** The run of an instant toolchain revision; undefined for any other, or while its adapter is unavailable. */
		run(db: Database, revisionId: string): InstantRun | undefined {
			const found = capabilities.toolchainBindingInTransaction(db, revisionId);
			const binding = found?.binding.document;
			if (binding?.execution !== "instant") return undefined;
			const adapter = registry.get(binding.adapterRef);
			if (!adapter?.instant || !adapter.availableInTransaction(db))
				return undefined;
			const operation = binding.tools[0]!.operationId;
			const fallback = capabilities
				.toolchainsInTransaction(db)
				.find((d) => d.id === binding.fallbackToolchainId);
			return {
				run: (args, signal, context) =>
					adapter.instant!.run(operation, args, signal, context),
				fallback:
					fallback && deps.fallbackAvailable(db, fallback)
						? {
								toolchainId: fallback.id,
								revisionId: fallback.revisionId,
								functionName: fallback.functionName!,
							}
						: null,
			};
		},
	};
}
