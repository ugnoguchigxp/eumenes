import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type {
	ArtifactEvent,
	Receipt,
	VideoWorkspaceResource,
} from "@eumenes/artifact-ui/contracts";
import { ApiError } from "../../../../client/transport";
import {
	videoInput,
	type VideoInput,
	type VideoRequestView,
} from "../../../../api/domains/video/contracts";
import { describeError } from "../../errorMessages";
import type { WebArtifactAdapter } from "../toolchain-artifacts/registry";
import { videoAdmissionMessage, videoQueryKey } from "./admission";
import { useVideoMedia } from "./use-video-media";

const numberField = (value: string | boolean | undefined) =>
	typeof value === "string" && value !== "" ? Number(value) : undefined;

type Pending = { id: string; input: VideoInput };
function readPending(key: string): Pending | undefined {
	try {
		const saved = JSON.parse(sessionStorage.getItem(key) ?? "null");
		if (saved && typeof saved.id === "string")
			return { id: saved.id, input: videoInput.parse(saved.input) };
	} catch {}
}
function jobView(
	request: VideoRequestView | null | undefined,
): VideoWorkspaceResource["job"] {
	if (!request) return undefined;
	const { job, state, title, errorCode } = request;
	const active = job?.status === "queued" || job?.status === "running";
	const label =
		state === "submitting"
			? "受付を確認中"
			: state === "unconfirmed"
				? "状態を確認できません"
				: job?.status === "completed"
					? "動画が完成しました"
					: job?.status === "cancelled"
						? "生成を取り消しました"
						: job?.phase === "stopping" && active
							? "ワーカーの停止を確認中"
							: job?.status === "queued"
								? "受け付けました。起動を待っています"
								: job?.phase === "starting" && active
									? "モデルを起動中"
									: active
										? "動画を生成中"
										: "動画を生成できませんでした";
	return {
		title: title ? `${label} · ${title}` : label,
		status:
			state === "submitting"
				? "queued"
				: state === "unconfirmed"
					? "failed"
					: (job?.status ?? "failed"),
		message: errorCode ? describeError(errorCode) : undefined,
		cancellable: active && job?.phase !== "stopping",
		reconcilable: state === "unconfirmed",
	};
}

export const videoWebAdapter: WebArtifactAdapter = {
	adapterRef: "adapter:video@1",
	useArtifact({ client, visible }) {
		const cache = useQueryClient();
		const root = videoQueryKey(client);
		const key = `eumenes:video:pending:${client.identity}`;
		const [pending, setPending] = useState<Pending | undefined>(() =>
			readPending(key),
		);
		const [busy, setBusy] = useState(false);
		const lock = useRef(false);
		const [operationError, setOperationError] = useState<string>();
		const [selection, setSelection] = useState<string>();
		const service = useQuery({
			queryKey: [...root, "service"],
			queryFn: ({ signal }) => client.videoService(signal),
			retry: false,
		});
		const workspace = useQuery({
			queryKey: [...root, "workspace"],
			queryFn: ({ signal }) => client.videoWorkspace(signal),
			refetchInterval: visible ? 3000 : false,
		});
		const list = useQuery({
			queryKey: [...root, "list"],
			queryFn: ({ signal }) => client.videoList(signal),
			retry: false,
		});
		const current = workspace.data?.request;
		const completedId =
			current?.job?.status === "completed" ? current.job.result?.id : undefined;
		const { refetch: refetchList } = list;
		useEffect(() => {
			if (completedId) void refetchList();
		}, [completedId, refetchList]);
		useEffect(() => {
			if (pending && current?.id === pending.id) {
				sessionStorage.removeItem(key);
				setPending(undefined);
			}
		}, [key, pending, current?.id]);
		const videos = list.data?.videos ?? [];
		const selected =
			videos.find((v) => v.id === (selection ?? completedId)) ??
			(selection === undefined ? videos[0] : undefined);
		const media = useVideoMedia(client, visible ? selected?.id : undefined);
		const state = workspace.data?.admission.state;
		function refresh() {
			void cache.invalidateQueries({ queryKey: root });
		}
		function retain(record: Pending | undefined) {
			if (record) sessionStorage.setItem(key, JSON.stringify(record));
			else sessionStorage.removeItem(key);
			setPending(record);
		}
		async function send(record: Pending) {
			retain(record);
			try {
				await client.generateVideo(record.id, record.input);
				retain(undefined);
			} catch (error) {
				if (error instanceof ApiError && error.status < 500) retain(undefined);
				throw error;
			}
		}
		async function local(event: ArtifactEvent): Promise<Receipt> {
			if (lock.current) return { status: "rejected", message: "操作中です。" };
			lock.current = true;
			setBusy(true);
			setOperationError(undefined);
			try {
				const id = event.values.id;
				switch (event.action) {
					case "video-generate": {
						if (pending) throw new Error("video_acceptance_unconfirmed");
						const input = videoInput.safeParse({
							prompt: event.values.prompt,
							title: event.values.title,
							seed:
								typeof event.values.seed === "string"
									? Number(event.values.seed)
									: undefined,
							width: numberField(event.values.width),
							height: numberField(event.values.height),
							durationSeconds: numberField(event.values.durationSeconds),
						});
						if (!input.success) throw new Error("invalid_video_request");
						await send({ id: event.id, input: input.data });
						setSelection(undefined);
						break;
					}
					case "video-reconcile":
						if (pending) await send(pending);
						else if (current?.state === "unconfirmed")
							await client.reconcileVideo(current.id);
						break;
					case "video-cancel":
						if (current && jobView(current)?.cancellable)
							await client.cancelVideo(current.id);
						break;
					case "video-select":
						if (typeof id === "string" && videos.some((v) => v.id === id))
							setSelection(id);
						return { status: "accepted", message: "" };
					case "video-delete":
						if (typeof id !== "string" || selected?.id !== id)
							throw new Error("video_not_found");
						await client.deleteVideo(id);
						setSelection("");
						break;
					case "video-refresh":
						break;
					default:
						return {
							status: "rejected",
							message: "この操作は利用できません。",
						};
				}
				return { status: "accepted", message: "" };
			} catch (error) {
				const message = describeError(error);
				setOperationError(message);
				return { status: "rejected", message };
			} finally {
				lock.current = false;
				setBusy(false);
				if (event.action !== "video-select") refresh();
			}
		}
		const resource: VideoWorkspaceResource = {
			kind: "video-workspace",
			revision: current?.revision ?? 0,
			model: service.data?.model,
			options: service.data?.options,
			canGenerate:
				!!service.data &&
				!!workspace.data &&
				!pending &&
				state !== "active" &&
				state !== "unconfirmed",
			pending: busy,
			retrySubmission: !!pending,
			admission: videoAdmissionMessage(state),
			error:
				operationError ??
				(workspace.error || service.error || list.error
					? describeError(workspace.error ?? service.error ?? list.error)
					: undefined),
			job: jobView(current),
			loading: list.isPending,
			videos: videos.map((v) => ({
				id: v.id,
				title: v.title,
				label: `${new Date(v.createdAt).toLocaleDateString("ja-JP")} · ${v.durationSeconds}秒`,
				previewSrc: `/api/videos/${encodeURIComponent(v.id)}/content`,
			})),
			selected: selected
				? {
						...media,
						id: selected.id,
						title: selected.title,
						label: `${selected.durationSeconds}秒 · 音声付きMP4`,
					}
				: undefined,
		};
		return {
			phase: { kind: "ready" },
			snapshot: { video: resource },
			targetOf: () => undefined,
			local: (_binding, event) => local(event),
			settled: () => {},
			refresh,
		};
	},
};
