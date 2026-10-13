import { DotsPanel } from "../dots";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { EumenesClient } from "../../../../client";
import {
	settingsSchema,
	type Settings,
} from "../../../../api/domains/settings/contracts";
import { queryRoots } from "../../queryKeys";
import { describeError } from "../../errorMessages";
import { TtsDictionaryPanel } from "../tts-dictionary";
import { emptyCloud } from "./shared";
import { AiSection } from "./sections/ai";
import { AppearanceSection } from "./sections/appearance";
import { ConnectionsSection } from "./sections/connections";
import { DataSection } from "./sections/data";
import { GeneralSection } from "./sections/general";
import { SchedulePanel as ScheduleSection } from "./sections/schedule";
import { VoiceSection } from "./sections/voice";
import { MemoryConnectionPanel } from "./MemoryConnectionPanel";
import { Button } from "../../design-system";
import {
	SettingsDraftProvider,
	useSettingsDraft,
	useOptionalSettingsDraft,
} from "./SettingsDraftHost";
const categories = [
	{ id: "general", label: "全般" },
	{ id: "ai", label: "AIの使い方" },
	{ id: "connections", label: "接続先" },
	{ id: "services", label: "サービスを試す" },
	{ id: "dots", label: "Codexへの委任" },
	{ id: "toolchains", label: "ツールチェーンの記録" },
	{ id: "voice", label: "音声" },
	{ id: "data", label: "データと利用記録" },
	{ id: "schedule", label: "予約" },
	{ id: "appearance", label: "表示" },
	{ id: "dictionary", label: "TTS辞書" },
	{ id: "memory", label: "メモリー" },
	{ id: "world", label: "World" },
] as const;
function SettingsPageBody({
	renderServiceTests,
	renderToolchainHistory,
	renderWorld,
	client,
	onDirty,
	onSaved,
}: {
	client: EumenesClient;
	onDirty: (dirty: boolean) => void;
	onSaved: (value: Settings) => void;
	renderServiceTests?: (disabled: boolean) => React.ReactNode;
	renderToolchainHistory?: () => React.ReactNode;
	renderWorld?: () => React.ReactNode;
}) {
	const host = useSettingsDraft();
	const {
		query,
		value,
		dirty,
		keys,
		setKeys,
		setDraft,
		setRetry,
		setMessage,
		adding,
		setAdding,
		newCloud,
		setNewCloud,
		change,
	} = host;
	const [category, setCategory] = useState<(typeof categories)[number]["id"]>(
		() =>
			categories.find((c) => c.id === window.location.hash.split("/")[1])?.id ??
			"general",
	);
	const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
	const [deviceError, setDeviceError] = useState("");
	const diagnostics = useQuery({
		queryKey: [queryRoots.settingsDiagnostics, client.identity],
		queryFn: () => client.settingsDiagnostics(),
		retry: 0,
	});
	const usage = useQuery({
		queryKey: [queryRoots.inferenceUsage, client.identity],
		queryFn: () => client.inferenceUsage(),
		retry: 0,
	});
	const probes = useQuery({
		queryKey: [queryRoots.inferenceProbes, client.identity],
		queryFn: () => client.inferenceProbes(),
		retry: 0,
	});
	const details = useQuery({
		queryKey: [queryRoots.larmDetails, client.identity],
		queryFn: () => client.larmDetails(),
		retry: 0,
	});
	const larmChanged =
		!!value &&
		!!query.data &&
		(value.larm.baseUrl !== query.data.larm.baseUrl ||
			value.larm.profile !== query.data.larm.profile ||
			value.larm.audience !== query.data.larm.audience);
	useEffect(() => {
		onDirty(dirty);
		const prevent = (e: BeforeUnloadEvent) => {
			if (dirty) e.preventDefault();
		};
		window.addEventListener("beforeunload", prevent);
		return () => window.removeEventListener("beforeunload", prevent);
	}, [dirty, onDirty]);
	async function apply() {
		const saved = await host.apply();
		if (saved) onSaved(saved);
	}
	function addCloud() {
		if (!value) return;
		const connectionId = crypto.randomUUID();
		const resourceId = crypto.randomUUID();
		const next = structuredClone(value);
		const agent = newCloud.kind !== "openai-compatible";
		const managed = newCloud.kind === "claude-managed-agents";
		next.connections.push({
			id: connectionId,
			...(agent ? { kind: newCloud.kind } : {}),
			...(managed
				? {
						agentId: newCloud.agentId.trim() || null,
						environmentId: newCloud.environmentId.trim() || null,
					}
				: {}),
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
		// Codex and Claude Agent SDK may use their CLI login instead of a key.
		if (!newCloud.key && !newCloud.envRef && (!agent || managed)) {
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
		setNewCloud(emptyCloud);
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
			setMessage(`診断データを保存できませんでした: ${describeError(e)}`);
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
			setMessage(`確認できませんでした: ${describeError(e)}`);
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
					<p className="hint">{categoryHelp(category)}</p>
				</header>
				{category === "dots" && <DotsPanel client={client} />}
				{category === "services" && renderServiceTests?.(dirty)}
				{category === "world" && renderWorld?.()}
				{category === "toolchains" && renderToolchainHistory?.()}
				{category === "general" && (
					<GeneralSection value={value} change={change} />
				)}
				{category === "ai" && (
					<AiSection value={value} change={change} usage={usage} />
				)}
				{category === "connections" && (
					<ConnectionsSection
						client={client}
						value={value}
						change={change}
						dirty={dirty}
						keys={keys}
						setKeys={setKeys}
						setRetry={setRetry}
						details={details}
						diagnostics={diagnostics}
						probes={probes}
						probe={probe}
						adding={adding}
						setAdding={setAdding}
						newCloud={newCloud}
						setNewCloud={setNewCloud}
						addCloud={addCloud}
					/>
				)}
				{category === "voice" && (
					<VoiceSection
						client={client}
						value={value}
						saved={query.data}
						change={change}
						larmChanged={larmChanged}
						usage={usage}
						devices={devices}
						deviceError={deviceError}
						discover={discover}
						outputSupported={outputSupported}
					/>
				)}
				{category === "data" && (
					<DataSection
						diagnostics={diagnostics}
						usage={usage}
						downloadDiagnostics={downloadDiagnostics}
					/>
				)}
				{category === "schedule" && <ScheduleSection client={client} />}
				{category === "dictionary" && <TtsDictionaryPanel client={client} />}
				{category === "memory" && (
					<MemoryConnectionPanel key={client.identity} client={client} />
				)}
				{category === "appearance" && (
					<AppearanceSection value={value} change={change} />
				)}
				{!["dots", "dictionary", "memory", "services", "toolchains"].includes(
					category,
				) && <SettingsFooter host={host} onApply={apply} />}
			</section>
		</div>
	);
}

function SettingsFooter({
	host,
	onApply,
}: {
	host: ReturnType<typeof useSettingsDraft>;
	onApply: () => Promise<void>;
}) {
	const { dirty, message, busy, adding } = host;
	return (
		<footer className="settings-footer">
			<output>
				{message && dirty && message === "変更を適用しました"
					? "送信した変更を適用しました。追加の変更は未適用です。"
					: message ||
						(dirty ? "変更はまだ保存されていません" : "すべての変更を保存済み")}
			</output>
			<div className="settings-actions">
				<Button variant="secondary" disabled={busy} onClick={host.discard}>
					最新の設定を読み直す
				</Button>
				<Button
					disabled={!dirty || adding || busy}
					onClick={() => void onApply()}
				>
					{busy ? "適用中…" : "変更を適用"}
				</Button>
			</div>
		</footer>
	);
}

function categoryHelp(category: string) {
	return category === "dots"
		? "dotsとの接続、作業するプロジェクト、担当とSkillを設定します。変更は各欄で保存します。"
		: category === "services"
			? "プロバイダを選んで、入力と結果を確認できます。"
			: category === "toolchains"
				? "会話がどのツールチェーンを選んだかの記録と、Web検索の保存済み取得手順を確認できます。"
				: category === "memory"
					? "保存した記憶を会話で使うかを切り替えます。変更はすぐに保存されます。"
					: category === "world"
						? "Worldが覚えている主張と、その根拠・条件を確認し、明示的に訂正・撤回・忘却できます。この画面は読み上げません。"
						: category === "dictionary"
							? "読み上げの直前に、登録した文字を読み方へ置き換えます（長い登録が優先）。会話の表示は変わりません。変更は行ごとにすぐ保存されます。"
							: category === "general"
								? "AIの名前・あなたの名前・話し方を設定します。次の返答から反映されます。"
								: "普段はLARMを使い、必要なときに登録済みのクラウドへ切り替えます。";
}

export function SettingsPage(props: Parameters<typeof SettingsPageBody>[0]) {
	const host = useOptionalSettingsDraft();
	return host ? (
		<SettingsPageBody {...props} />
	) : (
		<SettingsDraftProvider key={props.client.identity} client={props.client}>
			<SettingsPageBody {...props} />
		</SettingsDraftProvider>
	);
}
