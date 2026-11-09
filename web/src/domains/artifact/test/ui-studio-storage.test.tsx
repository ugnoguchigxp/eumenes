import {
	ArtifactRenderer,
	type ArtifactEvent,
	type Snapshot,
} from "@eumenes/artifact-ui";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

afterEach(cleanup);

test("the saved app uses its declared record form and confirms deletion of its records", async () => {
	const dispatch = vi.fn(async (_event: ArtifactEvent) => ({
		status: "accepted" as const,
		message: "",
	}));
	const viewing = {
		id: "app-1",
		title: "読書メモ",
		savedRevision: 3,
		definition: {
			view: "form",
			title: "本を記録",
			fields: [
				{ id: "book-title", label: "題名", type: "text", required: true },
				{ id: "score", label: "評価", type: "number" },
			],
		},
		hasStorage: true,
		deleteDigest: "digest-3",
		storage: {
			collection: "notes",
			inputs: { "book-title": "book", score: "score" },
			operations: ["list", "create", "update", "delete"],
			columns: [
				{ name: "book", type: "string", label: "題名" },
				{ name: "score", type: "integer", label: "評価" },
			],
			rows: [
				{
					id: "row-1",
					revision: 2,
					createdAt: 1,
					updatedAt: 2,
					values: { book: "最初の本", score: 4 },
				},
			],
			page: 0,
			hasMore: true,
		},
	};
	const snapshot = (
		storageState?: string,
		storageError?: string,
	): Snapshot => ({
		"ui-studio": {
			kind: "ui-studio",
			revision: 3,
			appDevelopment: true,
			work: null,
			viewing: { ...viewing, storageState, storageError },
			session: null,
			stoppable: false,
			history: [
				{ id: viewing.id, title: viewing.title, updatedAt: 1, storageState },
			],
		},
	});
	const view = (next: Snapshot) => (
		<ArtifactRenderer
			definition={JSON.stringify({
				view: "ui-studio",
				source: "ui-studio",
				title: "Webアプリ開発",
			})}
			runtime={{ snapshot: next, dispatch }}
		/>
	);
	const { rerender } = render(view(snapshot()));
	const records = screen.getByRole("region", { name: "保存した記録" });
	const field = screen.getByRole("textbox", {
		name: /題名/,
	}) as HTMLInputElement;
	fireEvent.click(within(records).getByRole("button", { name: /^編集$/ }));
	await vi.waitFor(() => expect(field.value).toBe("最初の本"));
	fireEvent.change(field, { target: { value: "本を読み返す" } });
	fireEvent.click(screen.getByRole("button", { name: "変更を保存" }));
	await vi.waitFor(() =>
		expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
			action: "ui-storage-record",
			values: {
				appId: viewing.id,
				revision: "3",
				collection: "notes",
				record: JSON.stringify({
					operation: "update",
					id: "row-1",
					expectedRevision: 2,
					values: { book: "本を読み返す", score: 4 },
				}),
			},
		}),
	);
	fireEvent.click(within(records).getByRole("button", { name: "次へ" }));
	await vi.waitFor(() =>
		expect(dispatch.mock.calls[1]?.[0]).toMatchObject({
			action: "ui-storage-page",
			values: { page: "1" },
		}),
	);
	fireEvent.click(screen.getByRole("button", { name: "アプリを削除" }));
	const dialog = await screen.findByRole("dialog");
	expect(within(dialog).getByText(/保存した記録も削除されます/)).toBeTruthy();
	fireEvent.click(within(dialog).getByRole("button", { name: "削除する" }));
	await vi.waitFor(() =>
		expect(dispatch.mock.calls[2]?.[0]).toMatchObject({
			action: "ui-app-delete",
			values: { appId: viewing.id, revision: "3", digest: "digest-3" },
		}),
	);
	rerender(view(snapshot("deleting", "app_storage_delete_failed")));
	expect(screen.queryByRole("region", { name: "保存した記録" })).toBeNull();
	expect(screen.getByText(/アプリの削除待ち/)).toBeTruthy();
	expect(screen.getByRole("button", { name: "削除を再試行" })).toBeTruthy();
});
