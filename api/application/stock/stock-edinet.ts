import { inflateRawSync } from "node:zlib";
import { normalizeName } from "./stock-names";

/** One listed company of the EDINET code list. */
export type ListedCompany = {
	/** The four-character securities code (e.g. "9434", "130A"). */
	code: string;
	/** The submitter name as EDINET writes it, without spaces (e.g. "ソフトバンク株式会社"). */
	name: string;
	/** 資本金 as the list writes it (millions of yen); 0 when it gives none. Only compared, never spoken. */
	capital: number;
	/** Comparable forms of the name, the English name and the reading. */
	keys: string[];
};

/** A code list is about 11 thousand rows; far more than that is not the list. */
const MAX_COMPANIES = 30_000;
const MAX_CSV_BYTES = 16 * 1024 * 1024;
const invalid = () => new Error("stock_codelist_invalid");

/**
 * The CSV inside the code list's zip. Only the central directory is read, and the entry is stored or
 * deflated, which is all the publisher uses; anything else is refused as a whole.
 */
export function unzipCsv(zip: Uint8Array): Uint8Array {
	const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
	let end = zip.byteLength - 22;
	for (; end >= 0 && end > zip.byteLength - 22 - 65_535; end--)
		if (view.getUint32(end, true) === 0x06054b50) break;
	if (end < 0 || view.getUint32(end, true) !== 0x06054b50) throw invalid();
	const entries = view.getUint16(end + 10, true);
	let at = view.getUint32(end + 16, true);
	for (let i = 0; i < entries; i++) {
		if (at + 46 > zip.byteLength || view.getUint32(at, true) !== 0x02014b50)
			throw invalid();
		const flags = view.getUint16(at + 8, true);
		const method = view.getUint16(at + 10, true);
		const compressed = view.getUint32(at + 20, true);
		const size = view.getUint32(at + 24, true);
		const nameLength = view.getUint16(at + 28, true);
		const extraLength = view.getUint16(at + 30, true);
		const commentLength = view.getUint16(at + 32, true);
		const local = view.getUint32(at + 42, true);
		const name = new TextDecoder().decode(
			zip.subarray(at + 46, at + 46 + nameLength),
		);
		at += 46 + nameLength + extraLength + commentLength;
		if (!name.toLowerCase().endsWith(".csv") || flags & 1) continue;
		if (
			size > MAX_CSV_BYTES ||
			local + 30 > zip.byteLength ||
			view.getUint32(local, true) !== 0x04034b50
		)
			throw invalid();
		const start =
			local +
			30 +
			view.getUint16(local + 26, true) +
			view.getUint16(local + 28, true);
		const data = zip.subarray(start, start + compressed);
		if (data.byteLength !== compressed) throw invalid();
		if (method === 0) return data;
		if (method !== 8) throw invalid();
		try {
			return inflateRawSync(data, { maxOutputLength: MAX_CSV_BYTES });
		} catch {
			throw invalid();
		}
	}
	throw invalid();
}

/** Rows of a CSV with quoted fields (a quote inside is doubled; a field may hold a comma or a line break). */
function csvRows(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i]!;
		if (quoted) {
			if (c === '"' && text[i + 1] === '"') {
				field += '"';
				i++;
			} else if (c === '"') quoted = false;
			else field += c;
		} else if (c === '"') quoted = true;
		else if (c === ",") {
			row.push(field);
			field = "";
		} else if (c === "\n" || c === "\r") {
			if (c === "\r" && text[i + 1] === "\n") i++;
			row.push(field);
			field = "";
			rows.push(row);
			row = [];
		} else field += c;
	}
	if (field || row.length) {
		row.push(field);
		rows.push(row);
	}
	return rows;
}

/**
 * The listed companies of the code list's CSV (CP932): the rows marked 上場 that have a securities code.
 * A document without the expected columns, or without any company, is refused as a whole, so a changed
 * document never leaves a half-known list.
 */
export function parseCompanies(csv: Uint8Array): ListedCompany[] {
	let text: string;
	try {
		text = new TextDecoder("shift_jis", { fatal: true }).decode(csv);
	} catch {
		throw invalid();
	}
	const rows = csvRows(text);
	const headerAt = rows.findIndex(
		(r) => r.includes("証券コード") && r.includes("提出者名"),
	);
	if (headerAt < 0) throw invalid();
	const header = rows[headerAt]!;
	const column = (name: string) => header.indexOf(name);
	const listing = column("上場区分");
	const nameAt = column("提出者名");
	const english = column("提出者名（英字）");
	const reading = column("提出者名（ヨミ）");
	const code = column("証券コード");
	const capitalAt = column("資本金");
	if (listing < 0 || english < 0 || reading < 0 || capitalAt < 0)
		throw invalid();
	const companies: ListedCompany[] = [];
	const seen = new Set<string>();
	for (const row of rows.slice(headerAt + 1)) {
		if (row[listing]?.trim() !== "上場") continue;
		// Five characters: the four-character code and a check digit "0" (94340 is 9434).
		const found = /^([0-9]{3}[0-9A-Z])0$/.exec((row[code] ?? "").trim());
		const name = (row[nameAt] ?? "").replace(/[\s　]/g, "");
		if (!found || !name || seen.has(found[1]!)) continue;
		seen.add(found[1]!);
		const keys = [row[nameAt], row[english], row[reading]]
			.map((n) => normalizeName(n ?? ""))
			.filter(Boolean);
		const capital = Number((row[capitalAt] ?? "").trim());
		companies.push({
			code: found[1]!,
			name,
			capital: Number.isSafeInteger(capital) && capital > 0 ? capital : 0,
			keys: [...new Set(keys)],
		});
	}
	if (!companies.length || companies.length > MAX_COMPANIES) throw invalid();
	return companies;
}
