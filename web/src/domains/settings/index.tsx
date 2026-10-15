import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { EumenesClient } from "../../../../client";
import {
	billingPath,
	type Settings,
} from "../../../../api/domains/settings/contracts";
import { queryRoots } from "../../queryKeys";
import { billingPathLabels, UNKNOWN_CONTEXT_WINDOW } from "./shared";

export { billingPathLabels };

export function useSettings(client: EumenesClient) {
	return useQuery({
		queryKey: [queryRoots.settings, client.identity],
		queryFn: () => client.settings(),
		retry: 0,
	});
}

const larmPrefix = "larm:";
const newModelPrefix = "new-model:";
const larmGroup = { id: "larm", label: "LARM" };

/** Query root of a connection's model list; the key is `[root, identity, connectionId, epoch]`. */

export type ConversationModelOption = {
	id: string;
	/** The model's own name; the group label carries the billing path. */
	label: string;
	groupId: string;
	groupLabel: string;
};

type Connection = Settings["connections"][number];

function groupLabelOf(connection: Connection) {
	const path = billingPath(connection);
	return path === "openai-compatible"
		? connection.name
		: billingPathLabels[path];
}

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
	const sdkConnections = (value?.connections ?? []).filter(
		(c) => c.kind === "claude-agent-sdk" && c.enabled,
	);
	// The model list also tests the credential; a failed list only hides the unregistered models.
	const modelLists = useQueries({
		queries: sdkConnections.map((c) => ({
			queryKey: [queryRoots.connectionModels, client.identity, c.id, c.epoch],
			queryFn: ({ signal }: { signal: AbortSignal }) =>
				client.connectionModels(c.id, signal),
			retry: 0,
			staleTime: 5 * 60_000,
		})),
	});
	const options: ConversationModelOption[] = [];
	// Unregistered models: picking one registers it as a resource on its connection.
	const unregistered = new Map<
		string,
		{ connectionId: string; model: string; contextWindow: number }
	>();
	if (value) {
		for (const p of profiles)
			options.push({
				id: `${larmPrefix}${p.profile}`,
				label: p.model ?? p.profile,
				groupId: larmGroup.id,
				groupLabel: larmGroup.label,
			});
		for (const c of value.connections) {
			if (!c.enabled) continue;
			const groupLabel = groupLabelOf(c);
			const listed =
				modelLists[sdkConnections.findIndex((x) => x.id === c.id)]?.data
					?.models ?? [];
			const registered = value.resources.filter(
				(r) => r.purpose === "llm" && r.connectionId === c.id,
			);
			for (const r of registered)
				options.push({
					id: r.id,
					label: listed.find((m) => m.id === r.model)?.displayName ?? r.model,
					groupId: c.id,
					groupLabel,
				});
			for (const m of listed) {
				if (registered.some((r) => r.model === m.id)) continue;
				const id = `${newModelPrefix}${c.id}:${m.id}`;
				unregistered.set(id, {
					connectionId: c.id,
					model: m.id,
					contextWindow: m.contextWindow ?? UNKNOWN_CONTEXT_WINDOW,
				});
				options.push({
					id,
					label: m.displayName,
					groupId: c.id,
					groupLabel,
				});
			}
		}
	}
	const selected =
		route?.mode === "cloud-only" &&
		route.fallbackId &&
		options.some((o) => o.id === route.fallbackId)
			? route.fallbackId
			: savedProfile
				? `${larmPrefix}${savedProfile}`
				: "";

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
				const entry = unregistered.get(id);
				if (entry) {
					id = crypto.randomUUID();
					settings.resources.push({
						id,
						connectionId: entry.connectionId,
						purpose: "llm",
						model: entry.model,
						contextWindow: entry.contextWindow,
						voice: null,
					});
				}
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
