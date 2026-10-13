import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryRoots } from "../../queryKeys";
import type { SettingsDraftHost } from "./SettingsDraftHost";
import { allVoiceFields } from "./voice-bindings";
import { updateVoiceCharacter } from "./sections/voice-character";
import { useVoiceSample } from "./useVoiceSample";
import {
	speechTargets,
	serviceSummary,
	voiceInputFields,
	type VoiceTools,
} from "./voice-presentation";

/** Settings owns effectful operations; DS and OpenUI receive data and allowlisted IDs. */
export function useVoiceSettings(host: SettingsDraftHost): VoiceTools {
	const s = host.value!;
	const saved = host.query.data;
	const changed =
		!saved ||
		(["baseUrl", "profile", "audience"] as const).some(
			(key) => s.larm[key] !== saved.larm[key],
		);
	const [chosen, setChosen] = useState("");
	const targets = speechTargets(s);
	const target =
		targets.find((t) => t.value === chosen)?.value ??
		(s.routes.tts.mode === "cloud-only"
			? (s.routes.tts.fallbackId ?? "")
			: "local");
	const voices = useQuery({
		queryKey: [
			queryRoots.larmVoices,
			host.client.identity,
			saved?.larm.baseUrl,
			saved?.larm.profile,
			saved?.larm.audience,
		],
		queryFn: ({ signal }) => host.client.larmVoices(signal),
		enabled: target === "local" && !!saved?.larm.baseUrl && !changed,
		retry: false,
		staleTime: Infinity,
		refetchOnWindowFocus: false,
	});
	const catalog = target === "local" && !changed ? voices.data : undefined;
	const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
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
	const canSample = !!catalog || !!s.larm.voice;
	const sample = useVoiceSample(
		host.client,
		{
			voice: s.larm.voice,
			style: s.larm.style ?? null,
			speed: s.larm.speed,
			pitchScale: s.larm.pitchScale,
			intonationScale: s.larm.intonationScale,
		},
		changed || target !== "local" || !canSample,
		s.voice.outputVolume,
		s.voice.outputDevice,
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
					setDevices(list);
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
	const fields = voiceInputFields(s, target, catalog, devices, outputSupported);
	const voice = catalog?.voices.find(
		(v) => v.id === (s.larm.voice || catalog.default_voice),
	);
	const status =
		target !== "local"
			? "声の一覧・スタイル・抑揚の取得にはこのAPIが対応していません。音声IDと速度を指定します。クラウドの生成確認は保存後に既存の「サービスを試す」で行います。"
			: changed
				? "接続先の変更を適用してから声の一覧を取得してください。"
				: voices.isFetching
					? "声の一覧を取得しています。"
					: voices.isError
						? "声の一覧を取得できません。接続を確認して再取得してください。" +
							(s.larm.voice ? " 保存した声の試聴はできます。" : "")
						: !catalog
							? "LARMの接続先を設定してから声の一覧を取得してください。"
							: "サービスが対応する調整項目だけを表示しています。";
	return {
		fields,
		groups: [
			{
				id: "speech",
				label: "読み上げ",
				description:
					serviceSummary(s, "tts") +
					"\n変更は適用後、次の発話から反映します。\n" +
					status +
					(voice?.credit ? "\nクレジット：" + voice.credit : "") +
					(sample.error ? "\n" + sample.error : ""),
			},
			{
				id: "input",
				label: "聞き取り",
				description:
					serviceSummary(s, "asr") +
					"\n録音の調整は適用後、次の音声開始から反映します。",
			},
			{
				id: "devices",
				label: "機器",
				description:
					"機器確認ボタンを押すとマイクの許可を求めます。変更は適用後、次の音声開始から反映します。" +
					(outputSupported
						? ""
						: "\nこのブラウザは再生先の切替に対応していません。システム標準を使います。") +
					(deviceMessage ? "\n" + deviceMessage : ""),
			},
		],
		actions: [
			{ id: "voice-routing", label: "利用先を変更", group: "speech" },
			{ id: "input-routing", label: "利用先を変更", group: "input" },
			{
				id: "voice-register",
				label: "読み上げ用のモデルを登録",
				group: "speech",
			},
			{ id: "voice-dictionary", label: "読み方辞書を開く", group: "speech" },
			...(target !== "local"
				? [
						{
							id: "voice-trial",
							label: "保存済みのサービスを試す",
							group: "speech",
							disabled: host.dirty,
						},
					]
				: []),
			...(target === "local"
				? [
						{
							id: "voice-refresh",
							label: "声の一覧を再取得",
							group: "speech",
							disabled: changed || !saved?.larm.baseUrl || voices.isFetching,
						},
						{
							id: "voice-sample",
							label:
								sample.state === "loading"
									? "サンプルの準備を取消"
									: sample.state === "playing"
										? "サンプルを停止"
										: "サンプルを再生",
							group: "speech",
							disabled: changed || !canSample,
						},
					]
				: []),
			{
				id: "devices-discover",
				label: checking ? "音声機器を確認中…" : "音声機器を確認",
				group: "devices",
				disabled: checking,
			},
		],
		edit(id, value) {
			if (id === "speech.target") {
				if (!fields.some((f) => f.id === id)) return false;
				if (!targets.some((t) => t.value === value))
					throw new Error("unknown_target");
				sample.stop();
				setChosen(value);
				return true;
			}
			const visible = fields.find((f) => f.id === id && !f.disabled);
			if (!visible) return false;
			if (
				visible.control === "select" &&
				!visible.options?.some((o) => o.value === value)
			)
				throw new Error("unknown_option");
			if (
				(visible.control === "number" || visible.control === "range") &&
				(!value.trim() ||
					!Number.isFinite(Number(value)) ||
					Number(value) < visible.minimum! ||
					Number(value) > visible.maximum!)
			)
				throw new Error("invalid_range");
			const binding = allVoiceFields(s).find((f) => f.id === id)!;
			if (id === "speech.local.voice") {
				sample.stop();
				updateVoiceCharacter(value, catalog, host.change);
			} else {
				if (id.startsWith("speech.local.")) sample.stop();
				host.change((draft) => {
					if (id === "speech.local.style" && value === "")
						delete draft.larm.style;
					else binding.edit(draft, value);
					if (
						id === "speech.local.autoIntonation" &&
						value === "true" &&
						draft.larm.intonationScale === undefined
					)
						draft.larm.intonationScale =
							voice?.capabilities.intonation_scale?.default ?? 1;
				});
			}
			return true;
		},
		action(id) {
			const action = this.actions.find((a) => a.id === id && !a.disabled);
			if (!action) throw new Error("invalid_action");
			const destinations: Record<string, string> = {
				"voice-routing": "ai",
				"input-routing": "ai",
				"voice-register": "connections",
				"voice-dictionary": "dictionary",
				"voice-trial": "services",
			};
			if (destinations[id]) {
				sample.stop();
				window.location.hash = "settings/" + destinations[id];
			} else if (id === "voice-refresh") {
				sample.stop();
				void voices.refetch();
			} else if (id === "voice-sample") {
				if (sample.state === "idle") void sample.play();
				else sample.stop();
			} else if (id === "devices-discover") void discover();
		},
	};
}
