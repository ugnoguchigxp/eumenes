import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { EumenesClient } from "../../../../client";
import type { Settings } from "../../../../api/domains/settings/contracts";
import { queryRoots } from "../../queryKeys";
import { useVoiceSample } from "../settings/useVoiceSample";
import { useNotificationSample } from "./useNotificationSample";
import type { VoiceCatalog } from "./voice-presentation";

/**
 * The effectful part of the voice screen, kept apart from the registered fields: the LARM voice
 * catalog, the sample player, device discovery and which speech target is being adjusted.
 * Registered fields only name document paths; what a catalog allows is decided here.
 */
export function useVoiceTools({
	client,
	saved,
	effective,
	active,
	speech,
}: {
	client: EumenesClient;
	/** The saved document. */
	saved: Settings | undefined;
	/** The saved document with the shared draft applied. */
	effective: Settings | undefined;
	/** The screen shows local voice fields; nothing is fetched or played otherwise. */
	active: boolean;
	/** The speech targets the settings adapter lists: the local voice and the cloud models. */
	speech: {
		local: boolean;
		cloud: ReadonlyArray<{ id: string; label: string }>;
	};
}) {
	const notification = useNotificationSample(effective?.voice, active);
	const connectionChanged =
		!!saved &&
		!!effective &&
		(["baseUrl", "profile", "audience"] as const).some(
			(key) => effective.larm[key] !== saved.larm[key],
		);
	const [chosen, setChosen] = useState("");
	const targets = [
		...(speech.local ? [{ value: "local", label: "ローカルの声" }] : []),
		...speech.cloud.map((t) => ({ value: t.id, label: t.label })),
	];
	const target =
		targets.find((t) => t.value === chosen)?.value ??
		targets.find(
			(t) =>
				t.value ===
				(effective?.routes.tts.mode === "cloud-only"
					? effective.routes.tts.fallbackId
					: "local"),
		)?.value ??
		targets[0]?.value ??
		(speech.local ? "local" : "");
	const voices = useQuery({
		queryKey: [
			queryRoots.larmVoices,
			client.identity,
			saved?.larm.baseUrl,
			saved?.larm.profile,
			saved?.larm.audience,
		],
		queryFn: ({ signal }) => client.larmVoices(signal),
		enabled:
			active &&
			target === "local" &&
			!!saved?.larm.baseUrl &&
			!connectionChanged,
		retry: false,
		staleTime: Infinity,
		refetchOnWindowFocus: false,
	});
	const catalog: VoiceCatalog | undefined =
		target === "local" && !connectionChanged ? voices.data : undefined;
	const selected = catalog?.voices.find(
		(v) => v.id === (effective?.larm.voice || catalog.default_voice),
	);
	// Discovered devices are kept per API identity, so a review screen names the same devices.
	const cache = useQueryClient();
	const devicesKey = [queryRoots.settings, client.identity, "devices"] as const;
	const devices =
		useQuery({
			queryKey: devicesKey,
			queryFn: () => [] as MediaDeviceInfo[],
			enabled: false,
			staleTime: Number.POSITIVE_INFINITY,
			gcTime: Number.POSITIVE_INFINITY,
		}).data ?? [];
	const [deviceMessage, setDeviceMessage] = useState("");
	const [checking, setChecking] = useState(false);
	const deviceRun = useRef<object | null>(null);
	useEffect(
		() => () => {
			deviceRun.current = null;
		},
		[],
	);
	const outputSupported =
		typeof AudioContext !== "undefined" &&
		"setSinkId" in AudioContext.prototype;
	const canSample = !!catalog || !!effective?.larm.voice;
	const sample = useVoiceSample(
		client,
		{
			voice: effective?.larm.voice ?? "",
			style: effective?.larm.style ?? null,
			speed: effective?.larm.speed,
			pitchScale: effective?.larm.pitchScale,
			intonationScale: effective?.larm.intonationScale,
		},
		!active || connectionChanged || target !== "local" || !canSample,
		effective?.voice.outputVolume,
		effective?.voice.outputDevice,
	);
	async function discover() {
		if (deviceRun.current) return;
		const mine = {};
		deviceRun.current = mine;
		setChecking(true);
		setDeviceMessage("");
		try {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			try {
				if (deviceRun.current !== mine) return;
				const list = await navigator.mediaDevices.enumerateDevices();
				if (deviceRun.current === mine) {
					cache.setQueryData<MediaDeviceInfo[]>(devicesKey, list);
					setDeviceMessage("音声機器を確認しました。");
				}
			} finally {
				stream.getTracks().forEach((t) => t.stop());
			}
		} catch {
			if (deviceRun.current === mine)
				setDeviceMessage("マイクの許可または機器の接続を確認してください。");
		} finally {
			if (deviceRun.current === mine) {
				deviceRun.current = null;
				setChecking(false);
			}
		}
	}
	return {
		notification,
		catalog,
		selected,
		voices,
		connectionChanged,
		targets,
		target,
		chooseTarget(value: string) {
			sample.stop();
			setChosen(value);
		},
		devices,
		deviceMessage,
		checking,
		discover,
		outputSupported,
		canSample,
		sample,
	};
}
export type VoiceTools = ReturnType<typeof useVoiceTools>;
