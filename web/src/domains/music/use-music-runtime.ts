import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { EumenesClient } from "../../../../client";
import {
	definitionRequests,
	parseDefinition,
	type Snapshot,
	type ArtifactEvent,
	type Receipt,
} from "@eumenes/artifact-ui/contracts";
import { queryRoots } from "../../queryKeys";

export function useMusicRuntime(
	client: EumenesClient,
	conversationId: string,
	definition: string,
) {
	const query = useQuery({
		queryKey: [queryRoots.music, "list", conversationId],
		queryFn: ({ signal }) => client.musicList(conversationId, signal),
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
	const initial = items.find(
		(item) =>
			sources.has(`music-${item.id}`) || sources.has(`generation-${item.id}`),
	);
	const [selected, setSelected] = useState<string>();
	const selectedItem = items.find((item) => item.id === selected) ?? initial;
	const [audio, setAudio] = useState<{ id: string; url: string }>();
	const [audioError, setAudioError] = useState<string>();
	const seen = useRef(new Set<string>());
	const id = selectedItem?.id;
	const ready = selectedItem?.state === "completed";
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
	const snapshot: Record<string, Snapshot[string]> = {};
	if (initial && selectedItem) {
		const revision = selectedItem.updatedAt;
		const url = audio && audio.id === id ? audio.url : undefined;
		snapshot[`music-${initial.id}`] = {
			kind: "music",
			revision,
			currentId: selectedItem.id,
			tracks: items.map((item) => ({
				id: item.id,
				title: item.title,
				subtitle: item.description,
				durationSeconds: item.durationSeconds ?? undefined,
				disabled: item.state !== "completed",
				url: item.id === id ? url : undefined,
				downloadName: `${item.title}.${item.mime === "audio/mpeg" ? "mp3" : item.mime === "audio/flac" ? "flac" : "wav"}`,
			})),
		};
		snapshot[`generation-${initial.id}`] = {
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
			!initial ||
			event.source !== `music-${initial.id}` ||
			resource?.kind !== "music" ||
			event.action !== "music-select"
		)
			return { status: "rejected", message: "許可されていない操作です。" };
		if (event.revision !== resource.revision)
			return { status: "conflict", message: "楽曲一覧を更新してください。" };
		if (seen.current.has(event.id))
			return { status: "duplicate", message: "選択済みです。" };
		const target = items.find(
			(item) => item.id === event.values.id && item.state === "completed",
		);
		if (!target)
			return { status: "rejected", message: "この楽曲は再生できません。" };
		seen.current.add(event.id);
		setSelected(target.id);
		return { status: "accepted", message: "楽曲を選択しました。" };
	};
	return {
		runtime: { snapshot, dispatch },
		loading: query.isPending,
		error: query.error,
	};
}
