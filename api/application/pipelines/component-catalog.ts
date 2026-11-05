import type { Database } from "bun:sqlite";
import type { ComponentRecord } from "eumenes-pipeline";
import type { TaskExecutionHost } from "../toolchain/task-execution-port";
import type { ExecutionSource } from "../../domains/tool-runtime";
import type { TaskChildContext } from "../toolchain/task-execution-catalog";
/** Public cards and host evidence only; command receipts are not completed-output schemas. */
export function pipelineComponents(
	host: TaskExecutionHost,
	context: TaskChildContext,
	db: Database,
	source: ExecutionSource,
): ComponentRecord[] {
	return context
		.available(db, source.runId)
		.filter(
			(e) =>
				!["session", "read", "task", "pipeline"].includes(e.runtime.execution),
		)
		.flatMap((e) => {
			const publicCard = host.routing.cardInTransaction(db, e.revisionId);
			if (!publicCard) return [];
			const set = host.capabilities.toolchainSetInTransaction(db, e.revisionId),
				bound = host.capabilities.toolchainBindingInTransaction(
					db,
					e.revisionId,
				),
				binding = bound?.binding.document;
			const instant =
				binding?.execution === "instant" ? binding.tools[0] : undefined;
			const args = publicCard.instant?.parameters;
			return [
				{
					card: {
						entry: e.id,
						bundle: e.id,
						title: set.toolchain.title,
						summary: set.toolchain.summary,
						useWhen: set.toolchain.useWhen,
						avoidWhen: set.toolchain.avoidWhen,
						...(args ? { arguments: args } : {}),
						output: { schemaRef: null, origin: "missing" },
						effects: ["read", "write"],
						mayAskUser: true,
					},
					execution:
						binding?.execution === "instant"
							? "instant"
							: binding?.execution === "command"
								? "command"
								: "unbound",
					enabled: true,
					support: "partial",
					reasons: [
						"completed output is host-confirmed; no public completed-result schema",
					],
					evidence: {
						toolchainRevisionId: e.revisionId,
						definitionHash: set.toolchain.hash,
						packageRevisionId: set.package.revisionId,
						bindingRevisionId: bound?.binding.revisionId ?? null,
						bindingDigest: bound?.binding.digest ?? null,
						adapterRef: binding?.adapterRef ?? null,
						bundleSource: binding ? "binding-document" : null,
						toolRevisionIds: set.tools.map((t) => t.revisionId),
						inputSchemaRefs: instant ? [instant.inputSchemaRef] : [],
						outputSchemaRef: null,
						inputOrigin: instant ? "catalog" : "missing",
					},
				},
			];
		});
}
