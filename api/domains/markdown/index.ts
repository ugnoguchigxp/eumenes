export { createMarkdown, type MarkdownService } from "./service";
export { migrations } from "./repository";
export { encodeArchive, decodeArchive } from "./service/archive-format";
export { registerMarkdown } from "./controller";
export {
	ArchiveFailure,
	type ArchivePort,
	type ArchiveEntry,
	type EditorDocument,
} from "./contracts";

export { createMarkdownResourceAdapter } from "./service/resource-adapter";
