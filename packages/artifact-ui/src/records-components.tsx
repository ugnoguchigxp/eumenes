import {
	RecordsWorkspace,
	type RecordsWorkspaceProps,
} from "@eumenes/design-system";
import type { ArtifactRequest } from "./contracts";
import { useAction } from "./components";

export type RecordsResource = Omit<
	RecordsWorkspaceProps,
	| "title"
	| "onRefresh"
	| "onQuery"
	| "onProcedureState"
	| "onProcedureDelete"
	| "onDownload"
> & { kind: "records-workspace"; revision: number };

export function RecordsWorkspaceView({
	request,
}: {
	request: ArtifactRequest;
}) {
	const action = useAction(request);
	const data = action.resource;
	if (data?.kind !== "records-workspace") return null;
	return (
		<RecordsWorkspace
			{...data}
			title={request.title}
			busy={data.busy || action.pending}
			message={action.message || data.message}
			onRefresh={() => void action.send("records-refresh", {})}
			onQuery={(tableId, query) =>
				void action.send("records-query", {
					tableId,
					pageIndex: String(query.pageIndex),
					pageSize: String(query.pageSize),
					sort: query.sort,
					desc: query.desc,
					q: query.q,
				})
			}
			onProcedureState={(id, enabled) =>
				void action.send("records-procedure-state", { id, enabled })
			}
			onProcedureDelete={(id) =>
				void action.send("records-procedure-delete", { id })
			}
			onDownload={() => void action.send("records-download", {})}
		/>
	);
}
