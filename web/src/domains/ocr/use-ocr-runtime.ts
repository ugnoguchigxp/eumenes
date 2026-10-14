import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
	ArtifactEvent,
	OcrResource,
	Receipt,
} from "@eumenes/artifact-ui/contracts";
import type { EumenesClient } from "../../../../client";
import { ApiError } from "../../../../client/transport";
import {
	maxInputBytes,
	inputMime,
} from "../../../../api/domains/ocr/contracts";
import { queryRoots } from "../../queryKeys";
import { ocrSource } from "./source";
import { ocrThumbnail } from "./thumbnail";
function incorporationError(cause: unknown): Receipt {
	if (cause instanceof ApiError && cause.message === "ocr_text_too_large")
		return {
			status: "rejected",
			message: "会話に追加できる長さを超えました。行を選んで追加してください。",
		};
	throw cause;
}
export function useOcrRuntime(client: EumenesClient, conversationId = "main") {
	const cache = useQueryClient();
	const key = [queryRoots.ocr, client.identity, conversationId];
	const records = useQuery({
		queryKey: key,
		queryFn: ({ signal }) => client.ocrRecords(conversationId, signal),
		refetchInterval: (q) =>
			q.state.data?.some((r) =>
				["queued", "starting", "running", "cancelling"].includes(r.state),
			)
				? 1000
				: false,
	});
	const connection = useQuery({
		queryKey: [queryRoots.ocr, client.identity, "connection"],
		queryFn: ({ signal }) => client.ocrConnection(signal),
	});
	const [selection, setSelection] = useState<string>();
	const [frameIndex, setFrameIndex] = useState(0);
	const [selectedLines, setSelectedLines] = useState<number[]>([]);
	const [busy, setBusy] = useState(false);
	const [recording, setRecording] = useState(false);
	const [error, setError] = useState("");
	const uploadLock = useRef(false);
	const viewEpoch = useRef(0);
	const items = records.data ?? [];
	const selected = items.find((i) => i.id === selection) ?? items[0];
	const selectedId = selected?.id;
	const content = useQuery({
		queryKey: [queryRoots.ocr, client.identity, "content", selectedId],
		enabled: !!selectedId,
		queryFn: ({ signal }) => client.ocrContent(selectedId!, signal),
		retry: false,
	});
	const [url, setUrl] = useState<{ id: string; value: string }>();
	const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
	const thumbnailUrls = useRef<Record<string, string>>({});
	const thumbnailPending = useRef(new Set<string>());
	const thumbnailRemoved = useRef(new Set<string>());
	const thumbnailActive = useRef(true);
	useEffect(() => {
		thumbnailActive.current = true;
		return () => {
			thumbnailActive.current = false;
			Object.values(thumbnailUrls.current).forEach((value) =>
				URL.revokeObjectURL(value),
			);
			thumbnailUrls.current = {};
		};
	}, []);
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
	const revision =
		items.reduce((sum, r) => sum + r.revision + 1, 0) +
		(connection.data?.revision ?? 0) +
		frameIndex +
		(recording ? 1 : 0) +
		selectedLines.reduce((sum, i) => sum + i + 1, 0);
	const resource: OcrResource = {
		kind: "ocr-workspace",
		revision,
		items,
		selectedId,
		mediaUrl: url?.id === selectedId ? url?.value : undefined,
		thumbnails,
		frameIndex,
		selectedLines,
		busy,
		recording,
		configured: !!connection.data?.credentialConfigured,
		connectionRevision: connection.data?.revision ?? 0,
		baseUrl: connection.data?.baseUrl ?? null,
		error:
			error ||
			(records.error || connection.error
				? "情報を取得できません。接続を確認してください。"
				: content.error
					? "原本を取得できませんでした。"
					: undefined),
	};
	async function refresh() {
		await Promise.all([records.refetch(), connection.refetch()]);
	}
	async function uploadFile(source: string, file: File): Promise<Receipt> {
		if (source !== ocrSource || uploadLock.current)
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
			const r = await client.ocrUpload(file, conversationId, requestId);
			if (viewEpoch.current === epoch) {
				setSelection(r.id);
				setFrameIndex(0);
				setSelectedLines([]);
			}
			await records.refetch();
			return { status: "accepted", message: "解析を受け付けました。" };
		} catch {
			const r = await client.ocrGet(requestId).catch(() => null);
			if (r) {
				if (viewEpoch.current === epoch) setSelection(r.id);
				await records.refetch();
				return {
					status: "accepted",
					message: "保存済みの受付に復帰しました。",
				};
			}
			setError("受付を確認できませんでした。自動再送はしていません。");
			return { status: "rejected", message: "受付未確認" };
		} finally {
			uploadLock.current = false;
			setBusy(false);
		}
	}
	async function dispatch(event: ArtifactEvent): Promise<Receipt> {
		if (event.source !== ocrSource)
			return { status: "rejected", message: "対象が見つかりません。" };
		if (event.action === "ocr-thumbnail") {
			const id = typeof event.values.id === "string" ? event.values.id : "";
			if (!items.some((item) => item.id === id))
				return { status: "rejected", message: "資料が見つかりません。" };
			if (thumbnailUrls.current[id] || thumbnailPending.current.has(id))
				return { status: "accepted", message: "" };
			thumbnailPending.current.add(id);
			try {
				const blob =
					id === selectedId && content.data
						? content.data
						: await client.ocrContent(id);
				const value = await ocrThumbnail(blob);
				if (value) {
					if (!thumbnailActive.current || thumbnailRemoved.current.has(id))
						URL.revokeObjectURL(value);
					else {
						thumbnailUrls.current[id] = value;
						setThumbnails({ ...thumbnailUrls.current });
					}
				}
			} finally {
				thumbnailPending.current.delete(id);
			}
			return { status: "accepted", message: "" };
		}
		if (event.revision !== revision)
			return {
				status: "conflict",
				message: "結果が更新されました。もう一度操作してください。",
			};
		if (event.action === "ocr-recording") {
			setRecording(event.values.recording === true);
			return { status: "accepted", message: "" };
		}
		if (event.action === "ocr-refresh") {
			await refresh();
			return { status: "accepted", message: "更新しました。" };
		}
		if (event.action === "ocr-configure") {
			const baseUrl = event.values.baseUrl;
			if (typeof baseUrl !== "string")
				return { status: "rejected", message: "接続先を確認してください。" };
			await client.configureOcrConnection({
				expectedRevision: connection.data?.revision ?? 0,
				baseUrl,
			});
			await connection.refetch();
			return { status: "accepted", message: "接続先を保存しました。" };
		}
		const id = typeof event.values.id === "string" ? event.values.id : "";
		if (["ocr-frame", "ocr-line"].includes(event.action)) {
			const index = Number(event.values.index);
			if (
				id !== selectedId ||
				!selected ||
				!Number.isInteger(index) ||
				index < 0
			)
				return { status: "rejected", message: "対象を選び直してください。" };
			if (event.action === "ocr-frame") {
				if (
					selected.result?.kind !== "video" ||
					index >= selected.result.frames.length
				)
					return { status: "rejected", message: "時刻を選び直してください。" };
				setFrameIndex(index);
				setSelectedLines([]);
			} else {
				const lines =
					selected.result?.kind === "image"
						? selected.result.lines
						: selected.result?.kind === "video"
							? selected.result.frames[frameIndex]?.lines
							: undefined;
				if (!lines || index >= lines.length)
					return { status: "rejected", message: "行を選び直してください。" };
				setSelectedLines((previous) =>
					previous.includes(index)
						? previous.filter((i) => i !== index)
						: [...previous, index].sort((a, b) => a - b),
				);
			}
			return { status: "accepted", message: "選択しました。" };
		}
		if (!items.some((i) => i.id === id))
			return { status: "rejected", message: "資料が見つかりません。" };
		if (event.action === "ocr-select") {
			viewEpoch.current++;
			setSelection(id);
			setFrameIndex(0);
			setSelectedLines([]);
		} else if (event.action === "ocr-cancel") {
			await client.ocrCancel(id);
			await records.refetch();
		} else if (event.action === "ocr-recheck") {
			await client.ocrRecheck(id);
			await records.refetch();
		} else if (event.action === "ocr-remove") {
			await client.ocrRemove(id);
			thumbnailRemoved.current.add(id);
			const thumbnail = thumbnailUrls.current[id];
			if (thumbnail) {
				URL.revokeObjectURL(thumbnail);
				delete thumbnailUrls.current[id];
				setThumbnails({ ...thumbnailUrls.current });
			}
			cache.removeQueries({
				queryKey: [queryRoots.ocr, client.identity, "content", id],
			});
			if (selection === id) {
				setSelection(undefined);
				setFrameIndex(0);
				setSelectedLines([]);
			}
			await records.refetch();
		} else if (event.action === "ocr-incorporate") {
			if (id !== selectedId)
				return { status: "rejected", message: "対象を選び直してください。" };
			const index =
				event.values.frameIndex === ""
					? undefined
					: Number(event.values.frameIndex);
			const lineValue = event.values.lineIndexes;
			const lineIndexes =
				typeof lineValue === "string" && lineValue
					? lineValue.split(",").map(Number)
					: undefined;
			if (
				index !== undefined &&
				(!Number.isInteger(index) || index < 0 || index > 59)
			)
				return { status: "rejected", message: "時刻を選び直してください。" };
			try {
				await client.ocrIncorporate(id, event.id, index, lineIndexes);
			} catch (cause) {
				return incorporationError(cause);
			}
			await Promise.all([
				cache.invalidateQueries({ queryKey: [queryRoots.conversation] }),
				cache.invalidateQueries({ queryKey: [queryRoots.dialogue] }),
			]);
			return { status: "accepted", message: "原文を会話に追加しました。" };
		} else return { status: "rejected", message: "未対応の操作です。" };
		return { status: "accepted", message: "操作を受け付けました。" };
	}
	return {
		loading: records.isPending || connection.isPending,
		refresh,
		runtime: { snapshot: { [ocrSource]: resource }, dispatch, uploadFile },
	};
}
