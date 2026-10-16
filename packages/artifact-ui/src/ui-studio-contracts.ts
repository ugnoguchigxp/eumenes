/** Snapshot resources of the UI studio and of the read-only JSON view (types only). */

type UiStudioWork = {
	workRef: string;
	sessionId: string;
	title: string;
	/** The adopted draft as a registered OpenUI definition. */
	definition: unknown;
	/** Draft revision; sent back as `expectedRevision` by Undo, Redo and Save. */
	revision: number;
	/** The saved item this draft started from, or null for a new work. */
	savedRef: string | null;
	savedRevision: number | null;
	dirty: boolean;
	/** A specialist turn is running: Save, Undo and Redo are unavailable. */
	busy: boolean;
	canUndo: boolean;
	canRedo: boolean;
};

type UiStudioViewing = {
	id: string;
	title: string;
	/** What the preview renders (the answer form is bound to the host's form source). */
	definition: unknown;
	/** The definition as stored, with its form fields inline; shown as the source. */
	storedDefinition?: unknown;
	savedRevision: number;
};

export type UiStudioResource = {
	kind: "ui-studio";
	revision: number;
	work: UiStudioWork | null;
	/** A saved work the user looks at; shown instead of the draft while set. */
	viewing: UiStudioViewing | null;
	history: Array<{ id: string; title: string; updatedAt: string | number }>;
	/** The dialogue session of this work, when the host knows one. */
	session: { state: "active" | "suspended"; expiresAt: string } | null;
	/** True when a turn of the session can be cancelled (stop). */
	stoppable: boolean;
};
