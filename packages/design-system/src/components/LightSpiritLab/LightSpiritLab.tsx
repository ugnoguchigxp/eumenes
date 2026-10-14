import { Play, RotateCcw, Square } from "lucide-react";
import { useId, type ReactNode } from "react";
import { cn } from "../../utils/cn";
import { Button } from "../Button";
import { Switch } from "../Switch";
import "./LightSpiritLab.css";

export type LightSpiritLabMotion = {
	id: string;
	label: string;
	group: string;
	groupLabel: string;
	variants: { id: string; label: string }[];
};
export type LightSpiritLabLayer = "secondary" | "gaze" | "gestures";
export type LightSpiritLabStatus = {
	state: "loading" | "ready" | "failed" | "unsupported";
	/** Shown under the stage, e.g. why the preview is still. */
	message?: string;
	motionLabel?: string;
	variantLabel?: string;
	elapsed?: number;
	fps?: number;
};
export type LightSpiritLabProps = {
	/** The host-owned canvas container. */
	stage: ReactNode;
	motions: LightSpiritLabMotion[];
	selected: string | null;
	/** `""` picks a variant automatically on each play. */
	variant: string;
	playing: boolean;
	loop: boolean;
	speed: number;
	speeds?: number[];
	speaking: boolean;
	layers: Record<LightSpiritLabLayer, boolean>;
	skeleton: boolean;
	status: LightSpiritLabStatus;
	onSelect: (id: string) => void;
	onVariant: (id: string) => void;
	onPlay: () => void;
	onStop: () => void;
	onRestart: () => void;
	onNeutral: () => void;
	onLoop: (value: boolean) => void;
	onSpeed: (value: number) => void;
	onSpeaking: (value: boolean) => void;
	onLayer: (layer: LightSpiritLabLayer, value: boolean) => void;
	onSkeleton: (value: boolean) => void;
	className?: string;
};
const layerLabels: Record<LightSpiritLabLayer, string> = {
	secondary: "揺れの追従（頭頂・裾・腕先）",
	gaze: "視線",
	gestures: "待機中の仕草",
};

function Toggle({
	id,
	label,
	checked,
	disabled,
	onChange,
}: {
	id: string;
	label: string;
	checked: boolean;
	disabled?: boolean;
	onChange: (value: boolean) => void;
}) {
	return (
		<div className="light-spirit-lab-toggle">
			<Switch
				id={id}
				checked={checked}
				disabled={disabled}
				onCheckedChange={onChange}
			/>
			<label htmlFor={id}>{label}</label>
		</div>
	);
}

