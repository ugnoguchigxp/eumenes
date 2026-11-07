import { z } from "zod";
import { readBounded } from "../../../infrastructure/bounded-read";
import type { DoclingConnection } from "../contracts";
import type { DoclingFetch } from ".";

const article = z.object({
	id: z.string().min(1).max(200),
	namespace: z.string(),
	path: z.string(),
	title: z.string(),
	revision: z.string(),
});
export type WikiArticle = z.infer<typeof article>;
const namespace = "Eumenes";
/** The existing Desk Wiki API. Credentials and the gateway origin never leave the backend. */
export function createDoclingWiki(deps: {
	connection: () => DoclingConnection | null;
	fetch?: DoclingFetch;
}) {
	const fetcher = deps.fetch ?? fetch;
	function access() {
		const connection = deps.connection();
		if (!connection) throw new Error("docling_unconfigured");
		return connection;
	}
	async function request(
		connection: DoclingConnection,
		path: string,
		signal: AbortSignal,
		body?: FormData,
	) {
		if (signal.aborted || deps.connection()?.version !== connection.version)
			throw new Error("docling_connection_changed");
		const response = await fetcher(new URL(path, connection.gatewayUrl), {
			method: body ? "POST" : "GET",
			headers: {
				Authorization: `Bearer ${connection.credential}`,
				Host: "127.0.0.1:28765",
			},
			...(body ? { body } : {}),
			redirect: "manual",
			signal,
		});
		if (deps.connection()?.version !== connection.version || signal.aborted) {
			await response.body?.cancel();
			throw new Error("docling_connection_changed");
		}
		if (response.status !== (body ? 201 : 200)) {
			await response.body?.cancel();
			throw new Error(
				[401, 403].includes(response.status)
					? "docling_auth_failed"
					: "docling_document_failed",
			);
		}
		const text = new TextDecoder().decode(
			await readBounded(response.body, {
				limit: 2 * 1024 * 1024,
				missing: "docling_invalid_response",
				tooLarge: "docling_invalid_response",
				signal,
			}),
		);
		if (deps.connection()?.version !== connection.version)
			throw new Error("docling_connection_changed");
		return text;
	}
	async function catalog(connection: DoclingConnection, signal: AbortSignal) {
		const data = z
			.object({ articles: z.array(article) })
			.parse(
				JSON.parse(await request(connection, "/api/wiki/catalog", signal)),
			);
		return data.articles.filter(
			(entry) =>
				entry.namespace === namespace && /^[a-f0-9-]{36}\.md$/.test(entry.path),
		);
	}
	async function read(
		connection: DoclingConnection,
		sourceId: string,
		signal: AbortSignal,
	) {
		const found = (await catalog(connection, signal)).find(
			(entry) => entry.id === sourceId,
		);
		if (!found) throw new Error("docling_document_not_found");
		const text = await request(
			connection,
			`/api/wiki/sources/${encodeURIComponent(found.id)}/markdown`,
			signal,
		);
		return { article: found, text };
	}
	return {
		available: () => !!deps.connection(),
		binding: () => deps.connection()?.version ?? null,
		list: (signal: AbortSignal) => catalog(access(), signal),
		read: (sourceId: string, signal: AbortSignal) =>
			read(access(), sourceId, signal),
		async save(
			input: {
				documentId: string;
				title: string;
				text: string;
				sourceId: string | null;
				remoteRevision: string | null;
				binding: string;
			},
			signal: AbortSignal,
		) {
			const connection = access();
			if (connection.version !== input.binding)
				throw new Error("docling_connection_changed");
			if (
				!z.uuid().safeParse(input.documentId).success ||
				Buffer.byteLength(input.text) > 2 * 1024 * 1024
			)
				throw new Error("docling_document_invalid");
			const path = `${input.documentId}.md`;
			const existing = (await catalog(connection, signal)).find(
				(entry) => entry.path === path,
			);
			if (
				(existing?.id ?? null) !== input.sourceId ||
				(existing?.revision ?? null) !== input.remoteRevision
			)
				throw new Error("docling_document_conflict");
			const form = new FormData();
			form.set("namespace", namespace);
			form.append(
				"files",
				new File([input.text], path, { type: "text/markdown" }),
			);
			form.set(
				"manifest",
				new File(
					[
						JSON.stringify({
							articles: {
								[path]: { title: input.title, external_key: input.documentId },
							},
						}),
					],
					"manifest.json",
					{ type: "application/json" },
				),
			);
			let submitted = false;
			try {
				submitted = true;
				const response = z
					.object({ articles: z.array(article).length(1) })
					.parse(
						JSON.parse(
							await request(connection, "/api/wiki/import", signal, form),
						),
					);
				const accepted = response.articles[0]!;
				if (
					accepted.path !== path ||
					accepted.namespace !== namespace ||
					(input.sourceId && accepted.id !== input.sourceId)
				)
					throw new Error("docling_invalid_response");
				const verified = await read(connection, accepted.id, signal);
				if (verified.text !== input.text)
					throw new Error("docling_document_unconfirmed");
				return verified.article;
			} catch {
				// Reconcile a possibly accepted POST with GET only. Never repeat the import.
				if (
					submitted &&
					!signal.aborted &&
					deps.connection()?.version === connection.version
				) {
					try {
						const found = (await catalog(connection, signal)).find(
							(entry) => entry.path === path,
						);
						if (found) {
							const confirmed = await read(connection, found.id, signal);
							if (confirmed.text === input.text) return confirmed.article;
						}
					} catch {
						/* The original mutation remains unconfirmed. */
					}
				}
				throw new Error("docling_document_unconfirmed");
			}
		},
	};
}
export type DoclingWiki = ReturnType<typeof createDoclingWiki>;
