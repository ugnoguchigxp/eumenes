import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { EumenesClient } from "../../../../client";
import { describeError } from "../../errorMessages";
import { videoQueryKey } from "./admission";

export function useVideoMedia(client: EumenesClient, id: string | undefined) {
	const metadata = useQuery({
		queryKey: [...videoQueryKey(client), "metadata", id],
		queryFn: ({ signal }) => client.videoMetadata(id!, signal),
		enabled: !!id,
		retry: false,
	});
	const [media, setMedia] = useState<{
		id: string;
		url?: string;
		error?: string;
	}>();
	useEffect(() => {
		if (!id) return;
		const controller = new AbortController();
		let url: string | undefined;
		void client.videoContent(id, controller.signal).then(
			(blob) => {
				if (controller.signal.aborted) return;
				url = URL.createObjectURL(blob);
				setMedia({ id, url });
			},
			(error) => {
				if (!controller.signal.aborted)
					setMedia({ id, error: describeError(error) });
			},
		);
		return () => {
			controller.abort();
			if (url) URL.revokeObjectURL(url);
			setMedia(undefined);
		};
	}, [client, id]);
	const data = metadata.data;
	const details = data && [
		{
			label: "プロンプト",
			value: data.request?.prompt ?? "取得できませんでした",
		},
		{
			label: "出力",
			value: `${data.width} × ${data.height} · ${data.durationSeconds}秒 · ${data.fps} fps · ${data.frames} フレーム`,
		},
		{ label: "ステップ / シード", value: `${data.steps} / ${data.seed}` },
		{ label: "モデル", value: `${data.model} · ${data.quantization}` },
		{ label: "モデル revision", value: data.modelRevision },
		{ label: "エンジン SHA-256", value: data.engineSha256 },
		{ label: "動画 SHA-256", value: data.sha256 },
		{
			label: "ファイルサイズ",
			value: `${data.bytes.toLocaleString("ja-JP")} バイト`,
		},
	];
	const current = media?.id === id ? media : undefined;
	return {
		url: current?.url,
		loading: !current,
		error:
			current?.error ??
			(metadata.error ? describeError(metadata.error) : undefined),
		details,
	};
}
