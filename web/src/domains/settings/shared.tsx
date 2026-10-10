import {
	cloneElement,
	isValidElement,
	useCallback,
	useId,
	useEffect,
	useRef,
	useState,
} from "react";
import { type EumenesClient } from "../../../../client";
import type {
	Purpose,
	Settings,
} from "../../../../api/domains/settings/contracts";
import { Button } from "../../design-system";
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
	const [state, setState] = useState<"idle" | "loading" | "playing">("idle");
	const [error, setError] = useState<string | null>(null);
	const run = useRef<{
		abort: AbortController;
		audio?: HTMLAudioElement;
		url?: string;
	}>(null);
	const stop = useCallback(() => {
		const current = run.current;
		run.current = null;
		current?.abort.abort();
		current?.audio?.pause();
		if (current?.url) URL.revokeObjectURL(current.url);
		setState("idle");
	}, []);
	useEffect(() => stop, [stop]);
	async function play() {
		stop();
		setError(null);
		const mine = { abort: new AbortController() } as {
			abort: AbortController;
			audio?: HTMLAudioElement;
			url?: string;
		};
		run.current = mine;
		setState("loading");
		try {
			const bytes = await client.voiceSample(voice, mine.abort.signal);
			if (run.current !== mine) return;
			const url = URL.createObjectURL(
				new Blob([new Uint8Array(bytes)], { type: "audio/wav" }),
			);
			mine.url = url;
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

export type Change = (fn: (s: Settings) => void) => void;
export type NewCloud = {
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
