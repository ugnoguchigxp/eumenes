import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
	ArtifactEvent,
	ObjectRecognitionResource,
	Receipt,
} from "@eumenes/artifact-ui/contracts";
import type { EumenesClient } from "../../../../client";
import {
	maxInputBytes,
	inputMime,
} from "../../../../api/domains/object-recognition/contracts";
import { recognitionSource } from "./source";
import { useRecognitionChatInbox } from "./chat-inbox";
import { queryRoots } from "../../queryKeys";
const finished = ["completed", "failed", "cancelled"];
const origins = new Set(["camera", "screen", "file"]);
export function useRecognitionRuntime(
	client: EumenesClient,
	conversationId = "main",
	/** Reports the still on screen, so a message can refer to it. */
	setTargetRef?: (ref: string | undefined) => void,
) {
	const cache = useQueryClient();
	const key = [queryRoots.objectRecognition, client.identity, conversationId];
	const records = useQuery({
		queryKey: key,
		queryFn: ({ signal }) => client.recognitionRecords(conversationId, signal),
		refetchInterval: (q) =>
			q.state.data?.some((r) =>
				["queued", "starting", "running", "cancelling"].includes(r.state),
			)
				? 1000
				: false,
	});
	const connection = useQuery({
		queryKey: [queryRoots.objectRecognition, client.identity, "connection"],
		queryFn: ({ signal }) => client.recognitionConnection(signal),
	});
	// The conversation's capture or "show this image" requests; polled only while this screen is open.
	const handoffs = useQuery({
		queryKey: [queryRoots.objectRecognition, client.identity, "handoffs"],
		queryFn: ({ signal }) => client.recognitionHandoffs(conversationId, signal),
		refetchInterval: 1500,
	});
	/** Requests being answered: handoff id → the record that answers it. */
	const [answering, setAnswering] = useState<ReadonlyMap<string, string>>(
		new Map(),
	);
	const answer = (handoffId: string, recognitionId: string) =>
		setAnswering((m) => new Map(m).set(handoffId, recognitionId));
	const sending = useRef(new Set<string>());
	const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
	const pushChatImage = useRecognitionChatInbox((s) => s.push);
	const [selection, setSelection] = useState<string>();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const uploadLock = useRef(false);
	const viewEpoch = useRef(0);
	const items = records.data ?? [];
	const selected = items.find((i) => i.id === selection) ?? items[0];
	const content = useQuery({
		queryKey: [
			queryRoots.objectRecognition,
			client.identity,
			"content",
			selected?.id,
		],
		enabled: !!selected,
		queryFn: ({ signal }) => client.recognitionContent(selected!.id, signal),
		retry: false,
	});
	const [url, setUrl] = useState<{ id: string; value: string }>();
	const selectedId = selected?.id;
	useEffect(() => {
		if (!content.data || !selectedId) return;
		const value = URL.createObjectURL(content.data);
		let active = true;
		queueMicrotask(() => {
			if (active) setUrl({ id: selectedId, value });
		});
		return () => {
			active = false;
			URL.revokeObjectURL(value);
		};
	}, [content.data, selectedId]);
	const selectedImage = selected?.mime.startsWith("image/")
		? selected.id
		: undefined;
	useEffect(() => {
		setTargetRef?.(selectedImage);
	}, [selectedImage, setTargetRef]);
	const pending = (handoffs.data ?? []).filter(
		(h) => !dismissed.has(h.id) && !answering.has(h.id),
	);
	const capture = pending.find((h) => h.source !== "saved");
	useEffect(() => {
		for (const h of handoffs.data ?? [])
			if (h.source === "saved" && h.recognitionId && !dismissed.has(h.id))
				setAnswering((m) =>
					m.has(h.id) ? m : new Map(m).set(h.id, h.recognitionId!),
				);
	}, [handoffs.data, dismissed]);
	// Once the answering still's detection ended (even unsuccessfully), it goes to the conversation.
	const refetchHandoffs = handoffs.refetch;
	useEffect(() => {
		for (const [handoffId, recognitionId] of answering) {
			const r = items.find((i) => i.id === recognitionId);
			if (!r || !finished.includes(r.state) || sending.current.has(handoffId))
				continue;
			sending.current.add(handoffId);
			const saved = (handoffs.data ?? []).some(
				(h) => h.id === handoffId && h.source === "saved",
			);
			void client
				.recognitionHandoffSend(handoffId, saved ? undefined : recognitionId)
				.then(async () => {
					await cache.invalidateQueries({ queryKey: [queryRoots.conversation] });
					await cache.invalidateQueries({ queryKey: [queryRoots.dialogue] });
				})
				.catch(() =>
					setError(
						"撮影した画像を会話に送れませんでした。もう一度依頼してください。",
					),
				)
				.finally(() => {
					setDismissed((d) => new Set(d).add(handoffId));
					setAnswering((m) => {
						const next = new Map(m);
						next.delete(handoffId);
						return next;
					});
					sending.current.delete(handoffId);
					void refetchHandoffs();
				});
		}
	}, [answering, items, handoffs.data, client, cache, refetchHandoffs]);
	const revision =
		items.reduce((sum, r) => sum + r.revision + 1, 0) +
		(connection.data?.revision ?? 0) +
		(capture ? 1 : 0);
	const resource: ObjectRecognitionResource = {
		kind: "object-recognition-workspace",
		revision,
		items,
		selectedId: selected?.id,
		mediaUrl: url?.id === selected?.id ? url?.value : undefined,
		configured: !!connection.data?.credentialConfigured,
		credentialSource: connection.data?.credentialSource,
		sharedCredentialAvailable: connection.data?.sharedCredentialAvailable,
		hasEndpoint: !!connection.data?.baseUrl,
		...(capture && capture.source !== "saved"
			? {
					handoff: {
						id: capture.id,
						source: capture.source,
						question: capture.question,
					},
				}
			: {}),
		busy,
		error:
			error ||
			(records.error || connection.error
				? "情報を取得できません。接続を確認し、更新してください。"
				: content.error
					? "元の画像・動画を取得できませんでした。"
					: undefined),
	};
	async function refresh() {
		await records.refetch();
		await connection.refetch();
	}
	async function uploadFile(
		source: string,
		file: File,
		context?: Readonly<Record<string, string>>,
	): Promise<Receipt> {
		const origin = (
			context?.origin && origins.has(context.origin) ? context.origin : "file"
		) as "camera" | "screen" | "file";
		const handoffId = context?.handoffId;
		if (source !== recognitionSource || uploadLock.current)
			return { status: "rejected", message: "入力を受け付けられません。" };
		if (
			!inputMime.safeParse(file.type).success ||
			!file.size ||
			file.size > maxInputBytes
		) {
			setError(
				"JPEG・PNG・WebP・MP4・MOV・WebMの16 MiB以内のファイルを選んでください。",
			);
			return {
				status: "rejected",
				message: "形式または容量が上限と一致しません。",
			};
		}
		uploadLock.current = true;
		setBusy(true);
		setError("");
		const requestId = crypto.randomUUID();
		const epoch = ++viewEpoch.current;
		try {
			const r = await client.recognitionUpload(
				file,
				conversationId,
				requestId,
				origin,
			);
			if (handoffId) answer(handoffId, r.id);
			if (viewEpoch.current === epoch) setSelection(r.id);
			await records.refetch();
			return { status: "accepted", message: "解析を受け付けました。" };
		} catch {
			// The durable request id lets the user reconnect without replaying the analyze POST.
			const r = await client.recognitionGet(requestId).catch(() => null);
			if (r) {
				if (handoffId) answer(handoffId, r.id);
				if (viewEpoch.current === epoch) setSelection(r.id);
				await records.refetch();
				return {
					status: "accepted",
					message: "保存済みの受付に復帰しました。",
				};
			}
			setError(
				"受付を確認できませんでした。backendの接続状態を確認してください。自動再送はしていません。",
			);
			return { status: "rejected", message: "受付未確認" };
		} finally {
			uploadLock.current = false;
			setBusy(false);
		}
	}
	async function dispatch(event: ArtifactEvent): Promise<Receipt> {
		if (event.source !== recognitionSource || event.revision !== revision)
			return {
				status: "conflict",
				message: "結果が更新されました。もう一度操作してください。",
			};
		if (event.action === "recognition-refresh") {
			await refresh();
			return { status: "accepted", message: "更新しました。" };
		}
		if (event.action === "recognition-credential-source") {
			const source = event.values.credentialSource;
			if (
				(source !== "dedicated" && source !== "larm") ||
				!connection.data?.baseUrl
			)
				return {
					status: "rejected",
					message: "backendの接続先を設定してください。",
				};
			if (source === "larm" && !connection.data.sharedCredentialAvailable)
				return {
					status: "rejected",
					message: "LARMの共有credentialがbackendに設定されていません。",
				};
			await client.configureRecognitionConnection({
				expectedRevision: connection.data.revision,
				credentialSource: source,
			});
			await connection.refetch();
			return {
				status: "accepted",
				message:
					source === "larm"
						? "LARMの共有credentialを参照します。"
						: "保存した専用credentialを参照します。",
			};
		}

		const id = typeof event.values.id === "string" ? event.values.id : "";
		if (event.action === "recognition-handoff-cancel") {
			setDismissed((d) => new Set(d).add(id));
			await client.recognitionHandoffCancel(id).catch(() => null);
			await handoffs.refetch();
			return { status: "accepted", message: "撮影を取りやめました。" };
		}
		if (!items.some((i) => i.id === id))
			return { status: "rejected", message: "資料が見つかりません。" };
		if (event.action === "recognition-select") {
			viewEpoch.current++;
			setSelection(id);
		} else if (event.action === "recognition-cancel") {
			await client.recognitionCancel(id);
			await records.refetch();
		} else if (event.action === "recognition-recheck") {
			await client.recognitionRecheck(id);
			await records.refetch();
		} else if (event.action === "recognition-remove") {
			await client.recognitionRemove(id);
			cache.removeQueries({
				queryKey: [
					queryRoots.objectRecognition,
					client.identity,
					"content",
					id,
				],
			});
			await records.refetch();
		} else if (event.action === "recognition-incorporate") {
			const attachment = await client.recognitionAttach(id, event.id);
			const preview = await client.attachmentPreview(
				conversationId,
				attachment.id,
			);
			pushChatImage({
				attachment,
				file: new File([preview], attachment.name, { type: preview.type }),
			});
			return {
				status: "accepted",
				message: "画像と検出結果をチャット欄に添付しました。",
			};
		} else return { status: "rejected", message: "未対応の操作です。" };
		return { status: "accepted", message: "操作を受け付けました。" };
	}
	return {
		loading: records.isPending || connection.isPending,
		refresh,
		runtime: {
			snapshot: { [recognitionSource]: resource },
			dispatch,
			uploadFile,
		},
	};
}
