import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@eumenes/design-system";
import type { useSpeechModels } from "../domains/settings/useSpeechModels";
import { shortModelName } from "./model-name";

export function SpeechModelSelect({
	models,
	disabled,
}: {
	models: ReturnType<typeof useSpeechModels>;
	disabled: boolean;
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
				onValueChange={(id) => void models.select(purpose, id)}
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
				</SelectContent>
			</Select>
		);
	});
}
