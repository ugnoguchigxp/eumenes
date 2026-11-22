import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@eumenes/design-system";
import type { useConversationModel } from "../domains/settings";

/**
 * Chooses the thinking level beside the conversation model. Only the levels the selected model accepts are offered;
 * the choice is saved at once and applies from the next utterance, so the control is locked while an answer is running,
 * as the model's select is. A model with no level to choose (or one whose catalog is not read) leaves it locked.
 */
export function ReasoningSelect({
	model,
	running,
}: {
	model: ReturnType<typeof useConversationModel>;
	running: boolean;
}) {
	if (!model.ready) return null;
	const { value, choices, select } = model.effort;
	const unavailable = !choices?.length;
	return (
		<Select
			value={choices?.includes(value) ? value : ""}
			onValueChange={(effort) => void select(effort)}
			disabled={running || model.busy || unavailable}
		>
			<SelectTrigger
				variant="ghost"
				size="sm"
				className="model-select"
				aria-label="思考レベル"
				title={
					unavailable
						? "このモデルには選べる思考レベルがありません"
						: `思考レベル: ${value}`
				}
			>
				<SelectValue placeholder="思考レベル">
					{choices?.includes(value) ? `思考: ${value}` : undefined}
				</SelectValue>
			</SelectTrigger>
			<SelectContent>
				{(choices ?? []).map((effort) => (
					<SelectItem key={effort} value={effort}>
						{effort}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
