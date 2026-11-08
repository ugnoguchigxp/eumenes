import { z } from "zod";
import { createDocumentLibrary } from "./document-library";
import { sha256Hex } from "../../../infrastructure/digest";
import { readBounded } from "../../../infrastructure/bounded-read";
import {
	documentCapabilities,
	documentId,
	documentEtag,
	documentList,
	savedDocument,
	type DocumentCapabilities,
	type DocumentFileConnection,
	type DocumentCondition,
	type DocumentWrite,
} from "../contracts/documents";

import { DocumentFileError } from "./document-error";
export { DocumentFileError } from "./document-error";
const codes = new Set([
	"etag_mismatch",
	"path_exists",
	"save_outcome_unknown",
	"not_found",
	"unauthorized",
	"forbidden",
	"invalid_request",
	"payload_too_large",
	"unavailable",
	"wiki_api_retired",
	"document_not_found",
	"precondition_required",
	"storage_unavailable",
	"delete_outcome_unknown",
	"operation_outcome_unknown",
	"overlapping_selection",
	"invalid_destination",
	"folder_not_empty",
	"unsupported_items",
]);
export const documentDigests = (markdown: string, recovery: string) => {
	const markdownSha256 = sha256Hex(markdown),
		recoverySha256 = sha256Hex(recovery);
	return {
		markdownSha256,
		recoverySha256,
		contentDigest: sha256Hex(markdownSha256 + "\n" + recoverySha256),
	};
};
const text = (max: number) =>
	z
		.string()
		.refine(
			(v) =>
				Buffer.byteLength(v) <= max &&
				Buffer.from(v, "utf8").toString("utf8") === v,
		);
const title = text(4096).refine((v) => v.length > 0);
const path = text(2048).refine(
	(v) =>
		[...v].length <= 512 &&
		v === v.trim() &&
		!v.includes("\\") &&
		![...v].some((c) => c.codePointAt(0)! < 32 || c.codePointAt(0) === 127) &&
		/\.(md|markdown)$/.test(v) &&
		v.split("/").every((p) => p !== "" && p !== "." && p !== ".."),
);

