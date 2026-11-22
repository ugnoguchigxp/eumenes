import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { EumenesClient } from "../../../../client";
import {
	type BackgroundKind,
	billingPath,
	defaultReasoningEffort,
	isAgentConnection,
	larmReasoningEfforts,
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
	/**
	 * The thinking levels this model accepts, in its catalog's order. `[]`: the model has no level to choose.
	 * `null`: not known (its catalog is not read yet, or could not be).
	 */
	efforts: readonly string[] | null;
	/** The level the model runs at when none is named (its catalog's, or LARM's declared `low`); null: the catalog names none. */
	defaultEffort: string | null;
};

/** The level a model switch saves when the saved one is not among the new model's: its default, else its first. */
function adjustedEffort(option: ConversationModelOption, saved: string) {
	const { efforts } = option;
	if (!efforts?.length || efforts.includes(saved)) return saved;
	return option.defaultEffort && efforts.includes(option.defaultEffort)
		? option.defaultEffort
		: efforts[0]!;
}

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
	// The thinking levels of an agent connection's models come from its catalog (the connection's model list).
	const agentConnections = (value?.connections ?? []).filter(
		(c) =>
			c.enabled &&
			isAgentConnection(c) &&
			value!.resources.some(
				(r) => r.purpose === "llm" && r.connectionId === c.id,
			),
	);
	const catalogs = useQueries({
		queries: agentConnections.map((c) => ({
			queryKey: [queryRoots.connectionModels, client.identity, c.id, c.epoch],
			queryFn: ({ signal }: { signal: AbortSignal }) =>
				client.connectionModels(c.id, signal),
			retry: 0,
			staleTime: 5 * 60_000,
		})),
	});
	// Only registered resources are offered; a connection's full model list (aliases, unwanted tiers) stays in settings.
	const options: ConversationModelOption[] = [];
	if (value) {
		for (const p of profiles)
			options.push({
				id: `${larmPrefix}${p.profile}`,
				label: p.model ?? p.profile,
				groupId: larmGroup.id,
				groupLabel: larmGroup.label,
				efforts: larmReasoningEfforts,
				defaultEffort: defaultReasoningEffort,
			});
		for (const c of value.connections) {
			if (!c.enabled) continue;
			const groupLabel = groupLabelOf(c);
			const catalog =
				catalogs[agentConnections.findIndex((a) => a.id === c.id)]?.data;
			for (const r of value.resources)
				if (r.purpose === "llm" && r.connectionId === c.id) {
					// A connection that sends no level (an OpenAI-compatible one) has none to choose.
					const reasoning = catalog?.models.find(
						(m) => m.id === r.model,
					)?.reasoning;
					options.push({
						id: r.id,
						label: r.model,
						groupId: c.id,
						groupLabel,
						efforts: isAgentConnection(c) ? (reasoning?.efforts ?? null) : [],
						defaultEffort: reasoning?.default ?? null,
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
			// The saved level moves with the model when the new one does not accept it, in the same save.
			const next = options.find((o) => o.id === id);
			if (next)
				settings.general.reasoningEffort = adjustedEffort(
					next,
					value.general.reasoningEffort,
				);
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
	const current = options.find((option) => option.id === selected);
	/** Saves the thinking level: the next utterance's calls use it. Only a level the selected model accepts is saved. */
	async function selectEffort(effort: string) {
		if (!value || busy || !current?.efforts?.includes(effort)) return;
		if (effort === value.general.reasoningEffort) return;
		await saveEffort(effort);
	}
	async function saveEffort(effort: string) {
		if (!value) return;
		setBusy(true);
		setError(null);
		try {
			const settings = structuredClone(value);
			settings.general.reasoningEffort = effort;
			const saved = await client.applySettings({
				requestId: crypto.randomUUID(),
				expectedRevision: value.revision,
				settings,
				keys: [],
			});
			cache.setQueryData([queryRoots.settings, client.identity], saved);
		} catch {
			setError("思考レベルを切り替えられませんでした");
			void cache.invalidateQueries({
				queryKey: [queryRoots.settings, client.identity],
			});
		} finally {
			setBusy(false);
		}
	}
	// Once the selected model's levels are known and the saved level is not among them, the level moves to the model's
	// default the way a model switch moves it. One try per (model, saved level): a failed save is not repeated.
	const adjustTried = useRef<string | null>(null);
	const savedEffort = value?.general.reasoningEffort;
	const adjusted =
		current && savedEffort !== undefined
			? adjustedEffort(current, savedEffort)
			: undefined;
	useEffect(() => {
		if (!current || savedEffort === undefined || adjusted === undefined) return;
		if (adjusted === savedEffort || busy) return;
		const key = `${current.id}:${savedEffort}`;
		if (adjustTried.current === key) return;
		adjustTried.current = key;
		void saveEffort(adjusted);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [current?.id, savedEffort, adjusted, busy]);
	return {
		ready: !!value,
		options,
		selected,
		busy,
		error,
		select,
		effort: {
			/** The saved level. */
			value: value?.general.reasoningEffort ?? "",
			/** The levels the selected model accepts; null while they are not known. */
			choices: current?.efforts ?? null,
			select: selectEffort,
		},
	};
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

/** Saves one change to the general settings through the shared settings document. */
function useGeneralChange(client: EumenesClient, failure: string) {
	const cache = useQueryClient();
	const query = useSettings(client);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const value = query.data;
	async function save(change: (general: Settings["general"]) => void) {
		if (!value || busy) return;
		setBusy(true);
		setError(null);
		try {
			const settings = structuredClone(value);
			change(settings.general);
			const saved = await client.applySettings({
				requestId: crypto.randomUUID(),
				expectedRevision: value.revision,
				settings,
				keys: [],
			});
			cache.setQueryData([queryRoots.settings, client.identity], saved);
		} catch {
			setError(failure);
			void cache.invalidateQueries({
				queryKey: [queryRoots.settings, client.identity],
			});
		} finally {
			setBusy(false);
		}
	}
	return { general: value?.general, busy, error, save };
}

/** Switches the conversation background without opening the settings page. */
export function useBackground(client: EumenesClient) {
	const { general, busy, error, save } = useGeneralChange(
		client,
		"背景を切り替えられませんでした",
	);
	const selected = general?.background ?? "light-fairy";
	async function select(kind: BackgroundKind) {
		if (kind === selected) return;
		await save((next) => {
			next.background = kind;
		});
	}
	return { ready: !!general, selected, busy, error, select };
}

/** The saved image behind the Live2D model: chosen from the image library, kept in the settings. */
export function useAvatarBackdrop(client: EumenesClient) {
	const { general, busy, error, save } = useGeneralChange(
		client,
		"背景の画像を保存できませんでした",
	);
	const imageId = general?.avatarBackdropImageId ?? null;
	/** null removes the image. */
	async function select(id: string | null) {
		if (id === imageId) return;
		await save((next) => {
			next.avatarBackdropImageId = id;
		});
	}
	return { ready: !!general, imageId, busy, error, select };
}

export { notificationSoundWav, completionVoiceWav } from "./notification-sound";
