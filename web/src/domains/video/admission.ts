import { useQuery } from "@tanstack/react-query";
import type { EumenesClient } from "../../../../client";
import type { VideoAdmission } from "../../../../api/domains/video/contracts";

export const videoQueryKey = (client: EumenesClient) =>
	["video", client.identity] as const;

export function useVideoAdmission(client: EumenesClient) {
	return useQuery({
		queryKey: [...videoQueryKey(client), "admission"],
		queryFn: ({ signal }) => client.videoAdmission(signal),
		refetchInterval: 3000,
		retry: false,
	});
}

export function videoAdmissionMessage(
	state: VideoAdmission["state"] | undefined,
) {
	switch (state) {
		case "active":
			return "動画処理中は、会話推論・画像・楽曲・3D・計算などの新規処理を開始できません。状態確認・取消・保存済み作品の閲覧はできます。";
		case "unconfirmed":
			return "動画処理の状態を確認できていません。動画生成画面で同じ依頼の受付・状態を確認してください。";
		case "isolated":
			return "動画ワーカーの停止が確認できていません。LARMで新規処理の受付が制限されています。";
		default:
			return undefined;
	}
}
