import { parseMusicSelection } from "./creation-selection";
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { EumenesClient } from "../../../../client";
import {
	definitionRequests,
	parseDefinition,
	type Snapshot,
	type ArtifactEvent,
	type Receipt,
} from "@eumenes/artifact-ui/contracts";
import { queryRoots } from "../../queryKeys";
import { useMusicCreation } from "./use-music-creation";
import { useMusicArtworkUrl } from "./use-music-artwork";
import { musicStudioSource } from "./artifact-definition";
import { useMusicAutoplay } from "./use-music-autoplay";

export function useMusicRuntime(
	client: EumenesClient,
	conversationId: string,
	definition: string,
	targetRef?: string,
	setTargetRef?: (ref: string | undefined) => void,
) {
	const cache = useQueryClient();
	const waitingForCreation = useRef(false);
	const query = useQuery({
		queryKey: [queryRoots.music, "list", conversationId],
		queryFn: ({ signal }) => client.musicList(conversationId, signal),
		refetchInterval: (query) =>
			waitingForCreation.current ||
			query.state.data?.some(
				(item) =>
					item.state === "planning" ||
					item.state === "generating" ||
					item.artwork?.state === "generating",
			)
				? 1000
				: false,
	});
	const providers = useQuery({
		queryKey: [queryRoots.music, "providers"],
		queryFn: ({ signal }) => client.musicProviders(signal),
		retry: false,
	});
	const items = query.data ?? [];
	const sources = (() => {
		try {
			return new Set(
				definitionRequests(parseDefinition(definition)).map((r) => r.source),
			);
		} catch {
			return new Set<string>();
		}
	})();
	const legacy = items.find(
		(item) =>
			sources.has(`music-${item.id}`) || sources.has(`generation-${item.id}`),
	);
	const studio = sources.has(musicStudioSource);
	const authorized = studio || !!legacy;
	const targetMissing =
		!!targetRef &&
		!query.isPending &&
		!items.some((item) => item.id === targetRef);
	const initial = studio
		? targetRef
			? items.find((item) => item.id === targetRef)
			: items.reduce<(typeof items)[number] | undefined>(
					(latest, item) =>
						!latest || item.createdAt > latest.createdAt ? item : latest,
					undefined,
				)
		: legacy;
	const source = studio ? musicStudioSource : `music-${legacy?.id}`;
	const creation = useMusicCreation(client, conversationId, items, initial);
	useEffect(() => {
		waitingForCreation.current = creation.busy;
	}, [creation.busy]);
	const [selected, setSelected] = useState<{ id: string; latestId?: string }>();
	const selectedItem =
		authorized && !targetMissing
			? targetRef
				? initial
				: (items.find(
						(item) =>
							selected?.latestId === initial?.id && item.id === selected?.id,
					) ??
					creation.submitted ??
					initial)
			: undefined;
	const [audio, setAudio] = useState<{ id: string; url: string }>();
	const [audioError, setAudioError] = useState<string>();
	const seen = useRef(new Set<string>());
	const operation = useRef(false);
	const id = selectedItem?.id;
	const ready = selectedItem?.state === "completed";
	useMusicAutoplay(conversationId, query.data, id, audio?.id);
	useEffect(() => {
		if (!id || !ready) return;
		const controller = new AbortController();
		let url: string | undefined;
		void client
			.musicAudio(id, controller.signal)
			.then((blob) => {
				if (controller.signal.aborted) return;
				url = URL.createObjectURL(blob);
				setAudio({ id, url });
				setAudioError(undefined);
			})
			.catch(() => {
				if (!controller.signal.aborted) setAudioError(id);
			});
		return () => {
			controller.abort();
			if (url) URL.revokeObjectURL(url);
		};
	}, [client, id, ready]);
	const artworkRevision =
		selectedItem?.artwork?.state === "completed"
			? selectedItem.artwork.revision
			: undefined;
	const artwork = useMusicArtworkUrl(client, id, artworkRevision);
	const snapshot: Record<string, Snapshot[string]> = {};
	if (authorized) {
		const revision =
			Math.max(0, ...items.map((item) => item.updatedAt)) + creation.revision;
		const url = audio && audio.id === id ? audio.url : undefined;
		snapshot[source] = {
			kind: "music",
			revision,
			currentId: selectedItem?.id ?? "",
			canArtwork: true,
			creation:
				audioError && audioError === id
					? {
							...creation.creation,
							status: "failed",
							title: "音声を取得できませんでした",
						}
					: {
							...creation.creation,
							models: providers.data?.providers.flatMap((p) => p.models ?? []),
						},
			tracks: items.map((item) => ({
				id: item.id,
				title: item.title,
				subtitle: item.description,
				prompt: item.prompt ?? undefined,
				model: item.actualModel ?? undefined,
				lyrics: item.lyrics,
				instrumental: item.instrumental,
				task: item.task,
				runtime: item.runtime,
				createdAt: new Date(item.createdAt).toISOString(),
				durationSeconds: item.durationSeconds ?? undefined,
				disabled: item.state !== "completed",
				url: item.id === id ? url : undefined,
				artworkStatus:
					item.id === id && artwork?.failed ? "failed" : item.artwork?.state,
				artworkUrl: item.id === id ? artwork?.url : undefined,
				downloadName: `${item.title}.${item.mime === "audio/ogg" ? "opus" : item.mime === "audio/mpeg" ? "mp3" : item.mime === "audio/flac" ? "flac" : "wav"}`,
			})),
		};
		if (legacy && selectedItem)
			snapshot[`generation-${legacy.id}`] = {
				kind: "generation",
				revision,
				status:
					audioError === id
						? "failed"
						: ready
							? url
								? "completed"
								: "running"
							: selectedItem.state === "planning"
								? "pending"
								: selectedItem.state === "generating"
									? "running"
									: selectedItem.state,
				hidden: ready && !!url,
				title:
					audioError === id
						? "音声を取得できませんでした"
						: ready
							? "音声を読み込み中です"
							: selectedItem.state === "failed"
								? "楽曲を作成できませんでした"
								: selectedItem.state === "cancelled"
									? "楽曲の制作を取り消しました"
									: "楽曲を生成しています",
				description:
					!ready && selectedItem.state === "planning"
						? "テーマから曲調を考えています。"
						: undefined,
			};
	}
	const dispatch = async (event: ArtifactEvent): Promise<Receipt> => {
		const resource = snapshot[event.source];
		if (
			!authorized ||
			event.source !== source ||
			resource?.kind !== "music" ||
			![
				"music-select",
				"music-generate",
				"music-cancel",
				"music-artwork",
			].includes(event.action)
		)
			return { status: "rejected", message: "許可されていない操作です。" };
		if (event.revision !== resource.revision)
			return { status: "conflict", message: "楽曲一覧を更新してください。" };
		if (seen.current.has(event.id))
			return { status: "duplicate", message: "選択済みです。" };
		if (event.action === "music-artwork") {
			const target = items.find(
				(item) =>
					item.id === event.values.id &&
					item.state === "completed" &&
					!!item.prompt &&
					item.artwork?.state !== "generating",
			);
			if (!target || operation.current)
				return {
					status: "rejected",
					message: "この楽曲のイメージは作成できません。",
				};
			seen.current.add(event.id);
			operation.current = true;
			try {
				await client.generateMusicArtwork(target.id);
				await cache.invalidateQueries({
					queryKey: [queryRoots.music, "list", conversationId],
				});
				return {
					status: "accepted",
					message: "イメージの作成を受け付けました。",
				};
			} catch {
				return {
					status: "rejected",
					message: "イメージの作成を受け付けられませんでした。",
				};
			} finally {
				operation.current = false;
			}
		}
		if (event.action !== "music-select") {
			if (operation.current)
				return { status: "rejected", message: "操作の受付を待っています。" };
			if (
				event.action === "music-generate" &&
				(creation.busy ||
					typeof event.values.prompt !== "string" ||
					!event.values.prompt.trim() ||
					event.values.prompt.length > 7600)
			)
				return {
					status: "rejected",
					message: "プロンプトと生成状態を確認してください。",
				};
			if (event.action === "music-cancel" && !resource.creation?.canCancel)
				return { status: "rejected", message: "取消できる生成がありません。" };
			seen.current.add(event.id);
			operation.current = true;
			try {
				if (event.action === "music-generate") {
					const { prompt, generation } = event.values;
					const input = parseMusicSelection(prompt, generation);
					if (input === null)
						return {
							status: "rejected",
							message: "用途・長さ・歌詞の指定を確認してください。",
						};
					await creation.generate(String(prompt), input);
					setSelected(undefined);
					setTargetRef?.(undefined);
				} else await creation.cancel();
				return { status: "accepted", message: "操作を受け付けました。" };
			} catch {
				return {
					status: "rejected",
					message:
						event.action === "music-generate"
							? "受付を確認できませんでした。同じ内容で再試行できます。"
							: "取消を確認できませんでした。状態を更新して再試行してください。",
				};
			} finally {
				operation.current = false;
			}
		}
		const target = items.find(
			(item) => item.id === event.values.id && item.state === "completed",
		);
		if (!target)
			return { status: "rejected", message: "この楽曲は再生できません。" };
		seen.current.add(event.id);
		setSelected({ id: target.id, latestId: initial?.id });
		if (targetRef) setTargetRef?.(target.id);
		return { status: "accepted", message: "楽曲を選択しました。" };
	};
	return {
		runtime: { snapshot, dispatch },
		loading: query.isPending,
		targetMissing,
		error:
			query.error ??
			(!query.isPending && !authorized
				? new Error("unauthorized_source")
				: null),
	};
}
