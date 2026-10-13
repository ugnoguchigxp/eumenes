import { test, expect } from "vitest";
import { drawingDrafts } from "./drafts";
test("a failed candidate retains its retry key and also preserves edits made afterwards", () => {
	const items = new Map<string, string>();
	const storage = {
		getItem: (key: string) => items.get(key) ?? null,
		setItem: (key: string, value: string) => {
			items.set(key, value);
		},
		removeItem: (key: string) => {
			items.delete(key);
		},
	};
	const drafts = drawingDrafts(storage),
		id = crypto.randomUUID(),
		scene = { elements: [], appState: {}, files: {} };
	drafts.write({
		referenceId: id,
		key: "draft-latest",
		title: "new edits",
		scene,
		expectedRevision: 1,
		pending: {
			key: "failed-original",
			title: "first attempt",
			scene,
			expectedRevision: 1,
		},
	});
	const saved = drafts.read(id)!;
	expect(saved.title).toBe("new edits");
	expect(saved.pending?.key).toBe("failed-original");
	expect(drafts.read(crypto.randomUUID())).toBeNull();
	drafts.remove(id);
	expect(drafts.read(id)).toBeNull();
	items.set(`eumenes-excalidraw-draft:${id}`, "{bad");
	expect(drafts.read(id)).toBeNull();
});
