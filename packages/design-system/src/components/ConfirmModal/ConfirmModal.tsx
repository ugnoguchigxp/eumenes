import type React from "react";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";

interface IConfirmModalProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description?: string;
	onConfirm: () => void;
	onCancel?: () => void;
	/** Text for confirm button. Default: "Confirm" */
	confirmText?: string;
	/** Text for cancel button. Default: "Cancel" */
	cancelText?: string;
	variant?: "default" | "destructive";
	loading?: boolean;
	showCancel?: boolean;
}

export const ConfirmModal: React.FC<IConfirmModalProps> = ({
	open,
	onOpenChange,
	title,
	description,
	onConfirm,
	onCancel,
	confirmText = "Confirm",
	cancelText = "Cancel",
	variant = "default",
	loading = false,
	showCancel = true,
}) => {
	const handleConfirm = () => {
		onConfirm();
	};

	const handleCancel = () => {
		onCancel?.();
		onOpenChange(false);
	};

	return (
		<Modal
			open={open}
			onOpenChange={onOpenChange}
			title={title}
			description={description}
			footer={
				<>
					{showCancel && (
						<Button variant="outline" onClick={handleCancel} disabled={loading}>
							{cancelText}
						</Button>
					)}
					<Button variant={variant} onClick={handleConfirm} loading={loading}>
						{confirmText}
					</Button>
				</>
			}
		/>
	);
};
