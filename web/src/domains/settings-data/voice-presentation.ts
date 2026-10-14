import type { EumenesClient } from "../../../../client";
import type { Settings } from "../../../../api/domains/settings/contracts";

export type VoiceCatalog = Awaited<ReturnType<EumenesClient["larmVoices"]>>;

export function serviceSummary(s: Settings, purpose: "tts" | "asr") {
	const route = s.routes[purpose];
	const resource = s.resources.find((r) => r.id === route.fallbackId);
	const cloud = resource
		? (s.connections.find((c) => c.id === resource.connectionId)?.name ??
				"登録モデル") +
			" / " +
			resource.model
		: "未割当";
	return (
		(route.mode === "cloud-only"
			? "クラウドのみ：" + cloud
			: route.mode === "larm-only"
				? "ローカルのみ"
				: !route.cloudAllowed
					? "ローカル優先。クラウドへの送信は許可していません"
					: "ローカル優先。切り替わったとき：" + cloud) +
		"。利用先・送信許可は「AIと接続」で変更します。"
	);
}
