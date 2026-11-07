import { z } from "zod";
import { sha256Hex } from "../../infrastructure/digest";
import type { DomainAdapter, AdapterResult } from "../../domains/tool-runtime";
import {
	newInput,
	applyInput,
	saveInput,
} from "../../domains/markdown/contracts";
import type { MarkdownService } from "../../domains/markdown";

export const MARKDOWN_ADAPTER_REF = "adapter:markdown@1";
const query = "query:markdown.workspace@1";
const operations = ["new", "apply", "archive"] as const;
export const markdownDomainSchemas = {
	"domain:markdown.new@2": newInput,
	"domain:markdown.apply@2": applyInput,
	"domain:markdown.archive@2": saveInput,
	"domain:markdown.receipt@1": z.strictObject({
		documentId: z.uuid(),
		revision: z.number().int().positive(),
		state: z.string(),
	}),
};
function input(
	name: (typeof operations)[number],
	raw: Record<string, unknown>,
) {
	if (name === "new") return { ok: true as const, value: raw };
	const n = raw.expectedRevision;
	if (typeof n !== "string" || !/^[0-9]{1,10}$/.test(n))
		return {
			ok: false as const,
			errors: [
				{ field: "expectedRevision", message: "文書の版を確認してください" },
			],
		};
	return { ok: true as const, value: { ...raw, expectedRevision: Number(n) } };
}
export const describeMarkdownAdapter = () => ({
	owner: "markdown",
	operations: new Map(
		operations.map((name) => [
			`markdown.${name}`,
			{ inputSchemaRef: `domain:markdown.${name}@2`, effect: "write" as const },
		]),
	),
	queries: new Set([query]),
	inputAdapters: new Map(
		operations.map((name) => [
			`input:markdown.${name}@1`,
			(raw: Record<string, unknown>) => input(name, raw),
		]),
	),
	projections: new Set<string>(),
	availability: "availability:markdown@1",
	workspaces: new Map([
		[
			"workspace:markdown.document@1",
			{ path: "document.json", mediaType: "application/json" },
		],
	]),
});
export function createMarkdownAdapter(service: MarkdownService): DomainAdapter {
	function result(
		value: { documentId: string; revision: number; state: string },
		requestId: string,
		replay = false,
	): AdapterResult {
		return {
			receipt: value,
			receiptRef: {
				owner: "markdown",
				operationId: requestId,
				digest: sha256Hex(JSON.stringify(value)),
			},
			resultRefs: [
				{
					owner: "markdown",
					kind: "markdown.document",
					id: value.documentId,
					revision: value.revision,
					schemaRef: "domain:markdown.receipt@1",
				},
			],
			replay,
			answerContext: { documentId: value.documentId, state: value.state },
		};
	}
	return {
		ref: MARKDOWN_ADAPTER_REF,
		describe: describeMarkdownAdapter,
		availableInTransaction: () => true,
		snapshotInTransaction: (db) => ({ items: service.listInTransaction(db) }),
		choicesInTransaction: (db, schema) =>
			schema === "schema:markdown-target@1"
				? service
						.listInTransaction(db)
						.map((item) => ({ ref: item.id, label: item.title }))
				: [],
		invokeInTransaction(db, request) {
			if (request.origin.kind !== "ui") throw new Error("origin_not_allowed");
			const replay = !!service.receiptInTransaction(db, request.requestId);
			return result(
				service.invokeInTransaction(
					db,
					request.operationName,
					request.input,
					request.requestId,
				),
				request.requestId,
				replay,
			);
		},
		readInTransaction(db, requestId) {
			const value = service.receiptInTransaction(db, requestId);
			return value ? result(value, requestId, true) : null;
		},
		sourceInTransaction(db, ref, targetRef, params) {
			if (ref !== query) return null;
			const parsed = z
				.strictObject({ workRef: z.string().optional() })
				.parse(params ?? {});
			const data = service.currentInTransaction(
				db,
				targetRef ?? undefined,
				parsed.workRef,
			);
			return { revision: data.revision, data };
		},
		targetInput: () => ({}),
		session: service.session,
		afterCommit: service.afterCommit,
	};
}
