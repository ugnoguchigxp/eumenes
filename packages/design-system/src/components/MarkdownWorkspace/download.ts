export function downloadMarkdown(text: string, name: string) {
	const url = URL.createObjectURL(
		new Blob([text], { type: "text/markdown;charset=utf-8" }),
	);
	const a = document.createElement("a");
	a.href = url;
	a.download = name;
	a.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}
