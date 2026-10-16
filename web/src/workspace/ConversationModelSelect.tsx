import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@eumenes/design-system";
import { useState } from "react";
import {
	billingPathLabels,
	type ConversationModelOption,
	type useConversationModel,
} from "../domains/settings";
import { shortModelName } from "./model-name";

type ActualModel = {
	source: string;
	model: string;
	billingPath?: string | null;
};

/** The path that served the last answer: the attempt's billing path when it is a named one, else cloud or LARM. */
function actualPathLabel(actual: ActualModel) {
	const named = (billingPathLabels as Record<string, string | undefined>)[
		actual.billingPath ?? ""
	];
	return named ?? (actual.source === "cloud" ? "クラウド" : "LARM");
}

const optionName = (option: ConversationModelOption) =>
	`${option.groupLabel} / ${option.label}`;

function groupOptions(options: ConversationModelOption[]) {
	const groups: {
		id: string;
		label: string;
		options: ConversationModelOption[];
	}[] = [];
	for (const option of options) {
		const group = groups.find((g) => g.id === option.groupId);
		if (group) group.options.push(option);
		else
			groups.push({
				id: option.groupId,
				label: option.groupLabel,
				options: [option],
			});
	}
	return groups;
}

/**
 * Switches the conversation agent from the chat screen. The route is saved at once and
 * applies from the next utterance, so the control is silently locked while an answer is running.
 */
export function ConversationModelSelect({
	model,
	running,
	actualModel,
}: {
	model: ReturnType<typeof useConversationModel>;
	running: boolean;
	actualModel?: ActualModel | undefined;
}) {
	// The route the current run started with. Adjusted during render (not in an effect)
	// so the hint appears on a switch and ends once the next utterance starts.
	const [settled, setSettled] = useState(model.selected);
	if (model.selected && (!settled || running) && settled !== model.selected)
		setSettled(model.selected);
	const switched = Boolean(settled) && settled !== model.selected;
	if (!model.ready)
		return (
			<span className="model-label">
				{actualModel?.source === "cloud" &&
					`${actualPathLabel(actualModel)} / `}
				{actualModel?.model}
			</span>
		);
	const selected = model.options.find((option) => option.id === model.selected);
	const lastUsed = actualModel
		? `直近の利用: ${actualPathLabel(actualModel)} / ${actualModel.model}`
		: undefined;
	const tooltip = [
		selected ? `現在の経路: ${optionName(selected)}` : undefined,
		lastUsed,
	]
		.filter(Boolean)
		.join("\n");
	return (
		<>
			<Select
				value={model.selected}
				onValueChange={(id) => void model.select(id)}
				disabled={running || model.busy}
			>
				<SelectTrigger
					variant="ghost"
					size="sm"
					className="model-select"
					aria-label="会話エージェント"
					title={tooltip}
				>
					<SelectValue placeholder="会話エージェント">
						{selected
							? shortModelName(selected.label)
							: actualModel && shortModelName(actualModel.model)}
					</SelectValue>
				</SelectTrigger>
				<SelectContent>
					{groupOptions(model.options).map((group) => (
						<SelectGroup key={group.id}>
							<SelectLabel>{group.label}</SelectLabel>
							{group.options.map((option) => (
								<SelectItem key={option.id} value={option.id}>
									{option.label}
								</SelectItem>
							))}
						</SelectGroup>
					))}
				</SelectContent>
			</Select>
			{switched && !running && (
				<output className="model-hint">次の発言から適用されます</output>
			)}
		</>
	);
}
