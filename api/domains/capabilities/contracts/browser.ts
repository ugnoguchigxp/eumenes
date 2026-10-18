import { z } from "zod";

/** Host-issued reference from the browser snapshot (tabs) or a capture receipt. */
const tabRef = z.uuid();

/**
 * One capture of a connected tab. Quality, format and file names are not inputs: the host fixes
 * them. An element capture needs an observation of the page, which only a page-operation task
 * has, so the conversation's capture tool offers the two whole-page ranges.
 */
export const browserCaptureStart = z
	.object({
		tabRef: tabRef.describe("snapshotのtabs[].tabRef"),
		range: z
			.enum(["viewport", "full-page"])
			.describe(
				"viewportは今見えている範囲、full-pageはページ全体（各辺2500pxまで）",
			),
	})
	.strict();
export const browserCaptureTarget = z
	.object({
		captureId: z.uuid().describe("snapshotのcaptures[].captureId"),
	})
	.strict();
/** A tab of the screen's list (switch or close); the screen reads the ref from the same list. */
export const browserTabTarget = z.object({ tabRef }).strict();
/** A new tab for a URL the user typed on the screen; the host checks where it may go. */
export const browserTabOpen = z
	.object({ url: z.string().trim().min(1).max(2048) })
	.strict();

/** A page-operation task (`browser.task.start`): the request and, optionally, the tab or URL it starts from. */
export const browserTaskStart = z
	.object({
		request: z
			.string()
			.trim()
			.min(1)
			.max(4000)
			.describe(
				"利用者の依頼。対象・条件・入力する語句を原文から保持し、直前の会話で明確になった対象を補う。未指定の条件は足さない。",
			),
		tabRef: tabRef
			.optional()
			.describe("操作するタブ。snapshotのtabs[].tabRef。省略は今のタブ"),
		url: z
			.string()
			.trim()
			.min(1)
			.max(2048)
			.optional()
			.describe("依頼が開くURLを指すときだけ"),
	})
	.strict();
/**
 * `browserTaskStart` plus the continuation of a task that ended asking for the user's approval
 * (`browser.task.begin`; the earlier schema stays for the revisions that use it). `approvePending` is true only
 * when the user clearly agreed to the action or value that task showed.
 */
export const browserTaskBegin = z
	.object({
		request: browserTaskStart.shape.request,
		tabRef: browserTaskStart.shape.tabRef,
		url: browserTaskStart.shape.url,
		continueFrom: z
			.uuid()
			.optional()
			.describe(
				"承認待ち（needs_input）で止まった操作のtaskId。snapshotのtasks[].taskId。その続きを頼むときだけ",
			),
		approvePending: z
			.boolean()
			.optional()
			.describe(
				"continueFromの操作・値を、利用者が示された内容のとおりにはっきり許可したときだけtrue。迷うときは省く",
			),
	})
	.strict()
	.refine((t) => !t.approvePending || !!t.continueFrom, "approve_without_task");
/** A task of the snapshot (status or cancel). */
export const browserTaskTarget = z
	.object({ taskId: z.uuid().describe("snapshotのtasks[].taskId") })
	.strict();

/**
 * The tools of the page operator (`package:browser.page-operator@1`). The model fills these flat objects; the
 * host checks them again before anything reaches the browser. Element refs come with the observation they were
 * read from, and typed text only as a value quoted from the request (the host turns it into a grant).
 */
const observationRef = z.uuid().describe("直近の観測のobservationRef");
const elementRef = z
	.string()
	.regex(/^[A-Za-z0-9_-]{1,32}$/)
	.describe("観測textの[ref=eN]のeN");
const elementName = z
	.string()
	.trim()
	.min(1)
	.max(200)
	.describe("要素の名前と役割（観測の表示どおり）");
const effect = z
	.enum(["navigate", "input", "commit"])
	.describe(
		"操作の影響。navigate=閲覧・移動・検索、input=入力欄の選択や値の入力、commit=送信・購入・公開・削除・保存（Eumenes自身の画面での保存を含む）",
	);

export const browserPageClick = z
	.object({
		observationRef,
		ref: elementRef,
		element: elementName,
		effect,
	})
	.strict();
export const browserPageHover = z
	.object({ observationRef, ref: elementRef, element: elementName })
	.strict();
export const browserPageType = z
	.object({
		observationRef,
		ref: elementRef,
		element: elementName,
		value: z.string().min(1).max(2000).describe("入力する値"),
		quote: z
			.string()
			.trim()
			.min(1)
			.max(500)
			.describe("valueの元にした、利用者の原文にある一節（原文のまま）"),
		purpose: z.string().trim().min(1).max(60).describe("入力の用途の短い語"),
		submit: z.boolean().describe("入力後にEnterを押すか"),
		effect: effect.optional().describe("submitがtrueのときは必須"),
	})
	.strict();
/**
 * `browserPageType` that can also type a value the user approved: `inputValueRef` of the REFERENCE's approved
 * list (then no `value` or `quote`), or a new value with the passage of the request it came from.
 */
export const browserPageTypeValue = z
	.object({
		observationRef,
		ref: elementRef,
		element: elementName,
		inputValueRef: z
			.uuid()
			.optional()
			.describe(
				"REFERENCEのapprovedにある入力値のinputValueRef。使うときvalueとquoteは書かない",
			),
		value: z.string().min(1).max(2000).optional().describe("入力する値"),
		quote: z
			.string()
			.trim()
			.min(1)
			.max(500)
			.optional()
			.describe("valueの元にした、利用者の原文にある一節（原文のまま）"),
		purpose: z.string().trim().min(1).max(60).describe("入力の用途の短い語"),
		submit: z.boolean().describe("入力後にEnterを押すか"),
		effect: effect.optional().describe("submitがtrueのときは必須"),
	})
	.strict()
	.refine(
		(t) => (t.inputValueRef ? !t.value && !t.quote : !!t.value && !!t.quote),
		"value_source",
	);
export const browserPageSelect = z
	.object({
		observationRef,
		ref: elementRef,
		element: elementName,
		values: z.array(z.string().min(1).max(500)).min(1).max(20),
	})
	.strict();
export const browserPagePress = z
	.object({
		key: z
			.string()
			.regex(/^[A-Za-z0-9+]{1,40}$/)
			.describe("キー名（Enter、Escape、ArrowDownなど）"),
		effect,
	})
	.strict();
export const browserPageWait = z
	.object({
		text: z.string().min(1).max(200).optional().describe("現れるのを待つ文字"),
		textGone: z
			.string()
			.min(1)
			.max(200)
			.optional()
			.describe("消えるのを待つ文字"),
		seconds: z.number().gt(0).max(30).optional().describe("待つ秒数"),
	})
	.strict()
	.refine((w) => w.text || w.textGone || w.seconds, "wait_condition");
export const browserPageCapture = z
	.object({
		range: z
			.enum(["viewport", "full-page", "element"])
			.describe(
				"viewport=見えている範囲、full-page=ページ全体、element=一要素",
			),
		observationRef: observationRef.optional().describe("elementのときだけ"),
		ref: elementRef.optional().describe("elementのときだけ"),
	})
	.strict()
	.refine(
		(c) =>
			c.range === "element"
				? !!c.ref && !!c.observationRef
				: !c.ref && !c.observationRef,
		"element_ref_mismatch",
	);
