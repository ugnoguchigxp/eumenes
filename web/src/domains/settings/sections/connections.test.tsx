import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type { EumenesClient } from "../../../../../client";
import { ConnectionsSection } from "./connections";
import { settingsFixture } from "./fixture";
import { emptyCloud, type NewCloud } from "../shared";

afterEach(cleanup);
function Harness({ addCloud }: { addCloud: () => void }) {
	const [adding, setAdding] = useState(false);
	const [newCloud, setNewCloud] = useState<NewCloud>(emptyCloud);
	return (
		<ConnectionsSection
			client={{ cancelProbe: vi.fn() } as unknown as EumenesClient}
			value={settingsFixture()}
			change={vi.fn()}
			dirty={false}
			keys={[]}
			setKeys={vi.fn()}
			setRetry={vi.fn()}
			details={{ data: undefined } as never}
			diagnostics={{ data: undefined } as never}
			probes={{ data: [], refetch: vi.fn() } as never}
			probe={vi.fn(async () => {})}
			adding={adding}
			setAdding={setAdding}
			newCloud={newCloud}
			setNewCloud={setNewCloud}
			addCloud={addCloud}
		/>
	);
}
test("connections section shows LARM and opens the cloud registration form", () => {
	const addCloud = vi.fn();
	render(<Harness addCloud={addCloud} />);
	expect(screen.getByText("LARM")).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "クラウドAPIを登録" }));
	expect(screen.getByText("クラウドAPIの登録")).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "登録内容を追加" }));
	expect(addCloud).toHaveBeenCalledOnce();
});
