import { expect, test } from "bun:test";
import { hash } from "../../domains/capabilities";
import type {
	ExecutionReference,
	SupervisedExecutionSource,
} from "../../domains/tool-runtime";
import {
	fixture,
	NOTE_TEXT,
} from "../../domains/web-note/test/web-note.fixture";
import { waitFor } from "../../infrastructure/wait-for";
import type { CodexTurnInput } from "../../../packages/coding-runner/src/codex-turn";
import { createCodexWebNote } from "../web-note/codex-web-note";

test("conversation and supervised research use the same Codex search turn with only the public query", async () => {
	const calls: CodexTurnInput[] = [];
	const privateRef = "fixture-private-context-never-search";
	const secret = "fixture-auth-value-never-search";
	const codex = createCodexWebNote(
		{ PATH: "/usr/bin:/bin", LARM_TOKEN: secret },
		"/usr/bin/true",
		{},
		async (input) => {
			calls.push(input);
			return { text: NOTE_TEXT, searches: 2, usage: null };
		},
	);
	const h = await fixture({ turn: codex.turn });
	try {
		const ordinary = await h.start();
		const source: SupervisedExecutionSource = {
			origin: "supervised",
			conversationId: "main",
			messageId: null,
			runId: "fixture-run",
			request: h.request,
			digest: hash(h.request),
			delegation: {
				grantRef: "grant",
				parentWorkId: "parent",
				taskId: "research",
				parentGeneration: 0,
				taskGeneration: 0,
			},
		};
		const refs: ExecutionReference[] = [
			{
				kind: "memory",
				owner: "memory",
				ref: "ref",
				id: "id",
				revision: "1",
				digest: hash(privateRef),
				label: privateRef,
				preview: privateRef,
			},
		];
		h.service.configure({
			validSourceInTransaction: () => true,
			deliverInTransaction: () => true,
			revokeDeliveryInTransaction() {},
			supervised: {
				authorizeInTransaction: (_db, candidate) =>
					hash(candidate.source) === hash(source)
						? { deadline: h.now() + 60_000 }
						: null,
				deliverInTransaction: () => true,
			},
		});
		const supervised = await h.store.write((db) =>
			h.service.supervised.startInTransaction(db, {
				operationId: crypto.randomUUID(),
				source,
				request: h.request,
				references: refs,
				toolchainRevisionId: "toolchain:web.note@4",
				bindingRevisionId: "binding:web.note@2",
			}),
		);
		const view = () =>
			h.store.readSnapshot((db) =>
				h.service.supervised.viewInTransaction(db, source, supervised.id),
			);
		h.run();
		await waitFor(
			() =>
				h.view(ordinary.id)?.status === "completed" &&
				view()?.status === "completed",
		);
		expect(calls).toHaveLength(2);
		const [{ signal: _first, ...first }, { signal: _second, ...second }] =
			calls as [CodexTurnInput, CodexTurnInput];
		expect(first).toEqual(second);
		expect(first.webSearch).toBe("live");
		expect(first.prompt).toContain(h.request);
		expect(first.prompt).not.toContain(privateRef);
		expect(JSON.stringify(first.env)).not.toContain(secret);
		expect(first.configOverrides).toContain("mcp_servers={}");
		expect(h.view(ordinary.id)?.result?.sources).toEqual(
			view()?.result?.sources,
		);
		expect(h.view(supervised.id)).toBeNull();
	} finally {
		await h.close();
	}
});
