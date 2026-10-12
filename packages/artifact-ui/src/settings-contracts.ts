import type {
	SettingsInputField,
	SettingsLink,
	SettingsChangeRow,
} from "@eumenes/design-system";

export type SettingsSectionResource = {
	kind: "settings-section";
	revision: number;
	fields: SettingsInputField[];
	description?: string;
	dirty: boolean;
};
export type SettingsNavigationResource = {
	kind: "settings-navigation";
	revision: number;
	entries: SettingsLink[];
	dirty: boolean;
};
export type SettingsChangesResource = {
	kind: "settings-changes";
	revision: number;
	rows: SettingsChangeRow[];
	dirty: boolean;
	busy: boolean;
	blocked: boolean;
	message: string;
};
