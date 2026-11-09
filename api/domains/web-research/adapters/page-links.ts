export type PageLink = { url: string; label: string };

const decodeReferences = (value: string) =>
	value.replace(/&(?:#(?:x[0-9a-f]+|\d+)|[a-z][a-z0-9]+);/gi, (entity) =>
		Bun.markdown.render(entity, { text: (value) => value }),
	);

/** Called only after the same bytes have passed the context guard. */
export async function sameOriginPageLinks(
	response: { body: Uint8Array; contentType?: string },
	page: URL,
): Promise<PageLink[]> {
	const contentType = response.contentType ?? "";
	if (
		!/^\s*(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/i.test(contentType)
	)
		return [];
	const charset = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType)?.[1];
	let html: string;
	try {
		html = new TextDecoder(charset).decode(response.body);
	} catch {
		return [];
	}
	const links = new Map<string, PageLink>();
	let active: PageLink | undefined;
	await new HTMLRewriter()
		.on("a[href]", {
			element(element) {
				active = undefined;
				const href = element.getAttribute("href");
				if (!href || links.size >= 96) return;
				let url: URL;
				try {
					url = new URL(decodeReferences(href), page);
				} catch {
					return;
				}
				url.hash = "";
				if (
					url.origin !== page.origin ||
					url.href === page.href ||
					url.username ||
					url.password ||
					url.href.length > 2048
				)
					return;
				const link = { url: url.href, label: "" };
				active = link;
				element.onEndTag(() => {
					if (active === link) active = undefined;
					link.label = decodeReferences(link.label).replace(/\s+/g, " ").trim();
					if (link.label && !links.has(link.url)) links.set(link.url, link);
				});
			},
			text(chunk) {
				if (active) active.label = (active.label + chunk.text).slice(0, 160);
			},
		})
		.transform(new Response(html))
		.arrayBuffer();
	return [...links.values()];
}
