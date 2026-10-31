/**
 * What the harness measurement reads from the app database, read-only: the saved persona and agency settings that fix
 * the system part, and the toolchain cards a search returns. The
 * database is opened read-only and only these fields are taken; no credential or connection is read.
 */
import { Database } from "bun:sqlite";
import type { PersonaSpec } from "../../api/domains/dialogue/service/context-system";
import { CARD_IDS, type Card } from "./harness-chains";
import type { SystemSource } from "./harness-compose";

const PERSONAS = ["butler", "maid", "strategist", "sage"] as const;

/** The persona and agency fields of a stored settings document (the shape `settingsSchema` writes). */
export function systemFieldsOf(document: string): SystemSource {
	const saved = JSON.parse(document) as {
		general?: Record<string, unknown>;
		agency?: Record<string, unknown>;
	};
	const general = saved.general ?? {};
	const agency = saved.agency ?? {};
	const persona = PERSONAS.find((p) => p === general.persona);
	if (!persona) throw new Error("harness_saved_persona_unreadable");
	const text = (value: unknown) => (typeof value === "string" ? value : "");
	const spec: PersonaSpec = {
		agentName: text(general.agentName),
		userName: text(general.userName),
		persona,
	};
	return {
		persona: spec,
		interests: Array.isArray(agency.interests)
			? agency.interests.filter((x): x is string => typeof x === "string")
			: [],
		emotion: agency.emotion === true,
	};
}

type ToolchainRow = { id: string; definition: string };

export function cardOf(row: ToolchainRow): Card {
	const d = JSON.parse(row.definition) as Record<string, unknown>;
	const list = (value: unknown) =>
		Array.isArray(value)
			? value.filter((x): x is string => typeof x === "string")
			: [];
	return {
		id: row.id,
		title: String(d.title ?? ""),
		summary: String(d.summary ?? ""),
		useWhen: list(d.useWhen),
	};
}

export type Saved = { source: SystemSource; cards: Record<string, Card> };

export function readSaved(dbPath: string): Saved {
	const db = new Database(dbPath, { readonly: true });
	try {
		const settings = db
			.query("SELECT document FROM settings_document WHERE id=1")
			.get() as { document: string } | null;
		if (!settings) throw new Error("harness_saved_settings_missing");
		const rows = db
			.query(
				`SELECT i.id AS id, r.definition_json AS definition
				 FROM capability_items i JOIN capability_revisions r ON r.id = i.active_revision_id
				 WHERE i.kind = 'toolchain' AND i.enabled = 1`,
			)
			.all() as ToolchainRow[];
		return {
			source: systemFieldsOf(settings.document),
			cards: Object.fromEntries(
				rows
					.filter((row) => CARD_IDS.includes(row.id))
					.map((row) => [row.id, cardOf(row)]),
			),
		};
	} finally {
		db.close();
	}
}
