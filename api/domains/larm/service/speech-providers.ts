import type { Provider, ProviderName } from "./profiles";
import { protocols, endpoints } from "./profiles";
import { providerEndpoint, record, string } from "./guards";
import type { ProviderHosts } from "./connect";

type Rec = Record<string, unknown>;
/** Bind optional roles to catalog-selected names, never to a model family or port. */
export function optionalSpeechProviders(
	claimed: Rec,
	created: Rec,
	catalog: Rec[],
	hosts: ProviderHosts,
	languageProvider?: string,
) {
	const found = new Map<ProviderName, Provider>();
	const english = catalog.find((p) => p.capability === "speech.tts.english");
	const candidates = catalog.filter(
		(p) =>
			p.capability === "decision.sentence-language" &&
			p.name !== "system-one" &&
			(!languageProvider || p.name === languageProvider),
	);
	const language = candidates.length === 1 ? candidates[0] : undefined;
	for (const [role, declared] of [
		["tts-english", english],
		["sentence-language", language],
	] as const) {
		if (
			!declared ||
			declared.protocol !== protocols[role] ||
			declared.endpoint !== endpoints[role]
		)
			continue;
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
			announced.readiness !== "ready"
		)
			continue;
		if (
			info.model !== declared.model ||
			info.model !== announced.model ||
			info.protocol !== declared.protocol ||
			announced.protocol !== declared.protocol ||
			announced.endpoint !== declared.endpoint
		)
			continue;
		try {
			found.set(role, claimedSpeechProvider(role, info, hosts));
		} catch {
			// Do not retain an invalid optional binding or break ordinary speech.
			// Selecting this role still fails closed in withProvider.
		}
	}
	return found;
}

export function claimedSpeechProvider(
	role: "tts-english" | "sentence-language",
	info: Rec,
	hosts: ProviderHosts,
): Provider {
	const fields = record(record(info.configuration).fields);
	const baseUrl = string(
		role === "sentence-language" ? fields.daemonURL : fields.baseURL,
	);
	providerEndpoint(baseUrl, hosts.base, hosts.extra);
	const expected = new URL(
		endpoints[role].slice("/v1/".length),
		`${baseUrl.replace(/\/$/, "")}/`,
	);
	// Sentence-language publishes an exact URL. Existing audio claims may
	// publish only baseURL, in which case their established speech path applies.
	const endpoint =
		role === "sentence-language" || info.endpoint !== undefined
			? string(info.endpoint)
			: expected.href;
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
