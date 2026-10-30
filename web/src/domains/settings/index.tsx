import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { EumenesClient } from "../../../../client";
import {
	type BackgroundKind,
	billingPath,
	type Settings,
} from "../../../../api/domains/settings/contracts";
import { queryRoots } from "../../queryKeys";
import { billingPathLabels } from "./shared";

export { billingPathLabels };

export function useSettings(client: EumenesClient) {
	return useQuery({
		queryKey: [queryRoots.settings, client.identity],
		queryFn: () => client.settings(),
		retry: 0,
	});
}

const larmPrefix = "larm:";
const larmGroup = { id: "larm", label: "LARM" };

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
	// Only registered resources are offered; a connection's full model list (aliases, unwanted tiers) stays in settings.
	const options: ConversationModelOption[] = [];
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
			for (const r of value.resources)
				if (r.purpose === "llm" && r.connectionId === c.id)
					options.push({ id: r.id, label: r.model, groupId: c.id, groupLabel });
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

/** Switches the conversation background without opening the settings page. */
export function useBackground(client: EumenesClient) {
	const cache = useQueryClient();
	const query = useSettings(client);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const value = query.data;
	const selected = value?.general.background ?? "light-fairy";
	async function select(kind: BackgroundKind) {
		if (!value || busy || kind === selected) return;
		setBusy(true);
		setError(null);
		try {
			const settings = structuredClone(value);
			settings.general.background = kind;
			const saved = await client.applySettings({
				requestId: crypto.randomUUID(),
				expectedRevision: value.revision,
				settings,
				keys: [],
			});
			cache.setQueryData([queryRoots.settings, client.identity], saved);
		} catch {
			setError("背景を切り替えられませんでした");
			void cache.invalidateQueries({
				queryKey: [queryRoots.settings, client.identity],
			});
		} finally {
			setBusy(false);
		}
	}
	return { ready: !!value, selected, busy, error, select };
}

export { notificationSoundWav } from "./notification-sound";
