import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Calculator } from "./Calculator";

// Mock react-i18next
vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string) => key,
	}),
}));

describe("電卓", () => {
	const user = userEvent.setup();

	it("renders correctly (inline mode)", () => {
		// If onResult is provided, it renders inline without modal
		render(<Calculator onResult={vi.fn()} />);
		// Check for display 0
		expect(
			screen.getByText("0", { selector: ".text-right" }),
		).toBeInTheDocument();
		// Check for buttons
		expect(screen.getByText("7")).toBeInTheDocument();
		expect(screen.getByText("=")).toBeInTheDocument();
		expect(screen.getByText("C")).toBeInTheDocument();
	});

	it("performs basic addition", async () => {
		render(<Calculator onResult={vi.fn()} />);

		await user.click(screen.getByRole("button", { name: "1" }));
		await user.click(screen.getByRole("button", { name: "+" }));
		await user.click(screen.getByRole("button", { name: "2" }));
		await user.click(screen.getByRole("button", { name: "=" }));

		expect(
			screen.getByText("3", { selector: ".text-right" }),
		).toBeInTheDocument();
	});

	it("performs basic subtraction", async () => {
		render(<Calculator onResult={vi.fn()} />);

		await user.click(screen.getByRole("button", { name: "5" }));
		await user.click(screen.getByRole("button", { name: "-" }));
		await user.click(screen.getByRole("button", { name: "3" }));
		await user.click(screen.getByRole("button", { name: "=" }));

		expect(
			screen.getByText("2", { selector: ".text-right" }),
		).toBeInTheDocument();
	});

	it("performs multiplication with precedence", async () => {
		render(<Calculator onResult={vi.fn()} />);

		// 2 + 3 * 4 = 14
		await user.click(screen.getByRole("button", { name: "2" }));
		await user.click(screen.getByRole("button", { name: "+" }));
		await user.click(screen.getByRole("button", { name: "3" }));
		await user.click(screen.getByRole("button", { name: "*" }));
		await user.click(screen.getByRole("button", { name: "4" }));
		await user.click(screen.getByRole("button", { name: "=" }));

		expect(
			screen.getByText("14", { selector: ".text-right" }),
		).toBeInTheDocument();
	});

	it("performs division", async () => {
		render(<Calculator onResult={vi.fn()} />);

		await user.click(screen.getByRole("button", { name: "8" }));
		await user.click(screen.getByRole("button", { name: "/" }));
		await user.click(screen.getByRole("button", { name: "2" }));
		await user.click(screen.getByRole("button", { name: "=" }));

		expect(
			screen.getByText("4", { selector: ".text-right" }),
		).toBeInTheDocument();
	});

	it("handles decimal numbers", async () => {
		render(<Calculator onResult={vi.fn()} />);

		await user.click(screen.getByRole("button", { name: "1" }));
		await user.click(screen.getByRole("button", { name: "." }));
		await user.click(screen.getByRole("button", { name: "5" }));
		await user.click(screen.getByRole("button", { name: "+" }));
		await user.click(screen.getByRole("button", { name: "0" }));
		await user.click(screen.getByRole("button", { name: "." }));
		await user.click(screen.getByRole("button", { name: "5" }));
		await user.click(screen.getByRole("button", { name: "=" }));

		expect(
			screen.getByText("2", { selector: ".text-right" }),
		).toBeInTheDocument();
	});

	it("handles division by zero", async () => {
		render(<Calculator onResult={vi.fn()} />);

		await user.click(screen.getByRole("button", { name: "5" }));
		await user.click(screen.getByRole("button", { name: "/" }));
		await user.click(screen.getByRole("button", { name: "0" }));
		await user.click(screen.getByRole("button", { name: "=" }));

		expect(
			screen.getByText("エラー", { selector: ".text-right" }),
		).toBeInTheDocument();
	});

	it("clears display", async () => {
		render(<Calculator onResult={vi.fn()} />);

		await user.click(screen.getByRole("button", { name: "5" }));
		await user.click(screen.getByRole("button", { name: "C" }));

		expect(
			screen.getByText("0", { selector: ".text-right" }),
		).toBeInTheDocument();
	});

	it("opens modal when onResult is not provided", async () => {
		render(<Calculator />);

		const trigger = screen.getByRole("button", { name: "電卓" });
		await user.click(trigger);

		expect(screen.getByRole("dialog")).toBeInTheDocument();
		expect(
			screen.getByText("0", { selector: ".text-right" }),
		).toBeInTheDocument();
	});

	it("calls onResult callback", async () => {
		const onResult = vi.fn();
		render(<Calculator onResult={onResult} />);

		await user.click(screen.getByRole("button", { name: "2" }));
		await user.click(screen.getByRole("button", { name: "*" }));
		await user.click(screen.getByRole("button", { name: "3" }));
		await user.click(screen.getByRole("button", { name: "=" }));

		expect(onResult).toHaveBeenCalledWith(6);
	});

	it("resets error state on new input", async () => {
		render(<Calculator onResult={vi.fn()} />);

		// Cause error
		await user.click(screen.getByRole("button", { name: "1" }));
		await user.click(screen.getByRole("button", { name: "/" }));
		await user.click(screen.getByRole("button", { name: "0" }));
		await user.click(screen.getByRole("button", { name: "=" }));
		expect(
			screen.getByText("エラー", { selector: ".text-right" }),
		).toBeInTheDocument();

		// New input
		await user.click(screen.getByRole("button", { name: "5" }));
		expect(
			screen.getByText("5", { selector: ".text-right" }),
		).toBeInTheDocument();
	});

	it("handles invalid expressions", async () => {
		render(<Calculator onResult={vi.fn()} />);

		// "1 + =" (Trailing operator)
		await user.click(screen.getByRole("button", { name: "1" }));
		await user.click(screen.getByRole("button", { name: "+" }));
		await user.click(screen.getByRole("button", { name: "=" }));
		expect(
			screen.getByText("エラー", { selector: ".text-right" }),
		).toBeInTheDocument();

		// Clear
		await user.click(screen.getByRole("button", { name: "C" }));

		// "++" (Consecutive operators - may be valid if signed? No, our parser is simple infix)
		await user.click(screen.getByRole("button", { name: "+" }));
		await user.click(screen.getByRole("button", { name: "+" }));
		await user.click(screen.getByRole("button", { name: "=" }));
		expect(
			screen.getByText("エラー", { selector: ".text-right" }),
		).toBeInTheDocument();

		// Clear
		await user.click(screen.getByRole("button", { name: "C" }));

		// "1 * -" (might crash parsing or be invalid)
		await user.click(screen.getByRole("button", { name: "1" }));
		await user.click(screen.getByRole("button", { name: "*" }));
		await user.click(screen.getByRole("button", { name: "-" }));
		await user.click(screen.getByRole("button", { name: "=" }));
		expect(
			screen.getByText("エラー", { selector: ".text-right" }),
		).toBeInTheDocument();
	});

	describe("表示方式", () => {
		it("display=inline は onResult なしでもキーパッドを直接出す", () => {
			render(<Calculator display="inline" />);
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
			expect(screen.getByRole("button", { name: "7" })).toBeInTheDocument();
		});

		it("display=modal は onResult があってもボタンから開く", async () => {
			render(<Calculator display="modal" onResult={vi.fn()} />);
			expect(screen.queryByRole("button", { name: "7" })).not.toBeInTheDocument();
			await user.click(screen.getByRole("button", { name: "電卓" }));
			expect(screen.getByRole("dialog")).toBeInTheDocument();
			expect(screen.getByRole("group", { name: "電卓" })).toHaveFocus();
		});
	});

	describe("initialExpression と evaluate", () => {
		it("計算式を入力済みにし、「=」で確かめる", async () => {
			const onResult = vi.fn();
			render(
				<Calculator
					display="inline"
					mode="scientific"
					initialExpression="1000 * tan(89.5)"
					onResult={onResult}
				/>,
			);
			expect(screen.getByRole("status")).toHaveTextContent("1000 * tan(89.5)");
			expect(onResult).not.toHaveBeenCalled();
			await user.click(screen.getByRole("button", { name: "=" }));
			expect(onResult).toHaveBeenCalledTimes(1);
			expect(onResult.mock.calls[0]?.[0]).toBeCloseTo(114588.65, 1);
			expect(screen.getByRole("status")).toHaveTextContent("114588.65");
		});

		it("evaluate があれば内部計算の代わりに使う", async () => {
			const evaluate = vi.fn(() => 42);
			const onResult = vi.fn();
			render(
				<Calculator display="inline" evaluate={evaluate} onResult={onResult} />,
			);
			await user.click(screen.getByRole("button", { name: "1" }));
			await user.click(screen.getByRole("button", { name: "+" }));
			await user.click(screen.getByRole("button", { name: "1" }));
			await user.click(screen.getByRole("button", { name: "=" }));
			expect(evaluate).toHaveBeenCalledWith("1+1");
			expect(onResult).toHaveBeenCalledWith(42);
			expect(screen.getByRole("status")).toHaveTextContent("42");
		});

		it("evaluate が null を返すと「エラー」を出し onResult を呼ばない", async () => {
			const onResult = vi.fn();
			render(
				<Calculator
					display="inline"
					evaluate={() => null}
					onResult={onResult}
				/>,
			);
			await user.click(screen.getByRole("button", { name: "5" }));
			await user.click(screen.getByRole("button", { name: "=" }));
			expect(screen.getByRole("status")).toHaveTextContent("エラー");
			expect(onResult).not.toHaveBeenCalled();
		});

		it("evaluate が例外を投げても「エラー」にする", async () => {
			render(
				<Calculator
					display="inline"
					evaluate={() => {
						throw new Error("boom");
					}}
				/>,
			);
			await user.click(screen.getByRole("button", { name: "=" }));
			expect(screen.getByRole("status")).toHaveTextContent("エラー");
		});
	});

	describe("scientific", () => {
		it("関数キーが計算式の文字列として積まれる", async () => {
			render(<Calculator display="inline" mode="scientific" />);
			await user.click(screen.getByRole("button", { name: "tan" }));
			await user.click(screen.getByRole("button", { name: "4" }));
			await user.click(screen.getByRole("button", { name: "5" }));
			await user.click(screen.getByRole("button", { name: ")" }));
			expect(screen.getByRole("status")).toHaveTextContent("tan(45)");
			await user.click(screen.getByRole("button", { name: "=" }));
			expect(screen.getByRole("status")).toHaveTextContent("1");
		});

		it("√ ^ π と括弧で計算できる", async () => {
			render(<Calculator display="inline" mode="scientific" />);
			for (const name of ["√", "1", "6", ")", "+", "1", "="]) {
				await user.click(screen.getByRole("button", { name }));
			}
			// sqrt(16) + 1
			expect(screen.getByRole("status").textContent).toBe("5");
			await user.click(screen.getByRole("button", { name: "C" }));
			await user.click(screen.getByRole("button", { name: "π" }));
			expect(screen.getByRole("status")).toHaveTextContent("pi");
		});

		it("三角関数は度数法である", async () => {
			const onResult = vi.fn();
			render(
				<Calculator
					display="inline"
					mode="scientific"
					initialExpression="sin(30)"
					onResult={onResult}
				/>,
			);
			await user.click(screen.getByRole("button", { name: "=" }));
			expect(onResult).toHaveBeenCalledWith(0.5);
		});

		it("basic には関数キーが無い", () => {
			render(<Calculator display="inline" />);
			expect(screen.queryByRole("button", { name: "sin" })).not.toBeInTheDocument();
		});

		it("⌫ は関数名と演算子を1つ分消す", async () => {
			render(<Calculator display="inline" mode="scientific" />);
			await user.click(screen.getByRole("button", { name: "2" }));
			await user.click(screen.getByRole("button", { name: "*" }));
			await user.click(screen.getByRole("button", { name: "sin" }));
			expect(screen.getByRole("status")).toHaveTextContent("2 * sin(");
			await user.click(screen.getByRole("button", { name: "1文字削除" }));
			expect(screen.getByRole("status").textContent).toBe("2 * ");
			await user.click(screen.getByRole("button", { name: "1文字削除" }));
			expect(screen.getByRole("status").textContent).toBe("2");
		});

		it("結果の後に数字を押すと新しい式になり、演算子は結果に続く", async () => {
			render(<Calculator display="inline" mode="scientific" />);
			for (const name of ["2", "+", "3", "="]) {
				await user.click(screen.getByRole("button", { name }));
			}
			await user.click(screen.getByRole("button", { name: "*" }));
			expect(screen.getByRole("status").textContent).toBe("5 * ");
			await user.click(screen.getByRole("button", { name: "C" }));
			for (const name of ["2", "+", "3", "=", "7"]) {
				await user.click(screen.getByRole("button", { name }));
			}
			expect(screen.getByRole("status").textContent).toBe("7");
		});
	});

	describe("キーボード", () => {
		it("数字・演算子・Enter で計算できる", async () => {
			const onResult = vi.fn();
			render(<Calculator display="inline" onResult={onResult} />);
			screen.getByRole("group", { name: "電卓" }).focus();
			await user.keyboard("12*3{Enter}");
			expect(onResult).toHaveBeenCalledWith(36);
			expect(screen.getByRole("status")).toHaveTextContent("36");
		});

		it("= キーでも計算する", async () => {
			const onResult = vi.fn();
			render(<Calculator display="inline" onResult={onResult} />);
			screen.getByRole("group", { name: "電卓" }).focus();
			await user.keyboard("6/3=");
			expect(onResult).toHaveBeenCalledWith(2);
		});

		it("Backspace で1文字消し、Escape で消去する", async () => {
			render(<Calculator display="inline" />);
			screen.getByRole("group", { name: "電卓" }).focus();
			await user.keyboard("123{Backspace}");
			expect(screen.getByRole("status")).toHaveTextContent("12");
			await user.keyboard("{Escape}");
			expect(screen.getByRole("status")).toHaveTextContent("0");
		});

		it("scientific では括弧とべき乗も打てる", async () => {
			const onResult = vi.fn();
			render(<Calculator display="inline" mode="scientific" onResult={onResult} />);
			screen.getByRole("group", { name: "電卓" }).focus();
			await user.keyboard("(1+2)^2{Enter}");
			expect(onResult).toHaveBeenCalledWith(9);
		});

		it("basic では括弧を受け付けない", async () => {
			render(<Calculator display="inline" />);
			screen.getByRole("group", { name: "電卓" }).focus();
			await user.keyboard("(");
			expect(screen.getByRole("status")).toHaveTextContent("0");
		});

		it("ボタンにフォーカスがあるとき Enter はそのボタンを押す", async () => {
			render(<Calculator display="inline" />);
			screen.getByRole("button", { name: "7" }).focus();
			await user.keyboard("{Enter}");
			expect(screen.getByRole("status")).toHaveTextContent("7");
		});

		it("モーダルでは消去済みの Escape を閉じる操作に譲る", async () => {
			render(<Calculator />);
			await user.click(screen.getByRole("button", { name: "電卓" }));
			await user.keyboard("{Escape}");
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		});
	});

	describe("暗黙の乗算", () => {
		const typeKeys = async (names: string[]) => {
			render(<Calculator display="inline" mode="scientific" />);
			for (const name of names)
				await user.click(screen.getByRole("button", { name }));
			return screen.getByRole("status").textContent;
		};

		it("数字の後の π・関数・括弧に「 * 」を補う", async () => {
			expect(await typeKeys(["2", "π"])).toBe("2 * pi");
		});
		it("数字の後の関数キー", async () => {
			expect(await typeKeys(["2", "sin"])).toBe("2 * sin(");
		});
		it("数字の後の括弧", async () => {
			expect(await typeKeys(["3", "("])).toBe("3 * (");
		});
		it(") の後の数字", async () => {
			expect(await typeKeys(["(", "1", "+", "2", ")", "3"])).toBe("(1 + 2) * 3");
		});
		it("π の後の数字", async () => {
			expect(await typeKeys(["π", "2"])).toBe("pi * 2");
		});
		it("演算子や ( の直後には補わない", async () => {
			expect(await typeKeys(["2", "+", "sin", "π"])).toBe("2 + sin(pi");
		});
	});
});
