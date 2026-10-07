/**
 * TextInput Component
 *
 * 標準のInputコンポーネントをラップし、以下の機能を提供します：
 * - type="text": 通常のテキスト入力
 * - type="numeric": 数値入力（クリック時にKeypadModalを表示）
 * - type="time": 時刻入力（クリック時にKeypadModalを表示）
 * - type="phone": 電話番号入力（クリック時にKeypadModalを表示）
 *
 * numeric, time, phoneタイプの場合、直接入力は無効化され（readOnly）、
 * 専用のキーパッドモーダル経由での入力が強制されます。
 */

import React, { useState } from "react";
import { Input, type InputProps } from "@/components/Input";
import { KeypadModal } from "@/components/KeypadModal";

export type TextInputType = "text" | "numeric" | "time" | "phone";

export interface TextInputProps
	extends Omit<InputProps, "type" | "onChange" | "value"> {
	type?: TextInputType;
	value?: string;
	onChange?: (value: string) => void;
	/**
	 * キーパッドモーダルのタイトル
	 * 指定しない場合はデフォルトのタイトルが使用されます
	 */
	modalTitle?: string;
}

export const TextInput: React.FC<TextInputProps> = React.memo(
	({
		type = "text",
		value = "",
		onChange,
		modalTitle,
		className,
		disabled,
		readOnly,
		...props
	}) => {
		const [isModalOpen, setIsModalOpen] = useState(false);

		const handleOpenModal = () => {
			if (!disabled && !readOnly) {
				setIsModalOpen(true);
			}
		};

		const handleCloseModal = () => {
			setIsModalOpen(false);
		};

		const handleSubmit = (newValue: string) => {
			onChange?.(newValue);
			setIsModalOpen(false);
		};

		// 標準テキスト入力の場合
		if (type === "text") {
			return (
				<Input
					type="text"
					value={value}
					onChange={(e) => onChange?.(e.target.value)}
					className={className}
					disabled={disabled}
					readOnly={readOnly}
					{...props}
				/>
			);
		}

		// キーパッドを使用する入力タイプの場合
		return (
			<>
				<Input
					type="text"
					value={value}
					// readOnlyを強制してキーボード入力を防ぐ
					readOnly={true}
					onClick={handleOpenModal}
					className={`${className} cursor-pointer`}
					disabled={disabled}
					{...props}
				/>

				{type === "numeric" && (
					<KeypadModal
						open={isModalOpen}
						onClose={handleCloseModal}
						onSubmit={handleSubmit}
						initialValue={value}
						title={modalTitle}
						placeholder={props.placeholder}
					/>
				)}

				{type === "time" && (
					<KeypadModal
						open={isModalOpen}
						onClose={handleCloseModal}
						onSubmit={handleSubmit}
						initialValue={value}
						title={modalTitle}
						variant="time"
					/>
				)}

				{type === "phone" && (
					<KeypadModal
						open={isModalOpen}
						onClose={handleCloseModal}
						onSubmit={handleSubmit}
						initialValue={value}
						title={modalTitle}
						placeholder={props.placeholder}
						variant="phone"
					/>
				)}
			</>
		);
	},
);
