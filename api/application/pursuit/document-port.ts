import type { MarkdownService } from "../../domains/markdown";
import { documentName, type PursuitService } from "../../domains/pursuit";
import type { ResearchDocumentPort } from "../../domains/pursuit/contracts";
import { scratchUri, type ScratchStore } from "../../domains/scratch";

export function createResearchDocuments(
	options: { markdown?: MarkdownService; scratch?: ScratchStore },
	pursuit: () => PursuitService | undefined,
): ResearchDocumentPort | undefined {
	const { markdown, scratch } = options;
	if (!markdown) return undefined;
	markdown.generated.configure({
		validInTransaction(db, documentId, ownerRef) {
			const parts = ownerRef.split(":"),
				[id, epoch] = parts;
			return (
				parts.length === 2 &&
				!!id &&
				!!epoch &&
				Number.isInteger(Number(epoch)) &&
				Number(epoch) >= 0 &&
				pursuit()?.documentSourceInTransaction(
					db,
					documentId,
					id,
					Number(epoch),
				) === true
			);
		},
		async writeLocal(input, signal) {
			signal.throwIfAborted();
			if (!scratch) throw new Error("scratch_unavailable");
			const item = await scratch.put({
				id: input.id,
				conversationId: input.conversationId,
				name: `${documentName(input.title) || "調査報告"}.md`,
				mime: "text/markdown",
				data: new TextEncoder().encode(input.markdown),
				origin: "written",
				maker: "詳しいWeb調査",
				internal: true,
			});
			return scratchUri(item.id);
		},
		hasLocal: (id) => !!scratch?.get(id),
		forgetLocal(id) {
			const item = scratch?.get(id);
			if (item) scratch?.forgetWritten(id, item.conversationId);
		},
	});
	return {
		flush: () => markdown.generated.flush(),
		startInTransaction: (db, input) => {
			markdown.generated.startInTransaction(db, input);
		},
		currentInTransaction: (db, id) =>
			markdown.generated.currentInTransaction(db, id),
		cancelInTransaction: (db, id, forget) =>
			markdown.generated.cancelInTransaction(db, id, forget),
	};
}
