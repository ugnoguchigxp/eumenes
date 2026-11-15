import { useEffect, useState } from "react";
import type { EumenesClient } from "../../../client";
import type { DebugDiagnosticDetail } from "../../../api/domains/dialogue/contracts";
import { ErrorReportButton } from "./ErrorReportDialog";

export function DebugDiagnostic({
	client,
	entry,
	conversationId,
}: {
	client: EumenesClient;
	entry: Omit<DebugDiagnosticDetail, "observation">;
	conversationId: string;
}) {
	const [expired, setExpired] = useState(entry.expiresAt <= Date.now());
	useEffect(() => {
		const timer = setTimeout(
			() => setExpired(true),
			Math.max(0, entry.expiresAt - Date.now()),
		);
		return () => clearTimeout(timer);
	}, [entry.expiresAt]);
	if (expired) return null;
	const heading = "デバッグ診断";
	const summary = entry.summary ?? "診断を生成できませんでした。";
	return (
		<aside className="agency-thought" aria-label={heading}>
			<p>
				{heading}　{summary}
			</p>
			<ErrorReportButton
				heading={heading}
				summary={summary}
				label="デバッグ診断の詳細"
				load={async (signal) => ({
					text: (
						await client.debugDiagnosticDetail(conversationId, entry.id, signal)
					).observation,
				})}
			/>
		</aside>
	);
}
