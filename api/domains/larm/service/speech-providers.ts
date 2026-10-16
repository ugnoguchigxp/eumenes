import type { Provider } from "./profiles";
import { protocols, endpoints } from "./profiles";
import { providerEndpoint, record, string } from "./guards";
import type { ProviderHosts } from "./connect";

type Rec = Record<string, unknown>;
/** Bind the optional English voice to its catalog-selected name, never to a model family or port. */
export function englishSpeechProvider(
	claimed: Rec,
	created: Rec,
	catalog: Rec[],
	hosts: ProviderHosts,
): Provider | undefined {
	const role = "tts-english";
	const declared = catalog.find((p) => p.capability === "speech.tts.english");
	if (
		!declared ||
		declared.protocol !== protocols[role] ||
		declared.endpoint !== endpoints[role]
	)
		return undefined;
	const announced = (created.providers as Rec[]).find(
		(p) => p.name === declared.name,
	);
	const info = (claimed.providers as Rec[]).find(
		(p) => p.name === declared.name,
	);
	if (
		!info ||
		!announced ||
		announced.claimable !== true ||
		announced.readiness !== "ready" ||
		info.model !== declared.model ||
		info.model !== announced.model ||
		info.protocol !== declared.protocol ||
		announced.protocol !== declared.protocol ||
		announced.endpoint !== declared.endpoint
	)
		return undefined;
	try {
		return claimedSpeechProvider(role, info, hosts);
	} catch {
		// Do not retain an invalid optional binding or break ordinary speech.
		// Selecting this role still fails closed in withProvider.
		return undefined;
	}
}

export function claimedSpeechProvider(
	role: "tts-english",
	info: Rec,
	hosts: ProviderHosts,
): Provider {
	const fields = record(record(info.configuration).fields);
	const baseUrl = string(fields.baseURL);
	providerEndpoint(baseUrl, hosts.base, hosts.extra);
	const expected = new URL(
		endpoints[role].slice("/v1/".length),
		`${baseUrl.replace(/\/$/, "")}/`,
	);
	// Audio claims may publish only baseURL, in which case their established speech path applies.
	const endpoint =
		info.endpoint !== undefined ? string(info.endpoint) : expected.href;
	providerEndpoint(endpoint, hosts.base, hosts.extra);
	if (
		new URL(endpoint).href !== expected.href ||
		(info.baseUrl !== undefined && baseUrl !== info.baseUrl) ||
		fields.model !== info.model ||
		info.protocol !== protocols[role]
	)
		throw new Error("larm_claim_configuration_mismatch");
	return {
		name: role,
		claimName: string(info.name),
		baseUrl,
		endpoint,
		model: string(info.model),
		protocol: string(info.protocol),
		token: string(record(info.credential).token),
		voice: typeof fields.voice === "string" ? fields.voice : undefined,
	};
}
