import { routerExportSchema } from "../api/domains/toolchain-history/contracts";
import { callJson, withQuery, type Transport } from "./transport";

export function routerExportClient(t: Transport) {
	return {
		routerExport: (
			options: { since?: string; withEmbeddings?: boolean } = {},
		) =>
			callJson(
				t,
				routerExportSchema,
				withQuery("/api/router-export", options),
				{ signal: AbortSignal.timeout(120_000) },
			),
	};
}
