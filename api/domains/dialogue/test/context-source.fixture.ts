/** Read a reference body's text for content assertions; user/assistant ledger messages stay verbatim. */
export function renderedContent(message: {
	role: string;
	content: string;
}): string {
	if (message.role !== "system" || !message.content.startsWith('{"context":'))
		return message.content;
	return JSON.parse(message.content).content;
}
