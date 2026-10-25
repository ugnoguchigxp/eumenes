import type { Database } from "bun:sqlite";
import type {
	DocumentDescription,
	DocumentFieldV1,
	DocumentPathInfo,
} from "../../domains/capabilities";
import { workSettingsApply, type WorkSettings } from "../../domains/dots";
import type { DotsWork } from "./dots-work";

const DOCUMENT = "document:dots.settings@1";
const descriptions: Record<keyof WorkSettings, DocumentPathInfo> = {
	enabled: { kind: "boolean", optional: false, nullable: false },
	connectionRef: {
		kind: "string",
		maxLength: 160,
		optional: false,
		nullable: true,
	},
	projectRef: {
		kind: "string",
		maxLength: 160,
		optional: false,
		nullable: true,
	},
	showInConversation: { kind: "boolean", optional: false, nullable: false },
	maxRuntimeSeconds: {
		kind: "integer",
		min: 60,
		max: 7200,
		optional: false,
		nullable: false,
	},
	maxSessions: {
		kind: "integer",
		min: 1,
		max: 20,
		optional: false,
		nullable: false,
	},
};
const keyOf = (path: string) =>
	Object.keys(descriptions).find((k) => path === `$.settings.${k}`) as
		| keyof WorkSettings
		| undefined;
export const dotsSettingsDocument: DocumentDescription = {
	describePath: (path) => {
		const k = keyOf(path);
		return k ? descriptions[k] : null;
	},
	targetQuery: () => null,
};
export function applyDotsSettings(
	db: Database,
	work: DotsWork,
	raw: unknown,
	requestId: string,
	digest: string,
	field: (id: string) => DocumentFieldV1 | undefined,
) {
	const input = workSettingsApply.parse(raw),
		current = work.settings.inTransaction(db);
	const next = { ...current.settings } as Record<keyof WorkSettings, unknown>;
	const seen = new Set<string>();
	for (const change of input.changes) {
		const registered = field(change.fieldId),
			key =
				registered?.document === DOCUMENT ? keyOf(registered.path) : undefined;
		if (!key || seen.has(key)) throw new Error("field_not_registered");
		seen.add(key);
		const rule = descriptions[key];
		if (rule.kind === "boolean") {
			if (!["true", "false"].includes(change.value))
				throw new Error("invalid_value");
			next[key] = change.value === "true";
		} else if (rule.kind === "integer") next[key] = Number(change.value);
		else next[key] = change.value === "" && rule.nullable ? null : change.value;
	}
	return work.settings.applyInTransaction(db, {
		requestId,
		expectedRevision: input.expectedRevision,
		settings: next,
		digest,
	});
}
