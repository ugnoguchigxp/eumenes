import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { EumenesClient } from "../../../../client";
import type { Settings } from "../../../../api/domains/settings/contracts";
import { queryRoots } from "../../queryKeys";
import {
	agentModelCatalog,
	connectionKindDefaults,
	connectionKindLabels,
	type CatalogKind,
} from "./shared";
export function useSettings(client: EumenesClient) {
	return useQuery({
		queryKey: [queryRoots.settings, client.identity],
		queryFn: () => client.settings(),
		retry: 0,
	});
}
const larmPrefix = "larm:";
const catalogPrefix = "catalog:";
/** Picks the conversation model (LARM or a cloud LLM) without opening the settings page. */
export function useConversationModel(client: EumenesClient) {
	const cache = useQueryClient();
	const query = useSettings(client);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const value = query.data;
	const route = value?.routes.llm;
	const larmProfiles = useQuery({
		queryKey: [queryRoots.larmProfiles, client.identity],
		queryFn: () => client.larmProfiles(),
		retry: 0,
		staleTime: 5 * 60_000,
	});
	const savedProfile = value?.larm.profile;
	// The saved profile stays listed even when LARM is unreachable or no longer publishes it.
	const profiles = [
		...(larmProfiles.data ?? []),
		...(savedProfile &&
		!larmProfiles.data?.some((p) => p.profile === savedProfile)
			? [{ profile: savedProfile, model: null }]
			: []),
	];
	const llmResources = value
		? value.resources.flatMap((r) => {
				const c = value.connections.find((x) => x.id === r.connectionId);
				return r.purpose === "llm" && c?.enabled ? [{ r, c }] : [];
			})
		: [];
	const options = value
		? [
				...profiles.map((p) => ({
					id: `${larmPrefix}${p.profile}`,
					label: `LARM / ${p.model ?? p.profile}`,
				})),
				...llmResources.map(({ r, c }) => ({
					id: r.id,
					label: `${c.name} / ${r.model}`,
				})),
				// Catalog models not yet registered: picking one registers it with the CLI login.
				...(Object.keys(agentModelCatalog) as CatalogKind[]).flatMap((kind) =>
					agentModelCatalog[kind]
						.filter(
							({ model }) =>
								!llmResources.some(
									({ r, c }) => c.kind === kind && r.model === model,
								),
						)
						.map(({ model }) => ({
							id: `${catalogPrefix}${kind}:${model}`,
							label: `${connectionKindLabels[kind]} / ${model}`,
						})),
				),
			]
		: [];
	const selected =
		route?.mode === "cloud-only" &&
		route.fallbackId &&
		options.some((o) => o.id === route.fallbackId)
			? route.fallbackId
			: `${larmPrefix}${savedProfile}`;
	async function select(id: string) {
		if (!value || busy || id === selected) return;
		setBusy(true);
		setError(null);
		try {
			const settings = structuredClone(value);
			const llm = settings.routes.llm;
			if (id.startsWith(larmPrefix)) {
				settings.larm.profile = id.slice(larmPrefix.length);
				if (llm.mode === "cloud-only") llm.mode = "larm-preferred";
			} else {
				if (id.startsWith(catalogPrefix))
					id = registerCatalogModel(settings, id);
				llm.mode = "cloud-only";
				llm.cloudAllowed = true;
				llm.fallbackId = id;
			}
			const saved = await client.applySettings({
				requestId: crypto.randomUUID(),
				expectedRevision: value.revision,
				settings,
				keys: [],
			});
			cache.setQueryData([queryRoots.settings, client.identity], saved);
			void cache.invalidateQueries({
				queryKey: [queryRoots.larmDetails, client.identity],
			});
		} catch {
			setError("会話モデルを切り替えられませんでした");
			void cache.invalidateQueries({
				queryKey: [queryRoots.settings, client.identity],
			});
		} finally {
			setBusy(false);
		}
	}
	return { ready: !!value, options, selected, busy, error, select };
}
/** Adds a catalog model to the first enabled connection of its kind (creating one if needed); returns the resource id. */
function registerCatalogModel(settings: Settings, id: string) {
	const rest = id.slice(catalogPrefix.length);
	const kind = rest.slice(0, rest.indexOf(":")) as CatalogKind;
	const entry = agentModelCatalog[kind].find(
		(m) => m.model === rest.slice(kind.length + 1),
	);
	if (!entry) throw new Error("unknown_catalog_model");
	let connection = settings.connections.find(
		(c) => c.kind === kind && c.enabled,
	);
	if (!connection) {
		connection = {
			id: crypto.randomUUID(),
			kind,
			name: connectionKindLabels[kind],
			baseUrl: connectionKindDefaults[kind].url,
			enabled: true,
			epoch: 0,
			envRef: null,
		};
		settings.connections.push(connection);
	}
	const resourceId = crypto.randomUUID();
	settings.resources.push({
		id: resourceId,
		connectionId: connection.id,
		purpose: "llm",
		model: entry.model,
		contextWindow: entry.context,
		voice: null,
	});
	return resourceId;
}
/** Toggles spoken replies without opening the settings page. */
export function useVoiceMute(client: EumenesClient) {
	const cache = useQueryClient();
	const query = useSettings(client);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const value = query.data;
	async function toggle() {
		if (!value || busy) return;
		setBusy(true);
		setError(null);
		try {
			const settings = structuredClone(value);
			settings.voice.autoSpeak = !value.voice.autoSpeak;
			const saved = await client.applySettings({
				requestId: crypto.randomUUID(),
				expectedRevision: value.revision,
				settings,
				keys: [],
			});
			cache.setQueryData([queryRoots.settings, client.identity], saved);
		} catch {
			setError("ミュートを切り替えられませんでした");
			void cache.invalidateQueries({
				queryKey: [queryRoots.settings, client.identity],
			});
		} finally {
			setBusy(false);
		}
	}
	return {
		muted: value ? !value.voice.autoSpeak : false,
		ready: !!value,
		busy,
		error,
		toggle,
	};
}
