import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ArtifactDefinitionV1 } from "../../../../api/domains/capabilities/contracts";
import { ApiConnectionError } from "../../../../client/transport";
import { reviewRows, ruleOf, toWire, type DocumentAccess } from "./documents";
import { createWebAdapterRegistry, type WebArtifactAdapter } from "./registry";
import { ToolchainArtifactHost } from "./ToolchainArtifactHost";

const DOC = "document:vault@1";
const REV = "artifact:vault.screen@1";
const SECRET = "sk-test-never-store-me";

/** A tiny document adapter: one plain field and one confidential field. */
const adapter: WebArtifactAdapter = {
	adapterRef: "adapter:vault@1",
	useArtifact(ctx) {
		const view = ctx.drafts[DOC]!;
		const fields = ctx.documentFields[DOC] ?? [];
		const access: DocumentAccess = {
			ready: true,
			revision: 7,
			read: () => undefined,
			rule: (field) => ruleOf(field),
			targets: () => [],
		};
		const own = ctx.artifact.fields ?? [];
		const revision = 7 + view.version;
		return {
			phase: { kind: "ready" },
			snapshot: {
				"vault-section": {
					kind: "settings-section",
					revision,
					dirty: view.entries.length + view.secrets.length > 0,
					busy: view.busy,
					message: view.message,
					fields: own.map((field) => ({
						id: field.fieldId,
						label: field.label,
						control: field.control,
						// A confidential value is never read back into the screen.
						value: field.confidential
							? ""
							: toWire(
									view.entries.find((e) => e.fieldId === field.fieldId)
										?.change &&
										"value" in
											view.entries.find((e) => e.fieldId === field.fieldId)!
												.change
										? (
												view.entries.find((e) => e.fieldId === field.fieldId)!
													.change as { value: string }
											).value
										: undefined,
								),
					})),
				},
				"vault-changes": {
					kind: "settings-changes",
					revision,
					dirty: view.entries.length + view.secrets.length > 0,
					busy: view.busy,
					blocked: false,
					message: view.message,
					rows: reviewRows(view, fields, access),
				},
			},
			targetOf: () => undefined,
			local: async () => ({ status: "rejected", message: "" }),
			settled: () => {},
			refresh: () => {},
			documents: { [DOC]: access },
		};
	},
};

const binding = (
	actionId: string,
	eventAction: string,
	source: string,
	extra: object,
) => ({
	actionId,
	eventAction,
	source,
	inputSchemaRef: "builtin:emptyInput",
	effect: "draft",
	...extra,
});
const artifact = {
	kind: "artifact",
	id: "vault.screen",
	revision: 1,
	title: "保管",
	defaultVariant: "standard",
	variants: [
		{
			id: "standard",
			label: "標準",
			definition: {
				view: "layout",
				children: [
					{ view: "settings-section", source: "vault-section", title: "保管" },
					{ view: "settings-changes", source: "vault-changes" },
				],
			},
		},
	],
	sourceBindings: [
		{
			source: "vault-section",
			adapterRef: "adapter:vault@1",
			query: "query:vault.doc@1",
			target: "none",
		},
		{
			source: "vault-changes",
			adapterRef: "adapter:vault@1",
			query: "query:vault.doc@1",
			target: "none",
		},
	],
	actionBindings: [
		binding("edit", "settings-edit", "vault-section", {
			draftAction: "edit",
			draftDocument: DOC,
		}),
		binding("apply", "settings-apply", "vault-section", {
			effect: "write",
			operationId: "vault.apply",
			inputSchemaRef: "builtin:vaultApply",
			draftDocument: DOC,
			confidentialFields: ["keys"],
		}),
		binding("apply-changes", "settings-apply", "vault-changes", {
			effect: "write",
			operationId: "vault.apply",
			inputSchemaRef: "builtin:vaultApply",
			draftDocument: DOC,
			confidentialFields: ["keys"],
		}),
		binding("discard", "settings-discard", "vault-changes", {
			draftAction: "discard",
			draftDocument: DOC,
		}),
	],
	fields: [
		{
			fieldId: "vault.name",
			document: DOC,
			path: "$.name",
			label: "名前",
			control: "text",
		},
		{
			fieldId: "vault.key",
			document: DOC,
			path: "$.key",
			label: "APIキー",
			control: "text",
			confidential: true,
		},
	],
} as unknown as ArtifactDefinitionV1;

function setup(
	submit: ReturnType<typeof vi.fn>,
	definition: ArtifactDefinitionV1 = artifact,
) {
	const client = {
		identity: crypto.randomUUID(),
		toolchainArtifact: vi.fn(async () => ({
			artifact: definition,
			artifactRevisionId: REV,
			digest: "d",
			scopeRef: "scope:main",
		})),
		toolchainArtifacts: vi.fn(async () => []),
		toolchainInteractions: vi.fn(async () => []),
		submitToolchainAction: submit,
		toolchainAction: vi.fn(),
		unsettledToolchainActions: vi.fn(async () => []),
	};
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={cache}>
			<ToolchainArtifactHost
				client={client as never}
				adapters={createWebAdapterRegistry([adapter])}
				artifactRevisionId={REV}
				artifactId="tab"
			/>
		</QueryClientProvider>,
	);
	return client;
}

