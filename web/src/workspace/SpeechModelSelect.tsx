import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@eumenes/design-system";
import type { useSpeechModels } from "../domains/settings/useSpeechModels";
import { shortModelName } from "./model-name";

const registerAsr = "settings.ai-connections";

export function SpeechModelSelect({
	models,
	disabled,
	openAsrSettings,
}: {
	models: ReturnType<typeof useSpeechModels>;
	disabled: boolean;
	openAsrSettings: () => void;
}) {
	return (["asr", "tts"] as const).map((purpose) => {
		const model = models[purpose];
		const label = purpose.toUpperCase();
		const selected = model.options.find(
			(option) => option.id === model.selected,
		);
		return (
			<Select
				key={purpose}
				value={model.selected}
				onValueChange={(id) => {
					if (purpose === "asr" && id === registerAsr) openAsrSettings();
					else void models.select(purpose, id);
				}}
				disabled={!models.ready || models.busy || disabled}
			>
				<SelectTrigger
					variant="ghost"
					size="sm"
					className="model-select"
					aria-label={`${label}モデル`}
					title={`${label}: ${selected?.label ?? "未設定"}`}
				>
					<SelectValue placeholder={`${label}モデル`}>
						{label}: {selected ? shortModelName(selected.label) : "未設定"}
					</SelectValue>
				</SelectTrigger>
				<SelectContent>
					{model.options.map((option) => (
						<SelectItem key={option.id} value={option.id}>
							{option.label}
						</SelectItem>
					))}
					{purpose === "asr" && (
						<SelectItem value={registerAsr}>ASRモデルを登録…</SelectItem>
					)}
				</SelectContent>
			</Select>
		);
	});
}
