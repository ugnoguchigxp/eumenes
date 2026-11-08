import { expect, test } from "bun:test";
import { waitFor } from "../../../infrastructure/wait-for";
import type { ResearchDocumentPort } from "../contracts";
import { fixture } from "./pursuit.fixture";
import { documentName } from "../service/documents";

function documentPort() {
	let input:
		Parameters<ResearchDocumentPort["startInTransaction"]>[1] | undefined;
	let ready = false,
		cancelled = false,
		forgotten = false;
	const port: ResearchDocumentPort = {
		startInTransaction(_db, value) {
			input = value;
		},
		currentInTransaction: () =>
			input
				? {
						id: input.id,
						title: input.title,
						path: input.path,
						state: ready ? "settled" : "pending",
						local: { state: "saved", uri: `eumenes://scratch/${input.id}` },
						archive: {
							state: "saved",
							sourceId: `wiki-${input.id.replaceAll("-", "")}`,
						},
					}
				: null,
		cancelInTransaction(_db, _id, forget) {
			cancelled = true;
			forgotten = !!forget;
		},
	};
	return {
		port,
		input: () => input,
		complete: () => {
			ready = true;
		},
		cancelled: () => cancelled,
		forgotten: () => forgotten,
	};
}
async function research(f: Awaited<ReturnType<typeof fixture>>) {
	f.start();
	await waitFor(() => f.observations.size === 1);
	await f.finishWeb();
	await waitFor(() => f.observations.size === 2);
	await f.finishWeb();
}

test("new research waits for the document receipt, then returns its title and file references without another model call", async () => {
	const documents = documentPort(),
		f = await fixture({ documents: documents.port });
	try {
		await research(f);
		await waitFor(() => !!documents.input());
		expect(f.view()?.status).toBe("waiting_child");
		expect(f.notices).toHaveLength(0);
		const calls = f.calls();
		expect(documents.input()).toMatchObject({
			title: "一次資料の比較調査",
			markdown: "本文で確認した結論です。[資料](https://example.com/source)",
			namespace: "eumenes",
		});
		expect(documents.input()!.path).toMatch(
			/^research\/\d{4}-\d{2}-\d{2}_一次資料の比較調査_.*\.md$/,
		);
		documents.complete();
		await f.service().maintain();
		expect(f.calls()).toBe(calls);
		expect(f.view()).toMatchObject({
			status: "completed",
			result: {
				document: { title: "一次資料の比較調査", archive: { state: "saved" } },
			},
		});
		expect(f.view()?.result?.links).toHaveLength(2);
		await f.service().maintain();
		expect(f.notices).toHaveLength(1);
		await f
			.store()
			.write((db) => f.service().task.forgetInTransaction!(db, f.id));
		expect(documents.forgotten()).toBe(true);
	} finally {
		await f.close();
	}
});

test("cancellation while saving revokes the document operation and never adopts the late receipt", async () => {
	const documents = documentPort(),
		f = await fixture({ documents: documents.port });
	try {
		await research(f);
		await waitFor(() => !!documents.input());
		await f
			.store()
			.write((db) => f.service().task.cancelInTransaction!(db, "main", f.id));
		expect(documents.cancelled()).toBe(true);
		documents.complete();
		await f.service().maintain();
		expect(f.view()?.status).toBe("cancelled");
		expect(f.view()?.result?.document).toBeUndefined();
	} finally {
		await f.close();
	}
});

test("only filesystem separators and filename length are normalized, without changing the document title", () => {
	expect(documentName("一次資料/日本語\\比較\n調査")).toBe(
		"一次資料_日本語_比較_調査",
	);
	expect([...documentName("長い日本語".repeat(100))]).toHaveLength(80);
});

test("a partial research report remains partial after its document is saved", async () => {
	const documents = documentPort(),
		f = await fixture({ documents: documents.port, grader: false });
	try {
		await research(f);
		await waitFor(() => !!documents.input());
		documents.complete();
		await f.service().maintain();
		expect(f.view()?.status).toBe("partial");
		expect(f.view()?.result?.document?.archive.state).toBe("saved");
	} finally {
		await f.close();
	}
});

test("restarting while awaiting the same document receipt does not repeat research or create another document", async () => {
	const documents = documentPort(),
		f = await fixture({ documents: documents.port });
	try {
		await research(f);
		await waitFor(() => !!documents.input());
		const id = documents.input()!.id,
			calls = f.calls();
		await f.restart();
		expect(f.view()?.status).toBe("waiting_child");
		expect(documents.input()!.id).toBe(id);
		documents.complete();
		await f.service().maintain();
		await waitFor(() => f.view()?.status === "completed");
		expect(f.calls()).toBe(calls);
	} finally {
		await f.close();
	}
});

test("forgetting after an amendment removes document outputs from every superseded epoch", async () => {
	const ids: string[] = [],
		forgotten: string[] = [];
	const documents = documentPort();
	const start = documents.port.startInTransaction;
	documents.port.startInTransaction = (db, input) => {
		ids.push(input.id);
		start(db, input);
	};
	const cancel = documents.port.cancelInTransaction;
	documents.port.cancelInTransaction = (db, id, forget) => {
		if (forget) forgotten.push(id);
		cancel(db, id, forget);
	};
	const f = await fixture({ documents: documents.port });
	try {
		await research(f);
		await waitFor(() => ids.length === 1);
		await f.store().write((db) =>
			f.service().task.controlInTransaction(
				db,
				"main",
				{
					workRef: f.id,
					expectedRevision: f.view()!.revision,
					action: "amend",
					request: "別の条件を確認して",
				},
				"amendment",
			),
		);
		await f
			.store()
			.write((db) => f.service().task.forgetInTransaction!(db, f.id));
		expect(forgotten).toContain(ids[0]!);
	} finally {
		await f.close();
	}
});
