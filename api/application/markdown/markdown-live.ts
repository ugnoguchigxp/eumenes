/** Resident document API acceptance; no Desk start/lease/activity, no product DB mutation. */
import { mkdir, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readStoredLarm } from "../../domains/settings";
import { resolveLarmToken } from "../../infrastructure/auth-config";
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

const output = resolve("spec/verification/markdown-larm-documents-2026-11-07");
await mkdir(output, { recursive: true });
const result: Record<string, unknown> = {
	checkedAt: new Date().toISOString(),
	mode: process.argv.includes("--save") ? "live-file-api" : "read-only",
};
const signal = AbortSignal.timeout(240000);
let directory: string | undefined;
try {
	const { baseUrl } = readStoredLarm(
			process.env.EUMENES_DB || "./data/eumenes.sqlite3",
		),
		credential = resolveLarmToken(process.env);
	if (!baseUrl || !credential) throw new Error("live_connection_unconfigured");
	const state = async () => {
		const r = await fetch(new URL("/v1/local-services/docling-desk", baseUrl), {
			headers: { Authorization: `Bearer ${credential}` },
			signal,
			redirect: "error",
		});
		if (!r.ok) throw new Error("live_state_unavailable");
		return (await r.json()).state;
	};
	result.serviceBefore = await state();
	if (result.serviceBefore !== "stopped")
		throw new Error("docling_not_stopped_no_state_change_performed");
	let drop = false,
		putCount = 0,
		pause: {
			started: ReturnType<typeof Promise.withResolvers<void>>;
			release: ReturnType<typeof Promise.withResolvers<void>>;
		} | null = null;
	const docling = createDocling({
		connection: () => null,
		status: () => ({ revision: 0, configured: false, publicOrigin: null }),
		fileConnection: () => ({ baseUrl, credential }),
		fetch: async (url, init) => {
			if (init.method === "PUT") putCount++;
			const r = await fetch(url, init);
			if (init.method === "PUT" && pause) {
				const p = pause;
				pause = null;
				p.started.resolve();
				await p.release.promise;
			}
			if (init.method === "PUT" && drop) {
				drop = false;
				await r.body?.cancel();
				throw new Error("simulated_response_loss_after_live_put");
			}
			return r;
		},
	});
	const archive = markdownArchive(docling),
		caps = await archive.capabilities(signal),
		page = await archive.list(signal);
	Object.assign(result, {
		capabilities: caps,
		namespaces: page.namespaces,
		listing: true,
	});
	if (process.argv.includes("--save")) {
		directory = await mkdtemp(join(tmpdir(), "eumenes-markdown-live-"));
		const store = openStore(join(directory, "work.sqlite"), [
				...queueMigrations,
				...migrations,
			]),
			queue = createQueue(store),
			service = createMarkdown({ store, queue, archive });
		try {
			const title = `文書API接続検証 ${new Date().toISOString()}`;
			const raw = "\uFEFF# 日本語の保存検証\r\n\r\n末尾の空白  \r\n";
			const document: EditorDocument = {
				formatVersion: 1,
				nodes: [
					{ type: "h1", children: [{ text: "日本語の保存検証" }] },
					{
						type: "p",
						align: "center",
						children: [
							{
								text: "装飾と原文を保持",
								bold: true,
								color: "#267d70",
								fontSize: "24px",
							},
						],
					},
				],
				originalMarkdown: raw,
			};
			const invoke = (operation: string, input: unknown) =>
				store.write((db) =>
					service.invokeInTransaction(
						db,
						operation,
						input,
						crypto.randomUUID(),
					),
				);
			const view = (id: string) =>
				store.read((db) => service.viewInTransaction(db, id));
			async function create(name: string) {
				const { id: stageId } = await service.stage({
					document,
					markdown: raw,
				});
				return (await invoke("markdown.new.v2", { title: name, stageId }))
					.documentId;
			}
			async function apply(id: string, text: string) {
				const current = view(id),
					doc = structuredClone(current.document);
				doc.nodes.push({ type: "p", children: [{ text }] });
				const { id: stageId } = await service.stage({ document: doc });
				return invoke("markdown.apply.v2", {
					documentId: id,
					expectedRevision: current.revision,
					title: current.title,
					stageId,
				});
			}
			async function enqueue(id: string, markdown: string) {
				const current = view(id);
				const { id: stageId } = await service.stage({
					document: current.document,
					markdown,
				});
				await invoke("markdown.archive", {
					documentId: id,
					expectedRevision: current.revision,
					stageId,
				});
				await queue.tick();
			}
			const settled = (id: string) =>
				waitFor(() => view(id).saveState !== "saving", { timeout: 70000 });
			const control = await create(title + " 対照文書");
			await enqueue(control, raw);
			await settled(control);
			if (view(control).saveState !== "saved")
				throw new Error("live_control_save_failed");
			const beforeControl = await archive.read(view(control).sourceId!, signal);
			const localId = await create(title);
			await enqueue(localId, raw);
			await settled(localId);
			if (view(localId).saveState !== "saved")
				throw new Error("live_create_failed");
			const remoteId = view(localId).sourceId!,
				first = await archive.read(remoteId, signal);
			if (first.markdown !== raw || first.recovery !== JSON.stringify(document))
				throw new Error("live_exact_roundtrip_failed");
			await service.open(remoteId, signal);
			await apply(localId, "同じ文書への更新");
			const secondMarkdown = raw + "\r\n同じ文書への更新  \r\n";
			drop = true;
			const beforeLost = putCount;
			await enqueue(localId, secondMarkdown);
			await settled(localId);
			if (view(localId).saveState !== "saved" || putCount !== beforeLost + 1)
				throw new Error("live_lost_response_confirmation_failed");
			const second = await archive.read(remoteId, signal);
			if (
				second.markdown !== secondMarkdown ||
				second.recovery !== JSON.stringify(view(localId).document)
			)
				throw new Error("live_update_roundtrip_failed");
			const external = await docling.documents.put(
				remoteId,
				{
					markdown: secondMarkdown + "\r\n外の編集\r\n",
					recovery: second.recovery,
				},
				{ kind: "update", etag: second.entry.revision },
				signal,
			);
			await apply(localId, "手元に残す編集");
			const localBefore = JSON.stringify(view(localId).document);
			await enqueue(localId, secondMarkdown + "\r\n手元に残す編集\r\n");
			await settled(localId);
			if (
				view(localId).saveState !== "conflict" ||
				JSON.stringify(view(localId).document) !== localBefore
			)
				throw new Error("live_conflict_retention_failed");
			await service.resolve(localId, view(localId).revision, external.etag);
			const gate = {
				started: Promise.withResolvers<void>(),
				release: Promise.withResolvers<void>(),
			};
			pause = gate;
			await enqueue(localId, secondMarkdown + "\r\n手元に残す編集\r\n");
			await gate.started.promise;
			await apply(localId, "保存中の追加編集");
			gate.release.resolve();
			await settled(localId);
			if (
				view(localId).saveState !== "saved" ||
				!view(localId).dirty ||
				JSON.stringify(view(localId).document) === localBefore
			)
				throw new Error("live_newer_typing_failed");
			const afterControl = await archive.read(view(control).sourceId!, signal);
			if (JSON.stringify(beforeControl) !== JSON.stringify(afterControl))
				throw new Error("live_other_document_changed");
			Object.assign(result, {
				remoteId,
				controlId: view(control).sourceId,
				putCount,
				exactMarkdown: true,
				exactRecovery: true,
				exactOriginal: true,
				sameDocument: true,
				otherDocumentUnchanged: true,
				lostResponseConfirmedWithoutResend: true,
				staleEtagRejectedAndLocalRetained: true,
				explicitConflictResolution: true,
				newerTypingRemainsUnsaved: true,
			});
		} finally {
			await queue.close(20);
			await store.close();
		}
	}
	result.serviceAfter = await state();
	if (result.serviceAfter !== "stopped")
		throw new Error("docling_state_changed");
	result.ok = true;
} catch (e) {
	result.ok = false;
	result.error =
		e instanceof Error && /^[a-z_]+$/.test(e.message)
			? e.message
			: "live_check_failed";
} finally {
	if (directory) await rm(directory, { recursive: true, force: true });
}
await writeFile(
	join(output, "live.json"),
	JSON.stringify(result, null, 2) + "\n",
);
console.log(JSON.stringify(result));
if (!result.ok) process.exitCode = 1;
