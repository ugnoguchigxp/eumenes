import { cloneElement, isValidElement, useId } from "react";
import { type EumenesClient } from "../../../../client";
import type {
	ConnectionKind,
	Purpose,
	Settings,
} from "../../../../api/domains/settings/contracts";
import { Button } from "../../design-system";
import { useVoiceSample } from "./useVoiceSample";
import { knownLarmVoices } from "./larm-voices";

export type TtsRange = NonNullable<
	Awaited<
		ReturnType<EumenesClient["larmVoices"]>
	>["voices"][number]["capabilities"]["speed"]
>;
export const purposes: Record<Purpose, string> = {
	llm: "会話",
	asr: "聞き取り",
	tts: "読み上げ",
};
export const connectionKindLabels: Record<ConnectionKind, string> = {
	"openai-compatible": "OpenAI互換API",
	"codex-sdk": "Codex SDK",
	"claude-agent-sdk": "Claude Agent SDK",
	"claude-managed-agents": "Claude Managed Agents",
};
/** Prefilled values when a kind is chosen; all stay editable. */
export const connectionKindDefaults: Record<
	ConnectionKind,
	{ url: string; model: string; context: number }
> = {
	"openai-compatible": { url: "", model: "", context: 8192 },
	"codex-sdk": {
		url: "https://api.openai.com/v1",
		model: "gpt-6-luna",
		context: 200_000,
	},
	"claude-agent-sdk": {
		url: "https://api.anthropic.com",
		model: "claude-opus-5-5",
		context: 1_000_000,
	},
	"claude-managed-agents": {
		url: "https://api.anthropic.com",
		model: "claude-opus-5-5",
		context: 1_000_000,
	},
};
/**
 * Models offered in the conversation model picker for CLI-login SDK connections.
 * Fable and Astra are left out on purpose: their usage cost is too high for casual switching.
 */
export type CatalogKind = "codex-sdk" | "claude-agent-sdk";
export const agentModelCatalog: Record<
	CatalogKind,
	readonly { model: string; context: number }[]
> = {
	"codex-sdk": [
		{ model: "gpt-6.1-sol", context: 500_000 },
		{ model: "gpt-6-sol", context: 272_000 },
		{ model: "gpt-6-luna", context: 272_000 },
		{ model: "gpt-5.6-sol", context: 272_000 },
		{ model: "gpt-5.6-terra", context: 272_000 },
		{ model: "gpt-5.6-luna", context: 272_000 },
		{ model: "gpt-daybreak-blue-latest", context: 272_000 },
	],
	"claude-agent-sdk": [
		{ model: "claude-opus-5-5", context: 1_000_000 },
		{ model: "claude-sonnet-5-5", context: 1_000_000 },
		{ model: "claude-haiku-5-5", context: 1_000_000 },
		{ model: "claude-opus-5", context: 1_000_000 },
		{ model: "claude-sonnet-5", context: 1_000_000 },
	],
};
export function Field({
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
export const presentationLabel: Record<string, string> = {
	masculine: "（男性）",
	feminine: "（女性）",
	androgynous: "（中性）",
};
export function SamplePlayer({
	client,
	voice,
	disabled,
}: {
	client: EumenesClient;
	voice: Parameters<EumenesClient["voiceSample"]>[0];
	disabled?: boolean;
}) {
	const { state, error, play, stop } = useVoiceSample(client, voice, disabled);
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
export function KnownVoiceSelect({
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
export function Toggle({
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
export function SpeechSpeed({
	value,
	onChange,
	range,
	label = "話す速さ",
}: {
	value: number;
	onChange: (v: number) => void;
	range?: TtsRange;
	label?: string;
}) {
	return (
		<Field
			label={`${label}（${value.toFixed(1)}倍）`}
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

export type Change = (fn: (s: Settings) => void) => void;
export type NewCloud = {
	kind: ConnectionKind;
	agentId: string;
	environmentId: string;
	name: string;
	url: string;
	key: string;
	envRef: string;
	purpose: Purpose;
	model: string;
	context: number;
	voice: string;
	assign: boolean;
};
export const emptyCloud: NewCloud = {
	kind: "openai-compatible",
	agentId: "",
	environmentId: "",
	name: "",
	url: "",
	key: "",
	envRef: "",
	purpose: "llm",
	model: "",
	context: 8192,
	voice: "",
	assign: true,
};