beforeEach(() => sessionStorage.clear());
afterEach(cleanup);

const accepted = (eventId: string) => ({
	httpStatus: 200,
	view: {
		eventId,
		status: "accepted",
		createdAt: new Date().toISOString(),
		result: {
			version: 1,
			executionId: "e",
			artifactRevisionId: REV,
			outcome: "completed",
			resultRefs: [],
			artifactRefs: [],
		},
	},
});

test("a confidential value stays in memory: not on screen, not in storage, only a count in the review", async () => {
	setup(vi.fn());
	fireEvent.change(await screen.findByLabelText("APIキー"), {
		target: { value: SECRET },
	});
	fireEvent.change(screen.getByLabelText("名前"), {
		target: { value: "公開名" },
	});
	await screen.findByText("更新・削除予定 1件");
	expect(document.body.textContent).not.toContain(SECRET);
	expect(JSON.stringify({ ...sessionStorage })).not.toContain(SECRET);
	expect(sessionStorage.length).toBe(0);
	expect(screen.getByLabelText("APIキー")).toHaveProperty("type", "password");
	expect(screen.getByLabelText("APIキー")).toHaveProperty("value", SECRET);
});

test("an apply with secrets sends them once, keeps nothing in the outbox and forgets them on success", async () => {
	const submit = vi.fn(async (event: { eventId: string; input?: unknown }) =>
		accepted(event.eventId),
	);
	setup(submit);
	fireEvent.change(await screen.findByLabelText("APIキー"), {
		target: { value: SECRET },
	});
	fireEvent.click(
		screen.getAllByRole("button", { name: "設定の変更をすべて適用" })[0]!,
	);
	await screen.findAllByText("変更を適用しました");
	expect(submit).toHaveBeenCalledOnce();
	const input = submit.mock.calls[0]![0].input;
	expect(input).toEqual({
		expectedRevision: 7,
		changes: [],
		keys: [{ connectionId: "vault.key", value: SECRET }],
	});
	expect(sessionStorage.length).toBe(0);
	expect(screen.queryByText(/更新・削除予定/)).toBeNull();
});

test("an unknown outcome asks for the credentials again, resends nothing and keeps no secret", async () => {
	const submit = vi.fn(async () => {
		throw new ApiConnectionError();
	});
	const client = setup(submit);
	fireEvent.change(await screen.findByLabelText("APIキー"), {
		target: { value: SECRET },
	});
	fireEvent.change(screen.getByLabelText("名前"), {
		target: { value: "公開名" },
	});
	fireEvent.click(
		screen.getAllByRole("button", { name: "設定の変更をすべて適用" })[0]!,
	);
	await screen.findAllByText(/認証情報を再入力して適用し直してください/);
	expect(sessionStorage.length).toBe(0);
	await new Promise((resolve) => setTimeout(resolve, 150));
	expect(submit).toHaveBeenCalledOnce();
	expect(client.toolchainAction).not.toHaveBeenCalled();
	// The secret is gone from the draft; the plain edit is still there to apply again.
	expect(screen.queryByText(/更新・削除予定/)).toBeNull();
	await waitFor(() =>
		expect(screen.getByLabelText("名前")).toHaveProperty("value", "公開名"),
	);
});

test("a plain draft is written to the outbox before it is sent", async () => {
	const submit = vi.fn(async () => {
		throw new ApiConnectionError();
	});
	setup(submit);
	fireEvent.change(await screen.findByLabelText("名前"), {
		target: { value: "公開名" },
	});
	fireEvent.click(
		screen.getAllByRole("button", { name: "設定の変更をすべて適用" })[0]!,
	);
	await waitFor(() => expect(sessionStorage.length).toBe(1));
	const stored = sessionStorage.getItem(sessionStorage.key(0)!);
	expect(stored).toContain("公開名");
});

test("secrets are never persisted even when the binding declares no confidential fields", async () => {
	const undeclared = {
		...artifact,
		actionBindings: artifact.actionBindings.map((b) => {
			const { confidentialFields: _omit, ...rest } = b;
			return rest;
		}),
	} as unknown as ArtifactDefinitionV1;
	const submit = vi.fn(async () => {
		throw new ApiConnectionError();
	});
	setup(submit, undeclared);
	fireEvent.change(await screen.findByLabelText("APIキー"), {
		target: { value: SECRET },
	});
	fireEvent.click(
		screen.getAllByRole("button", { name: "設定の変更をすべて適用" })[0]!,
	);
	await screen.findAllByText(/認証情報を再入力して適用し直してください/);
	expect(sessionStorage.length).toBe(0);
	await new Promise((resolve) => setTimeout(resolve, 100));
	expect(submit).toHaveBeenCalledOnce();
});
