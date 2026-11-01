import type { Control } from "./connect";
import { readJson, record } from "./guards";

/** A ready connection's claimable flag is a short-lived semantic cache, refreshed by the existing health API. */
export async function refreshClaimability(
	control: Control,
	id: string,
	providers: Record<string, unknown>[],
) {
	let delay = 0;
	for (const provider of providers) {
		const name = String(provider.name);
		const response = await control(
			`/v1/agent-connections/${encodeURIComponent(id)}/providers/${encodeURIComponent(name)}/health`,
			{ method: "GET" },
			[200, 503],
		);
		const health = record(await readJson(response));
		if (
			health.name !== name ||
			(provider.capability !== undefined &&
				health.capability !== provider.capability) ||
			typeof health.ready !== "boolean" ||
			typeof health.acceptingRequests !== "boolean" ||
			(response.status === 200) !== health.ready
		)
			throw new Error("larm_invalid_provider_health");
		if (!health.ready) delay = 1000;
	}
	return delay;
}
