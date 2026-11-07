/** Backend-only acceptance runner. Product settings are read through their public read-only operations. */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { readStoredLarm } from "../../domains/settings";
import {
	readApiToken,
	resolveLarmToken,
} from "../../infrastructure/auth-config";
import { createDocling } from "../../domains/docling";
import {
	createMarkdown,
	migrations,
	type EditorDocument,
} from "../../domains/markdown";
import {
	createQueue,
	migrations as queueMigrations,
} from "../../domains/queue";
import { openStore } from "../../infrastructure/sqlite";
import { waitFor } from "../../infrastructure/wait-for";
import { markdownArchive } from "./markdown-composition";

const output = resolve("verification-reports/markdown-full-bundle-2026-11-07");
await mkdir(output, { recursive: true });
const result: Record<string, unknown> = {
	checkedAt: new Date().toISOString(),
	mode: process.argv.includes("--save") ? "save-and-reopen" : "read-only",
};
const signal = AbortSignal.timeout(240000);
try {
	const saved = readStoredLarm(
			process.env.EUMENES_DB || "./data/eumenes.sqlite3",
		),
		credential = resolveLarmToken(process.env);
	if (!saved.baseUrl || !credential)
		throw new Error("live_connection_unconfigured");
	const get = async (url: string, token: string) => {
		const r = await fetch(url, {
			headers: { Authorization: `Bearer ${token}` },
			signal,
			redirect: "manual",
		});
		if (!r.ok) {
			await r.body?.cancel();
			throw new Error("live_read_unavailable");
		}
		return r.json();
	};
	const state = await get(
		new URL("/v1/local-services/docling-desk", saved.baseUrl).href,
		credential,
	);
	result.serviceState = state.state;
	if (state.state !== "running")
		throw new Error("docling_must_already_be_running");
	const config = await get(
		"http://127.0.0.1:8787/api/settings/docling",
		readApiToken(process.env),
	);
	if (!config.gatewayUrl || !config.publicOrigin)
		throw new Error("docling_unconfigured");
	const connection = {
		revision: config.revision,
		version: `${saved.baseUrl}:${config.revision}:${createHash("sha256").update(credential).digest("hex")}`,
		gatewayUrl: config.gatewayUrl,
		publicOrigin: config.publicOrigin,
		credential,
	};
	const docling = createDocling({
		connection: () => connection,
		status: () => ({
			revision: config.revision,
			configured: true,
			publicOrigin: config.publicOrigin,
		}),
	});
	const archive = markdownArchive(docling);
	await archive.list(signal);
	result.catalogRead = true;
	if (process.argv.includes("--save")) {
		const store = openStore(
				resolve(output, `live-${crypto.randomUUID()}.sqlite3`),
				[...queueMigrations, ...migrations],
			),
			queue = createQueue(store),
			service = createMarkdown({ store, queue, archive });
		try {
			const document: EditorDocument = {
				formatVersion: 1,
				nodes: [
					{ type: "h1", children: [{ text: "文書エディタの保存検証" }] },
					{
						type: "p",
						align: "center",
						children: [
							{
								text: "日本語と装飾をDocling Deskに保存します。",
								bold: true,
								color: "#267d70",
								fontSize: "24px",
							},
						],
					},
				],
				originalMarkdown: "# 原文\r\n\r\n日本語入力  \r\n",
			};
			let stageId = (await service.stage({ document })).id;
			const created = await store.write((db) =>
				service.invokeInTransaction(
					db,
					"markdown.new",
					{ title: "文書エディタの保存検証", stageId },
					crypto.randomUUID(),
				),
			);
			const view = () =>
				store.read((db) => service.viewInTransaction(db, created.documentId));
			async function save(markdown: string) {
				const frozen = view();
				stageId = (await service.stage({ document: frozen.document, markdown }))
					.id;
				await store.write((db) =>
					service.invokeInTransaction(
						db,
						"markdown.archive",
						{
							documentId: frozen.id,
							expectedRevision: frozen.revision,
							stageId,
						},
						crypto.randomUUID(),
					),
				);
				await queue.tick();
				await waitFor(() => view().saveState !== "saving", { timeout: 70000 });
				if (view().saveState !== "saved")
					throw new Error("live_save_unconfirmed");
			}
			await save(
				"# 文書エディタの保存検証\n\n**日本語と装飾をDocling Deskに保存します。**\n",
			);
			const sourceId = view().sourceId;
			document.nodes.push({
				type: "p",
				children: [{ text: "同じ文書への更新を確認しました。" }],
			});
			stageId = (await service.stage({ document })).id;
			await store.write((db) =>
				service.invokeInTransaction(
					db,
					"markdown.apply",
					{
						documentId: created.documentId,
						title: "文書エディタの保存検証",
						expectedRevision: view().revision,
						stageId,
					},
					crypto.randomUUID(),
				),
			);
			await save(
				"# 文書エディタの保存検証\n\n**日本語と装飾をDocling Deskに保存します。**\n\n同じ文書への更新を確認しました。\n",
			);
			const restored = await service.open(sourceId!, signal);
			if (
				restored.sourceId !== sourceId ||
				JSON.stringify(restored.document) !== JSON.stringify(document)
			)
				throw new Error("live_roundtrip_mismatch");
			Object.assign(result, {
				documentId: created.documentId,
				sourceId,
				saves: 2,
				sameArticle: true,
				exactEditorData: true,
				exactOriginal: true,
				reopened: true,
			});
		} finally {
			await queue.close(20);
			await store.close();
		}
	}
	result.ok = true;
} catch (error) {
	result.ok = false;
	result.error =
		error instanceof Error && /^[a-z_]+$/.test(error.message)
			? error.message
			: "live_check_failed";
}
await writeFile(
	resolve(output, "live.json"),
	JSON.stringify(result, null, 2) + "\n",
);
console.log(JSON.stringify(result));
if (!result.ok) process.exitCode = 1;
