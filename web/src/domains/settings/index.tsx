import {
	useQuery,
	useQueryClient,
	useInfiniteQuery,
} from "@tanstack/react-query";
import {
	cloneElement,
	isValidElement,
	useCallback,
	useId,
	useEffect,
	useRef,
	useState,
} from "react";
import type { EumenesClient } from "../../../../client";
import {
	asrLanguages,
	settingsSchema,
	type Settings,
	type Purpose,
	type ApplySettings,
} from "../../../../api/domains/settings/contracts";
type TtsRange = NonNullable<
	Awaited<
		ReturnType<EumenesClient["larmVoices"]>
	>["voices"][number]["capabilities"]["speed"]
>;
import { TtsDictionaryPanel } from "../tts-dictionary";
import { MemoryConnectionPanel } from "./MemoryConnectionPanel";
import {
	Button,
	Input,
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "../../design-system";
const purposes: Record<Purpose, string> = {
	llm: "会話",
	asr: "聞き取り",
	tts: "読み上げ",
};
const categories = [
	{ id: "general", label: "全般" },
	{ id: "ai", label: "AIの使い方" },
	{ id: "connections", label: "接続先" },
	{ id: "services", label: "サービスを試す" },
	{ id: "voice", label: "音声" },
	{ id: "data", label: "データと利用記録" },
	{ id: "schedule", label: "予約" },
	{ id: "appearance", label: "表示" },
	{ id: "dictionary", label: "TTS辞書" },
	{ id: "memory", label: "メモリー" },
] as const;
function Field({
	label,
	children,
	hint,
}: {
	label: string;
	children: React.ReactNode;
	hint?: string;
}) {
	const id = useId();
	return (
		<div className="settings-field">
			<label htmlFor={id}>{label}</label>
			{isValidElement<{ id?: string; "aria-describedby"?: string }>(children)
				? cloneElement(children, {
						id,
						"aria-describedby": hint ? `${id}-hint` : undefined,
					})
				: children}
			{hint && <small id={`${id}-hint`}>{hint}</small>}
		</div>
	);
}
import { knownLarmVoices } from "./larm-voices";
import { Subtitle } from "../../components/domains/subtitle/Subtitle";
const presentationLabel: Record<string, string> = {
	masculine: "（男性）",
	feminine: "（女性）",
	androgynous: "（中性）",
};
function SamplePlayer({
	client,
	voice,
	disabled,
}: {
	client: EumenesClient;
	voice: Parameters<EumenesClient["voiceSample"]>[0];
	disabled?: boolean;
}) {
	const [state, setState] = useState<"idle" | "loading" | "playing">("idle");
	const [error, setError] = useState<string | null>(null);
	const run = useRef<{ abort: AbortController; audio?: HTMLAudioElement }>(
		null,
	);
	const stop = useCallback(() => {
		run.current?.abort.abort();
		run.current?.audio?.pause();
		run.current = null;
		setState("idle");
	}, []);
	useEffect(() => stop, [stop]);
	async function play() {
		stop();
		setError(null);
		const mine = { abort: new AbortController() } as {
			abort: AbortController;
			audio?: HTMLAudioElement;
		};
		run.current = mine;
		setState("loading");
		try {
			const bytes = await client.voiceSample(voice, mine.abort.signal);
			if (run.current !== mine) return;
			const url = URL.createObjectURL(
				new Blob([new Uint8Array(bytes)], { type: "audio/wav" }),
			);
			const audio = new Audio(url);
			mine.audio = audio;
			const finish = () => {
				URL.revokeObjectURL(url);
				if (run.current === mine) {
					run.current = null;
					setState("idle");
				}
			};
			audio.onended = finish;
			audio.onerror = () => {
				finish();
				setError("サンプルを再生できませんでした。");
			};
			setState("playing");
			await audio.play();
		} catch (e) {
			if (mine.abort.signal.aborted) return;
			run.current = null;
			setState("idle");
			setError(
				`サンプルを作れませんでした（${e instanceof Error ? e.message : "不明なエラー"}）`,
			);
		}
	}
	return (
		<>
			<Button
				variant="secondary"
				disabled={disabled || state === "loading"}
				onClick={() => (state === "playing" ? stop() : void play())}
			>
				{state === "loading"
					? "準備中…"
					: state === "playing"
						? "サンプルを停止"
						: "サンプルを再生"}
			</Button>
			{error && <span role="alert">{error}</span>}
		</>
	);
}
function KnownVoiceSelect({
	value,
	emptyLabel,
	onChange,
	id,
	"aria-describedby": describedBy,
}: {
	value: string;
	emptyLabel: string;
	onChange: (id: string) => void;
	id?: string;
	"aria-describedby"?: string;
}) {
	const known = knownLarmVoices.some((v) => v.id === value);
	return (
		<select
			id={id}
			aria-describedby={describedBy}
			value={value}
			onChange={(e) => onChange(e.target.value)}
		>
			<option value="">{emptyLabel}</option>
			{value && !known && (
				<option value={value}>{value}（候補にありません）</option>
			)}
			{knownLarmVoices.map((v) => (
				<option key={v.id} value={v.id}>
					{v.name}
				</option>
			))}
		</select>
	);
}
function Toggle({
	label,
	value,
	onChange,
	hint,
}: {
	label: string;
	value: boolean;
	onChange: (v: boolean) => void;
	hint?: string;
}) {
	return (
		<label className="settings-toggle">
			<input
				type="checkbox"
				checked={value}
				onChange={(e) => onChange(e.target.checked)}
			/>
			<span>
				{label}
				{hint && <small>{hint}</small>}
			</span>
		</label>
	);
}
function SpeechSpeed({
	value,
	onChange,
	range,
}: {
	value: number;
	onChange: (v: number) => void;
	range?: TtsRange;
}) {
	return (
		<Field
			label={`話す速さ（${value.toFixed(1)}倍）`}
			hint="1.0倍が標準です。音声サービスの対応範囲で反映されます。"
		>
			<input
				type="range"
				min={range?.minimum ?? 0.5}
				max={range?.maximum ?? 2}
				step={0.1}
				value={value}
				onChange={(e) => onChange(Number(e.target.value))}
			/>
		</Field>
	);
}
export function useSettings(client: EumenesClient) {
	return useQuery({
		queryKey: ["settings", client.identity],
		queryFn: () => client.settings(),
		retry: 0,
	});
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
			cache.setQueryData(["settings", client.identity], saved);
		} catch {
			setError("ミュートを切り替えられませんでした");
			void cache.invalidateQueries({ queryKey: ["settings", client.identity] });
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
export function SettingsPage({
	renderServiceTests,
	client,
	onDirty,
	onSaved,
}: {
	client: EumenesClient;
	onDirty: (dirty: boolean) => void;
	onSaved: (value: Settings) => void;
	renderServiceTests?: (disabled: boolean) => React.ReactNode;
}) {
	const query = useSettings(client);
	const cache = useQueryClient();
	const [draft, setDraft] = useState<Settings | null>(null);
	const [keys, setKeys] = useState<ApplySettings["keys"]>([]);
	const [category, setCategory] =
		useState<(typeof categories)[number]["id"]>("general");
	const [message, setMessage] = useState("");
	const [busy, setBusy] = useState(false);
	const [retry, setRetry] = useState<ApplySettings | null>(null);
	const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
	const [deviceError, setDeviceError] = useState("");
	const [adding, setAdding] = useState(false);
	const [newCloud, setNewCloud] = useState({
		name: "",
		url: "",
		key: "",
		envRef: "",
		purpose: "llm" as Purpose,
		model: "",
		context: 8192,
		voice: "",
		assign: true,
	});
	const diagnostics = useQuery({
		queryKey: ["settings-diagnostics", client.identity],
		queryFn: () => client.settingsDiagnostics(),
		retry: 0,
	});
	const usage = useQuery({
		queryKey: ["inference-usage", client.identity],
		queryFn: () => client.inferenceUsage(),
		retry: 0,
	});
	const probes = useQuery({
		queryKey: ["inference-probes", client.identity],
		queryFn: () => client.inferenceProbes(),
		retry: 0,
	});
	const details = useQuery({
		queryKey: ["larm-details", client.identity],
		queryFn: () => client.larmDetails(),
		retry: 0,
	});
	const value = draft ?? query.data;
	const dirty = !!draft || keys.length > 0 || adding;
	const larmChanged =
		!!value &&
		!!query.data &&
		(value.larm.baseUrl !== query.data.larm.baseUrl ||
			value.larm.profile !== query.data.larm.profile ||
			value.larm.audience !== query.data.larm.audience);
	const voices = useQuery({
		queryKey: [
			"larm-voices",
			client.identity,
			query.data?.larm.baseUrl,
			query.data?.larm.profile,
			query.data?.larm.audience,
		],
		queryFn: ({ signal }) => client.larmVoices(signal),
		enabled: category === "voice" && !!value && !larmChanged,
		retry: 0,
	});
	useEffect(() => {
		onDirty(dirty);
		const prevent = (e: BeforeUnloadEvent) => {
			if (dirty) e.preventDefault();
		};
		window.addEventListener("beforeunload", prevent);
		return () => window.removeEventListener("beforeunload", prevent);
	}, [dirty, onDirty]);
	function change(fn: (s: Settings) => void) {
		if (!value) return;
		const next = structuredClone(value);
		fn(next);
		setDraft(next);
		setRetry(null);
		setMessage("");
	}
	async function apply() {
		if (!value || busy) return;
		const validated = settingsSchema.safeParse(value);
		if (!validated.success) {
			setMessage(validated.error.issues.map((i) => i.message).join(" / "));
			return;
		}
		setBusy(true);
		setMessage("");
		try {
			const input = retry ?? {
				requestId: crypto.randomUUID(),
				expectedRevision: value.revision,
				settings: value,
				keys,
			};
			setRetry(input);
			const saved = await client.applySettings(input);
			cache.setQueryData(["settings", client.identity], saved);
			setDraft((current) => {
				if (!current || current === input.settings) return null;
				const next = structuredClone(current);
				next.revision = saved.revision;
				for (const p of Object.keys(purposes) as Purpose[])
					next.routes[p].epoch = saved.routes[p].epoch;
				for (const c of next.connections) {
					const normalized = saved.connections.find((x) => x.id === c.id);
					const submitted = input.settings.connections.find(
						(x) => x.id === c.id,
					);
					if (normalized) {
						c.epoch = normalized.epoch;
						if (submitted?.envRef === c.envRef) c.envRef = normalized.envRef;
					}
				}
				return next;
			});
			setKeys((current) =>
				current.filter(
					(k) =>
						!input.keys.some(
							(sent) =>
								sent.connectionId === k.connectionId && sent.value === k.value,
						),
				),
			);
			setRetry(null);
			onSaved(saved);
			setMessage("変更を適用しました");
			void diagnostics.refetch();
		} catch (e) {
			setMessage(
				e instanceof Error && e.message === "revision_conflict"
					? "別の画面で設定が変更されました。最新の設定を読み直してから適用してください。"
					: `適用できませんでした: ${String(e)}`,
			);
		} finally {
			setBusy(false);
		}
	}
	function addCloud() {
		if (!value) return;
		const connectionId = crypto.randomUUID();
		const resourceId = crypto.randomUUID();
		const next = structuredClone(value);
		next.connections.push({
			id: connectionId,
			name: newCloud.name,
			baseUrl: newCloud.url,
			enabled: true,
			epoch: 0,
			envRef: newCloud.envRef || null,
		});
		next.resources.push({
			id: resourceId,
			connectionId,
			purpose: newCloud.purpose,
			model: newCloud.model,
			contextWindow: newCloud.purpose === "llm" ? newCloud.context : null,
			voice: newCloud.purpose === "tts" ? newCloud.voice : null,
		});
		if (newCloud.assign && !next.routes[newCloud.purpose].fallbackId)
			next.routes[newCloud.purpose].fallbackId = resourceId;
		const parsed = settingsSchema.safeParse(next);
		if (!parsed.success) {
			setMessage(parsed.error.issues.map((i) => i.message).join(" / "));
			return;
		}
		if (!newCloud.key && !newCloud.envRef) {
			setMessage("APIキーか環境変数名を指定してください");
			return;
		}
		if (newCloud.key && newCloud.envRef) {
			setMessage("APIキーと環境変数はどちらか一方を指定してください");
			return;
		}
		setDraft(parsed.data);
		if (newCloud.key)
			setKeys((k) => [...k, { connectionId, value: newCloud.key }]);
		setNewCloud({
			name: "",
			url: "",
			key: "",
			envRef: "",
			purpose: "llm",
			model: "",
			context: 8192,
			voice: "",
			assign: true,
		});
		setAdding(false);
		setRetry(null);
		setMessage("登録内容を確認して「変更を適用」を押してください");
	}
	async function downloadDiagnostics() {
		try {
			const [diagnostics, larm, usage] = await Promise.all([
				client.settingsDiagnostics(),
				client.larmDetails(),
				client.inferenceUsage(),
			]);
			const blob = new Blob(
				[
					JSON.stringify(
						{ generatedAt: new Date().toISOString(), diagnostics, larm, usage },
						null,
						2,
					),
				],
				{ type: "application/json" },
			);
			const url = URL.createObjectURL(blob);
			const link = document.createElement("a");
			link.href = url;
			link.download = "eumenes-diagnostics.json";
			link.click();
			setTimeout(() => URL.revokeObjectURL(url), 0);
		} catch (e) {
			setMessage(`診断データを保存できませんでした: ${String(e)}`);
		}
	}
	async function discover() {
		setDeviceError("");
		try {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			try {
				setDevices(await navigator.mediaDevices.enumerateDevices());
			} finally {
				stream.getTracks().forEach((t) => t.stop());
			}
		} catch {
			setDeviceError("マイクの許可または機器の接続を確認してください");
		}
	}
	async function probe(target: string) {
		try {
			await client.startProbe(target);
			await probes.refetch();
		} catch (e) {
			setMessage(`確認できませんでした: ${String(e)}`);
		}
	}
	if (!value)
		return (
			<section className="settings-loading">
				<h1>設定</h1>
				<p role={query.isError ? "alert" : "status"}>
					{query.isError
						? "設定を読み込めません。APIの接続を確認してください。"
						: "設定を読み込んでいます…"}
				</p>
			</section>
		);
	const outputSupported =
		typeof AudioContext !== "undefined" &&
		"setSinkId" in AudioContext.prototype;
	const voiceCatalog = larmChanged ? undefined : voices.data;
	const character = voiceCatalog?.voices.find(
		(v) => v.id === (value.larm.voice || voiceCatalog.default_voice),
	);
	const voicevox = voiceCatalog?.model === "voicevox-core";
	function selectCharacter(id: string) {
		const selected = voiceCatalog?.voices.find(
			(v) => v.id === (id || voiceCatalog.default_voice),
		);
		change((s) => {
			s.larm.voice = id;
			s.larm.style = selected?.default_style;
			for (const [field, capability] of [
				["speed", "speed"],
				["pitchScale", "pitch_scale"],
				["intonationScale", "intonation_scale"],
			] as const) {
				const range = selected?.capabilities[capability];
				const current = s.larm[field];
				if (
					range &&
					current !== undefined &&
					(current < range.minimum || current > range.maximum)
				)
					s.larm[field] = range.default;
			}
		});
	}
	const speechCredit =
		usage.data
			?.filter((u) => u.purpose === "tts" && u.accepted && u.source === "larm")
			.flatMap((u) => u.providerDetails ?? [])
			.find(
				(d) =>
					d.model === voiceCatalog?.model &&
					d.speechVoice === character?.id &&
					d.speechCredit,
			)?.speechCredit ?? character?.credit;
	return (
		<div className="settings-layout">
			<nav className="settings-nav" aria-label="設定カテゴリ">
				<h1>設定</h1>
				{categories.map(({ id, label }) => (
					<button
						type="button"
						key={label}
						aria-current={id === category ? "page" : undefined}
						onClick={() => setCategory(id)}
					>
						{label}
					</button>
				))}
			</nav>
			<section
				className={`settings-body${category === "services" ? " settings-playground" : ""}`}
				aria-label={categories.find((c) => c.id === category)?.label}
			>
				<header>
					<span className="section-kicker">SETTINGS</span>
					<h2>{categories.find((c) => c.id === category)?.label}</h2>
					<p className="hint">
						{category === "services"
							? "プロバイダを選んで、入力と結果を確認できます。"
							: category === "memory"
								? "保存した記憶を会話で使うかを切り替えます。変更はすぐに保存されます。"
								: category === "dictionary"
									? "読み上げの直前に、登録した文字を読み方へ置き換えます（長い登録が優先）。会話の表示は変わりません。変更は行ごとにすぐ保存されます。"
									: category === "general"
										? "AIの名前・あなたの名前・話し方を設定します。次の返答から反映されます。"
										: "普段はLARMを使い、必要なときに登録済みのクラウドへ切り替えます。"}
					</p>
				</header>
				{category === "services" && renderServiceTests?.(dirty)}
				{category === "general" && (
					<Card>
						<CardHeader>
							<CardTitle>会話</CardTitle>
						</CardHeader>
						<CardContent>
							<Field label="AIの名前" hint="空欄の場合は名前を設定しません。">
								<input
									type="text"
									maxLength={40}
									value={value.general.agentName}
									onChange={(e) =>
										change((s) => {
											s.general.agentName = e.target.value;
										})
									}
								/>
							</Field>
							<Field label="あなたの名前" hint="空欄の場合は名前で呼びません。">
								<input
									type="text"
									maxLength={40}
									value={value.general.userName}
									onChange={(e) =>
										change((s) => {
											s.general.userName = e.target.value;
										})
									}
								/>
							</Field>
							<Field
								label="利用する言語"
								hint="聞き取り結果がここにない言語の文字を含む場合は破棄します（最低1つ）。"
							>
								<fieldset className="language-options">
									{asrLanguages.map(([code, label]) => (
										<Toggle
											key={code}
											label={label}
											value={value.general.asrLanguages.includes(code)}
											onChange={(on) =>
												change((s) => {
													const next = on
														? [...s.general.asrLanguages, code]
														: s.general.asrLanguages.filter((c) => c !== code);
													if (next.length) s.general.asrLanguages = next;
												})
											}
										/>
									))}
								</fieldset>
							</Field>
							<Field label="口調">
								<select
									value={value.general.persona}
									onChange={(e) =>
										change((s) => {
											s.general.persona = e.target
												.value as Settings["general"]["persona"];
										})
									}
								>
									<option value="butler">執事</option>
									<option value="maid">メイド</option>
									<option value="strategist">参謀</option>
									<option value="sage">老師</option>
								</select>
							</Field>
						</CardContent>
					</Card>
				)}
				{category === "ai" && (
					<>
						<div className="settings-notice">
							クラウドへの自動切替は初期値で有効です。代替先を登録すると、会話・録音・読み上げ用のテキストが設定したAPIへ送信されます。
						</div>
						{(Object.keys(purposes) as Purpose[]).map((p) => (
							<Card key={p}>
								<CardHeader>
									<CardTitle>{purposes[p]}</CardTitle>
								</CardHeader>
								<CardContent>
									<Field label="使い方">
										<select
											value={value.routes[p].mode}
											onChange={(e) =>
												change((s) => {
													s.routes[p].mode = e.target
														.value as Settings["routes"][Purpose]["mode"];
												})
											}
										>
											<option value="larm-preferred">
												LARMを優先・クラウドへ自動切替
											</option>
											<option value="larm-only">LARMのみ</option>
											<option value="cloud-only">クラウドのみ</option>
										</select>
									</Field>
									<Field label="クラウド代替先">
										<select
											value={value.routes[p].fallbackId ?? ""}
											onChange={(e) =>
												change((s) => {
													s.routes[p].fallbackId = e.target.value || null;
												})
											}
										>
											<option value="">未登録</option>
											{value.resources
												.filter((r) => r.purpose === p)
												.map((r) => (
													<option key={r.id} value={r.id}>
														{
															value.connections.find(
																(c) => c.id === r.connectionId,
															)?.name
														}{" "}
														/ {r.model}
													</option>
												))}
										</select>
									</Field>
									<Toggle
										label="この用途でクラウド送信を許可"
										value={value.routes[p].cloudAllowed}
										onChange={(v) =>
											change((s) => {
												s.routes[p].cloudAllowed = v;
												if (!v && s.routes[p].mode === "cloud-only")
													s.routes[p].mode = "larm-only";
											})
										}
										hint="許可を取り消して適用すると、実行中のクラウド処理も取り消します。"
									/>
									{!value.routes[p].fallbackId && (
										<p className="hint">
											代替先が未登録のため、現在はLARMを使います。
										</p>
									)}
									<p className="hint">
										直近の利用:{" "}
										{(() => {
											const last = usage.data?.find(
												(u) => u.purpose === p && u.accepted,
											);
											return last
												? `${last.source === "larm" ? "LARM" : "クラウド"} / ${last.model}`
												: "まだありません";
										})()}
									</p>
								</CardContent>
							</Card>
						))}
					</>
				)}
				{category === "connections" && (
					<>
						<Card>
							<CardHeader>
								<CardTitle>LARM</CardTitle>
							</CardHeader>
							<CardContent>
								<Field
									label="LARMのURL"
									hint="空欄ならbackend既定のLARMに接続します。"
								>
									<Input
										value={value.larm.baseUrl ?? ""}
										placeholder="http://127.0.0.1:…"
										onChange={(e) =>
											change((s) => {
												s.larm.baseUrl = e.target.value || null;
											})
										}
									/>
								</Field>
								<Field label="Profile">
									<Input
										value={value.larm.profile}
										onChange={(e) =>
											change((s) => {
												s.larm.profile = e.target.value;
											})
										}
									/>
								</Field>
								<Field label="接続方式">
									<select
										value={value.larm.audience}
										onChange={(e) =>
											change((s) => {
												s.larm.audience = e.target
													.value as Settings["larm"]["audience"];
											})
										}
									>
										<option value="saaa-desktop">LARMが提供する接続</option>
										<option value="same-host">同じ端末の接続</option>
									</select>
								</Field>
								<Field
									label="読み上げ音声の上書き"
									hint="空欄ならLARMが指定する音声を使います。"
								>
									<KnownVoiceSelect
										value={value.larm.voice}
										emptyLabel="LARMの指定に従う"
										onChange={(id) =>
											change((s) => {
												s.larm.voice = id;
											})
										}
									/>
								</Field>
								<p className="hint">
									LARMの認証情報はbackendの環境変数を使います。音声にはProfile全体の提供が必要です。
								</p>
								<Button
									variant="secondary"
									disabled={dirty}
									onClick={() => void probe("larm")}
								>
									LARMの接続を確認
								</Button>
								{details.data?.providers.map((p) => (
									<p key={p.name}>
										{purposes[p.name as Purpose]}: {p.model}
										<small className="hint"> {p.baseUrl}</small>
									</p>
								))}
							</CardContent>
						</Card>
						{value.connections.map((c) => (
							<Card key={c.id}>
								<CardHeader>
									<CardTitle>{c.name}</CardTitle>
								</CardHeader>
								<CardContent>
									<Field label="接続名">
										<Input
											value={c.name}
											onChange={(e) =>
												change((s) => {
													s.connections.find((x) => x.id === c.id)!.name =
														e.target.value;
												})
											}
										/>
									</Field>
									<Field label="APIのベースURL">
										<Input
											value={c.baseUrl}
											onChange={(e) =>
												change((s) => {
													s.connections.find((x) => x.id === c.id)!.baseUrl =
														e.target.value;
												})
											}
										/>
									</Field>
									<Field
										label="認証用の環境変数名"
										hint="環境変数を使う場合はAPIキー欄を空にしてください。"
									>
										<Input
											value={c.envRef ?? ""}
											onChange={(e) =>
												change((s) => {
													s.connections.find((x) => x.id === c.id)!.envRef =
														e.target.value || null;
												})
											}
										/>
									</Field>
									<Toggle
										label="この接続を有効にする"
										value={c.enabled}
										onChange={(v) =>
											change((s) => {
												s.connections.find((x) => x.id === c.id)!.enabled = v;
											})
										}
									/>
									<Field
										label="APIキーの更新"
										hint="空欄なら保存済みのキーを維持します。"
									>
										<Input
											type="password"
											autoComplete="new-password"
											value={
												keys.find((k) => k.connectionId === c.id)?.value ?? ""
											}
											onChange={(e) => {
												setKeys((k) => [
													...k.filter((x) => x.connectionId !== c.id),
													...(e.target.value
														? [{ connectionId: c.id, value: e.target.value }]
														: []),
												]);
												setRetry(null);
											}}
										/>
									</Field>
									<p className="hint">
										認証:{" "}
										{diagnostics.data?.connections.find((x) => x.id === c.id)
											?.credentialAvailable
											? "登録済み"
											: "未登録"}
										{c.envRef && `（環境変数 ${c.envRef}）`}
									</p>
									<div className="settings-actions">
										<Button
											variant="secondary"
											onClick={() => {
												setKeys((k) => [
													...k.filter((x) => x.connectionId !== c.id),
													{ connectionId: c.id, value: null },
												]);
												setRetry(null);
											}}
										>
											キーを削除
										</Button>
										<Button
											variant="secondary"
											onClick={() =>
												change((s) => {
													const refs = s.resources
														.filter((r) => r.connectionId === c.id)
														.map((r) => r.id);
													s.connections = s.connections.filter(
														(x) => x.id !== c.id,
													);
													s.resources = s.resources.filter(
														(r) => r.connectionId !== c.id,
													);
													for (const p of Object.keys(purposes) as Purpose[])
														if (refs.includes(s.routes[p].fallbackId ?? "")) {
															s.routes[p].fallbackId = null;
															if (s.routes[p].mode === "cloud-only")
																s.routes[p].mode = "larm-preferred";
														}
													setKeys((k) =>
														k.filter((x) => x.connectionId !== c.id),
													);
												})
											}
										>
											接続を削除
										</Button>
									</div>
									{value.resources
										.filter((r) => r.connectionId === c.id)
										.map((r) => (
											<div className="settings-resource" key={r.id}>
												<strong>{purposes[r.purpose]}</strong>
												<Field label="用途">
													<select
														value={r.purpose}
														onChange={(e) =>
															change((s) => {
																const resource = s.resources.find(
																	(x) => x.id === r.id,
																)!;
																const old = resource.purpose;
																resource.purpose = e.target.value as Purpose;
																resource.contextWindow =
																	resource.purpose === "llm" ? 8192 : null;
																resource.voice =
																	resource.purpose === "tts" ? "" : null;
																if (s.routes[old].fallbackId === r.id) {
																	s.routes[old].fallbackId = null;
																	if (s.routes[old].mode === "cloud-only")
																		s.routes[old].mode = "larm-preferred";
																}
															})
														}
													>
														{Object.entries(purposes).map(([p, label]) => (
															<option key={p} value={p}>
																{label}
															</option>
														))}
													</select>
												</Field>
												<Field label="モデル名">
													<Input
														value={r.model}
														onChange={(e) =>
															change((s) => {
																s.resources.find((x) => x.id === r.id)!.model =
																	e.target.value;
															})
														}
													/>
												</Field>
												{r.purpose === "llm" && (
													<Field label="文脈長">
														<Input
															type="number"
															min={2048}
															value={r.contextWindow ?? 8192}
															onChange={(e) =>
																change((s) => {
																	s.resources.find(
																		(x) => x.id === r.id,
																	)!.contextWindow = Number(e.target.value);
																})
															}
														/>
													</Field>
												)}
												{r.purpose === "tts" && (
													<Field label="音声名">
														<Input
															value={r.voice ?? ""}
															onChange={(e) =>
																change((s) => {
																	s.resources.find(
																		(x) => x.id === r.id,
																	)!.voice = e.target.value;
																})
															}
														/>
													</Field>
												)}
												{
													<Button
														variant="secondary"
														disabled={dirty || !c.enabled}
														onClick={() => void probe(r.id)}
													>
														{r.purpose === "llm"
															? "少量の会話テスト"
															: r.purpose === "asr"
																? "聞き取りテスト（無音）"
																: "読み上げ生成テスト"}
													</Button>
												}
											</div>
										))}
									<Button
										variant="secondary"
										onClick={() =>
											change((s) => {
												const p: Purpose = "llm";
												s.resources.push({
													id: crypto.randomUUID(),
													connectionId: c.id,
													purpose: p,
													model: "",
													contextWindow: 8192,
													voice: null,
												});
											})
										}
									>
										この接続にモデルを追加
									</Button>
								</CardContent>
							</Card>
						))}
						{!adding ? (
							<Button onClick={() => setAdding(true)}>クラウドAPIを登録</Button>
						) : (
							<Card>
								<CardHeader>
									<CardTitle>クラウドAPIの登録</CardTitle>
								</CardHeader>
								<CardContent>
									<p className="hint">
										OpenAI互換の会話・音声認識・WAV音声合成に対応します。
									</p>
									<Field label="接続名">
										<Input
											value={newCloud.name}
											onChange={(e) =>
												setNewCloud((n) => ({ ...n, name: e.target.value }))
											}
										/>
									</Field>
									<Field
										label="APIのベースURL"
										hint="例: https://example.com/v1。末尾に用途別のAPIパスを追加します。"
									>
										<Input
											value={newCloud.url}
											onChange={(e) =>
												setNewCloud((n) => ({ ...n, url: e.target.value }))
											}
										/>
									</Field>
									<Field label="APIキー">
										<Input
											type="password"
											autoComplete="new-password"
											value={newCloud.key}
											onChange={(e) =>
												setNewCloud((n) => ({ ...n, key: e.target.value }))
											}
										/>
									</Field>
									<Field label="環境変数名（APIキーの代わり）">
										<Input
											value={newCloud.envRef}
											onChange={(e) =>
												setNewCloud((n) => ({ ...n, envRef: e.target.value }))
											}
										/>
									</Field>
									<Field label="用途">
										<select
											value={newCloud.purpose}
											onChange={(e) =>
												setNewCloud((n) => ({
													...n,
													purpose: e.target.value as Purpose,
												}))
											}
										>
											{Object.entries(purposes).map(([p, label]) => (
												<option key={p} value={p}>
													{label}
												</option>
											))}
										</select>
									</Field>
									<Field label="モデル名">
										<Input
											value={newCloud.model}
											onChange={(e) =>
												setNewCloud((n) => ({ ...n, model: e.target.value }))
											}
										/>
									</Field>
									{newCloud.purpose === "llm" && (
										<Field label="文脈長">
											<Input
												type="number"
												value={newCloud.context}
												onChange={(e) =>
													setNewCloud((n) => ({
														...n,
														context: Number(e.target.value),
													}))
												}
											/>
										</Field>
									)}
									{newCloud.purpose === "tts" && (
										<Field label="音声名">
											<Input
												value={newCloud.voice}
												onChange={(e) =>
													setNewCloud((n) => ({ ...n, voice: e.target.value }))
												}
											/>
										</Field>
									)}
									<Toggle
										label="この用途の代替先として使う"
										value={newCloud.assign}
										onChange={(v) => setNewCloud((n) => ({ ...n, assign: v }))}
										hint="既に代替先を選んでいる場合は、その選択を維持します。"
									/>
									<div className="settings-actions">
										<Button onClick={addCloud}>登録内容を追加</Button>
										<Button
											variant="secondary"
											onClick={() => {
												setAdding(false);
												setNewCloud((n) => ({ ...n, key: "" }));
											}}
										>
											やめる
										</Button>
									</div>
								</CardContent>
							</Card>
						)}
						<div className="settings-resource">
							<h3>接続確認の記録</h3>
							<p className="hint">
								保存した設定で確認します。会話テストはAPIへの送信と少量の利用が発生します。
							</p>
							{probes.data?.map((p) => (
								<p key={p.id}>
									{p.target === "larm"
										? "LARM"
										: (value.resources.find((r) => r.id === p.target)?.model ??
											"削除されたモデル")}
									: {p.status}
									{p.error && ` (${p.error})`}
									{p.revision !== value.revision && " — 以前の設定"}
									{p.status === "running" && (
										<Button
											size="sm"
											onClick={() =>
												void client
													.cancelProbe(p.id)
													.then(() => probes.refetch())
											}
										>
											取消
										</Button>
									)}
								</p>
							))}
						</div>
					</>
				)}
				{category === "voice" && (
					<>
						<Card>
							<CardHeader>
								<CardTitle>アバターの読み上げ音声</CardTitle>
							</CardHeader>
							<CardContent>
								<p className="hint">
									変更を適用すると、声と速さは次の発話から、音量は次の再生から反映します。
								</p>
								<Field
									label={`読み上げ音量（${Math.round(value.voice.outputVolume * 100)}%）`}
									hint="0%で消音になります。マイクの音量には影響しません。"
								>
									<input
										type="range"
										min={0}
										max={1}
										step={0.05}
										value={value.voice.outputVolume}
										onChange={(e) =>
											change((s) => {
												s.voice.outputVolume = Number(e.target.value);
											})
										}
									/>
								</Field>
								<div className="settings-resource">
									<h3>LARMの声</h3>
									<Field
										label="キャラクター"
										hint="自動選択では、LARMが指定する声を使います。"
									>
										{voices.data &&
										!larmChanged &&
										voices.data.voices.length > 0 ? (
											<select
												value={value.larm.voice}
												onChange={(e) => selectCharacter(e.target.value)}
											>
												<option value="">
													既定のキャラクター
													{voiceCatalog?.default_voice &&
														`（${voiceCatalog.voices.find((v) => v.id === voiceCatalog.default_voice)?.display_name ?? voiceCatalog.default_voice}）`}
												</option>
												{value.larm.voice &&
													!voices.data.voices.some(
														(v) => v.id === value.larm.voice,
													) && (
														<option value={value.larm.voice}>
															{value.larm.voice}（現在の一覧にありません）
														</option>
													)}
												{voices.data.voices.map((v) => (
													<option key={v.id} value={v.id}>
														{v.display_name}
														{presentationLabel[v.voice_presentation ?? ""] ??
															""}
													</option>
												))}
											</select>
										) : (
											<KnownVoiceSelect
												value={value.larm.voice}
												emptyLabel="既定のキャラクター"
												onChange={selectCharacter}
											/>
										)}
									</Field>
									{larmChanged ? (
										<p className="hint">
											接続先の変更を適用すると、声の一覧を取得できます。
										</p>
									) : voices.isFetching ? (
										<output>声の一覧を取得しています…</output>
									) : (
										(voices.isError || voices.data?.voices.length === 0) && (
											<p className="hint">
												声の一覧を取得できません。保存したキャラクターと調整値は保持しています。
											</p>
										)
									)}
									{voiceCatalog && value.larm.voice && !character && (
										<p role="alert">
											保存したキャラクターが一覧にありません。再取得するか、既定のキャラクターに戻してください。
										</p>
									)}
									<div className="settings-actions">
										<Button
											variant="secondary"
											disabled={voices.isFetching || larmChanged}
											onClick={() => void voices.refetch()}
										>
											声の一覧を再取得
										</Button>
										<Button
											variant="secondary"
											onClick={() => selectCharacter("")}
										>
											既定のキャラクターに戻す
										</Button>
										<SamplePlayer
											client={client}
											disabled={larmChanged}
											voice={{
												voice: value.larm.voice || undefined,
												style: value.larm.style,
												speed: value.larm.speed,
												pitchScale: value.larm.pitchScale,
												intonationScale: value.larm.intonationScale,
											}}
										/>
									</div>
									{voicevox && character && (
										<>
											<Field label="発話スタイル">
												<select
													value={
														value.larm.style ?? character.default_style ?? ""
													}
													onChange={(e) =>
														change((s) => {
															s.larm.style = e.target.value || undefined;
														})
													}
												>
													<option value="">キャラクターの既定スタイル</option>
													{value.larm.style &&
														!character.styles.some(
															(s) => s.id === value.larm.style,
														) && (
															<option value={value.larm.style}>
																{value.larm.style}（このキャラクターでは未対応）
															</option>
														)}
													{character.styles.map((s) => (
														<option key={s.id} value={s.id}>
															{s.display_name}
														</option>
													))}
												</select>
											</Field>
											{(
												[
													[
														"pitchScale",
														"pitch_scale",
														"声の高さ",
														-0.15,
														0.15,
														0,
														0.01,
													],
													[
														"intonationScale",
														"intonation_scale",
														"抑揚",
														0,
														2,
														1,
														0.05,
													],
												] as const
											).map(
												([
													field,
													capability,
													label,
													min,
													max,
													standard,
													step,
												]) => {
													const range = character.capabilities[capability];
													const setting =
														value.larm[field] ?? range?.default ?? standard;
													return (
														<Field
															key={field}
															label={`${label}（${setting.toFixed(2)}）`}
															hint={
																field === "pitchScale"
																	? "数値は音声サービスの調整値です。0が基準です。"
																	: "1が基準、0で平坦になります。"
															}
														>
															<input
																type="range"
																min={range?.minimum ?? min}
																max={range?.maximum ?? max}
																step={step}
																value={setting}
																disabled={!range}
																onChange={(e) =>
																	change((s) => {
																		s.larm[field] = Number(e.target.value);
																	})
																}
															/>
														</Field>
													);
												},
											)}
											<Toggle
												label="文章に合わせて抑揚・速さ・高さを変える（簡易）"
												value={value.larm.autoIntonation ?? false}
												onChange={(v) =>
													change((s) => {
														s.larm.autoIntonation = v;
														if (v && s.larm.intonationScale === undefined)
															s.larm.intonationScale =
																character.capabilities.intonation_scale
																	?.default ?? 1;
													})
												}
												hint="疑問文・感嘆文・注意を促す文の抑揚・速さ・高さを、設定値を基準に句ごとに増減させます。"
											/>
											{value.larm.autoIntonation && (
												<Field
													label={`自動調整の強さ（${Math.round((value.larm.autoStrength ?? 1) * 100)}%）`}
													hint="上の設定値を基準に、文章ごとに増減させる幅の倍率です。0%で基準値のまま、200%で2倍まで動かします。"
												>
													<input
														type="range"
														min={0}
														max={2}
														step={0.05}
														value={value.larm.autoStrength ?? 1}
														onChange={(e) =>
															change((s) => {
																s.larm.autoStrength = Number(e.target.value);
															})
														}
													/>
												</Field>
											)}
										</>
									)}
									{voiceCatalog && !voicevox && (
										<p className="hint">
											このモデルではVOICEVOXのスタイル・高さ・抑揚を使いません。
										</p>
									)}
									<SpeechSpeed
										value={
											value.larm.speed ??
											character?.capabilities.speed?.default ??
											1
										}
										range={character?.capabilities.speed}
										onChange={(v) =>
											change((s) => {
												s.larm.speed = v;
											})
										}
									/>
									{speechCredit && (
										<p className="hint">クレジット: {speechCredit}</p>
									)}
								</div>
								{value.resources
									.filter((r) => r.purpose === "tts")
									.map((r) => (
										<div className="settings-resource" key={r.id}>
											<h3>
												{
													value.connections.find((c) => c.id === r.connectionId)
														?.name
												}{" "}
												/ {r.model}
											</h3>
											<p className="hint">
												{value.routes.tts.fallbackId === r.id
													? "現在のクラウド読み上げ先です。"
													: "この接続先を読み上げに選んだときに使います。"}
											</p>
											<Field
												label="クラウドの声の種類（音声ID）"
												hint="このサービスが提供する音声IDを入力してください。"
											>
												<Input
													value={r.voice ?? ""}
													maxLength={200}
													onChange={(e) =>
														change((s) => {
															s.resources.find((x) => x.id === r.id)!.voice =
																e.target.value;
														})
													}
												/>
											</Field>
											<SpeechSpeed
												value={r.speed ?? 1}
												onChange={(v) =>
													change((s) => {
														s.resources.find((x) => x.id === r.id)!.speed = v;
													})
												}
											/>
										</div>
									))}
								{!value.resources.some((r) => r.purpose === "tts") && (
									<p className="hint">
										クラウドの声を使う場合は「接続先」で読み上げ用のモデルを登録してください。
									</p>
								)}
							</CardContent>
						</Card>
						<Card>
							<CardHeader>
								<CardTitle>声での会話</CardTitle>
							</CardHeader>
							<CardContent>
								<p className="hint">
									録音と機器の調整は次の音声開始から、読み上げの設定は次の発話から反映します。
								</p>
								<Toggle
									label="回答を読み上げる"
									value={value.voice.autoSpeak}
									onChange={(v) =>
										change((s) => {
											s.voice.autoSpeak = v;
										})
									}
									hint="オフでも回答のテキストは会話に残ります。"
								/>
								<Toggle
									label="話し始めたら読み上げを止める"
									value={value.voice.bargeIn}
									onChange={(v) =>
										change((s) => {
											s.voice.bargeIn = v;
										})
									}
								/>
								<Button variant="secondary" onClick={() => void discover()}>
									音声機器を確認
								</Button>
								{deviceError && <p role="alert">{deviceError}</p>}
								<Field
									label="マイク"
									hint="変更は次に音声を開始したときに反映されます。"
								>
									<select
										value={value.voice.inputDevice}
										onChange={(e) =>
											change((s) => {
												s.voice.inputDevice = e.target.value;
											})
										}
									>
										<option value="">システム標準</option>
										{devices
											.filter((d) => d.kind === "audioinput")
											.map((d) => (
												<option key={d.deviceId} value={d.deviceId}>
													{d.label || "マイク"}
												</option>
											))}
										{value.voice.inputDevice &&
											!devices.some(
												(d) => d.deviceId === value.voice.inputDevice,
											) && (
												<option value={value.voice.inputDevice}>
													選択したマイクを確認できません
												</option>
											)}
									</select>
								</Field>
								{outputSupported ? (
									<Field label="再生機器">
										<select
											value={value.voice.outputDevice}
											onChange={(e) =>
												change((s) => {
													s.voice.outputDevice = e.target.value;
												})
											}
										>
											<option value="">システム標準</option>
											{devices
												.filter((d) => d.kind === "audiooutput")
												.map((d) => (
													<option key={d.deviceId} value={d.deviceId}>
														{d.label || "再生機器"}
													</option>
												))}
											{value.voice.outputDevice &&
												!devices.some(
													(d) => d.deviceId === value.voice.outputDevice,
												) && (
													<option value={value.voice.outputDevice}>
														選択した機器を確認できません
													</option>
												)}
										</select>
									</Field>
								) : (
									<p className="hint">
										このブラウザでは再生先の切替に対応していません。システム標準を使います。
									</p>
								)}
								<Field
									label="声を検出するしきい値"
									hint="小さい値ほど小さな声を拾います。"
								>
									<Input
										type="number"
										min={0.001}
										max={0.1}
										step={0.001}
										value={value.voice.threshold}
										onChange={(e) =>
											change((s) => {
												s.voice.threshold = Number(e.target.value);
											})
										}
									/>
								</Field>
								<Field label="発話を確定する無音時間（ミリ秒）">
									<Input
										type="number"
										min={300}
										max={3000}
										step={100}
										value={value.voice.silenceMs}
										onChange={(e) =>
											change((s) => {
												s.voice.silenceMs = Number(e.target.value);
											})
										}
									/>
								</Field>
								{(
									[
										"echoCancellation",
										"noiseSuppression",
										"autoGainControl",
									] as const
								).map((key, i) => (
									<Toggle
										key={key}
										label={
											[
												"エコーを抑える",
												"周囲の雑音を抑える",
												"マイクの音量を自動調整する",
											][i]!
										}
										value={value.voice[key]}
										onChange={(v) =>
											change((s) => {
												s.voice[key] = v;
											})
										}
									/>
								))}
							</CardContent>
						</Card>
					</>
				)}
				{category === "data" && (
					<>
						<Card>
							<CardHeader>
								<CardTitle>保存と送信</CardTitle>
							</CardHeader>
							<CardContent>
								<p>
									会話・設定・予約はこの端末のデータベースに保存します。APIキーは暗号化してbackendに保管します。
								</p>
								<p>
									クラウド送信の許可は「AIの使い方」で用途ごとに変更できます。費用は利用したサービスで確認してください。
								</p>
								<Button
									variant="secondary"
									onClick={() => void downloadDiagnostics()}
								>
									診断データを保存
								</Button>
								<p className="hint">
									接続状態と利用先の記録を保存します。APIキー・会話本文・録音は含めません。
								</p>
								{diagnostics.data?.keyError && (
									<p role="alert">
										保存済みキーを開けません。backendの暗号鍵を確認してください。LARMと環境変数による接続は引き続き利用できます。
									</p>
								)}
							</CardContent>
						</Card>
						<h3>直近100件の利用記録</h3>
						<div className="settings-table-wrap">
							<table>
								<thead>
									<tr>
										<th>用途</th>
										<th>利用先</th>
										<th>結果</th>
										<th>切替・失敗理由</th>
										<th>入力 / 出力トークン</th>
									</tr>
								</thead>
								<tbody>
									{usage.data?.map((u) => (
										<tr key={u.id}>
											<td>{purposes[u.purpose]}</td>
											<td>
												{u.source} / {u.model}
											</td>
											<td>{u.accepted ? "採用済み" : u.status}</td>
											<td>{u.reason ?? "—"}</td>
											<td>
												{u.inputTokens ?? "不明"} / {u.outputTokens ?? "不明"}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
						{!usage.data?.length && (
							<p className="hint">利用記録はまだありません。</p>
						)}
						{usage.isError && <p role="alert">利用記録を読み込めません。</p>}
					</>
				)}
				{category === "schedule" && <SchedulePanel client={client} />}
				{category === "dictionary" && <TtsDictionaryPanel client={client} />}
				{category === "memory" && (
					<MemoryConnectionPanel key={client.identity} client={client} />
				)}
				{category === "appearance" && (
					<Card>
						<CardHeader>
							<CardTitle>表示</CardTitle>
						</CardHeader>
						<CardContent>
							<Field label="テーマ">
								<select
									value={value.general.theme}
									onChange={(e) =>
										change((s) => {
											s.general.theme = e.target
												.value as Settings["general"]["theme"];
										})
									}
								>
									<option value="system">端末の設定に合わせる</option>
									<option value="light">ライト</option>
									<option value="dark">ダーク</option>
								</select>
							</Field>
							<Toggle
								label="読み上げ字幕を表示する"
								value={value.general.subtitles.enabled}
								onChange={(v) =>
									change((s) => {
										s.general.subtitles.enabled = v;
									})
								}
								hint="読み上げに合わせて画面中央に字幕を出します。"
							/>
							<Field label="字幕のデザイン">
								<select
									value={value.general.subtitles.style}
									onChange={(e) =>
										change((s) => {
											s.general.subtitles.style = e.target
												.value as Settings["general"]["subtitles"]["style"];
										})
									}
								>
									<option value="netflix">シネマ（白文字・影）</option>
									<option value="prime">ボックス（半透明の黒背景）</option>
									<option value="classic">クラシック（黄文字・黒縁）</option>
									<option value="glass">ガラス（ぼかし背景）</option>
								</select>
							</Field>
							<Field label="字幕の大きさ">
								<select
									value={value.general.subtitles.size}
									onChange={(e) =>
										change((s) => {
											s.general.subtitles.size = e.target
												.value as Settings["general"]["subtitles"]["size"];
										})
									}
								>
									<option value="medium">中</option>
									<option value="large">大</option>
									<option value="xlarge">特大</option>
								</select>
							</Field>
							<div className="subtitle-preview-stage" aria-hidden="true">
								<Subtitle
									text="これは字幕のプレビューです。"
									style={value.general.subtitles.style}
									size={value.general.subtitles.size}
									inline
								/>
							</div>
						</CardContent>
					</Card>
				)}
				{category !== "dictionary" &&
					category !== "memory" &&
					category !== "services" && (
						<footer className="settings-footer">
							<output>
								{message && dirty && message === "変更を適用しました"
									? "送信した変更を適用しました。追加の変更は未適用です。"
									: message ||
										(dirty
											? "変更はまだ保存されていません"
											: "すべての変更を保存済み")}
							</output>
							<div className="settings-actions">
								<Button
									variant="secondary"
									disabled={busy}
									onClick={() => {
										setDraft(null);
										setKeys([]);
										setRetry(null);
										setAdding(false);
										setNewCloud((n) => ({ ...n, key: "" }));
										setMessage("");
										void query.refetch();
									}}
								>
									最新の設定を読み直す
								</Button>
								<Button
									disabled={!dirty || adding || busy}
									onClick={() => void apply()}
								>
									{busy ? "適用中…" : "変更を適用"}
								</Button>
							</div>
						</footer>
					)}
			</section>
		</div>
	);
}
function SchedulePanel({ client }: { client: EumenesClient }) {
	const query = useInfiniteQuery({
		queryKey: ["settings-schedules", client.identity],
		initialPageParam: null as string | null,
		queryFn: ({ pageParam }) =>
			client.schedules({ limit: 100, cursor: pageParam ?? undefined }),
		getNextPageParam: (last) => last.nextCursor,
		retry: 0,
	});
	const [text, setText] = useState("");
	const [at, setAt] = useState("");
	const [interval, setInterval] = useState(false);
	const [minutes, setMinutes] = useState(60);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [selected, setSelected] = useState<string | null>(null);
	const occurrences = useInfiniteQuery({
		queryKey: ["settings-occurrences", client.identity, selected],
		initialPageParam: null as string | null,
		queryFn: ({ pageParam }) =>
			client.scheduleOccurrences(selected!, { cursor: pageParam ?? undefined }),
		getNextPageParam: (last) => last.nextCursor,
		enabled: !!selected,
		retry: 0,
	});
	async function act(fn: () => Promise<unknown>) {
		setBusy(true);
		setError("");
		try {
			await fn();
			await query.refetch();
		} catch (e) {
			setError(String(e));
		} finally {
			setBusy(false);
		}
	}
	return (
		<>
			<Card>
				<CardHeader>
					<CardTitle>会話を予約する</CardTitle>
				</CardHeader>
				<CardContent>
					<Field label="依頼内容">
						<Input value={text} onChange={(e) => setText(e.target.value)} />
					</Field>
					<Field label="実行日時（端末の時刻）">
						<Input
							type="datetime-local"
							value={at}
							onChange={(e) => setAt(e.target.value)}
						/>
					</Field>
					<Toggle
						label="固定間隔で繰り返す"
						value={interval}
						onChange={setInterval}
					/>
					{interval && (
						<Field label="間隔（分）">
							<Input
								type="number"
								min={1}
								value={minutes}
								onChange={(e) => setMinutes(Number(e.target.value))}
							/>
						</Field>
					)}
					<Button
						disabled={busy || !text.trim() || !at}
						onClick={() =>
							void act(async () => {
								const iso = new Date(at).toISOString();
								await client.createSchedule({
									requestId: crypto.randomUUID(),
									target: {
										kind: "dialogue.prompt",
										payload: { conversationId: "main", text },
									},
									schedule: interval
										? {
												type: "interval",
												anchor: iso,
												intervalMs: minutes * 60000,
											}
										: { type: "once", at: iso },
								});
								setText("");
							})
						}
					>
						予約を作成
					</Button>
					<p className="hint">
						Eumenesが起動している間に実行します。過ぎた予約は既存の予約処理の規則に従います。
					</p>
				</CardContent>
			</Card>
			{error && <p role="alert">{error}</p>}
			{query.isError && <p role="alert">予約を読み込めません。</p>}
			{query.data?.pages
				.flatMap((p) => p.items)
				.map((s) => (
					<Card key={s.id}>
						<CardContent>
							<p>
								{(s.targetPayload as { text?: string }).text ?? s.targetKind}
							</p>
							<p className="hint">
								{s.state} / 次回: {s.nextDueAt ?? "なし"}
							</p>
							<div className="settings-actions">
								{s.state === "active" && (
									<Button
										variant="secondary"
										disabled={busy}
										onClick={() =>
											void act(() => client.pauseSchedule(s.id, s.revision))
										}
									>
										一時停止
									</Button>
								)}
								{s.state === "paused" && (
									<Button
										variant="secondary"
										disabled={busy}
										onClick={() =>
											void act(() => client.resumeSchedule(s.id, s.revision))
										}
									>
										再開
									</Button>
								)}
								{["active", "paused"].includes(s.state) && (
									<Button
										variant="secondary"
										disabled={busy}
										onClick={() =>
											void act(() => client.cancelSchedule(s.id, s.revision))
										}
									>
										今後の予約を取消
									</Button>
								)}
								<Button variant="secondary" onClick={() => setSelected(s.id)}>
									実行履歴
								</Button>
							</div>
							<p className="hint">
								予約を取り消しても、受付済みの会話は続きます。会話の「実行記録」から取り消せます。
							</p>
						</CardContent>
					</Card>
				))}
			{query.hasNextPage && (
				<Button
					variant="secondary"
					disabled={query.isFetchingNextPage}
					onClick={() => void query.fetchNextPage()}
				>
					続きを読み込む
				</Button>
			)}
			{selected && (
				<section>
					<h3>予約の実行履歴</h3>
					{occurrences.data?.pages
						.flatMap((p) => p.items)
						.map((o) => (
							<p key={o.id}>
								{o.scheduledAt}: {o.state} / {o.jobState ?? o.reason ?? "—"}
							</p>
						))}
					{occurrences.hasNextPage && (
						<Button
							disabled={occurrences.isFetchingNextPage}
							onClick={() => void occurrences.fetchNextPage()}
						>
							履歴の続きを読み込む
						</Button>
					)}
				</section>
			)}
		</>
	);
}
