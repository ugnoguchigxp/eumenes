import { useLayoutEffect, useState } from "react";
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
	const key = `${entry.id}:${entry.expiresAt}`;
	const [hidden, setHidden] = useState<string | null>(null);
	const expired = hidden === key;
	useLayoutEffect(() => {
		const remaining = entry.expiresAt - Date.now();
		if (remaining <= 0) {
			// The expiry is an external clock. Apply it before paint so an already-expired diagnostic is not shown.
			// eslint-disable-next-line react/set-state-in-effect
			setHidden(key);
			return;
		}
		const timer = setTimeout(() => setHidden(key), remaining);
		return () => clearTimeout(timer);
	}, [key, entry.expiresAt]);
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
