import type { Database } from "bun:sqlite";

/** Only used to REMOVE saved connection strings from exported prose. Never returned through an API. */
export function routingExportSecrets(db: Database): string[] {
	const values = new Set<string>();
	const collect = (value: unknown, key = "") => {
		if (
			typeof value === "string" &&
			/url|origin|endpoint|token|credential|secret|password|api.?key/i.test(key)
		) {
			if (value) values.add(value);
		} else if (Array.isArray(value))
			value.forEach((item) => collect(item, key));
		else if (value && typeof value === "object")
			for (const [name, item] of Object.entries(value)) collect(item, name);
	};
	const doc = db
		.query("SELECT document FROM settings_document WHERE id=1")
		.get() as { document: string } | null;
	if (doc) collect(JSON.parse(doc.document));
	for (const row of db
		.query(
			"SELECT gateway_url, gateway_origin,lease_endpoint FROM settings_excalidraw",
		)
		.all())
		collect(row);
	for (const row of db
		.query("SELECT base_url,credential FROM settings_object_recognition")
		.all())
		collect(row);
	for (const row of db.query("SELECT base_url FROM settings_ocr").all())
		collect(row);
	for (const row of db
		.query("SELECT gateway_url,public_origin FROM settings_docling")
		.all())
		collect(row);
	return [...values];
}
