import type {
	SettingsInputField,
	SettingsFieldGroup,
	SettingsPanelAction,
	SettingsLink,
	SettingsChangeRow,
} from "@eumenes/design-system";
import type { SubtitlePreviewProps } from "@eumenes/design-system";

export type SubtitlePreviewResource = Omit<SubtitlePreviewProps, "title"> & {
	kind: "subtitle-preview";
	revision: number;
};

export type SettingsSectionResource = {
	kind: "settings-section";
	revision: number;
	fields: SettingsInputField[];
	groups?: SettingsFieldGroup[];
	actions?: SettingsPanelAction[];
	description?: string;
	dirty: boolean;
	busy?: boolean;
	blocked?: boolean;
	message?: string;
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
