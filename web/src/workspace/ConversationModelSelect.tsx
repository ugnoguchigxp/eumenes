import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@eumenes/design-system";
import { useEffect, useRef, useState } from "react";
import {
	billingPathLabels,
	type ConversationModelOption,
	type useConversationModel,
} from "../domains/settings";

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
 * applies from the next utterance, so the control is locked while an answer is running.
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
	const [switched, setSwitched] = useState(false);
	const previous = useRef(model.selected);
	useEffect(() => {
		if (previous.current !== model.selected) {
			if (previous.current) setSwitched(true);
			previous.current = model.selected;
		}
	}, [model.selected]);
	// The hint ends once the next utterance starts.
	useEffect(() => {
		if (running) setSwitched(false);
	}, [running]);
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
						{selected ? optionName(selected) : actualModel?.model}
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
			{(running || switched) && (
				<span className="model-hint" role="status">
					{running ? "回答中は切り替えできません" : "次の発言から適用されます"}
				</span>
			)}
		</>
	);
}
