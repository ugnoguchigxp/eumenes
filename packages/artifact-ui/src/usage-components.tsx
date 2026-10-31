import {
	UsageDashboard,
	type UsageDashboardData,
} from "@eumenes/design-system";
import type { ArtifactRequest } from "./contracts";
import { useAction } from "./components";
export type UsageDashboardResource = UsageDashboardData & {
	kind: "usage-dashboard";
	busy?: boolean;
	message?: string;
};
export function UsageDashboardView({ request }: { request: ArtifactRequest }) {
	const action = useAction(request);
	const data = action.resource;
	if (data?.kind !== "usage-dashboard") return null;
	return (
		<UsageDashboard
			data={data}
			title={request.title}
			busy={action.pending || data.busy}
			message={action.message || data.message}
			onRefresh={() => void action.send("usage-refresh", {})}
			onQuery={(q) =>
				void action.send("usage-query", {
					...q,
					pageIndex: String(q.pageIndex),
				})
			}
			onRateSave={(draft) =>
				action.send("usage-rate-save", {
					...draft,
					expectedRevision: String(data.revision),
				})
			}
		/>
	);
}
