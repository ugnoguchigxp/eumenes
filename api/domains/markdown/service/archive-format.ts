import { sha256Hex } from "../../../infrastructure/digest";
import {
	editorDocumentSchema,
	id,
	title,
	type EditorDocument,
} from "../contracts";
const legacyStart = "<!-- eumenes-plate-document:v1\n";
const legacyEnd = "\n-->\n";
/** Desk excludes this existing original-source section from its evidence index. */
const section =
	"\n\n## 書き出し原本\n\nこの文書の編集データはEumenesで復元できます。\n\n";
const referenceStart = "[eumenes-plate-document-v2-";
// Desk rejects data: references. A reserved, unused HTTPS reference is accepted
// by its parser; it is never rendered as a link or fetched.
const referenceUrl = "]: <https://eumenes.invalid/plate-document/v2#";
/** An unused Markdown reference is invisible even in Desk's html:false renderer. */
export function encodeArchive(
	documentId: string,
	name: string,
	document: EditorDocument,
	markdown: string,
) {
	const payload = JSON.stringify({
		documentId: id.parse(documentId),
		title: title.parse(name),
		document: editorDocumentSchema.parse(document),
		markdownDigest: sha256Hex(markdown),
	});
	// A leading blank prevents Desk from removing a leading YAML-looking body as frontmatter.
	const encoded =
		"\n" +
		markdown +
		section +
		referenceStart +
		documentId +
		referenceUrl +
		Buffer.from(payload, "utf8").toString("base64") +
		">\n";
	if (Buffer.byteLength(encoded) > 2 * 1024 * 1024)
		throw new Error("markdown_document_too_large");
	for (let index = 0; index < markdown.length; index++) {
		const code = markdown.charCodeAt(index);
		if (code < 32 && code !== 9 && code !== 10 && code !== 13)
			throw new Error("markdown_source_invalid");
	}
	return encoded;
}
export function decodeArchive(text: string) {
	if (Buffer.byteLength(text) > 2 * 1024 * 1024)
		throw new Error("markdown_source_invalid");
	let encoded: string, markdown: string, labelId: string | undefined;
	if (text.startsWith(legacyStart)) {
		const boundary = text.indexOf(legacyEnd, legacyStart.length);
		if (boundary < 0) throw new Error("markdown_source_invalid");
		encoded = text.slice(legacyStart.length, boundary);
		markdown = text.slice(boundary + legacyEnd.length);
	} else {
		const boundary = text.lastIndexOf(section);
		if (!text.startsWith("\n") || boundary < 1)
			throw new Error("markdown_source_invalid");
		const reference = text.slice(boundary + section.length);
		const match =
			/^\[eumenes-plate-document-v2-([a-f0-9-]{36})\]: <https:\/\/eumenes\.invalid\/plate-document\/v2#([A-Za-z0-9+/]+={0,2})>\n$/.exec(
				reference,
			);
		if (!match) throw new Error("markdown_source_invalid");
		labelId = match[1];
		encoded = match[2]!;
		markdown = text.slice(1, boundary);
	}
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
		throw new Error("markdown_source_invalid");
	let value: Record<string, unknown>;
	try {
		value = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
	} catch {
		throw new Error("markdown_source_invalid");
	}
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("markdown_source_invalid");
	const documentId = id.safeParse(value.documentId),
		name = title.safeParse(value.title),
		document = editorDocumentSchema.safeParse(value.document);
	if (
		!documentId.success ||
		!name.success ||
		!document.success ||
		value.markdownDigest !== sha256Hex(markdown) ||
		(labelId !== undefined && labelId !== documentId.data)
	)
		throw new Error("markdown_source_invalid");
	return {
		documentId: documentId.data,
		title: name.data,
		document: document.data,
		markdown,
	};
}
