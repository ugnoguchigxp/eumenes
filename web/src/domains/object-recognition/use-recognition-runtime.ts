import { useVisualAnalysis } from "../../hooks/use-visual-analysis";
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
import { useRecognitionHandoffs } from "./use-recognition-handoffs";
import { queryRoots } from "../../queryKeys";
import { useCaptureSave } from "./use-capture-save";
import {
	imageContentUrl,
	useImageLibrary,
} from "../../media/use-image-library";
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
			q.state.data?.some(
				(r) =>
					["queued", "starting", "running", "cancelling"].includes(r.state) ||
					r.captureSave === "queued",
			)
				? 1000
				: false,
	});
	const connection = useQuery({
		queryKey: [queryRoots.objectRecognition, client.identity, "connection"],
		queryFn: ({ signal }) => client.recognitionConnection(signal),
	});
	const library = useImageLibrary(client);
	const pushChatImage = useRecognitionChatInbox((s) => s.push);
	const [selection, setSelection] = useState<string>();
	const [selectedFrame, setFrame] = useState<{ id: string; index: number }>();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const uploadLock = useRef(false);
	const viewEpoch = useRef(0);
	const items = records.data ?? [];
	const selected = items.find((i) => i.id === selection);
	const captureSave = useCaptureSave(client, selected, items);
	const frameIndex =
		selectedFrame?.id === selected?.id ? (selectedFrame?.index ?? 0) : 0;
	const analyses = useVisualAnalysis(
		client,
		"object-recognition",
		conversationId,
		selected,
		frameIndex,
	);
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
	const handoffs = useRecognitionHandoffs(
		client,
		conversationId,
		items,
		setError,
	);
	const capture = handoffs.capture;
	const revision =
		items.reduce((sum, r) => sum + r.revision + 1, 0) +
		(connection.data?.revision ?? 0) +
		(capture ? 1 : 0) +
		analyses.revision +
		frameIndex;
	const resource: ObjectRecognitionResource = {
		kind: "object-recognition-workspace",
		frameIndex,
		...analyses.resource,
		revision,
		items,
		...libraryResource(library),
		selectedId: selected?.id,
		captureSaveStatus: captureSave.status,
		captureSaveCanResume: captureSave.canResume,
		mediaUrl: url?.id === selected?.id ? url?.value : undefined,
		configured: !!connection.data?.credentialConfigured,
		credentialSource: connection.data?.credentialSource,
		sharedCredentialAvailable: connection.data?.sharedCredentialAvailable,
		hasEndpoint: !!connection.data?.baseUrl,
		...(capture
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
		await analyses.refresh();
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
		if (!validInput(file)) {
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
				handoffId,
			);
			if (handoffId) handoffs.answer(handoffId, r.id);
			if (viewEpoch.current === epoch) setSelection(r.id);
			await records.refetch();
			return { status: "accepted", message: "解析を受け付けました。" };
		} catch {
			// The durable request id lets the user reconnect without replaying the analyze POST.
			const r = await client.recognitionGet(requestId).catch(() => null);
			if (r) {
				if (handoffId) handoffs.answer(handoffId, r.id);
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
		if (event.action.startsWith("analysis-")) return analyses.dispatch(event);
		if (event.action === "recognition-frame") {
			const index = Number(event.values.index);
			if (
				event.values.id !== selected?.id ||
				selected?.result?.kind !== "video" ||
				!Number.isInteger(index) ||
				!selected.result.frames[index]
			)
				return { status: "rejected", message: "時刻を選び直してください。" };
			setFrame({ id: selected.id, index });
			return { status: "accepted", message: "時刻を選びました。" };
		}
		if (event.source !== recognitionSource || event.revision !== revision)
			return {
				status: "conflict",
				message: "結果が更新されました。もう一度操作してください。",
			};
		if (event.action === "recognition-refresh") {
			await refresh();
			return { status: "accepted", message: "更新しました。" };
		}
		if (
			event.action === "recognition-save-recheck" ||
			event.action === "recognition-save-resume"
		) {
			if (
				!selected ||
				event.values.id !== selected.id ||
				selected.captureSave !== "unconfirmed"
			)
				return { status: "rejected", message: "資料を選び直してください。" };
			if (event.action === "recognition-save-recheck")
				return captureSave.recheck();
			const result = await captureSave.resume();
			if (result.status === "accepted") await records.refetch();
			return result;
		}
		if (
			event.action === "recognition-library-refresh" ||
			event.action === "recognition-library-select"
		)
			return handleLibrary(event, {
				library,
				client,
				uploadFile,
				uploadLock,
				viewEpoch,
				setBusy,
				setError,
			});
		if (event.action === "recognition-credential-source")
			return changeCredentialSource(
				client,
				connection.data,
				event.values.credentialSource,
				connection.refetch,
			);

		const id = typeof event.values.id === "string" ? event.values.id : "";
		if (event.action === "recognition-handoff-cancel") {
			await handoffs.cancel(id);
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

function validInput(file: File) {
	return (
		inputMime.safeParse(file.type).success &&
		file.size > 0 &&
		file.size <= maxInputBytes
	);
}

function libraryResource(library: ReturnType<typeof useImageLibrary>) {
	return {
		libraryImages: (library.data?.images ?? [])
			.slice()
			.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
			.map((image) => ({
				id: image.id,
				title: `画像 ${image.createdAt.slice(0, 10)}（${image.width}×${image.height}）`,
				thumbnailUrl: imageContentUrl(image.id),
			})),
		libraryLoading: library.isPending,
		libraryError: library.error
			? "保存画像を取得できませんでした。一覧を更新してください。"
			: undefined,
	};
}

async function handleLibrary(
	event: ArtifactEvent,
	deps: {
		library: ReturnType<typeof useImageLibrary>;
		client: EumenesClient;
		uploadFile: (source: string, file: File) => Promise<Receipt>;
		uploadLock: { current: boolean };
		viewEpoch: { current: number };
		setBusy: (value: boolean) => void;
		setError: (value: string) => void;
	},
): Promise<Receipt> {
	if (event.action === "recognition-library-refresh") {
		await deps.library.refetch();
		return { status: "accepted", message: "画像一覧を更新しました。" };
	}
	const id = event.values.id;
	if (
		typeof id !== "string" ||
		!deps.library.data?.images.some((image) => image.id === id) ||
		deps.uploadLock.current
	)
		return { status: "rejected", message: "画像を選び直してください。" };
	const epoch = ++deps.viewEpoch.current;
	deps.setBusy(true);
	deps.setError("");
	try {
		const blob = await deps.client.imageContent(id);
		if (deps.viewEpoch.current !== epoch)
			return { status: "rejected", message: "表示が変更されました。" };
		return await deps.uploadFile(
			recognitionSource,
			new File([blob], `image.${blob.type.split("/")[1] || "image"}`, {
				type: blob.type,
			}),
		);
	} catch {
		deps.setError("保存画像を取得できませんでした。一覧を更新してください。");
		return { status: "rejected", message: "保存画像を取得できませんでした。" };
	} finally {
		deps.setBusy(false);
	}
}

async function changeCredentialSource(
	client: EumenesClient,
	connection:
		| Awaited<ReturnType<EumenesClient["recognitionConnection"]>>
		| undefined,
	source: unknown,
	refetch: () => Promise<unknown>,
): Promise<Receipt> {
	if ((source !== "dedicated" && source !== "larm") || !connection?.baseUrl)
		return {
			status: "rejected",
			message: "backendの接続先を設定してください。",
		};
	if (source === "larm" && !connection.sharedCredentialAvailable)
		return {
			status: "rejected",
			message: "LARMの共有credentialがbackendに設定されていません。",
		};
	await client.configureRecognitionConnection({
		expectedRevision: connection.revision,
		credentialSource: source,
	});
	await refetch();
	return {
		status: "accepted",
		message:
			source === "larm"
				? "LARMの共有credentialを参照します。"
				: "保存した専用credentialを参照します。",
	};
}
