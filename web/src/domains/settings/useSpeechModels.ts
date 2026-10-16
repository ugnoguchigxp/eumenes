import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { EumenesClient } from "../../../../client";
import { queryRoots } from "../../queryKeys";
import { useSettings } from ".";

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
	function model(purpose: "asr" | "tts") {
		const route = value?.routes[purpose];
		const provider = details.data?.providers.find((p) => p.name === purpose);
		const options = [
			{ id: "larm", label: provider ? `LARM / ${provider.model}` : "LARM" },
			...(value?.resources ?? []).flatMap((resource) => {
				const connection = value?.connections.find(
					(c) => c.id === resource.connectionId && c.enabled,
				);
				return resource.purpose === purpose && connection
					? [
							{
								id: resource.id,
								label: `${connection.name} / ${resource.model}`,
							},
						]
					: [];
			}),
		];
		return {
			options,
			selected:
				route?.mode === "cloud-only" ? (route.fallbackId ?? "") : "larm",
		};
	}
	async function select(purpose: "asr" | "tts", id: string) {
		if (
			!value ||
			busy ||
			!model(purpose).options.some((option) => option.id === id)
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
		asr: model("asr"),
		tts: model("tts"),
		select,
	};
}
