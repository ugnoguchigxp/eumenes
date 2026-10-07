import { act, fireEvent } from "@testing-library/react";

/** Minimal stand-in for @testing-library/user-event, which is not installed. */
export const user = {
	click: async (element: Element) => {
		await act(async () => {
			fireEvent.click(element);
		});
	},
	clear: async (element: HTMLElement) => {
		await act(async () => {
			fireEvent.change(element, { target: { value: "" } });
		});
	},
	type: async (element: HTMLElement, text: string) => {
		await act(async () => {
			fireEvent.change(element, {
				target: { value: (element as HTMLInputElement).value + text },
			});
		});
	},
	selectOptions: async (element: HTMLElement, value: string) => {
		await act(async () => {
			fireEvent.change(element, { target: { value } });
		});
	},
};
