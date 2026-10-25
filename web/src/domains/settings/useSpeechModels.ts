import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { EumenesClient } from "../../../../client";
import { queryRoots } from "../../queryKeys";
import { useSettings } from ".";

const newModelPrefix = "new-model:";

type Purpose = "asr" | "tts";
type Model = Awaited<
	ReturnType<EumenesClient["connectionModels"]>
>["models"][number];

/** A listed model the switcher can register without asking: supported, and any required voice or language has a default. */
function registrable(model: Model, purpose: Purpose) {
	const speech = model.speech;
	return (
		model.purpose === purpose &&
		!!speech?.supported &&
		(!speech.voiceRequired || !!speech.voiceDefault) &&
		(!speech.languageRequired || !!speech.languageDefault)
	);
}

export function useSpeechModels(client: EumenesClient) {
	const cache = useQueryClient();
	const query = useSettings(client);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const details = useQuery({
		queryKey: [queryRoots.larmDetails, client.identity],
		queryFn: () => client.larmDetails(),
		retry: 0,
		staleTime: 60_000,
	});
	const value = query.data;
	// Workers AI publishes its speech models; a failed list only hides the unregistered ones.
	const speechConnections = (value?.connections ?? []).filter(
		(c) => c.kind === "cloudflare-workers-ai" && c.enabled,
	);
	const modelLists = useQueries({
		queries: speechConnections.map((c) => ({
			queryKey: [queryRoots.connectionModels, client.identity, c.id, c.epoch],
			queryFn: ({ signal }: { signal: AbortSignal }) =>
				client.connectionModels(c.id, signal),
			retry: 0,
			staleTime: 5 * 60_000,
		})),
	});
	// Unregistered models: picking one registers it as a resource on its connection.
	const unregistered = new Map<
		string,
		{ connectionId: string; purpose: Purpose; model: Model }
	>();
	function model(purpose: Purpose) {
		const route = value?.routes[purpose];
		const provider = details.data?.providers.find((p) => p.name === purpose);
		const options = [
			{ id: "larm", label: provider ? `LARM / ${provider.model}` : "LARM" },
		];
		for (const connection of value?.connections ?? []) {
			if (!connection.enabled) continue;
			const listed =
				modelLists[speechConnections.findIndex((c) => c.id === connection.id)]
					?.data?.models ?? [];
			const registered = value!.resources.filter(
				(r) => r.purpose === purpose && r.connectionId === connection.id,
			);
			for (const r of registered)
				options.push({
					id: r.id,
					label: `${connection.name} / ${r.model}`,
				});
			for (const m of listed) {
				if (
					!registrable(m, purpose) ||
					registered.some((r) => r.model === m.id)
				)
					continue;
				const id = `${newModelPrefix}${connection.id}:${m.id}`;
				unregistered.set(id, {
					connectionId: connection.id,
					purpose,
					model: m,
				});
				options.push({ id, label: `${connection.name} / ${m.displayName}` });
			}
		}
		return {
			options,
			selected:
				route?.mode === "cloud-only" ? (route.fallbackId ?? "") : "larm",
		};
	}
	const asr = model("asr");
	const tts = model("tts");
	async function select(purpose: Purpose, id: string) {
		if (
			!value ||
			busy ||
			!(purpose === "asr" ? asr : tts).options.some(
				(option) => option.id === id,
			)
		)
			return;
		setBusy(true);
		setError(null);
		try {
			const settings = structuredClone(value);
			const route = settings.routes[purpose];
			if (id === "larm") {
				if (route.mode === "cloud-only") route.mode = "larm-preferred";
			} else {
				const entry = unregistered.get(id);
				if (entry) {
					id = crypto.randomUUID();
					const speech = entry.model.speech!;
					settings.resources.push({
						id,
						connectionId: entry.connectionId,
						purpose: entry.purpose,
						model: entry.model.id,
						contextWindow: null,
						voice: speech.voiceDefault,
						...(speech.languageDefault
							? { language: speech.languageDefault }
							: {}),
					});
				}
				route.mode = "cloud-only";
				route.cloudAllowed = true;
				route.fallbackId = id;
			}
			const saved = await client.applySettings({
				requestId: crypto.randomUUID(),
				expectedRevision: value.revision,
				settings,
				keys: [],
			});
			cache.setQueryData([queryRoots.settings, client.identity], saved);
		} catch {
			setError("音声モデルを切り替えられませんでした");
			void cache.invalidateQueries({
				queryKey: [queryRoots.settings, client.identity],
			});
		} finally {
			setBusy(false);
		}
	}
	return {
		ready: !!value,
		busy,
		error,
		asr,
		tts,
		select,
	};
}