/** Resident LARM file operations only. No prepare, connection, lease, activity or mutation retries. */
export function createDoclingDocuments(deps: {
	connection(): DocumentFileConnection | null;
	fetch?: (url: URL, init: RequestInit) => Promise<Response>;
	now?(): number;
}) {
	const fetcher = deps.fetch ?? fetch;
	const binding = () => {
		const c = deps.connection();
		return c ? sha256Hex(JSON.stringify([c.baseUrl, c.credential])) : null;
	};
	let cached: {
		binding: string;
		until: number;
		value: DocumentCapabilities;
	} | null = null;
	function access() {
		const connection = deps.connection(),
			key = binding();
		if (!connection || !key)
			throw new DocumentFileError("docling_unconfigured", 503);
		const base = new URL(connection.baseUrl);
		if (
			!["http:", "https:"].includes(base.protocol) ||
			base.username ||
			base.password
		)
			throw new DocumentFileError("docling_connection_invalid", 503);
		return { ...connection, binding: key };
	}
	type Access = ReturnType<typeof access>;
	function current(c: Access, signal: AbortSignal) {
		signal.throwIfAborted();
		if (binding() !== c.binding)
			throw new DocumentFileError("docling_connection_changed", 503);
	}
	async function bytes(r: Response, limit: number, signal: AbortSignal) {
		return readBounded(r.body, {
			limit,
			signal,
			missing: "docling_invalid_response",
			tooLarge: "docling_response_too_large",
		});
	}
	async function request(
		c: Access,
		endpoint: string,
		signal: AbortSignal,
		limit: number,
		init: RequestInit = {},
	) {
		current(c, signal);
		const mutation = !!init.method && !["GET", "HEAD"].includes(init.method);
		let response: Response;
		try {
			response = await fetcher(new URL(endpoint, c.baseUrl), {
				...init,
				signal,
				redirect: "error",
				headers: { ...init.headers, Authorization: `Bearer ${c.credential}` },
			});
		} catch {
			throw new DocumentFileError("docling_unreachable", null, mutation);
		}
		try {
			current(c, signal);
		} catch (error) {
			await response.body?.cancel();
			throw error;
		}
		if (!response.ok) {
			let code = "docling_upstream_failed";
			try {
				const v = JSON.parse(
					new TextDecoder().decode(await bytes(response, 16384, signal)),
				);
				if (codes.has(v?.error?.code)) code = v.error.code;
			} catch {
				await response.body?.cancel().catch(() => {});
			}
			throw new DocumentFileError(
				code,
				response.status,
				mutation && response.status >= 500,
			);
		}
		try {
			const value: unknown = JSON.parse(
				new TextDecoder("utf-8", { fatal: true }).decode(
					await bytes(response, limit, signal),
				),
			);
			current(c, signal);
			return { response, value };
		} catch (error) {
			if (error instanceof DocumentFileError) throw error;
			throw new DocumentFileError(
				"docling_invalid_response",
				response.status,
				mutation,
			);
		}
	}
	async function capabilities(signal: AbortSignal) {
		const c = access(),
			now = (deps.now ?? Date.now)();
		current(c, signal);
		if (cached?.binding === c.binding && cached.until > now)
			return cached.value;
		const { value } = await request(
			c,
			"/v1/docling/capabilities",
			signal,
			32768,
		);
		const parsed = documentCapabilities.safeParse(value);
		if (!parsed.success)
			throw new DocumentFileError("docling_contract_unsupported", 503);
		cached = { binding: c.binding, until: now + 60000, value: parsed.data };
		return parsed.data;
	}
	async function document(
		c: Access,
		endpoint: string,
		id: string,
		signal: AbortSignal,
		init?: RequestInit,
		expectedStatus = 200,
	) {
		const caps = await capabilities(signal);
		const limit = Math.min(
			Number.MAX_SAFE_INTEGER,
			6 * (caps.maxMarkdownBytes + caps.maxRecoveryBytes) + 65536,
		);
		const result = await request(c, endpoint, signal, limit, init);
		const parsed = savedDocument.safeParse(result.value),
			mutation = !!init?.method && !["GET", "HEAD"].includes(init.method);
		if (
			result.response.status !== expectedStatus ||
			!parsed.success ||
			parsed.data.id !== id ||
			result.response.headers.get("etag") !== parsed.data.etag ||
			Buffer.byteLength(parsed.data.markdown) > caps.maxMarkdownBytes ||
			Buffer.byteLength(parsed.data.recovery) > caps.maxRecoveryBytes
		)
			throw new DocumentFileError(
				"docling_invalid_response",
				result.response.status,
				mutation,
			);
		const digests = documentDigests(parsed.data.markdown, parsed.data.recovery);
		if (
			Object.entries(digests).some(
				([k, v]) => parsed.data[k as keyof typeof digests] !== v,
			)
		)
			throw new DocumentFileError(
				"docling_digest_mismatch",
				result.response.status,
				mutation,
			);
		return parsed.data;
	}
	return {
		...createDocumentLibrary({ access, capabilities, request, document }),
		available: () => !!deps.connection(),
		binding,
		capabilities,
		async list(signal: AbortSignal, cursor?: string) {
			const c = access(),
				caps = await capabilities(signal);
			const query = new URLSearchParams({
				limit: String(caps.maxPageSize),
				...(cursor ? { cursor } : {}),
			});
			const { value } = await request(
				c,
				`${caps.basePath}?${query}`,
				signal,
				4 * 1024 * 1024,
			);
			const parsed = documentList.safeParse(value);
			if (
				!parsed.success ||
				parsed.data.documents.length > caps.maxPageSize ||
				parsed.data.documents.some(
					(d) => !parsed.data.namespaces.includes(d.namespace),
				)
			)
				throw new DocumentFileError("docling_invalid_response", 502);
			return parsed.data;
		},
		async read(id: string, signal: AbortSignal) {
			if (!documentId.safeParse(id).success)
				throw new DocumentFileError("invalid_request", 400);
			const c = access(),
				caps = await capabilities(signal);
			return document(
				c,
				`${caps.basePath}/${encodeURIComponent(id)}`,
				id,
				signal,
			);
		},
		async put(
			id: string,
			input: DocumentWrite,
			condition: DocumentCondition,
			signal: AbortSignal,
			expectedBinding?: string,
		) {
			const c = access(),
				caps = await capabilities(signal);
			if (expectedBinding && expectedBinding !== c.binding)
				throw new DocumentFileError("docling_connection_changed", 503);
			const fields = {
				markdown: text(caps.maxMarkdownBytes),
				recovery: text(caps.maxRecoveryBytes),
			};
			const schema =
				condition.kind === "create"
					? z.strictObject({
							...fields,
							title,
							namespace: z.string().min(1),
							path,
						})
					: z.strictObject({ ...fields, title: title.optional() });
			if (
				!documentId.safeParse(id).success ||
				!schema.safeParse(input).success ||
				(condition.kind === "update" &&
					!documentEtag.safeParse(condition.etag).success)
			)
				throw new DocumentFileError("invalid_request", 400);
			const body = JSON.stringify(input);
			if (Buffer.byteLength(body) > caps.maxRequestBytes)
				throw new DocumentFileError("payload_too_large", 413);
			return document(
				c,
				`${caps.basePath}/${encodeURIComponent(id)}`,
				id,
				signal,
				{
					method: "PUT",
					body,
					headers: {
						"Content-Type": "application/json; charset=utf-8",
						...(condition.kind === "create"
							? { "If-None-Match": "*" }
							: { "If-Match": condition.etag }),
					},
				},
				condition.kind === "create" ? 201 : 200,
			);
		},
	};
}
export type DoclingDocuments = ReturnType<typeof createDoclingDocuments>;
