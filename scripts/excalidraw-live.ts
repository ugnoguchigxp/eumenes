import { mkdirSync, writeFileSync } from "node:fs";
import { readStoredExcalidrawAvailability } from "../api/domains/settings";
import { liveLarmSettings } from "./live-larm";
if (!process.argv.includes("--check"))
	throw new Error("use --check for a read-only deployment check");
const saved = liveLarmSettings();
const availability = readStoredExcalidrawAvailability(
	process.env.EUMENES_DB || "./data/eumenes.sqlite3",
);
let localServiceRoute: number | string = "larm_unconfigured";
if (saved.baseUrl) {
	try {
		// No LLM or administrator token is substituted for a missing consumer credential.
		const response = await fetch(
			`${saved.baseUrl.replace(/\/$/, "")}/v1/local-services`,
			{ redirect: "error", signal: AbortSignal.timeout(10000) },
		);
		localServiceRoute = response.status;
		await response.body?.cancel();
	} catch {
		localServiceRoute = "connection_failed";
	}
}
const result = {
	checkedAt: new Date().toISOString(),
	mode: "read-only",
	availability,
	localServiceRoute,
	leaseRequested: false,
	sceneEdited: false,
	liveAcceptance: "not_run",
	reason: availability.configured
		? "requires_registered_consumer_and_hosted_gateway_acceptance"
		: "dedicated_consumer_and_gateway_not_configured",
};
mkdirSync("verification-reports/excalidraw", { recursive: true });
writeFileSync(
	"verification-reports/excalidraw/live-status.json",
	JSON.stringify(result, null, 2),
);
console.log(JSON.stringify(result));
