import { sha256Hex } from "../../../infrastructure/digest";
import { editorDocumentSchema, type EditorDocument, type ArchiveEntry, type ArchiveSave } from "../contracts";
export const archiveDigest = (markdown: string, recovery: string) =>
	sha256Hex(sha256Hex(markdown) + "\n" + sha256Hex(recovery));
export function restoreDocument(recovery: string): EditorDocument | null {
	if (recovery === "") return null;
	try { return editorDocumentSchema.parse(JSON.parse(recovery)); }
	catch { throw new Error("markdown_source_invalid"); }
}
export const matchesSave = (entry: ArchiveEntry, save: ArchiveSave) =>
	entry.sourceId === save.sourceId && entry.contentDigest === save.contentDigest &&
	entry.title === save.title && entry.namespace === save.namespace && entry.path === save.path;
