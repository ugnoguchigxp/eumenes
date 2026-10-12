import { definitionRequests, parseDefinition } from "@eumenes/artifact-ui";
import {
	settingsSchema,
	type Settings,
} from "../../../../api/domains/settings/contracts";
import type { SettingsInputField } from "@eumenes/design-system";
import type { z } from "zod";

type Binding = {
	id: string;
	descriptor: Omit<SettingsInputField, "id" | "value">;
	read: (settings: Settings) => string;
	edit: (settings: Settings, value: unknown) => void;
};
function field<T extends string>(input: {
	id: string;
	descriptor: Binding["descriptor"];
	schema: z.ZodType<T>;
	read: (settings: Settings) => T;
	write: (settings: Settings, value: T) => void;
}): Binding {
	return {
		id: input.id,
		descriptor: input.descriptor,
		read: input.read,
		edit: (settings, value) => {
			input.schema.parse(value);
			input.write(settings, value as T);
		},
	};
}
const general = settingsSchema.shape.general.shape;
export const conversationFields = [
	field({
		id: "conversation.agent-name",
		descriptor: {
			label: "AIの名前",
			help: "空欄の場合は名前を設定しません。",
			control: "text",
			maxLength: 40,
		},
		schema: general.agentName,
		read: (s) => s.general.agentName,
		write: (s, value) => {
			s.general.agentName = value;
		},
	}),
	field({
		id: "conversation.user-name",
		descriptor: {
			label: "あなたの名前",
			help: "空欄の場合は名前で呼びません。",
			control: "text",
			maxLength: 40,
		},
		schema: general.userName,
		read: (s) => s.general.userName,
		write: (s, value) => {
			s.general.userName = value;
		},
	}),
	field({
		id: "conversation.persona",
		descriptor: {
			label: "口調",
			help: "次の返答から反映されます。",
			control: "select",
			options: [
				{ value: "butler", label: "執事" },
				{ value: "maid", label: "メイド" },
				{ value: "strategist", label: "参謀" },
				{ value: "sage", label: "老師" },
			],
		},
		schema: general.persona,
		read: (s) => s.general.persona,
		write: (s, value) => {
			s.general.persona = value;
		},
	}),
];

export const settingsArtifacts = {
	hub: {
		id: "settings",
		title: "設定",
		source: "settings-hub",
		view: "settings-navigation",
	},
	conversation: {
		id: "settings-conversation",
		title: "会話の設定",
		source: "settings-conversation",
		view: "settings-section",
	},
	changes: {
		id: "settings-changes",
		title: "設定の変更一覧",
		source: "settings-changes",
		view: "settings-changes",
	},
} as const;
export type SettingsArtifactId = keyof typeof settingsArtifacts;
export function settingsArtifactDefinition(id: SettingsArtifactId) {
	const artifact = settingsArtifacts[id];
	return JSON.stringify({
		view: artifact.view,
		source: artifact.source,
		title: id === "conversation" ? "会話" : artifact.title,
	});
}
const sources = new Set<string>(
	Object.values(settingsArtifacts).map((artifact) => artifact.source),
);
export function isSettingsArtifactDefinition(definition: string) {
	try {
		return definitionRequests(parseDefinition(definition)).some(
			(request) => request.source && sources.has(request.source),
		);
	} catch {
		return false;
	}
}
