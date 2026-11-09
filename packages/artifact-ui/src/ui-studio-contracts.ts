/** Snapshot resources of the UI studio and of the read-only JSON view (types only). */

type UiStudioRejected = {
	title: string;
	text: string;
	issues: Array<{ path: string; rule: string }>;
	fixes: string[];
	createdAt: string;
};

export type AppWorkflowStatus = {
	runId?: string;
	state?: string;
	result?: { code?: string; path?: string; kind?: string } | null;
	schedule?: { id: string; state: string; nextDueAt: string | null } | null;
};
type UiStudioWork = {
	workRef: string;
	sessionId: string;
	title: string;
	/** The adopted draft as a registered OpenUI definition. */
	definition: unknown;
	/** Draft revision; sent back as `expectedRevision` by Undo, Redo, Save and source apply. */
	revision: number;
	/** The canonical text of the current definition (keys ordered, 2-space indent); "" when empty. */
	source: string;
	/** The canonical text of the revision before the current one; "" when there is none. */
	previousSource: string;
	/** The last whole draft the specialist wrote that failed the check, until the next accepted change or save. */
	rejected: UiStudioRejected | null;
	/** The saved item this draft started from, or null for a new work. */
	savedRef: string | null;
	savedRevision: number | null;
	dirty: boolean;
	/** A specialist turn is running: Save, Undo and Redo are unavailable. */
	busy: boolean;
	canUndo: boolean;
	canRedo: boolean;
	confirmation?: { digest: string; summary: unknown } | null;
	issue?: string | null;
};

type UiStudioViewing = {
	id: string;
	title: string;
	/** What the preview renders (the answer form is bound to the host's form source). */
	definition: unknown;
	/** The definition as stored, with its form fields inline; shown as the source. */
	storedDefinition?: unknown;
	savedRevision: number;
	bindings?: {
		inputs: Record<string, string>;
		table?: { path: number[]; rowsKey: string; columns: string[] };
		sections?: {
			path: number[];
			rowsKey: string;
			groupBy: string;
			itemKeys: string[];
			labels?: Record<string, Record<string, string>>;
		};
	} | null;
	workflow?: { trigger?: string; publish?: { schemaRef?: string } } | null;
	status?: AppWorkflowStatus;
	data?: unknown;
};

export type UiStudioResource = {
	kind: "ui-studio";
	appDevelopment?: boolean;
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
