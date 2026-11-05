import { z } from "zod";
import type { ExtractedContent } from "eumenes-interact";
import { BrowserDriverError } from "../contracts/ports";
const extracted = z.object({
	url: z.string().optional(),
	title: z.string().optional(),
	text: z.string(),
	charCount: z.number().int().nonnegative(),
	truncated: z.boolean(),
	root: z.enum(["target", "article", "main", "largest-block", "body"]),
});
/** A fixed read-only DOM inspection; neither page data nor model output becomes executable code. */
export function interactTextFunction(maxChars: number) {
	return `(el) => {
 const kind=el?'target':document.querySelector('article')?'article':document.querySelector('main')?'main':'body';
 const root=el||document.querySelector('article')||document.querySelector('main')||document.body;
 const walk=document.createTreeWalker(root,NodeFilter.SHOW_TEXT); const chunks=[]; let node;let count=0;
 while((node=walk.nextNode())&&count++<100000){const p=node.parentElement;if(!p||p.closest('script,style,nav,header,footer,aside')||p.getClientRects().length===0||getComputedStyle(p).visibility==='hidden')continue;chunks.push(node.textContent||'');}
 const text=chunks.join(' ').replace(/\\s+/g,' ').trim();return {url:location.href,title:document.title,text:text.slice(0,${maxChars}),charCount:text.length,truncated:count>=100000||text.length>${maxChars},root:kind};
}`;
}
export function parseInteractText(
	result: string | undefined,
	maxChars: number,
): ExtractedContent {
	try {
		const v = extracted.parse(
			JSON.parse(
				(result ?? "").replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, ""),
			),
		);
		if (v.text.length > maxChars || v.charCount < v.text.length)
			throw new Error("length");
		return v;
	} catch {
		throw new BrowserDriverError("extraction_invalid", false);
	}
}
