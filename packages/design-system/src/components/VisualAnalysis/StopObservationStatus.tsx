import type { VisualAnalysisRecord } from "./types";
export function StopObservationStatus({
	observation,
}: {
	observation: VisualAnalysisRecord["stopObservation"];
}) {
	if (!observation) return null;
	return (
		<p role="status">
			{observation.status === "observing"
				? "停止状態を確認中"
				: observation.status === "cold"
					? "停止確認（LARMの稼働状態: COLD）"
					: "停止未確認"}
			{observation.status === "unconfirmed" &&
				"。他の利用者が使用中の場合もあります。"}
		</p>
	);
}