/** Plays every avatar motion with its variants, speed, loop and layer switches. */
export function LightSpiritLab({
	stage,
	motions,
	selected,
	variant,
	playing,
	loop,
	speed,
	speeds = [0.5, 1, 1.5],
	speaking,
	layers,
	skeleton,
	status,
	onSelect,
	onVariant,
	onPlay,
	onStop,
	onRestart,
	onNeutral,
	onLoop,
	onSpeed,
	onSpeaking,
	onLayer,
	onSkeleton,
	className,
}: LightSpiritLabProps) {
	// Unique per instance so each switch keeps its own label.
	const idPrefix = useId();
	const ready = status.state === "ready";
	const groups = [...new Set(motions.map((m) => m.group))].map((group) => ({
		group,
		label: motions.find((m) => m.group === group)!.groupLabel,
		motions: motions.filter((m) => m.group === group),
	}));
	const current = motions.find((m) => m.id === selected);
	return (
		<div
			className={cn("light-spirit-lab", className)}
			data-lab-state={status.state}
		>
			<div className="light-spirit-lab-stage-column">
				<div className="light-spirit-lab-stage">{stage}</div>
				<output className="light-spirit-lab-status" aria-live="polite">
					{status.state === "loading" && "読み込んでいます"}
					{status.state === "unsupported" &&
						"この環境では3D表示を利用できません"}
					{status.state === "failed" && "表示に失敗しました"}
					{ready && (
						<>
							<span>
								{status.motionLabel ?? "待機"}
								{status.variantLabel ? `・${status.variantLabel}` : ""}
							</span>
							{status.elapsed !== undefined && (
								<span>{status.elapsed.toFixed(1)}秒</span>
							)}
							{status.fps !== undefined && <span>{status.fps} fps</span>}
						</>
					)}
				</output>
				{status.message && (
					<p className="light-spirit-lab-message">{status.message}</p>
				)}
			</div>
			<div className="light-spirit-lab-controls">
				<div
					className="light-spirit-lab-transport"
					role="group"
					aria-label="再生の操作"
				>
					{playing ? (
						<Button type="button" disabled={!ready} onClick={onStop}>
							<Square aria-hidden="true" />
							停止
						</Button>
					) : (
						<Button
							type="button"
							disabled={!ready || !current}
							onClick={onPlay}
						>
							<Play aria-hidden="true" />
							再生
						</Button>
					)}
					<Button
						type="button"
						variant="outline"
						disabled={!ready || !current}
						onClick={onRestart}
					>
						<RotateCcw aria-hidden="true" />
						最初から
					</Button>
					<Button
						type="button"
						variant="outline"
						disabled={!ready}
						onClick={onNeutral}
					>
						待機に戻す
					</Button>
				</div>
				<div
					className="light-spirit-lab-speed"
					role="radiogroup"
					aria-label="速度"
				>
					{speeds.map((value) => (
						<Button
							key={value}
							type="button"
							size="sm"
							variant={value === speed ? "default" : "outline"}
							role="radio"
							aria-checked={value === speed}
							disabled={!ready}
							onClick={() => onSpeed(value)}
						>
							{value}×
						</Button>
					))}
				</div>
				{groups.map(({ group, label, motions: list }) => (
					<fieldset key={group} className="light-spirit-lab-group">
						<legend>{label}</legend>
						<div className="light-spirit-lab-motions">
							{list.map((motion) => (
								<Button
									key={motion.id}
									type="button"
									size="sm"
									variant={motion.id === selected ? "default" : "outline"}
									aria-pressed={motion.id === selected}
									disabled={!ready}
									onClick={() => onSelect(motion.id)}
								>
									{motion.label}
								</Button>
							))}
						</div>
					</fieldset>
				))}
				{current && current.variants.length > 1 && (
					<label className="light-spirit-lab-variant">
						<span>変化版</span>
						<select
							value={variant}
							disabled={!ready}
							onChange={(event) => onVariant(event.target.value)}
						>
							<option value="">自動（毎回変える）</option>
							{current.variants.map((v) => (
								<option key={v.id} value={v.id}>
									{v.label}
								</option>
							))}
						</select>
					</label>
				)}
				<fieldset className="light-spirit-lab-group">
					<legend>重ねる動き</legend>
					<Toggle
						id={`${idPrefix}-loop`}
						label="繰り返す"
						checked={loop}
						disabled={!ready}
						onChange={onLoop}
					/>
					<Toggle
						id={`${idPrefix}-speaking`}
						label="発話を重ねる"
						checked={speaking}
						disabled={!ready}
						onChange={onSpeaking}
					/>
					{(Object.keys(layerLabels) as LightSpiritLabLayer[]).map((layer) => (
						<Toggle
							key={layer}
							id={`${idPrefix}-${layer}`}
							label={layerLabels[layer]}
							checked={layers[layer]}
							disabled={!ready}
							onChange={(value) => onLayer(layer, value)}
						/>
					))}
					<Toggle
						id={`${idPrefix}-skeleton`}
						label="ボーンを表示する"
						checked={skeleton}
						disabled={!ready}
						onChange={onSkeleton}
					/>
				</fieldset>
			</div>
		</div>
	);
}
