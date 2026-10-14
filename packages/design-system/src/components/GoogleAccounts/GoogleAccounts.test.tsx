import { render, screen, fireEvent } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { GoogleAccounts } from ".";
const props={configured:true,status:"disconnected" as const,pending:false,onBack:vi.fn(),onConnect:vi.fn(),onCancel:vi.fn(),onDisconnect:vi.fn()};
it("requires explicit disconnect confirmation and allows cancellation",()=>{
 const disconnect=vi.fn();
 render(<GoogleAccounts {...props} status="connected" profile={{name:"花子",email:"hanako@example.com"}} onDisconnect={disconnect}/>);
 fireEvent.click(screen.getByRole("button",{name:"連携を解除"}));
 expect(disconnect).not.toHaveBeenCalled();
 expect(screen.getByRole("alertdialog")).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"キャンセル"}));
 expect(screen.queryByRole("alertdialog")).toBeNull();
 fireEvent.click(screen.getByRole("button",{name:"連携を解除"}));
 fireEvent.click(screen.getByRole("button",{name:"解除する"}));
 expect(disconnect).toHaveBeenCalledTimes(1);
});
it("unconfigured account cannot start authentication",()=>{
 render(<GoogleAccounts {...props} configured={false}/>);
 expect((screen.getByRole("button",{name:"Googleアカウントを接続"}) as HTMLButtonElement).disabled).toBe(true);
});
it("pending auth exposes a separate-tab fallback and cancellation",()=>{
 const cancel=vi.fn();
 render(<GoogleAccounts {...props} pending authorizationUrl="https://accounts.google.com/" onCancel={cancel}/>);
 expect(screen.getByRole("link",{name:/認証画面を開く/}).getAttribute("rel")).toContain("noopener");
 fireEvent.click(screen.getByRole("button",{name:"キャンセル"}));
 expect(cancel).toHaveBeenCalledOnce();
});
