export { createMarkdown, type MarkdownService } from "./service";
export { migrations } from "./repository";
export { encodeArchive, decodeArchive } from "./service/archive-format";
export { registerMarkdown } from "./controller";
export type { ArchivePort, EditorDocument } from "./contracts";

export { createMarkdownResourceAdapter } from "./service/resource-adapter";
