import { sha256Hex } from "../../../infrastructure/digest";
import {
	editorDocumentSchema,
	id,
	title,
	type EditorDocument,
} from "../contracts";
const start = "<!-- eumenes-plate-document:v1\n";
const end = "\n-->\n";
/** Markdown remains viewable in Desk; the passive envelope restores full editor data. */
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
	return (
		start + Buffer.from(payload, "utf8").toString("base64") + end + markdown
	);
}
export function decodeArchive(text: string) {
	if (!text.startsWith(start) || Buffer.byteLength(text) > 2 * 1024 * 1024)
		throw new Error("markdown_source_invalid");
	const boundary = text.indexOf(end, start.length);
	if (boundary < 0) throw new Error("markdown_source_invalid");
	const encoded = text.slice(start.length, boundary);
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
	const markdown = text.slice(boundary + end.length);
	if (
		!documentId.success ||
		!name.success ||
		!document.success ||
		value.markdownDigest !== sha256Hex(markdown)
	)
		throw new Error("markdown_source_invalid");
	return {
		documentId: documentId.data,
		title: name.data,
		document: document.data,
		markdown,
	};
}
