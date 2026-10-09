var ps = (e) => {
  throw TypeError(e);
};
var hs = (e, t, n) => t.has(e) || ps("Cannot " + n);
var we = (e, t, n) => (hs(e, t, "read from private field"), n ? n.call(e) : t.get(e)), gs = (e, t, n) => t.has(e) ? ps("Cannot add the same private member more than once") : t instanceof WeakSet ? t.add(e) : t.set(e, n), br = (e, t, n, r) => (hs(e, t, "write to private field"), r ? r.call(e, n) : t.set(e, n), n);
import * as u from "react";
import R, { forwardRef as ha, createElement as Dr, useRef as an, useState as Ge, useLayoutEffect as ga, useMemo as rt, useContext as Sc, createContext as kc, useEffect as Ut, useCallback as Ft, useId as Ec } from "react";
import { jsx as f, jsxs as O, Fragment as Ze } from "react/jsx-runtime";
import * as pn from "react-dom";
import Nc, { createPortal as Rc } from "react-dom";
import { useTranslation as Pc } from "react-i18next";
var Tc = Object.defineProperty, va = (e, t) => Tc(e, "name", { value: t, configurable: !0 }), ba = u.createContext(void 0), Zb = /* @__PURE__ */ va((e) => {
  const { dir: t, children: n } = e;
  return /* @__PURE__ */ f(ba.Provider, { value: t, children: n });
}, "DirectionProvider");
function qn(e) {
  const t = u.useContext(ba);
  return e || t || "ltr";
}
va(qn, "useDirection");
function _c(e) {
  if (typeof document > "u") return;
  let t = document.head || document.getElementsByTagName("head")[0], n = document.createElement("style");
  n.type = "text/css", t.appendChild(n), n.styleSheet ? n.styleSheet.cssText = e : n.appendChild(document.createTextNode(e));
}
const Ic = (e) => {
  switch (e) {
    case "success":
      return Dc;
    case "info":
      return Lc;
    case "warning":
      return Mc;
    case "error":
      return $c;
    default:
      return null;
  }
}, Oc = Array(12).fill(0), Ac = ({ visible: e, className: t }) => /* @__PURE__ */ R.createElement("div", {
  className: [
    "sonner-loading-wrapper",
    t
  ].filter(Boolean).join(" "),
  "data-visible": e
}, /* @__PURE__ */ R.createElement("div", {
  className: "sonner-spinner"
}, Oc.map((n, r) => /* @__PURE__ */ R.createElement("div", {
  className: "sonner-loading-bar",
  key: `spinner-bar-${r}`
})))), Dc = /* @__PURE__ */ R.createElement("svg", {
  xmlns: "http://www.w3.org/2000/svg",
  viewBox: "0 0 20 20",
  fill: "currentColor",
  height: "20",
  width: "20",
  "aria-hidden": "true"
}, /* @__PURE__ */ R.createElement("path", {
  fillRule: "evenodd",
  d: "M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z",
  clipRule: "evenodd"
})), Mc = /* @__PURE__ */ R.createElement("svg", {
  xmlns: "http://www.w3.org/2000/svg",
  viewBox: "0 0 24 24",
  fill: "currentColor",
  height: "20",
  width: "20",
  "aria-hidden": "true"
}, /* @__PURE__ */ R.createElement("path", {
  fillRule: "evenodd",
  d: "M9.401 3.003c1.155-2 4.043-2 5.197 0l7.355 12.748c1.154 2-.29 4.5-2.599 4.5H4.645c-2.309 0-3.752-2.5-2.598-4.5L9.4 3.003zM12 8.25a.75.75 0 01.75.75v3.75a.75.75 0 01-1.5 0V9a.75.75 0 01.75-.75zm0 8.25a.75.75 0 100-1.5.75.75 0 000 1.5z",
  clipRule: "evenodd"
})), Lc = /* @__PURE__ */ R.createElement("svg", {
  xmlns: "http://www.w3.org/2000/svg",
  viewBox: "0 0 20 20",
  fill: "currentColor",
  height: "20",
  width: "20",
  "aria-hidden": "true"
}, /* @__PURE__ */ R.createElement("path", {
  fillRule: "evenodd",
  d: "M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z",
  clipRule: "evenodd"
})), $c = /* @__PURE__ */ R.createElement("svg", {
  xmlns: "http://www.w3.org/2000/svg",
  viewBox: "0 0 20 20",
  fill: "currentColor",
  height: "20",
  width: "20",
  "aria-hidden": "true"
}, /* @__PURE__ */ R.createElement("path", {
  fillRule: "evenodd",
  d: "M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-5a.75.75 0 01.75.75v4.5a.75.75 0 01-1.5 0v-4.5A.75.75 0 0110 5zm0 10a1 1 0 100-2 1 1 0 000 2z",
  clipRule: "evenodd"
})), Fc = /* @__PURE__ */ R.createElement("svg", {
  xmlns: "http://www.w3.org/2000/svg",
  width: "12",
  height: "12",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: "1.5",
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": "true"
}, /* @__PURE__ */ R.createElement("line", {
  x1: "18",
  y1: "6",
  x2: "6",
  y2: "18"
}), /* @__PURE__ */ R.createElement("line", {
  x1: "6",
  y1: "6",
  x2: "18",
  y2: "18"
})), zc = () => {
  const [e, t] = R.useState(document.hidden);
  return R.useEffect(() => {
    const n = () => {
      t(document.hidden);
    };
    return document.addEventListener("visibilitychange", n), () => document.removeEventListener("visibilitychange", n);
  }, []), e;
};
let Bc = 1;
const Vc = 100, vs = (e) => {
  var t;
  return typeof e?.id == "number" || (e == null || (t = e.id) == null ? void 0 : t.length) > 0 ? e.id : Bc++;
};
class jc {
  constructor() {
    this.subscribe = (t) => (this.subscribers.push(t), this.getActiveToasts().forEach((n) => t(n)), () => {
      const n = this.subscribers.indexOf(t);
      this.subscribers.splice(n, 1);
    }), this.publish = (t) => {
      this.subscribers.forEach((n) => n(t));
    }, this.addToast = (t) => {
      this.publish(t), this.toasts = [
        ...this.toasts,
        t
      ], this.trimHistory();
    }, this.trimHistory = () => {
      let t = this.toasts.length - Vc;
      t <= 0 || (this.toasts = this.toasts.filter((n) => t > 0 && this.dismissedToasts.has(n.id) ? (this.dismissedToasts.delete(n.id), t--, !1) : !0));
    }, this.create = (t) => {
      const { message: n, ...r } = t, o = vs(t), s = this.pendingDismissals.get(o);
      s !== void 0 && (cancelAnimationFrame(s), this.pendingDismissals.delete(o), this.dismissedToasts.delete(o));
      const a = this.dismissedToasts.has(o), i = t.dismissible === void 0 ? !0 : t.dismissible;
      return a && (this.dismissedToasts.delete(o), this.toasts = this.toasts.filter((c) => c.id !== o)), (a ? void 0 : this.toasts.find((c) => c.id === o)) ? this.toasts = this.toasts.map((c) => c.id === o ? (this.publish({
        ...c,
        ...t,
        id: o,
        title: n
      }), {
        ...c,
        ...t,
        id: o,
        dismissible: i,
        title: n
      }) : c) : this.addToast({
        title: n,
        ...r,
        dismissible: i,
        id: o
      }), o;
    }, this.dismiss = (t) => {
      if (t == null)
        return this.getActiveToasts().forEach((r) => {
          this.dismissedToasts.add(r.id), this.subscribers.forEach((o) => o({
            id: r.id,
            dismiss: !0
          }));
        }), t;
      this.dismissedToasts.add(t);
      const n = this.pendingDismissals.get(t);
      return n !== void 0 && cancelAnimationFrame(n), this.pendingDismissals.set(t, requestAnimationFrame(() => {
        this.pendingDismissals.delete(t), this.subscribers.forEach((r) => r({
          id: t,
          dismiss: !0
        }));
      })), t;
    }, this.message = (t, n) => this.create({
      ...n,
      message: t,
      type: void 0
    }), this.error = (t, n) => this.create({
      ...n,
      message: t,
      type: "error"
    }), this.success = (t, n) => this.create({
      ...n,
      type: "success",
      message: t
    }), this.info = (t, n) => this.create({
      ...n,
      type: "info",
      message: t
    }), this.warning = (t, n) => this.create({
      ...n,
      type: "warning",
      message: t
    }), this.loading = (t, n) => this.create({
      ...n,
      type: "loading",
      message: t
    }), this.promise = (t, n) => {
      if (!n)
        return;
      let r;
      n.loading !== void 0 && (r = this.create({
        ...n,
        promise: t,
        type: "loading",
        message: n.loading,
        description: typeof n.description != "function" ? n.description : void 0
      }));
      const o = Promise.resolve(t instanceof Function ? t() : t);
      let s = r !== void 0, a;
      const i = o.then(async (c) => {
        if (a = [
          "resolve",
          c
        ], R.isValidElement(c))
          s = !1, this.create({
            id: r,
            type: "default",
            message: c
          });
        else if (Wc(c) && !c.ok) {
          s = !1;
          const l = typeof n.error == "function" ? await n.error(`HTTP error! status: ${c.status}`) : n.error, p = typeof n.description == "function" ? await n.description(`HTTP error! status: ${c.status}`) : n.description, b = typeof l == "object" && !R.isValidElement(l) ? l : {
            message: l
          };
          this.create({
            id: r,
            type: "error",
            description: p,
            ...b
          });
        } else if (c instanceof Error) {
          s = !1;
          const l = typeof n.error == "function" ? await n.error(c) : n.error, p = typeof n.description == "function" ? await n.description(c) : n.description, b = typeof l == "object" && !R.isValidElement(l) ? l : {
            message: l
          };
          this.create({
            id: r,
            type: "error",
            description: p,
            ...b
          });
        } else if (n.success !== void 0) {
          s = !1;
          const l = typeof n.success == "function" ? await n.success(c) : n.success, p = typeof n.description == "function" ? await n.description(c) : n.description, b = typeof l == "object" && !R.isValidElement(l) ? l : {
            message: l
          };
          this.create({
            id: r,
            type: "success",
            description: p,
            ...b
          });
        }
      }).catch(async (c) => {
        if (a = [
          "reject",
          c
        ], n.error !== void 0) {
          s = !1;
          const m = typeof n.error == "function" ? await n.error(c) : n.error, l = typeof n.description == "function" ? await n.description(c) : n.description, h = typeof m == "object" && !R.isValidElement(m) ? m : {
            message: m
          };
          this.create({
            id: r,
            type: "error",
            description: l,
            ...h
          });
        }
      }).finally(() => {
        s && (this.dismiss(r), r = void 0), n.finally == null || n.finally.call(n);
      }), d = () => new Promise((c, m) => i.then(() => a[0] === "reject" ? m(a[1]) : c(a[1])).catch(m));
      return typeof r != "string" && typeof r != "number" ? {
        unwrap: d
      } : Object.assign(r, {
        unwrap: d
      });
    }, this.custom = (t, n) => {
      const r = vs(n);
      return this.create({
        ...n,
        jsx: t(r),
        id: r,
        type: void 0
      }), r;
    }, this.getActiveToasts = () => this.toasts.filter((t) => !this.dismissedToasts.has(t.id)), this.subscribers = [], this.toasts = [], this.dismissedToasts = /* @__PURE__ */ new Set(), this.pendingDismissals = /* @__PURE__ */ new Map();
  }
}
const Re = new jc(), Hc = (e, t) => Re.message(e, t), Wc = (e) => e && typeof e == "object" && "ok" in e && typeof e.ok == "boolean" && "status" in e && typeof e.status == "number", Uc = Hc, Gc = () => Re.toasts, Kc = () => Re.getActiveToasts(), Qb = Object.assign(Uc, {
  success: Re.success,
  info: Re.info,
  warning: Re.warning,
  error: Re.error,
  custom: Re.custom,
  message: Re.message,
  promise: Re.promise,
  dismiss: Re.dismiss,
  loading: Re.loading
}, {
  getHistory: Gc,
  getToasts: Kc
});
_c("[data-sonner-toaster][dir=ltr],html[dir=ltr]{--toast-icon-margin-start:-3px;--toast-icon-margin-end:4px;--toast-svg-margin-start:-1px;--toast-svg-margin-end:0px;--toast-button-margin-start:auto;--toast-button-margin-end:0;--toast-close-button-start:0;--toast-close-button-end:unset;--toast-close-button-transform:translate(-35%, -35%)}[data-sonner-toaster][dir=rtl],html[dir=rtl]{--toast-icon-margin-start:4px;--toast-icon-margin-end:-3px;--toast-svg-margin-start:0px;--toast-svg-margin-end:-1px;--toast-button-margin-start:0;--toast-button-margin-end:auto;--toast-close-button-start:unset;--toast-close-button-end:0;--toast-close-button-transform:translate(35%, -35%)}[data-sonner-toaster]{position:fixed;width:var(--width);font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,Noto Sans,sans-serif,Apple Color Emoji,Segoe UI Emoji,Segoe UI Symbol,Noto Color Emoji;--gray1:hsl(0, 0%, 99%);--gray2:hsl(0, 0%, 97.3%);--gray3:hsl(0, 0%, 95.1%);--gray4:hsl(0, 0%, 93%);--gray5:hsl(0, 0%, 90.9%);--gray6:hsl(0, 0%, 88.7%);--gray7:hsl(0, 0%, 85.8%);--gray8:hsl(0, 0%, 78%);--gray9:hsl(0, 0%, 56.1%);--gray10:hsl(0, 0%, 52.3%);--gray11:hsl(0, 0%, 43.5%);--gray12:hsl(0, 0%, 9%);--border-radius:8px;box-sizing:border-box;padding:0;margin:0;list-style:none;outline:0;z-index:999999999;transition:transform .4s ease}@media (hover:none) and (pointer:coarse){[data-sonner-toaster][data-lifted=true]{transform:none}}[data-sonner-toaster][data-x-position=right]{right:var(--offset-right)}[data-sonner-toaster][data-x-position=left]{left:var(--offset-left)}[data-sonner-toaster][data-x-position=center]{left:50%;transform:translateX(-50%)}[data-sonner-toaster][data-y-position=top]{top:var(--offset-top)}[data-sonner-toaster][data-y-position=bottom]{bottom:var(--offset-bottom)}[data-sonner-toast]{--y:translateY(100%);--lift-amount:calc(var(--lift) * var(--gap));z-index:var(--z-index);position:absolute;opacity:0;transform:var(--y);touch-action:none;transition:transform .4s,opacity .4s,height .4s,box-shadow .2s;box-sizing:border-box;outline:0;overflow-wrap:anywhere}[data-sonner-toast][data-styled=true]{padding:16px;background:var(--normal-bg);border:1px solid var(--normal-border);color:var(--normal-text);border-radius:var(--border-radius);box-shadow:0 4px 12px rgba(0,0,0,.1);width:var(--width);font-size:13px;display:flex;align-items:center;gap:6px}[data-sonner-toast]:focus-visible{box-shadow:0 4px 12px rgba(0,0,0,.1),0 0 0 2px rgba(0,0,0,.2)}[data-sonner-toast][data-y-position=top]{top:0;--y:translateY(-100%);--lift:1;--lift-amount:calc(1 * var(--gap))}[data-sonner-toast][data-y-position=bottom]{bottom:0;--y:translateY(100%);--lift:-1;--lift-amount:calc(var(--lift) * var(--gap))}[data-sonner-toast][data-styled=true] [data-description]{font-weight:400;line-height:1.4;color:#3f3f3f}[data-rich-colors=true][data-sonner-toast][data-styled=true] [data-description]{color:inherit}[data-sonner-toaster][data-sonner-theme=dark] [data-description]{color:#e8e8e8}[data-sonner-toast][data-styled=true] [data-title]{font-weight:500;line-height:1.5;color:inherit}[data-sonner-toast][data-styled=true] [data-icon]{display:flex;height:16px;width:16px;position:relative;justify-content:flex-start;align-items:center;flex-shrink:0;margin-left:var(--toast-icon-margin-start);margin-right:var(--toast-icon-margin-end)}[data-sonner-toast][data-promise=true] [data-icon]>svg{opacity:0;transform:scale(.8);transform-origin:center;animation:sonner-fade-in .3s ease forwards}[data-sonner-toast][data-styled=true] [data-icon]>*{flex-shrink:0}[data-sonner-toast][data-styled=true] [data-icon] svg{margin-left:var(--toast-svg-margin-start);margin-right:var(--toast-svg-margin-end)}[data-sonner-toast][data-styled=true] [data-content]{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}[data-sonner-toast][data-styled=true] [data-button]{border-radius:4px;padding-left:8px;padding-right:8px;height:24px;font-size:12px;color:var(--normal-bg);background:var(--normal-text);margin-left:var(--toast-button-margin-start);margin-right:var(--toast-button-margin-end);border:none;font-weight:500;cursor:pointer;outline:0;display:flex;align-items:center;flex-shrink:0;transition:opacity .4s,box-shadow .2s}[data-sonner-toast][data-styled=true] [data-button]:focus-visible{box-shadow:0 0 0 2px rgba(0,0,0,.4)}[data-sonner-toast][data-styled=true] [data-button]:first-of-type{margin-left:var(--toast-button-margin-start);margin-right:var(--toast-button-margin-end)}[data-sonner-toast][data-styled=true] [data-cancel]{color:var(--normal-text);background:rgba(0,0,0,.08)}[data-sonner-toaster][data-sonner-theme=dark] [data-sonner-toast][data-styled=true] [data-cancel]{background:rgba(255,255,255,.3)}[data-sonner-toast][data-styled=true] [data-close-button]{position:absolute;left:var(--toast-close-button-start);right:var(--toast-close-button-end);top:0;height:20px;width:20px;display:flex;justify-content:center;align-items:center;padding:0;color:var(--normal-text);background:var(--normal-bg);border:1px solid var(--normal-border);transform:var(--toast-close-button-transform);border-radius:50%;cursor:pointer;z-index:1;transition:opacity .1s,background .2s,border-color .2s}[data-sonner-toast][data-styled=true] [data-close-button]:focus-visible{box-shadow:0 4px 12px rgba(0,0,0,.1),0 0 0 2px rgba(0,0,0,.2)}[data-sonner-toast][data-styled=true] [data-disabled=true]{cursor:not-allowed}[data-sonner-toast][data-styled=true]:hover [data-close-button]:hover{background:var(--gray2);border-color:var(--gray5)}[data-sonner-toast][data-swiping=true]::before{content:'';position:absolute;left:-100%;right:-100%;height:100%;z-index:-1}[data-sonner-toast][data-y-position=top][data-swiping=true]::before{bottom:50%;transform:scaleY(3) translateY(50%)}[data-sonner-toast][data-y-position=bottom][data-swiping=true]::before{top:50%;transform:scaleY(3) translateY(-50%)}[data-sonner-toast][data-swiping=false][data-removed=true]::before{content:'';position:absolute;inset:0;transform:scaleY(2)}[data-sonner-toast][data-expanded=true]::after{content:'';position:absolute;left:0;height:calc(var(--gap) + 1px);bottom:100%;width:100%}[data-sonner-toast][data-mounted=true]{--y:translateY(0);opacity:1}[data-sonner-toast][data-expanded=false][data-front=false]{--scale:var(--toasts-before) * 0.05 + 1;--y:translateY(calc(var(--lift-amount) * var(--toasts-before))) scale(calc(-1 * var(--scale)));height:var(--front-toast-height)}[data-sonner-toast]>*{transition:opacity .4s}[data-sonner-toast][data-x-position=right]{right:0}[data-sonner-toast][data-x-position=left]{left:0}[data-sonner-toast][data-expanded=false][data-front=false][data-styled=true]>*{opacity:0}[data-sonner-toast][data-visible=false]{opacity:0;pointer-events:none}[data-sonner-toast][data-mounted=true][data-expanded=true]{--y:translateY(calc(var(--lift) * var(--offset)));height:var(--initial-height)}[data-sonner-toast][data-removed=true][data-front=true][data-swipe-out=false]{--y:translateY(calc(var(--lift) * -100%));opacity:0}[data-sonner-toast][data-removed=true][data-front=false][data-swipe-out=false][data-expanded=true]{--y:translateY(calc(var(--lift) * var(--offset) + var(--lift) * -100%));opacity:0}[data-sonner-toast][data-removed=true][data-front=false][data-swipe-out=false][data-expanded=false]{--y:translateY(40%);opacity:0;transition:transform .5s,opacity .2s}[data-sonner-toast][data-removed=true][data-front=false]::before{height:calc(var(--initial-height) + 20%)}[data-sonner-toast][data-swiping=true]{transform:var(--y) translateY(var(--swipe-amount-y,0)) translateX(var(--swipe-amount-x,0));transition:none}[data-sonner-toast][data-swiped=true]{-webkit-user-select:none;user-select:none}[data-sonner-toast][data-swipe-out=true][data-y-position=bottom],[data-sonner-toast][data-swipe-out=true][data-y-position=top]{animation-duration:.2s;animation-timing-function:ease-out;animation-fill-mode:forwards}[data-sonner-toast][data-swipe-out=true][data-swipe-direction=left]{animation-name:swipe-out-left}[data-sonner-toast][data-swipe-out=true][data-swipe-direction=right]{animation-name:swipe-out-right}[data-sonner-toast][data-swipe-out=true][data-swipe-direction=up]{animation-name:swipe-out-up}[data-sonner-toast][data-swipe-out=true][data-swipe-direction=down]{animation-name:swipe-out-down}@keyframes swipe-out-left{from{transform:var(--y) translateX(var(--swipe-amount-x));opacity:1}to{transform:var(--y) translateX(calc(var(--swipe-amount-x) - 100%));opacity:0}}@keyframes swipe-out-right{from{transform:var(--y) translateX(var(--swipe-amount-x));opacity:1}to{transform:var(--y) translateX(calc(var(--swipe-amount-x) + 100%));opacity:0}}@keyframes swipe-out-up{from{transform:var(--y) translateY(var(--swipe-amount-y));opacity:1}to{transform:var(--y) translateY(calc(var(--swipe-amount-y) - 100%));opacity:0}}@keyframes swipe-out-down{from{transform:var(--y) translateY(var(--swipe-amount-y));opacity:1}to{transform:var(--y) translateY(calc(var(--swipe-amount-y) + 100%));opacity:0}}@media (max-width:600px){[data-sonner-toaster]{position:fixed;right:var(--mobile-offset-right);left:var(--mobile-offset-left);width:100%}[data-sonner-toaster][dir=rtl]{left:calc(var(--mobile-offset-left) * -1)}[data-sonner-toaster] [data-sonner-toast]{left:0;right:0;width:calc(100% - var(--mobile-offset-left) * 2)}[data-sonner-toaster][data-x-position=left]{left:var(--mobile-offset-left)}[data-sonner-toaster][data-y-position=bottom]{bottom:var(--mobile-offset-bottom)}[data-sonner-toaster][data-y-position=top]{top:var(--mobile-offset-top)}[data-sonner-toaster][data-x-position=center]{left:var(--mobile-offset-left);right:var(--mobile-offset-right);transform:none}}[data-sonner-toaster][data-sonner-theme=light]{--normal-bg:#fff;--normal-border:var(--gray4);--normal-text:var(--gray12);--success-bg:hsl(143, 85%, 96%);--success-border:hsl(145, 92%, 87%);--success-text:hsl(140, 100%, 27%);--info-bg:hsl(208, 100%, 97%);--info-border:hsl(221, 91%, 93%);--info-text:hsl(210, 92%, 45%);--warning-bg:hsl(49, 100%, 97%);--warning-border:hsl(49, 91%, 84%);--warning-text:hsl(31, 92%, 45%);--error-bg:hsl(359, 100%, 97%);--error-border:hsl(359, 100%, 94%);--error-text:hsl(360, 100%, 45%)}[data-sonner-toaster][data-sonner-theme=light] [data-sonner-toast][data-invert=true]{--normal-bg:#000;--normal-border:hsl(0, 0%, 20%);--normal-text:var(--gray1)}[data-sonner-toaster][data-sonner-theme=dark] [data-sonner-toast][data-invert=true]{--normal-bg:#fff;--normal-border:var(--gray3);--normal-text:var(--gray12)}[data-sonner-toaster][data-sonner-theme=dark]{--normal-bg:#000;--normal-bg-hover:hsl(0, 0%, 12%);--normal-border:hsl(0, 0%, 20%);--normal-border-hover:hsl(0, 0%, 25%);--normal-text:var(--gray1);--success-bg:hsl(150, 100%, 6%);--success-border:hsl(147, 100%, 12%);--success-text:hsl(150, 86%, 65%);--info-bg:hsl(215, 100%, 6%);--info-border:hsl(223, 43%, 17%);--info-text:hsl(216, 87%, 65%);--warning-bg:hsl(64, 100%, 6%);--warning-border:hsl(60, 100%, 9%);--warning-text:hsl(46, 87%, 65%);--error-bg:hsl(358, 76%, 10%);--error-border:hsl(357, 89%, 16%);--error-text:hsl(358, 100%, 81%)}[data-sonner-toaster][data-sonner-theme=dark] [data-sonner-toast] [data-close-button]{background:var(--normal-bg);border-color:var(--normal-border);color:var(--normal-text)}[data-sonner-toaster][data-sonner-theme=dark] [data-sonner-toast] [data-close-button]:hover{background:var(--normal-bg-hover);border-color:var(--normal-border-hover)}[data-rich-colors=true][data-sonner-toast][data-type=success]{background:var(--success-bg);border-color:var(--success-border);color:var(--success-text)}[data-rich-colors=true][data-sonner-toast][data-type=success] [data-close-button]{background:var(--success-bg);border-color:var(--success-border);color:var(--success-text)}[data-rich-colors=true][data-sonner-toast][data-type=info]{background:var(--info-bg);border-color:var(--info-border);color:var(--info-text)}[data-rich-colors=true][data-sonner-toast][data-type=info] [data-close-button]{background:var(--info-bg);border-color:var(--info-border);color:var(--info-text)}[data-rich-colors=true][data-sonner-toast][data-type=warning]{background:var(--warning-bg);border-color:var(--warning-border);color:var(--warning-text)}[data-rich-colors=true][data-sonner-toast][data-type=warning] [data-close-button]{background:var(--warning-bg);border-color:var(--warning-border);color:var(--warning-text)}[data-rich-colors=true][data-sonner-toast][data-type=error]{background:var(--error-bg);border-color:var(--error-border);color:var(--error-text)}[data-rich-colors=true][data-sonner-toast][data-type=error] [data-close-button]{background:var(--error-bg);border-color:var(--error-border);color:var(--error-text)}.sonner-loading-wrapper{--size:16px;height:var(--size);width:var(--size);position:absolute;inset:0;z-index:10}.sonner-loading-wrapper[data-visible=false]{transform-origin:center;animation:sonner-fade-out .2s ease forwards}.sonner-spinner{position:relative;top:50%;left:50%;height:var(--size);width:var(--size)}.sonner-loading-bar{animation:sonner-spin 1.2s linear infinite;background:var(--gray11);border-radius:6px;height:8%;left:-10%;position:absolute;top:-3.9%;width:24%}.sonner-loading-bar:first-child{animation-delay:-1.2s;transform:rotate(.0001deg) translate(146%)}.sonner-loading-bar:nth-child(2){animation-delay:-1.1s;transform:rotate(30deg) translate(146%)}.sonner-loading-bar:nth-child(3){animation-delay:-1s;transform:rotate(60deg) translate(146%)}.sonner-loading-bar:nth-child(4){animation-delay:-.9s;transform:rotate(90deg) translate(146%)}.sonner-loading-bar:nth-child(5){animation-delay:-.8s;transform:rotate(120deg) translate(146%)}.sonner-loading-bar:nth-child(6){animation-delay:-.7s;transform:rotate(150deg) translate(146%)}.sonner-loading-bar:nth-child(7){animation-delay:-.6s;transform:rotate(180deg) translate(146%)}.sonner-loading-bar:nth-child(8){animation-delay:-.5s;transform:rotate(210deg) translate(146%)}.sonner-loading-bar:nth-child(9){animation-delay:-.4s;transform:rotate(240deg) translate(146%)}.sonner-loading-bar:nth-child(10){animation-delay:-.3s;transform:rotate(270deg) translate(146%)}.sonner-loading-bar:nth-child(11){animation-delay:-.2s;transform:rotate(300deg) translate(146%)}.sonner-loading-bar:nth-child(12){animation-delay:-.1s;transform:rotate(330deg) translate(146%)}@keyframes sonner-fade-in{0%{opacity:0;transform:scale(.8)}100%{opacity:1;transform:scale(1)}}@keyframes sonner-fade-out{0%{opacity:1;transform:scale(1)}100%{opacity:0;transform:scale(.8)}}@keyframes sonner-spin{0%{opacity:1}100%{opacity:.15}}@media (prefers-reduced-motion){.sonner-loading-bar,[data-sonner-toast],[data-sonner-toast]>*{transition:none!important;animation:none!important}}.sonner-loader{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);transform-origin:center;transition:opacity .2s,transform .2s}.sonner-loader[data-visible=false]{opacity:0;transform:scale(.8) translate(-50%,-50%)}");
function wn(e) {
  return e.label !== void 0;
}
const Yc = 3, Xc = "24px", qc = "16px", bs = 4e3, Zc = 356, Qc = 14, Jc = 45, ed = 200;
function je(...e) {
  return e.filter(Boolean).join(" ");
}
function td(e) {
  const [t, n] = e.split("-"), r = [];
  return t && r.push(t), n && r.push(n), r;
}
const nd = (e) => {
  var t, n, r, o, s, a, i, d, c;
  const { invert: m, toast: l, unstyled: p, interacting: h, setHeights: b, visibleToasts: v, heights: g, index: y, toasts: C, expanded: w, removeToast: x, defaultRichColors: E, closeButton: N, style: k, cancelButtonStyle: S, actionButtonStyle: P, className: _ = "", descriptionClassName: M = "", duration: A, position: T, gap: D, expandByDefault: W, classNames: $, icons: z, closeButtonAriaLabel: H = "Close toast" } = e, [F, L] = R.useState(null), [ie, J] = R.useState(null), [se, X] = R.useState(!1), [K, U] = R.useState(!1), [ae, G] = R.useState(!1), [B, ce] = R.useState(!1), [te, ne] = R.useState(!1), [oe, me] = R.useState(0), [ke, At] = R.useState(0), Qe = R.useRef(l.duration || A || bs), Dt = R.useRef(null), Je = R.useRef(null), pc = y === 0, hc = y + 1 <= v, Ce = l.type, as = Ce ?? "default", Mt = l.dismissible !== !1, gc = l.className || "", vc = l.descriptionClassName || "", xn = R.useMemo(() => g.findIndex((q) => q.toastId === l.id) || 0, [
    g,
    l.id
  ]), bc = R.useMemo(() => {
    var q;
    return (q = l.closeButton) != null ? q : N;
  }, [
    l.closeButton,
    N
  ]), is = R.useMemo(() => l.duration || A || bs, [
    l.duration,
    A
  ]), pr = R.useRef(0), Lt = R.useRef(0), ls = R.useRef(0), $t = R.useRef(null), [yc, xc] = T.split("-"), cs = R.useMemo(() => g.reduce((q, pe, xe) => xe >= xn ? q : q + pe.height, 0), [
    g,
    xn
  ]), ds = zc(), ze = R.useMemo(() => {
    var q;
    return (q = e.swipeDirections) != null ? q : td(T);
  }, [
    e.swipeDirections,
    T
  ]), wc = l.invert || m, hr = Ce === "loading";
  Lt.current = R.useMemo(() => xn * D + cs, [
    xn,
    cs
  ]), R.useEffect(() => {
    Qe.current = is;
  }, [
    is
  ]), R.useEffect(() => {
    X(!0);
  }, []), R.useEffect(() => {
    const q = Je.current;
    if (q) {
      const pe = q.getBoundingClientRect().height;
      return At(pe), b((xe) => [
        {
          toastId: l.id,
          height: pe,
          position: l.position
        },
        ...xe
      ]), () => b((xe) => xe.filter((Ee) => Ee.toastId !== l.id));
    }
  }, [
    b,
    l.id
  ]), R.useLayoutEffect(() => {
    if (!se) return;
    const q = Je.current, pe = q.style.height;
    q.style.height = "auto";
    const xe = q.getBoundingClientRect().height;
    q.style.height = pe, At(xe), b((Ee) => Ee.find((ve) => ve.toastId === l.id) ? Ee.map((ve) => ve.toastId === l.id ? {
      ...ve,
      height: xe
    } : ve) : [
      {
        toastId: l.id,
        height: xe,
        position: l.position
      },
      ...Ee
    ]);
  }, [
    se,
    l.title,
    l.description,
    b,
    l.id,
    l.jsx,
    l.action,
    l.cancel
  ]);
  const ut = R.useCallback(() => {
    U(!0), me(Lt.current), b((q) => q.filter((pe) => pe.toastId !== l.id)), setTimeout(() => {
      x(l);
    }, ed);
  }, [
    l,
    x,
    b,
    Lt
  ]);
  R.useEffect(() => {
    if (l.promise && Ce === "loading" || l.duration === 1 / 0 || l.type === "loading") return;
    let q;
    return w || h || ds ? (() => {
      if (ls.current < pr.current) {
        const Ee = (/* @__PURE__ */ new Date()).getTime() - pr.current;
        Qe.current = Qe.current - Ee;
      }
      ls.current = (/* @__PURE__ */ new Date()).getTime();
    })() : Qe.current !== 1 / 0 && (pr.current = (/* @__PURE__ */ new Date()).getTime(), q = setTimeout(() => {
      l.onAutoClose == null || l.onAutoClose.call(l, l), ut();
    }, Qe.current)), () => clearTimeout(q);
  }, [
    w,
    h,
    l,
    Ce,
    ds,
    ut
  ]), R.useEffect(() => {
    l.delete && (ut(), l.onDismiss == null || l.onDismiss.call(l, l));
  }, [
    ut,
    l.delete
  ]);
  function us() {
    var q;
    if (z?.loading) {
      var pe;
      return /* @__PURE__ */ R.createElement("div", {
        className: je($?.loader, l == null || (pe = l.classNames) == null ? void 0 : pe.loader, "sonner-loader"),
        "data-visible": Ce === "loading"
      }, z.loading);
    }
    return /* @__PURE__ */ R.createElement(Ac, {
      className: je($?.loader, l == null || (q = l.classNames) == null ? void 0 : q.loader),
      visible: Ce === "loading"
    });
  }
  const Cc = l.icon || z?.[Ce] || Ic(Ce);
  var fs, ms;
  return /* @__PURE__ */ R.createElement("li", {
    tabIndex: 0,
    ref: Je,
    className: je(_, gc, $?.toast, l == null || (t = l.classNames) == null ? void 0 : t.toast, $?.[as], l == null || (n = l.classNames) == null ? void 0 : n[as]),
    "data-sonner-toast": "",
    "data-rich-colors": (fs = l.richColors) != null ? fs : E,
    "data-styled": !(l.jsx || l.unstyled || p),
    "data-mounted": se,
    "data-promise": !!l.promise,
    "data-swiped": te,
    "data-removed": K,
    "data-visible": hc,
    "data-y-position": yc,
    "data-x-position": xc,
    "data-index": y,
    "data-front": pc,
    "data-swiping": ae,
    "data-dismissible": Mt,
    "data-type": Ce,
    "data-invert": wc,
    "data-swipe-out": B,
    "data-swipe-direction": ie,
    "data-expanded": !!(w || W && se),
    "data-testid": l.testId,
    style: {
      "--index": y,
      "--toasts-before": y,
      "--z-index": C.length - y,
      "--offset": `${K ? oe : Lt.current}px`,
      "--initial-height": W ? "auto" : `${ke}px`,
      ...k,
      ...l.style
    },
    onDragEnd: () => {
      G(!1), L(null), $t.current = null;
    },
    onPointerDown: (q) => {
      q.button !== 2 && (hr || !Mt || (Dt.current = /* @__PURE__ */ new Date(), me(Lt.current), q.target.setPointerCapture(q.pointerId), q.target.tagName !== "BUTTON" && (G(!0), $t.current = {
        x: q.clientX,
        y: q.clientY
      })));
    },
    onPointerUp: () => {
      var q, pe, xe;
      if (B || !Mt) return;
      $t.current = null;
      const Ee = Number(((q = Je.current) == null ? void 0 : q.style.getPropertyValue("--swipe-amount-x").replace("px", "")) || 0), rn = Number(((pe = Je.current) == null ? void 0 : pe.style.getPropertyValue("--swipe-amount-y").replace("px", "")) || 0), ve = (/* @__PURE__ */ new Date()).getTime() - ((xe = Dt.current) == null ? void 0 : xe.getTime()), Oe = F === "x" ? Ee : rn, Be = Math.abs(Oe) / ve;
      if ((F === "x" ? ze.includes(Ee > 0 ? "right" : "left") : ze.includes(rn > 0 ? "bottom" : "top")) && (Math.abs(Oe) >= Jc || Be > 0.11)) {
        me(Lt.current), l.onDismiss == null || l.onDismiss.call(l, l), J(F === "x" ? Ee > 0 ? "right" : "left" : rn > 0 ? "down" : "up"), ut(), ce(!0);
        return;
      } else {
        var Ve, vr;
        (Ve = Je.current) == null || Ve.style.setProperty("--swipe-amount-x", "0px"), (vr = Je.current) == null || vr.style.setProperty("--swipe-amount-y", "0px");
      }
      ne(!1), G(!1), L(null);
    },
    onPointerMove: (q) => {
      var pe, xe, Ee;
      if (!$t.current || !Mt || ((pe = window.getSelection()) == null ? void 0 : pe.toString().length) > 0) return;
      const ve = q.clientY - $t.current.y, Oe = q.clientX - $t.current.x;
      !F && (Math.abs(Oe) > 1 || Math.abs(ve) > 1) && L(Math.abs(Oe) > Math.abs(ve) ? "x" : "y");
      let Be = {
        x: 0,
        y: 0
      };
      const gr = (Ve) => 1 / (1.5 + Math.abs(Ve) / 20);
      if (F === "y") {
        if (ze.includes("top") || ze.includes("bottom"))
          if (ze.includes("top") && ve < 0 || ze.includes("bottom") && ve > 0)
            Be.y = ve;
          else {
            const Ve = ve * gr(ve);
            Be.y = Math.abs(Ve) < Math.abs(ve) ? Ve : ve;
          }
      } else if (F === "x" && (ze.includes("left") || ze.includes("right")))
        if (ze.includes("left") && Oe < 0 || ze.includes("right") && Oe > 0)
          Be.x = Oe;
        else {
          const Ve = Oe * gr(Oe);
          Be.x = Math.abs(Ve) < Math.abs(Oe) ? Ve : Oe;
        }
      (Math.abs(Be.x) > 0 || Math.abs(Be.y) > 0) && ne(!0), (xe = Je.current) == null || xe.style.setProperty("--swipe-amount-x", `${Be.x}px`), (Ee = Je.current) == null || Ee.style.setProperty("--swipe-amount-y", `${Be.y}px`);
    }
  }, bc && !l.jsx && Ce !== "loading" ? /* @__PURE__ */ R.createElement("button", {
    "aria-label": H,
    "data-disabled": hr,
    "data-close-button": !0,
    onClick: hr || !Mt ? () => {
    } : () => {
      ut(), l.onDismiss == null || l.onDismiss.call(l, l);
    },
    className: je($?.closeButton, l == null || (r = l.classNames) == null ? void 0 : r.closeButton)
  }, (ms = z?.close) != null ? ms : Fc) : null, (Ce || l.icon || l.promise) && l.icon !== null && (z?.[Ce] !== null || l.icon) ? /* @__PURE__ */ R.createElement("div", {
    "data-icon": "",
    className: je($?.icon, l == null || (o = l.classNames) == null ? void 0 : o.icon)
  }, Ce === "loading" ? l.icon || us() : l.promise ? us() : null, Ce !== "loading" ? Cc : null) : null, /* @__PURE__ */ R.createElement("div", {
    "data-content": "",
    className: je($?.content, l == null || (s = l.classNames) == null ? void 0 : s.content)
  }, /* @__PURE__ */ R.createElement("div", {
    "data-title": "",
    className: je($?.title, l == null || (a = l.classNames) == null ? void 0 : a.title)
  }, l.jsx ? l.jsx : typeof l.title == "function" ? l.title() : l.title), l.description ? /* @__PURE__ */ R.createElement("div", {
    "data-description": "",
    className: je(M, vc, $?.description, l == null || (i = l.classNames) == null ? void 0 : i.description)
  }, typeof l.description == "function" ? l.description() : l.description) : null), /* @__PURE__ */ R.isValidElement(l.cancel) ? l.cancel : l.cancel && wn(l.cancel) ? /* @__PURE__ */ R.createElement("button", {
    "data-button": !0,
    "data-cancel": !0,
    style: l.cancelButtonStyle || S,
    onClick: (q) => {
      wn(l.cancel) && Mt && (l.cancel.onClick == null || l.cancel.onClick.call(l.cancel, q), ut());
    },
    className: je($?.cancelButton, l == null || (d = l.classNames) == null ? void 0 : d.cancelButton)
  }, l.cancel.label) : null, /* @__PURE__ */ R.isValidElement(l.action) ? l.action : l.action && wn(l.action) ? /* @__PURE__ */ R.createElement("button", {
    "data-button": !0,
    "data-action": !0,
    style: l.actionButtonStyle || P,
    onClick: (q) => {
      wn(l.action) && (l.action.onClick == null || l.action.onClick.call(l.action, q), !q.defaultPrevented && ut());
    },
    className: je($?.actionButton, l == null || (c = l.classNames) == null ? void 0 : c.actionButton)
  }, l.action.label) : null);
};
function ys() {
  if (typeof window > "u" || typeof document > "u") return "ltr";
  const e = document.documentElement.getAttribute("dir");
  return e === "auto" || !e ? window.getComputedStyle(document.documentElement).direction : e;
}
function rd(e, t) {
  const n = {};
  return [
    e,
    t
  ].forEach((r, o) => {
    const s = o === 1, a = s ? "--mobile-offset" : "--offset", i = s ? qc : Xc;
    function d(c) {
      [
        "top",
        "right",
        "bottom",
        "left"
      ].forEach((m) => {
        n[`${a}-${m}`] = typeof c == "number" ? `${c}px` : c;
      });
    }
    typeof r == "number" || typeof r == "string" ? d(r) : typeof r == "object" ? [
      "top",
      "right",
      "bottom",
      "left"
    ].forEach((c) => {
      r[c] === void 0 ? n[`${a}-${c}`] = i : n[`${a}-${c}`] = typeof r[c] == "number" ? `${r[c]}px` : r[c];
    }) : d(i);
  }), n;
}
const Jb = /* @__PURE__ */ R.forwardRef(function(t, n) {
  const { id: r, invert: o, position: s = "bottom-right", hotkey: a = [
    "altKey",
    "KeyT"
  ], expand: i, closeButton: d, className: c, offset: m, mobileOffset: l, theme: p = "light", richColors: h, duration: b, style: v, visibleToasts: g = Yc, toastOptions: y, dir: C = ys(), gap: w = Qc, icons: x, customAriaLabel: E, containerAriaLabel: N = "Notifications" } = t, [k, S] = R.useState([]), P = R.useMemo(() => r ? k.filter((X) => X.toasterId === r) : k.filter((X) => !X.toasterId), [
    k,
    r
  ]), _ = R.useMemo(() => Array.from(new Set([
    s
  ].concat(P.filter((X) => X.position).map((X) => X.position)))), [
    P,
    s
  ]), [M, A] = R.useState([]), [T, D] = R.useState(!1), [W, $] = R.useState(!1), [z, H] = R.useState(p !== "system" ? p : typeof window < "u" && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"), F = R.useRef(null), L = a.join("+").replace(/Key/g, "").replace(/Digit/g, ""), ie = R.useRef(null), J = R.useRef(!1), se = R.useCallback((X) => {
    S((K) => {
      var U;
      return (U = K.find((ae) => ae.id === X.id)) != null && U.delete || Re.dismiss(X.id), K.filter(({ id: ae }) => ae !== X.id);
    });
  }, []);
  return R.useEffect(() => Re.subscribe((X) => {
    if (X.dismiss) {
      requestAnimationFrame(() => {
        S((K) => K.map((U) => U.id === X.id ? {
          ...U,
          delete: !0
        } : U));
      });
      return;
    }
    setTimeout(() => {
      Nc.flushSync(() => {
        S((K) => {
          const U = K.findIndex((ae) => ae.id === X.id);
          return U !== -1 ? [
            ...K.slice(0, U),
            {
              ...K[U],
              ...X
            },
            ...K.slice(U + 1)
          ] : [
            X,
            ...K
          ];
        });
      });
    });
  }), []), R.useEffect(() => {
    if (p !== "system") {
      H(p);
      return;
    }
    if (p === "system" && (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? H("dark") : H("light")), typeof window > "u") return;
    const X = window.matchMedia("(prefers-color-scheme: dark)");
    try {
      X.addEventListener("change", ({ matches: K }) => {
        H(K ? "dark" : "light");
      });
    } catch {
      X.addListener(({ matches: U }) => {
        try {
          H(U ? "dark" : "light");
        } catch (ae) {
          console.error(ae);
        }
      });
    }
  }, [
    p
  ]), R.useEffect(() => {
    k.length <= 1 && D(!1);
  }, [
    k
  ]), R.useEffect(() => {
    const X = (K) => {
      var U;
      if (a.length > 0 && a.every((B) => K[B] || K.code === B)) {
        var G;
        D(!0), (G = F.current) == null || G.focus();
      }
      K.code === "Escape" && (document.activeElement === F.current || (U = F.current) != null && U.contains(document.activeElement)) && D(!1);
    };
    return document.addEventListener("keydown", X), () => document.removeEventListener("keydown", X);
  }, [
    a
  ]), R.useEffect(() => {
    if (F.current)
      return () => {
        ie.current && (ie.current.focus({
          preventScroll: !0
        }), ie.current = null, J.current = !1);
      };
  }, [
    F.current
  ]), // Remove item from normal navigation flow, only available via hotkey
  /* @__PURE__ */ R.createElement("section", {
    ref: n,
    "aria-label": E ?? `${N} ${L}`,
    tabIndex: -1,
    "aria-live": "polite",
    "aria-relevant": "additions text",
    "aria-atomic": "false",
    suppressHydrationWarning: !0,
    "data-react-aria-top-layer": !0
  }, _.map((X, K) => {
    var U;
    const [ae, G] = X.split("-");
    return P.length ? /* @__PURE__ */ R.createElement("ol", {
      key: X,
      dir: C === "auto" ? ys() : C,
      tabIndex: -1,
      ref: F,
      className: c,
      "data-sonner-toaster": !0,
      "data-sonner-theme": z,
      "data-y-position": ae,
      "data-x-position": G,
      style: {
        "--front-toast-height": `${((U = M[0]) == null ? void 0 : U.height) || 0}px`,
        "--width": `${Zc}px`,
        "--gap": `${w}px`,
        ...v,
        ...rd(m, l)
      },
      onBlur: (B) => {
        J.current && !B.currentTarget.contains(B.relatedTarget) && (J.current = !1, ie.current && (ie.current.focus({
          preventScroll: !0
        }), ie.current = null));
      },
      onFocus: (B) => {
        B.target instanceof HTMLElement && B.target.dataset.dismissible === "false" || J.current || (J.current = !0, ie.current = B.relatedTarget);
      },
      onMouseEnter: () => D(!0),
      onMouseMove: () => D(!0),
      onMouseLeave: () => {
        W || D(!1);
      },
      onDragEnd: () => D(!1),
      onPointerDown: (B) => {
        B.target instanceof HTMLElement && B.target.dataset.dismissible === "false" || $(!0);
      },
      onPointerUp: () => $(!1)
    }, P.filter((B) => !B.position && K === 0 || B.position === X).map((B, ce) => {
      var te, ne;
      return /* @__PURE__ */ R.createElement(nd, {
        key: B.id,
        icons: x,
        index: ce,
        toast: B,
        defaultRichColors: h,
        duration: (te = y?.duration) != null ? te : b,
        className: y?.className,
        descriptionClassName: y?.descriptionClassName,
        invert: o,
        visibleToasts: g,
        closeButton: (ne = y?.closeButton) != null ? ne : d,
        interacting: W,
        position: X,
        style: y?.style,
        unstyled: y?.unstyled,
        classNames: y?.classNames,
        cancelButtonStyle: y?.cancelButtonStyle,
        actionButtonStyle: y?.actionButtonStyle,
        closeButtonAriaLabel: y?.closeButtonAriaLabel,
        removeToast: se,
        toasts: P.filter((oe) => oe.position == B.position),
        heights: M.filter((oe) => oe.position == B.position),
        setHeights: A,
        expandByDefault: i,
        gap: w,
        expanded: T,
        swipeDirections: t.swipeDirections
      });
    })) : null;
  }));
});
var od = Object.defineProperty, io = (e, t) => od(e, "name", { value: t, configurable: !0 });
function Mr(e, t) {
  if (typeof e == "function")
    return e(t);
  e != null && (e.current = t);
}
io(Mr, "setRef");
function ya(...e) {
  return (t) => {
    let n = !1;
    const r = e.map((o) => {
      const s = Mr(o, t);
      return !n && typeof s == "function" && (n = !0), s;
    });
    if (n)
      return () => {
        for (let o = 0; o < r.length; o++) {
          const s = r[o];
          typeof s == "function" ? s() : Mr(e[o], null);
        }
      };
  };
}
io(ya, "composeRefs");
function re(...e) {
  return u.useCallback(ya(...e), e);
}
io(re, "useComposedRefs");
var sd = Object.defineProperty, $e = (e, t) => sd(e, "name", { value: t, configurable: !0 });
// @__NO_SIDE_EFFECTS__
function Ke(e) {
  const t = u.forwardRef((n, r) => {
    let { children: o, ...s } = n, a = null, i = !1;
    const d = [];
    Lr(o) && typeof Cn == "function" && (o = Cn(o._payload)), u.Children.forEach(o, (p) => {
      if (Ea(p)) {
        i = !0;
        const h = p;
        let b = "child" in h.props ? h.props.child : h.props.children;
        Lr(b) && typeof Cn == "function" && (b = Cn(b._payload)), a = ad(h, b), d.push(a?.props?.children);
      } else
        d.push(p);
    }), a ? a = u.cloneElement(a, void 0, d) : (
      // A `Slottable` was found but it didn't resolve to a single element (e.g.
      // it wrapped multiple elements, text, or a render-prop `child` that
      // wasn't an element). Don't fall back to treating the `Slottable` wrapper
      // itself as the slot target — throw a descriptive error below instead.
      !i && u.Children.count(o) === 1 && u.isValidElement(o) && (a = o)
    );
    const c = a ? ka(a) : void 0, m = re(r, c);
    if (!a) {
      if (o || o === 0)
        throw new Error(
          i ? cd(e) : ld(e)
        );
      return o;
    }
    const l = Sa(s, a.props ?? {});
    return a.type !== u.Fragment && (l.ref = r ? m : c), u.cloneElement(a, l);
  });
  return t.displayName = `${e}.Slot`, t;
}
$e(Ke, "createSlot");
var xa = /* @__PURE__ */ Ke("Slot"), wa = /* @__PURE__ */ Symbol.for("radix.slottable");
// @__NO_SIDE_EFFECTS__
function Ca(e) {
  const t = /* @__PURE__ */ $e((n) => "child" in n ? n.children(n.child) : n.children, "Slottable");
  return t.displayName = `${e}.Slottable`, t.__radixId = wa, t;
}
$e(Ca, "createSlottable");
var ad = /* @__PURE__ */ $e((e, t) => {
  if ("child" in e.props) {
    const n = e.props.child;
    return u.isValidElement(n) ? u.cloneElement(n, void 0, e.props.children(n.props.children)) : null;
  }
  return u.isValidElement(t) ? t : null;
}, "getSlottableElementFromSlottable");
function Sa(e, t) {
  const n = { ...t };
  for (const r in t) {
    const o = e[r], s = t[r];
    /^on[A-Z]/.test(r) ? o && s ? n[r] = (...i) => {
      const d = s(...i);
      return o(...i), d;
    } : o && (n[r] = o) : r === "style" ? n[r] = { ...o, ...s } : r === "className" && (n[r] = [o, s].filter(Boolean).join(" "));
  }
  return { ...e, ...n };
}
$e(Sa, "mergeProps");
function ka(e) {
  let t = Object.getOwnPropertyDescriptor(e.props, "ref")?.get, n = t && "isReactWarning" in t && t.isReactWarning;
  return n ? e.ref : (t = Object.getOwnPropertyDescriptor(e, "ref")?.get, n = t && "isReactWarning" in t && t.isReactWarning, n ? e.props.ref : e.props.ref || e.ref);
}
$e(ka, "getElementRef");
function Ea(e) {
  return u.isValidElement(e) && typeof e.type == "function" && "__radixId" in e.type && e.type.__radixId === wa;
}
$e(Ea, "isSlottable");
var id = /* @__PURE__ */ Symbol.for("react.lazy");
function Lr(e) {
  return e != null && typeof e == "object" && "$$typeof" in e && e.$$typeof === id && "_payload" in e && Na(e._payload);
}
$e(Lr, "isLazyComponent");
function Na(e) {
  return typeof e == "object" && e !== null && "then" in e;
}
$e(Na, "isPromiseLike");
var ld = /* @__PURE__ */ $e((e) => `${e} failed to slot onto its children. Expected a single React element child or \`Slottable\`.`, "createSlotError"), cd = /* @__PURE__ */ $e((e) => `${e} failed to slot onto its \`Slottable\`. Expected \`Slottable\` to receive a single React element child.`, "createSlottableError"), Cn = u[" use ".trim().toString()];
function Ra(e) {
  var t, n, r = "";
  if (typeof e == "string" || typeof e == "number") r += e;
  else if (typeof e == "object") if (Array.isArray(e)) {
    var o = e.length;
    for (t = 0; t < o; t++) e[t] && (n = Ra(e[t])) && (r && (r += " "), r += n);
  } else for (n in e) e[n] && (r && (r += " "), r += n);
  return r;
}
function Pa() {
  for (var e, t, n = 0, r = "", o = arguments.length; n < o; n++) (e = arguments[n]) && (t = Ra(e)) && (r && (r += " "), r += t);
  return r;
}
const xs = (e) => typeof e == "boolean" ? `${e}` : e === 0 ? "0" : e, ws = Pa, Xt = (e, t) => (n) => {
  var r;
  if (t?.variants == null) return ws(e, n?.class, n?.className);
  const { variants: o, defaultVariants: s } = t, a = Object.keys(o).map((c) => {
    const m = n?.[c], l = s?.[c];
    if (m === null) return null;
    const p = xs(m) || xs(l);
    return o[c][p];
  }), i = n && Object.entries(n).reduce((c, m) => {
    let [l, p] = m;
    return p === void 0 || (c[l] = p), c;
  }, {}), d = t == null || (r = t.compoundVariants) === null || r === void 0 ? void 0 : r.reduce((c, m) => {
    let { class: l, className: p, ...h } = m;
    return Object.entries(h).every((b) => {
      let [v, g] = b;
      return Array.isArray(g) ? g.includes({
        ...s,
        ...i
      }[v]) : {
        ...s,
        ...i
      }[v] === g;
    }) ? [
      ...c,
      l,
      p
    ] : c;
  }, []);
  return ws(e, a, d, n?.class, n?.className);
};
const dd = (e) => e.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase(), ud = (e) => e.replace(
  /^([A-Z])|[\s-_]+(\w)/g,
  (t, n, r) => r ? r.toUpperCase() : n.toLowerCase()
), Cs = (e) => {
  const t = ud(e);
  return t.charAt(0).toUpperCase() + t.slice(1);
}, Ta = (...e) => e.filter((t, n, r) => !!t && t.trim() !== "" && r.indexOf(t) === n).join(" ").trim(), fd = (e) => {
  for (const t in e)
    if (t.startsWith("aria-") || t === "role" || t === "title")
      return !0;
};
var md = {
  xmlns: "http://www.w3.org/2000/svg",
  width: 24,
  height: 24,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round"
};
const pd = ha(
  ({
    color: e = "currentColor",
    size: t = 24,
    strokeWidth: n = 2,
    absoluteStrokeWidth: r,
    className: o = "",
    children: s,
    iconNode: a,
    ...i
  }, d) => Dr(
    "svg",
    {
      ref: d,
      ...md,
      width: t,
      height: t,
      stroke: e,
      strokeWidth: r ? Number(n) * 24 / Number(t) : n,
      className: Ta("lucide", o),
      ...!s && !fd(i) && { "aria-hidden": "true" },
      ...i
    },
    [
      ...a.map(([c, m]) => Dr(c, m)),
      ...Array.isArray(s) ? s : [s]
    ]
  )
);
const le = (e, t) => {
  const n = ha(
    ({ className: r, ...o }, s) => Dr(pd, {
      ref: s,
      iconNode: t,
      className: Ta(
        `lucide-${dd(Cs(e))}`,
        `lucide-${e}`,
        r
      ),
      ...o
    })
  );
  return n.displayName = Cs(e), n;
};
const hd = [
  ["path", { d: "m12 19-7-7 7-7", key: "1l729n" }],
  ["path", { d: "M19 12H5", key: "x3x0zl" }]
], _a = le("arrow-left", hd);
const gd = [
  ["path", { d: "M5 12h14", key: "1ays0h" }],
  ["path", { d: "m12 5 7 7-7 7", key: "xquz4c" }]
], vd = le("arrow-right", gd);
const bd = [
  ["rect", { width: "16", height: "20", x: "4", y: "2", rx: "2", key: "1nb95v" }],
  ["line", { x1: "8", x2: "16", y1: "6", y2: "6", key: "x4nwl0" }],
  ["line", { x1: "16", x2: "16", y1: "14", y2: "18", key: "wjye3r" }],
  ["path", { d: "M16 10h.01", key: "1m94wz" }],
  ["path", { d: "M12 10h.01", key: "1nrarc" }],
  ["path", { d: "M8 10h.01", key: "19clt8" }],
  ["path", { d: "M12 14h.01", key: "1etili" }],
  ["path", { d: "M8 14h.01", key: "6423bh" }],
  ["path", { d: "M12 18h.01", key: "mhygvu" }],
  ["path", { d: "M8 18h.01", key: "lrp35t" }]
], yd = le("calculator", bd);
const xd = [["path", { d: "M20 6 9 17l-5-5", key: "1gmf2c" }]], jn = le("check", xd);
const wd = [["path", { d: "m6 9 6 6 6-6", key: "qrunsl" }]], Zn = le("chevron-down", wd);
const Cd = [["path", { d: "m15 18-6-6 6-6", key: "1wnfg3" }]], $r = le("chevron-left", Cd);
const Sd = [["path", { d: "m9 18 6-6-6-6", key: "mthhwq" }]], Fr = le("chevron-right", Sd);
const kd = [["path", { d: "m18 15-6-6-6 6", key: "153udz" }]], Ed = le("chevron-up", kd);
const Nd = [
  ["circle", { cx: "12", cy: "12", r: "10", key: "1mglay" }],
  ["line", { x1: "12", x2: "12", y1: "8", y2: "12", key: "1pkeuh" }],
  ["line", { x1: "12", x2: "12.01", y1: "16", y2: "16", key: "4dfq90" }]
], Ia = le("circle-alert", Nd);
const Rd = [
  ["path", { d: "M21.801 10A10 10 0 1 1 17 3.335", key: "yps3ct" }],
  ["path", { d: "m9 11 3 3L22 4", key: "1pflzl" }]
], Pd = le("circle-check-big", Rd);
const Td = [
  ["circle", { cx: "12", cy: "12", r: "10", key: "1mglay" }],
  ["path", { d: "m9 12 2 2 4-4", key: "dzmm74" }]
], _d = le("circle-check", Td);
const Id = [["circle", { cx: "12", cy: "12", r: "10", key: "1mglay" }]], Od = le("circle", Id);
const Ad = [
  ["rect", { width: "14", height: "14", x: "8", y: "8", rx: "2", ry: "2", key: "17jyea" }],
  ["path", { d: "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2", key: "zix9uf" }]
], Dd = le("copy", Ad);
const Md = [
  ["circle", { cx: "12", cy: "12", r: "10", key: "1mglay" }],
  ["path", { d: "M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20", key: "13o1zl" }],
  ["path", { d: "M2 12h20", key: "9i4pu4" }]
], Ld = le("globe", Md);
const $d = [
  ["circle", { cx: "12", cy: "12", r: "10", key: "1mglay" }],
  ["path", { d: "M12 16v-4", key: "1dtifu" }],
  ["path", { d: "M12 8h.01", key: "e9boi3" }]
], Fd = le("info", $d);
const zd = [["path", { d: "M21 12a9 9 0 1 1-6.219-8.56", key: "13zald" }]], Bd = le("loader-circle", zd);
const Vd = [
  [
    "path",
    {
      d: "M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719",
      key: "1sd12s"
    }
  ]
], jd = le("message-circle", Vd);
const Hd = [["path", { d: "M5 12h14", key: "1ays0h" }]], Wd = le("minus", Hd);
const Ud = [
  [
    "path",
    {
      d: "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z",
      key: "1a8usu"
    }
  ],
  ["path", { d: "m15 5 4 4", key: "1mk7zo" }]
], Gd = le("pencil", Ud);
const Kd = [
  ["path", { d: "M5 12h14", key: "1ays0h" }],
  ["path", { d: "M12 5v14", key: "s699le" }]
], Oa = le("plus", Kd);
const Yd = [
  ["path", { d: "M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8", key: "14sxne" }],
  ["path", { d: "M3 3v5h5", key: "1xhq8a" }],
  ["path", { d: "M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16", key: "1hlbsb" }],
  ["path", { d: "M16 16h5v5", key: "ccwih5" }]
], Xd = le("refresh-ccw", Yd);
const qd = [
  [
    "path",
    {
      d: "M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z",
      key: "1c8476"
    }
  ],
  ["path", { d: "M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7", key: "1ydtos" }],
  ["path", { d: "M7 3v4a1 1 0 0 0 1 1h7", key: "t51u73" }]
], Zd = le("save", qd);
const Qd = [
  ["path", { d: "m21 21-4.34-4.34", key: "14j7rj" }],
  ["circle", { cx: "11", cy: "11", r: "8", key: "4ej97u" }]
], Jd = le("search", Qd);
const eu = [
  ["path", { d: "M10 11v6", key: "nco0om" }],
  ["path", { d: "M14 11v6", key: "outv1u" }],
  ["path", { d: "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6", key: "miytrc" }],
  ["path", { d: "M3 6h18", key: "d0wm0j" }],
  ["path", { d: "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2", key: "e791ji" }]
], tu = le("trash-2", eu);
const nu = [
  [
    "path",
    {
      d: "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3",
      key: "wmoenq"
    }
  ],
  ["path", { d: "M12 9v4", key: "juzpu7" }],
  ["path", { d: "M12 17h.01", key: "p32p05" }]
], ru = le("triangle-alert", nu);
const ou = [
  ["path", { d: "M18 6 6 18", key: "1bl5f8" }],
  ["path", { d: "m6 6 12 12", key: "d8bk6v" }]
], Pt = le("x", ou), su = (e, t) => {
  const n = new Array(e.length + t.length);
  for (let r = 0; r < e.length; r++)
    n[r] = e[r];
  for (let r = 0; r < t.length; r++)
    n[e.length + r] = t[r];
  return n;
}, au = (e, t) => ({
  classGroupId: e,
  validator: t
}), Aa = (e = /* @__PURE__ */ new Map(), t = null, n) => ({
  nextPart: e,
  validators: t,
  classGroupId: n
}), Hn = "-", Ss = [], iu = "arbitrary..", lu = (e) => {
  const t = du(e), {
    conflictingClassGroups: n,
    conflictingClassGroupModifiers: r
  } = e;
  return {
    getClassGroupId: (a) => {
      if (a.startsWith("[") && a.endsWith("]"))
        return cu(a);
      const i = a.split(Hn), d = i[0] === "" && i.length > 1 ? 1 : 0;
      return Da(i, d, t);
    },
    getConflictingClassGroupIds: (a, i) => {
      if (i) {
        const d = r[a], c = n[a];
        return d ? c ? su(c, d) : d : c || Ss;
      }
      return n[a] || Ss;
    }
  };
}, Da = (e, t, n) => {
  if (e.length - t === 0)
    return n.classGroupId;
  const o = e[t], s = n.nextPart.get(o);
  if (s) {
    const c = Da(e, t + 1, s);
    if (c) return c;
  }
  const a = n.validators;
  if (a === null)
    return;
  const i = t === 0 ? e.join(Hn) : e.slice(t).join(Hn), d = a.length;
  for (let c = 0; c < d; c++) {
    const m = a[c];
    if (m.validator(i))
      return m.classGroupId;
  }
}, cu = (e) => e.slice(1, -1).indexOf(":") === -1 ? void 0 : (() => {
  const t = e.slice(1, -1), n = t.indexOf(":"), r = t.slice(0, n);
  return r ? iu + r : void 0;
})(), du = (e) => {
  const {
    theme: t,
    classGroups: n
  } = e;
  return uu(n, t);
}, uu = (e, t) => {
  const n = Aa();
  for (const r in e) {
    const o = e[r];
    lo(o, n, r, t);
  }
  return n;
}, lo = (e, t, n, r) => {
  const o = e.length;
  for (let s = 0; s < o; s++) {
    const a = e[s];
    fu(a, t, n, r);
  }
}, fu = (e, t, n, r) => {
  if (typeof e == "string") {
    mu(e, t, n);
    return;
  }
  if (typeof e == "function") {
    pu(e, t, n, r);
    return;
  }
  hu(e, t, n, r);
}, mu = (e, t, n) => {
  const r = e === "" ? t : Ma(t, e);
  r.classGroupId = n;
}, pu = (e, t, n, r) => {
  if (gu(e)) {
    lo(e(r), t, n, r);
    return;
  }
  t.validators === null && (t.validators = []), t.validators.push(au(n, e));
}, hu = (e, t, n, r) => {
  const o = Object.entries(e), s = o.length;
  for (let a = 0; a < s; a++) {
    const [i, d] = o[a];
    lo(d, Ma(t, i), n, r);
  }
}, Ma = (e, t) => {
  let n = e;
  const r = t.split(Hn), o = r.length;
  for (let s = 0; s < o; s++) {
    const a = r[s];
    let i = n.nextPart.get(a);
    i || (i = Aa(), n.nextPart.set(a, i)), n = i;
  }
  return n;
}, gu = (e) => "isThemeGetter" in e && e.isThemeGetter === !0, vu = (e) => {
  if (e < 1)
    return {
      get: () => {
      },
      set: () => {
      }
    };
  let t = 0, n = /* @__PURE__ */ Object.create(null), r = /* @__PURE__ */ Object.create(null);
  const o = (s, a) => {
    n[s] = a, t++, t > e && (t = 0, r = n, n = /* @__PURE__ */ Object.create(null));
  };
  return {
    get(s) {
      let a = n[s];
      if (a !== void 0)
        return a;
      if ((a = r[s]) !== void 0)
        return o(s, a), a;
    },
    set(s, a) {
      s in n ? n[s] = a : o(s, a);
    }
  };
}, zr = "!", ks = ":", bu = [], Es = (e, t, n, r, o) => ({
  modifiers: e,
  hasImportantModifier: t,
  baseClassName: n,
  maybePostfixModifierPosition: r,
  isExternal: o
}), yu = (e) => {
  const {
    prefix: t,
    experimentalParseClassName: n
  } = e;
  let r = (o) => {
    const s = [];
    let a = 0, i = 0, d = 0, c;
    const m = o.length;
    for (let v = 0; v < m; v++) {
      const g = o[v];
      if (a === 0 && i === 0) {
        if (g === ks) {
          s.push(o.slice(d, v)), d = v + 1;
          continue;
        }
        if (g === "/") {
          c = v;
          continue;
        }
      }
      g === "[" ? a++ : g === "]" ? a-- : g === "(" ? i++ : g === ")" && i--;
    }
    const l = s.length === 0 ? o : o.slice(d);
    let p = l, h = !1;
    l.endsWith(zr) ? (p = l.slice(0, -1), h = !0) : (
      /**
       * In Tailwind CSS v3 the important modifier was at the start of the base class name. This is still supported for legacy reasons.
       * @see https://github.com/dcastil/tailwind-merge/issues/513#issuecomment-2614029864
       */
      l.startsWith(zr) && (p = l.slice(1), h = !0)
    );
    const b = c && c > d ? c - d : void 0;
    return Es(s, h, p, b);
  };
  if (t) {
    const o = t + ks, s = r;
    r = (a) => a.startsWith(o) ? s(a.slice(o.length)) : Es(bu, !1, a, void 0, !0);
  }
  if (n) {
    const o = r;
    r = (s) => n({
      className: s,
      parseClassName: o
    });
  }
  return r;
}, xu = (e) => {
  const t = /* @__PURE__ */ new Map();
  return e.orderSensitiveModifiers.forEach((n, r) => {
    t.set(n, 1e6 + r);
  }), (n) => {
    const r = [];
    let o = [];
    for (let s = 0; s < n.length; s++) {
      const a = n[s], i = a[0] === "[", d = t.has(a);
      i || d ? (o.length > 0 && (o.sort(), r.push(...o), o = []), r.push(a)) : o.push(a);
    }
    return o.length > 0 && (o.sort(), r.push(...o)), r;
  };
}, wu = (e) => ({
  cache: vu(e.cacheSize),
  parseClassName: yu(e),
  sortModifiers: xu(e),
  postfixLookupClassGroupIds: Cu(e),
  ...lu(e)
}), Cu = (e) => {
  const t = /* @__PURE__ */ Object.create(null), n = e.postfixLookupClassGroups;
  if (n)
    for (let r = 0; r < n.length; r++)
      t[n[r]] = !0;
  return t;
}, Su = /\s+/, ku = (e, t) => {
  const {
    parseClassName: n,
    getClassGroupId: r,
    getConflictingClassGroupIds: o,
    sortModifiers: s,
    postfixLookupClassGroupIds: a
  } = t, i = [], d = e.trim().split(Su);
  let c = "";
  for (let m = d.length - 1; m >= 0; m -= 1) {
    const l = d[m], {
      isExternal: p,
      modifiers: h,
      hasImportantModifier: b,
      baseClassName: v,
      maybePostfixModifierPosition: g
    } = n(l);
    if (p) {
      c = l + (c.length > 0 ? " " + c : c);
      continue;
    }
    let y = !!g, C;
    if (y) {
      const k = v.substring(0, g);
      C = r(k);
      const S = C && a[C] ? r(v) : void 0;
      S && S !== C && (C = S, y = !1);
    } else
      C = r(v);
    if (!C) {
      if (!y) {
        c = l + (c.length > 0 ? " " + c : c);
        continue;
      }
      if (C = r(v), !C) {
        c = l + (c.length > 0 ? " " + c : c);
        continue;
      }
      y = !1;
    }
    const w = h.length === 0 ? "" : h.length === 1 ? h[0] : s(h).join(":"), x = b ? w + zr : w, E = x + C;
    if (i.indexOf(E) > -1)
      continue;
    i.push(E);
    const N = o(C, y);
    for (let k = 0; k < N.length; ++k) {
      const S = N[k];
      i.push(x + S);
    }
    c = l + (c.length > 0 ? " " + c : c);
  }
  return c;
}, Eu = (...e) => {
  let t = 0, n, r, o = "";
  for (; t < e.length; )
    (n = e[t++]) && (r = La(n)) && (o && (o += " "), o += r);
  return o;
}, La = (e) => {
  if (typeof e == "string")
    return e;
  let t, n = "";
  for (let r = 0; r < e.length; r++)
    e[r] && (t = La(e[r])) && (n && (n += " "), n += t);
  return n;
}, Ns = (e, ...t) => {
  let n, r, o, s;
  const a = (d) => {
    const c = t.reduce((m, l) => l(m), e());
    return n = wu(c), r = n.cache.get, o = n.cache.set, s = i, i(d);
  }, i = (d) => {
    const c = r(d);
    if (c)
      return c;
    const m = ku(d, n);
    return o(d, m), m;
  };
  return s = a, (...d) => s(Eu(...d));
}, Nu = [], fe = (e) => {
  const t = (n) => n[e] || Nu;
  return t.isThemeGetter = !0, t.themeKey = e, t;
}, $a = /^\[(?:(\w[\w-]*):)?(.+)\]$/i, Fa = /^\((?:(\w[\w-]*):)?(.+)\)$/i, Ru = /^\d+(?:\.\d+)?\/\d+(?:\.\d+)?$/, Pu = /^(\d+(\.\d+)?)?(xs|sm|md|lg|xl)$/, Tu = /\d+(%|px|r?em|[sdl]?v([hwib]|min|max)|pt|pc|in|cm|mm|cap|ch|ex|r?lh|cq(w|h|i|b|min|max))|\b(calc|min|max|clamp)\(.+\)|^0$/, _u = /^(rgba?|hsla?|hwb|(ok)?(lab|lch)|color-mix|color|light-dark)\(.+\)$/, Iu = /^(inset_)?-?((\d+)?\.?(\d+)[a-z]+|0)_-?((\d+)?\.?(\d+)[a-z]+|0)/, Ou = /^(url|image|image-set|cross-fade|element|(repeating-)?(linear|radial|conic)-gradient)\(.+\)$/, ft = (e) => Ru.test(e), Q = (e) => !!e && !Number.isNaN(Number(e)), He = (e) => !!e && Number.isInteger(Number(e)), yr = (e) => e.endsWith("%") && Q(e.slice(0, -1)), et = (e) => Pu.test(e), za = () => !0, Au = (e) => (
  // `colorFunctionRegex` check is necessary because color functions can have percentages in them which which would be incorrectly classified as lengths.
  // For example, `hsl(0 0% 0%)` would be classified as a length without this check.
  // I could also use lookbehind assertion in `lengthUnitRegex` but that isn't supported widely enough.
  Tu.test(e) && !_u.test(e)
), co = () => !1, Du = (e) => Iu.test(e), Mu = (e) => Ou.test(e), Lu = (e) => !V(e) && !j(e), $u = (e) => e.startsWith("@container") && (e[10] === "/" && e[11] !== void 0 || e[11] === "s" && e[16] !== void 0 && e.startsWith("-size/", 10) || e[11] === "n" && e[18] !== void 0 && e.startsWith("-normal/", 10)), Fu = (e) => vt(e, ja, co), V = (e) => $a.test(e), wt = (e) => vt(e, Ha, Au), Rs = (e) => vt(e, Gu, Q), zu = (e) => vt(e, Ua, za), Bu = (e) => vt(e, Wa, co), Ps = (e) => vt(e, Ba, co), Vu = (e) => vt(e, Va, Mu), Sn = (e) => vt(e, Ga, Du), j = (e) => Fa.test(e), on = (e) => Tt(e, Ha), ju = (e) => Tt(e, Wa), Ts = (e) => Tt(e, Ba), Hu = (e) => Tt(e, ja), Wu = (e) => Tt(e, Va), kn = (e) => Tt(e, Ga, !0), Uu = (e) => Tt(e, Ua, !0), vt = (e, t, n) => {
  const r = $a.exec(e);
  return r ? r[1] ? t(r[1]) : n(r[2]) : !1;
}, Tt = (e, t, n = !1) => {
  const r = Fa.exec(e);
  return r ? r[1] ? t(r[1]) : n : !1;
}, Ba = (e) => e === "position" || e === "percentage", Va = (e) => e === "image" || e === "url", ja = (e) => e === "length" || e === "size" || e === "bg-size", Ha = (e) => e === "length", Gu = (e) => e === "number", Wa = (e) => e === "family-name", Ua = (e) => e === "number" || e === "weight", Ga = (e) => e === "shadow", _s = () => {
  const e = fe("color"), t = fe("font"), n = fe("text"), r = fe("font-weight"), o = fe("tracking"), s = fe("leading"), a = fe("breakpoint"), i = fe("container"), d = fe("spacing"), c = fe("radius"), m = fe("shadow"), l = fe("inset-shadow"), p = fe("text-shadow"), h = fe("drop-shadow"), b = fe("blur"), v = fe("perspective"), g = fe("aspect"), y = fe("ease"), C = fe("animate"), w = () => ["auto", "avoid", "all", "avoid-page", "page", "left", "right", "column"], x = () => [
    "center",
    "top",
    "bottom",
    "left",
    "right",
    "top-left",
    // Deprecated since Tailwind CSS v4.1.0, see https://github.com/tailwindlabs/tailwindcss/pull/17378
    "left-top",
    "top-right",
    // Deprecated since Tailwind CSS v4.1.0, see https://github.com/tailwindlabs/tailwindcss/pull/17378
    "right-top",
    "bottom-right",
    // Deprecated since Tailwind CSS v4.1.0, see https://github.com/tailwindlabs/tailwindcss/pull/17378
    "right-bottom",
    "bottom-left",
    // Deprecated since Tailwind CSS v4.1.0, see https://github.com/tailwindlabs/tailwindcss/pull/17378
    "left-bottom"
  ], E = () => [...x(), j, V], N = () => ["auto", "hidden", "clip", "visible", "scroll"], k = () => ["auto", "contain", "none"], S = () => [j, V, d], P = () => [ft, "full", "auto", ...S()], _ = () => [He, "none", "subgrid", j, V], M = () => ["auto", {
    span: ["full", He, j, V]
  }, He, j, V], A = () => [He, "auto", j, V], T = () => ["auto", "min", "max", "fr", j, V], D = () => ["start", "end", "center", "between", "around", "evenly", "stretch", "baseline", "center-safe", "end-safe"], W = () => ["start", "end", "center", "stretch", "center-safe", "end-safe"], $ = () => ["auto", ...S()], z = () => [ft, "auto", "full", "dvw", "dvh", "lvw", "lvh", "svw", "svh", "min", "max", "fit", ...S()], H = () => [i, ft, "screen", "full", "dvw", "lvw", "svw", "min", "max", "fit", ...S()], F = () => [ft, "screen", "full", "lh", "dvh", "lvh", "svh", "min", "max", "fit", ...S()], L = () => [e, j, V], ie = () => [...x(), Ts, Ps, {
    position: [j, V]
  }], J = () => ["no-repeat", {
    repeat: ["", "x", "y", "space", "round"]
  }], se = () => ["auto", "cover", "contain", Hu, Fu, {
    size: [j, V]
  }], X = () => [yr, on, wt], K = () => [
    // Deprecated since Tailwind CSS v4.0.0
    "",
    "none",
    "full",
    c,
    j,
    V
  ], U = () => ["", Q, on, wt], ae = () => ["solid", "dashed", "dotted", "double"], G = () => ["normal", "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn", "hard-light", "soft-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity"], B = () => [Q, yr, Ts, Ps], ce = () => [
    // Deprecated since Tailwind CSS v4.0.0
    "",
    "none",
    b,
    j,
    V
  ], te = () => ["none", Q, j, V], ne = () => ["none", Q, j, V], oe = () => [Q, j, V], me = () => [ft, "full", ...S()];
  return {
    cacheSize: 500,
    theme: {
      animate: ["spin", "ping", "pulse", "bounce"],
      aspect: ["video"],
      blur: [et],
      breakpoint: [et],
      color: [za],
      container: [et],
      "drop-shadow": [et],
      ease: ["in", "out", "in-out"],
      font: [Lu],
      "font-weight": ["thin", "extralight", "light", "normal", "medium", "semibold", "bold", "extrabold", "black"],
      "inset-shadow": [et],
      leading: ["none", "tight", "snug", "normal", "relaxed", "loose"],
      perspective: ["dramatic", "near", "normal", "midrange", "distant", "none"],
      radius: [et],
      shadow: [et],
      spacing: ["px", Q],
      text: [et],
      "text-shadow": [et],
      tracking: ["tighter", "tight", "normal", "wide", "wider", "widest"]
    },
    classGroups: {
      // --------------
      // --- Layout ---
      // --------------
      /**
       * Aspect Ratio
       * @see https://tailwindcss.com/docs/aspect-ratio
       */
      aspect: [{
        aspect: ["auto", "square", ft, V, j, g]
      }],
      /**
       * Container
       * @see https://tailwindcss.com/docs/container
       * @deprecated since Tailwind CSS v4.0.0
       */
      container: ["container"],
      /**
       * Container Type
       * @see https://tailwindcss.com/docs/responsive-design#container-queries
       */
      "container-type": [{
        "@container": ["", "normal", "size", j, V]
      }],
      /**
       * Container Name
       * @see https://tailwindcss.com/docs/responsive-design#named-containers
       */
      "container-named": [$u],
      /**
       * Columns
       * @see https://tailwindcss.com/docs/columns
       */
      columns: [{
        columns: [Q, "auto", V, j, i]
      }],
      /**
       * Break After
       * @see https://tailwindcss.com/docs/break-after
       */
      "break-after": [{
        "break-after": w()
      }],
      /**
       * Break Before
       * @see https://tailwindcss.com/docs/break-before
       */
      "break-before": [{
        "break-before": w()
      }],
      /**
       * Break Inside
       * @see https://tailwindcss.com/docs/break-inside
       */
      "break-inside": [{
        "break-inside": ["auto", "avoid", "avoid-page", "avoid-column"]
      }],
      /**
       * Box Decoration Break
       * @see https://tailwindcss.com/docs/box-decoration-break
       */
      "box-decoration": [{
        "box-decoration": ["slice", "clone"]
      }],
      /**
       * Box Sizing
       * @see https://tailwindcss.com/docs/box-sizing
       */
      box: [{
        box: ["border", "content"]
      }],
      /**
       * Display
       * @see https://tailwindcss.com/docs/display
       */
      display: ["block", "inline-block", "inline", "flex", "inline-flex", "table", "inline-table", "table-caption", "table-cell", "table-column", "table-column-group", "table-footer-group", "table-header-group", "table-row-group", "table-row", "flow-root", "grid", "inline-grid", "contents", "list-item", "hidden"],
      /**
       * Screen Reader Only
       * @see https://tailwindcss.com/docs/display#screen-reader-only
       */
      sr: ["sr-only", "not-sr-only"],
      /**
       * Floats
       * @see https://tailwindcss.com/docs/float
       */
      float: [{
        float: ["right", "left", "none", "start", "end"]
      }],
      /**
       * Clear
       * @see https://tailwindcss.com/docs/clear
       */
      clear: [{
        clear: ["left", "right", "both", "none", "start", "end"]
      }],
      /**
       * Isolation
       * @see https://tailwindcss.com/docs/isolation
       */
      isolation: ["isolate", "isolation-auto"],
      /**
       * Object Fit
       * @see https://tailwindcss.com/docs/object-fit
       */
      "object-fit": [{
        object: ["contain", "cover", "fill", "none", "scale-down"]
      }],
      /**
       * Object Position
       * @see https://tailwindcss.com/docs/object-position
       */
      "object-position": [{
        object: E()
      }],
      /**
       * Overflow
       * @see https://tailwindcss.com/docs/overflow
       */
      overflow: [{
        overflow: N()
      }],
      /**
       * Overflow X
       * @see https://tailwindcss.com/docs/overflow
       */
      "overflow-x": [{
        "overflow-x": N()
      }],
      /**
       * Overflow Y
       * @see https://tailwindcss.com/docs/overflow
       */
      "overflow-y": [{
        "overflow-y": N()
      }],
      /**
       * Overscroll Behavior
       * @see https://tailwindcss.com/docs/overscroll-behavior
       */
      overscroll: [{
        overscroll: k()
      }],
      /**
       * Overscroll Behavior X
       * @see https://tailwindcss.com/docs/overscroll-behavior
       */
      "overscroll-x": [{
        "overscroll-x": k()
      }],
      /**
       * Overscroll Behavior Y
       * @see https://tailwindcss.com/docs/overscroll-behavior
       */
      "overscroll-y": [{
        "overscroll-y": k()
      }],
      /**
       * Position
       * @see https://tailwindcss.com/docs/position
       */
      position: ["static", "fixed", "absolute", "relative", "sticky"],
      /**
       * Inset
       * @see https://tailwindcss.com/docs/top-right-bottom-left
       */
      inset: [{
        inset: P()
      }],
      /**
       * Inset Inline
       * @see https://tailwindcss.com/docs/top-right-bottom-left
       */
      "inset-x": [{
        "inset-x": P()
      }],
      /**
       * Inset Block
       * @see https://tailwindcss.com/docs/top-right-bottom-left
       */
      "inset-y": [{
        "inset-y": P()
      }],
      /**
       * Inset Inline Start
       * @see https://tailwindcss.com/docs/top-right-bottom-left
       * @todo class group will be renamed to `inset-s` in next major release
       */
      start: [{
        "inset-s": P(),
        /**
         * @deprecated since Tailwind CSS v4.2.0 in favor of `inset-s-*` utilities.
         * @see https://github.com/tailwindlabs/tailwindcss/pull/19613
         */
        start: P()
      }],
      /**
       * Inset Inline End
       * @see https://tailwindcss.com/docs/top-right-bottom-left
       * @todo class group will be renamed to `inset-e` in next major release
       */
      end: [{
        "inset-e": P(),
        /**
         * @deprecated since Tailwind CSS v4.2.0 in favor of `inset-e-*` utilities.
         * @see https://github.com/tailwindlabs/tailwindcss/pull/19613
         */
        end: P()
      }],
      /**
       * Inset Block Start
       * @see https://tailwindcss.com/docs/top-right-bottom-left
       */
      "inset-bs": [{
        "inset-bs": P()
      }],
      /**
       * Inset Block End
       * @see https://tailwindcss.com/docs/top-right-bottom-left
       */
      "inset-be": [{
        "inset-be": P()
      }],
      /**
       * Top
       * @see https://tailwindcss.com/docs/top-right-bottom-left
       */
      top: [{
        top: P()
      }],
      /**
       * Right
       * @see https://tailwindcss.com/docs/top-right-bottom-left
       */
      right: [{
        right: P()
      }],
      /**
       * Bottom
       * @see https://tailwindcss.com/docs/top-right-bottom-left
       */
      bottom: [{
        bottom: P()
      }],
      /**
       * Left
       * @see https://tailwindcss.com/docs/top-right-bottom-left
       */
      left: [{
        left: P()
      }],
      /**
       * Visibility
       * @see https://tailwindcss.com/docs/visibility
       */
      visibility: ["visible", "invisible", "collapse"],
      /**
       * Z-Index
       * @see https://tailwindcss.com/docs/z-index
       */
      z: [{
        z: [He, "auto", j, V]
      }],
      // ------------------------
      // --- Flexbox and Grid ---
      // ------------------------
      /**
       * Flex Basis
       * @see https://tailwindcss.com/docs/flex-basis
       */
      basis: [{
        basis: [ft, "full", "auto", i, ...S()]
      }],
      /**
       * Flex Direction
       * @see https://tailwindcss.com/docs/flex-direction
       */
      "flex-direction": [{
        flex: ["row", "row-reverse", "col", "col-reverse"]
      }],
      /**
       * Flex Wrap
       * @see https://tailwindcss.com/docs/flex-wrap
       */
      "flex-wrap": [{
        flex: ["nowrap", "wrap", "wrap-reverse"]
      }],
      /**
       * Flex
       * @see https://tailwindcss.com/docs/flex
       */
      flex: [{
        flex: [Q, ft, "auto", "initial", "none", V]
      }],
      /**
       * Flex Grow
       * @see https://tailwindcss.com/docs/flex-grow
       */
      grow: [{
        grow: ["", Q, j, V]
      }],
      /**
       * Flex Shrink
       * @see https://tailwindcss.com/docs/flex-shrink
       */
      shrink: [{
        shrink: ["", Q, j, V]
      }],
      /**
       * Order
       * @see https://tailwindcss.com/docs/order
       */
      order: [{
        order: [He, "first", "last", "none", j, V]
      }],
      /**
       * Grid Template Columns
       * @see https://tailwindcss.com/docs/grid-template-columns
       */
      "grid-cols": [{
        "grid-cols": _()
      }],
      /**
       * Grid Column Start / End
       * @see https://tailwindcss.com/docs/grid-column
       */
      "col-start-end": [{
        col: M()
      }],
      /**
       * Grid Column Start
       * @see https://tailwindcss.com/docs/grid-column
       */
      "col-start": [{
        "col-start": A()
      }],
      /**
       * Grid Column End
       * @see https://tailwindcss.com/docs/grid-column
       */
      "col-end": [{
        "col-end": A()
      }],
      /**
       * Grid Template Rows
       * @see https://tailwindcss.com/docs/grid-template-rows
       */
      "grid-rows": [{
        "grid-rows": _()
      }],
      /**
       * Grid Row Start / End
       * @see https://tailwindcss.com/docs/grid-row
       */
      "row-start-end": [{
        row: M()
      }],
      /**
       * Grid Row Start
       * @see https://tailwindcss.com/docs/grid-row
       */
      "row-start": [{
        "row-start": A()
      }],
      /**
       * Grid Row End
       * @see https://tailwindcss.com/docs/grid-row
       */
      "row-end": [{
        "row-end": A()
      }],
      /**
       * Grid Auto Flow
       * @see https://tailwindcss.com/docs/grid-auto-flow
       */
      "grid-flow": [{
        "grid-flow": ["row", "col", "dense", "row-dense", "col-dense"]
      }],
      /**
       * Grid Auto Columns
       * @see https://tailwindcss.com/docs/grid-auto-columns
       */
      "auto-cols": [{
        "auto-cols": T()
      }],
      /**
       * Grid Auto Rows
       * @see https://tailwindcss.com/docs/grid-auto-rows
       */
      "auto-rows": [{
        "auto-rows": T()
      }],
      /**
       * Gap
       * @see https://tailwindcss.com/docs/gap
       */
      gap: [{
        gap: S()
      }],
      /**
       * Gap X
       * @see https://tailwindcss.com/docs/gap
       */
      "gap-x": [{
        "gap-x": S()
      }],
      /**
       * Gap Y
       * @see https://tailwindcss.com/docs/gap
       */
      "gap-y": [{
        "gap-y": S()
      }],
      /**
       * Justify Content
       * @see https://tailwindcss.com/docs/justify-content
       */
      "justify-content": [{
        justify: [...D(), "normal"]
      }],
      /**
       * Justify Items
       * @see https://tailwindcss.com/docs/justify-items
       */
      "justify-items": [{
        "justify-items": [...W(), "normal"]
      }],
      /**
       * Justify Self
       * @see https://tailwindcss.com/docs/justify-self
       */
      "justify-self": [{
        "justify-self": ["auto", ...W()]
      }],
      /**
       * Align Content
       * @see https://tailwindcss.com/docs/align-content
       */
      "align-content": [{
        content: ["normal", ...D()]
      }],
      /**
       * Align Items
       * @see https://tailwindcss.com/docs/align-items
       */
      "align-items": [{
        items: [...W(), {
          baseline: ["", "last"]
        }]
      }],
      /**
       * Align Self
       * @see https://tailwindcss.com/docs/align-self
       */
      "align-self": [{
        self: ["auto", ...W(), {
          baseline: ["", "last"]
        }]
      }],
      /**
       * Place Content
       * @see https://tailwindcss.com/docs/place-content
       */
      "place-content": [{
        "place-content": D()
      }],
      /**
       * Place Items
       * @see https://tailwindcss.com/docs/place-items
       */
      "place-items": [{
        "place-items": [...W(), "baseline"]
      }],
      /**
       * Place Self
       * @see https://tailwindcss.com/docs/place-self
       */
      "place-self": [{
        "place-self": ["auto", ...W()]
      }],
      // Spacing
      /**
       * Padding
       * @see https://tailwindcss.com/docs/padding
       */
      p: [{
        p: S()
      }],
      /**
       * Padding Inline
       * @see https://tailwindcss.com/docs/padding
       */
      px: [{
        px: S()
      }],
      /**
       * Padding Block
       * @see https://tailwindcss.com/docs/padding
       */
      py: [{
        py: S()
      }],
      /**
       * Padding Inline Start
       * @see https://tailwindcss.com/docs/padding
       */
      ps: [{
        ps: S()
      }],
      /**
       * Padding Inline End
       * @see https://tailwindcss.com/docs/padding
       */
      pe: [{
        pe: S()
      }],
      /**
       * Padding Block Start
       * @see https://tailwindcss.com/docs/padding
       */
      pbs: [{
        pbs: S()
      }],
      /**
       * Padding Block End
       * @see https://tailwindcss.com/docs/padding
       */
      pbe: [{
        pbe: S()
      }],
      /**
       * Padding Top
       * @see https://tailwindcss.com/docs/padding
       */
      pt: [{
        pt: S()
      }],
      /**
       * Padding Right
       * @see https://tailwindcss.com/docs/padding
       */
      pr: [{
        pr: S()
      }],
      /**
       * Padding Bottom
       * @see https://tailwindcss.com/docs/padding
       */
      pb: [{
        pb: S()
      }],
      /**
       * Padding Left
       * @see https://tailwindcss.com/docs/padding
       */
      pl: [{
        pl: S()
      }],
      /**
       * Margin
       * @see https://tailwindcss.com/docs/margin
       */
      m: [{
        m: $()
      }],
      /**
       * Margin Inline
       * @see https://tailwindcss.com/docs/margin
       */
      mx: [{
        mx: $()
      }],
      /**
       * Margin Block
       * @see https://tailwindcss.com/docs/margin
       */
      my: [{
        my: $()
      }],
      /**
       * Margin Inline Start
       * @see https://tailwindcss.com/docs/margin
       */
      ms: [{
        ms: $()
      }],
      /**
       * Margin Inline End
       * @see https://tailwindcss.com/docs/margin
       */
      me: [{
        me: $()
      }],
      /**
       * Margin Block Start
       * @see https://tailwindcss.com/docs/margin
       */
      mbs: [{
        mbs: $()
      }],
      /**
       * Margin Block End
       * @see https://tailwindcss.com/docs/margin
       */
      mbe: [{
        mbe: $()
      }],
      /**
       * Margin Top
       * @see https://tailwindcss.com/docs/margin
       */
      mt: [{
        mt: $()
      }],
      /**
       * Margin Right
       * @see https://tailwindcss.com/docs/margin
       */
      mr: [{
        mr: $()
      }],
      /**
       * Margin Bottom
       * @see https://tailwindcss.com/docs/margin
       */
      mb: [{
        mb: $()
      }],
      /**
       * Margin Left
       * @see https://tailwindcss.com/docs/margin
       */
      ml: [{
        ml: $()
      }],
      /**
       * Space Between X
       * @see https://tailwindcss.com/docs/margin#adding-space-between-children
       */
      "space-x": [{
        "space-x": S()
      }],
      /**
       * Space Between X Reverse
       * @see https://tailwindcss.com/docs/margin#adding-space-between-children
       */
      "space-x-reverse": ["space-x-reverse"],
      /**
       * Space Between Y
       * @see https://tailwindcss.com/docs/margin#adding-space-between-children
       */
      "space-y": [{
        "space-y": S()
      }],
      /**
       * Space Between Y Reverse
       * @see https://tailwindcss.com/docs/margin#adding-space-between-children
       */
      "space-y-reverse": ["space-y-reverse"],
      // --------------
      // --- Sizing ---
      // --------------
      /**
       * Size
       * @see https://tailwindcss.com/docs/width#setting-both-width-and-height
       */
      size: [{
        size: z()
      }],
      /**
       * Inline Size
       * @see https://tailwindcss.com/docs/inline-size
       */
      "inline-size": [{
        inline: ["auto", ...H()]
      }],
      /**
       * Min-Inline Size
       * @see https://tailwindcss.com/docs/min-inline-size
       */
      "min-inline-size": [{
        "min-inline": ["auto", ...H()]
      }],
      /**
       * Max-Inline Size
       * @see https://tailwindcss.com/docs/max-inline-size
       */
      "max-inline-size": [{
        "max-inline": ["none", ...H()]
      }],
      /**
       * Block Size
       * @see https://tailwindcss.com/docs/block-size
       */
      "block-size": [{
        block: ["auto", ...F()]
      }],
      /**
       * Min-Block Size
       * @see https://tailwindcss.com/docs/min-block-size
       */
      "min-block-size": [{
        "min-block": ["auto", ...F()]
      }],
      /**
       * Max-Block Size
       * @see https://tailwindcss.com/docs/max-block-size
       */
      "max-block-size": [{
        "max-block": ["none", ...F()]
      }],
      /**
       * Width
       * @see https://tailwindcss.com/docs/width
       */
      w: [{
        w: [i, "screen", ...z()]
      }],
      /**
       * Min-Width
       * @see https://tailwindcss.com/docs/min-width
       */
      "min-w": [{
        "min-w": [
          i,
          "screen",
          /** Deprecated. @see https://github.com/tailwindlabs/tailwindcss.com/issues/2027#issuecomment-2620152757 */
          "none",
          ...z()
        ]
      }],
      /**
       * Max-Width
       * @see https://tailwindcss.com/docs/max-width
       */
      "max-w": [{
        "max-w": [
          i,
          "screen",
          "none",
          /** Deprecated since Tailwind CSS v4.0.0. @see https://github.com/tailwindlabs/tailwindcss.com/issues/2027#issuecomment-2620152757 */
          "prose",
          /** Deprecated since Tailwind CSS v4.0.0. @see https://github.com/tailwindlabs/tailwindcss.com/issues/2027#issuecomment-2620152757 */
          {
            screen: [a]
          },
          ...z()
        ]
      }],
      /**
       * Height
       * @see https://tailwindcss.com/docs/height
       */
      h: [{
        h: ["screen", "lh", ...z()]
      }],
      /**
       * Min-Height
       * @see https://tailwindcss.com/docs/min-height
       */
      "min-h": [{
        "min-h": ["screen", "lh", "none", ...z()]
      }],
      /**
       * Max-Height
       * @see https://tailwindcss.com/docs/max-height
       */
      "max-h": [{
        "max-h": ["screen", "lh", "none", ...z()]
      }],
      // ------------------
      // --- Typography ---
      // ------------------
      /**
       * Font Size
       * @see https://tailwindcss.com/docs/font-size
       */
      "font-size": [{
        text: ["base", n, on, wt]
      }],
      /**
       * Font Smoothing
       * @see https://tailwindcss.com/docs/font-smoothing
       */
      "font-smoothing": ["antialiased", "subpixel-antialiased"],
      /**
       * Font Style
       * @see https://tailwindcss.com/docs/font-style
       */
      "font-style": ["italic", "not-italic"],
      /**
       * Font Weight
       * @see https://tailwindcss.com/docs/font-weight
       */
      "font-weight": [{
        font: [r, Uu, zu]
      }],
      /**
       * Font Stretch
       * @see https://tailwindcss.com/docs/font-stretch
       */
      "font-stretch": [{
        "font-stretch": ["ultra-condensed", "extra-condensed", "condensed", "semi-condensed", "normal", "semi-expanded", "expanded", "extra-expanded", "ultra-expanded", yr, V]
      }],
      /**
       * Font Family
       * @see https://tailwindcss.com/docs/font-family
       */
      "font-family": [{
        font: [ju, Bu, t]
      }],
      /**
       * Font Feature Settings
       * @see https://tailwindcss.com/docs/font-feature-settings
       */
      "font-features": [{
        "font-features": [V]
      }],
      /**
       * Font Variant Numeric
       * @see https://tailwindcss.com/docs/font-variant-numeric
       */
      "fvn-normal": ["normal-nums"],
      /**
       * Font Variant Numeric
       * @see https://tailwindcss.com/docs/font-variant-numeric
       */
      "fvn-ordinal": ["ordinal"],
      /**
       * Font Variant Numeric
       * @see https://tailwindcss.com/docs/font-variant-numeric
       */
      "fvn-slashed-zero": ["slashed-zero"],
      /**
       * Font Variant Numeric
       * @see https://tailwindcss.com/docs/font-variant-numeric
       */
      "fvn-figure": ["lining-nums", "oldstyle-nums"],
      /**
       * Font Variant Numeric
       * @see https://tailwindcss.com/docs/font-variant-numeric
       */
      "fvn-spacing": ["proportional-nums", "tabular-nums"],
      /**
       * Font Variant Numeric
       * @see https://tailwindcss.com/docs/font-variant-numeric
       */
      "fvn-fraction": ["diagonal-fractions", "stacked-fractions"],
      /**
       * Letter Spacing
       * @see https://tailwindcss.com/docs/letter-spacing
       */
      tracking: [{
        tracking: [o, j, V]
      }],
      /**
       * Line Clamp
       * @see https://tailwindcss.com/docs/line-clamp
       */
      "line-clamp": [{
        "line-clamp": [Q, "none", j, Rs]
      }],
      /**
       * Line Height
       * @see https://tailwindcss.com/docs/line-height
       */
      leading: [{
        leading: [
          "none",
          /** Deprecated since Tailwind CSS v4.0.0. @see https://github.com/tailwindlabs/tailwindcss.com/issues/2027#issuecomment-2620152757 */
          s,
          ...S()
        ]
      }],
      /**
       * List Style Image
       * @see https://tailwindcss.com/docs/list-style-image
       */
      "list-image": [{
        "list-image": ["none", j, V]
      }],
      /**
       * List Style Position
       * @see https://tailwindcss.com/docs/list-style-position
       */
      "list-style-position": [{
        list: ["inside", "outside"]
      }],
      /**
       * List Style Type
       * @see https://tailwindcss.com/docs/list-style-type
       */
      "list-style-type": [{
        list: ["disc", "decimal", "none", j, V]
      }],
      /**
       * Text Alignment
       * @see https://tailwindcss.com/docs/text-align
       */
      "text-alignment": [{
        text: ["left", "center", "right", "justify", "start", "end"]
      }],
      /**
       * Placeholder Color
       * @deprecated since Tailwind CSS v3.0.0
       * @see https://v3.tailwindcss.com/docs/placeholder-color
       */
      "placeholder-color": [{
        placeholder: L()
      }],
      /**
       * Text Color
       * @see https://tailwindcss.com/docs/text-color
       */
      "text-color": [{
        text: L()
      }],
      /**
       * Text Decoration
       * @see https://tailwindcss.com/docs/text-decoration
       */
      "text-decoration": ["underline", "overline", "line-through", "no-underline"],
      /**
       * Text Decoration Style
       * @see https://tailwindcss.com/docs/text-decoration-style
       */
      "text-decoration-style": [{
        decoration: [...ae(), "wavy"]
      }],
      /**
       * Text Decoration Thickness
       * @see https://tailwindcss.com/docs/text-decoration-thickness
       */
      "text-decoration-thickness": [{
        decoration: [Q, "from-font", "auto", j, wt]
      }],
      /**
       * Text Decoration Color
       * @see https://tailwindcss.com/docs/text-decoration-color
       */
      "text-decoration-color": [{
        decoration: L()
      }],
      /**
       * Text Underline Offset
       * @see https://tailwindcss.com/docs/text-underline-offset
       */
      "underline-offset": [{
        "underline-offset": [Q, "auto", j, V]
      }],
      /**
       * Text Transform
       * @see https://tailwindcss.com/docs/text-transform
       */
      "text-transform": ["uppercase", "lowercase", "capitalize", "normal-case"],
      /**
       * Text Overflow
       * @see https://tailwindcss.com/docs/text-overflow
       */
      "text-overflow": ["truncate", "text-ellipsis", "text-clip"],
      /**
       * Text Wrap
       * @see https://tailwindcss.com/docs/text-wrap
       */
      "text-wrap": [{
        text: ["wrap", "nowrap", "balance", "pretty"]
      }],
      /**
       * Text Indent
       * @see https://tailwindcss.com/docs/text-indent
       */
      indent: [{
        indent: S()
      }],
      /**
       * Tab Size
       * @see https://tailwindcss.com/docs/tab-size
       */
      "tab-size": [{
        tab: [He, j, V]
      }],
      /**
       * Vertical Alignment
       * @see https://tailwindcss.com/docs/vertical-align
       */
      "vertical-align": [{
        align: ["baseline", "top", "middle", "bottom", "text-top", "text-bottom", "sub", "super", j, V]
      }],
      /**
       * Whitespace
       * @see https://tailwindcss.com/docs/whitespace
       */
      whitespace: [{
        whitespace: ["normal", "nowrap", "pre", "pre-line", "pre-wrap", "break-spaces"]
      }],
      /**
       * Word Break
       * @see https://tailwindcss.com/docs/word-break
       */
      break: [{
        break: ["normal", "words", "all", "keep"]
      }],
      /**
       * Overflow Wrap
       * @see https://tailwindcss.com/docs/overflow-wrap
       */
      wrap: [{
        wrap: ["break-word", "anywhere", "normal"]
      }],
      /**
       * Hyphens
       * @see https://tailwindcss.com/docs/hyphens
       */
      hyphens: [{
        hyphens: ["none", "manual", "auto"]
      }],
      /**
       * Content
       * @see https://tailwindcss.com/docs/content
       */
      content: [{
        content: ["none", j, V]
      }],
      // -------------------
      // --- Backgrounds ---
      // -------------------
      /**
       * Background Attachment
       * @see https://tailwindcss.com/docs/background-attachment
       */
      "bg-attachment": [{
        bg: ["fixed", "local", "scroll"]
      }],
      /**
       * Background Clip
       * @see https://tailwindcss.com/docs/background-clip
       */
      "bg-clip": [{
        "bg-clip": ["border", "padding", "content", "text"]
      }],
      /**
       * Background Origin
       * @see https://tailwindcss.com/docs/background-origin
       */
      "bg-origin": [{
        "bg-origin": ["border", "padding", "content"]
      }],
      /**
       * Background Position
       * @see https://tailwindcss.com/docs/background-position
       */
      "bg-position": [{
        bg: ie()
      }],
      /**
       * Background Repeat
       * @see https://tailwindcss.com/docs/background-repeat
       */
      "bg-repeat": [{
        bg: J()
      }],
      /**
       * Background Size
       * @see https://tailwindcss.com/docs/background-size
       */
      "bg-size": [{
        bg: se()
      }],
      /**
       * Background Image
       * @see https://tailwindcss.com/docs/background-image
       */
      "bg-image": [{
        bg: ["none", {
          linear: [{
            to: ["t", "tr", "r", "br", "b", "bl", "l", "tl"]
          }, He, j, V],
          radial: ["", j, V],
          conic: ["", He, j, V]
        }, Wu, Vu]
      }],
      /**
       * Background Color
       * @see https://tailwindcss.com/docs/background-color
       */
      "bg-color": [{
        bg: L()
      }],
      /**
       * Gradient Color Stops From Position
       * @see https://tailwindcss.com/docs/gradient-color-stops
       */
      "gradient-from-pos": [{
        from: X()
      }],
      /**
       * Gradient Color Stops Via Position
       * @see https://tailwindcss.com/docs/gradient-color-stops
       */
      "gradient-via-pos": [{
        via: X()
      }],
      /**
       * Gradient Color Stops To Position
       * @see https://tailwindcss.com/docs/gradient-color-stops
       */
      "gradient-to-pos": [{
        to: X()
      }],
      /**
       * Gradient Color Stops From
       * @see https://tailwindcss.com/docs/gradient-color-stops
       */
      "gradient-from": [{
        from: L()
      }],
      /**
       * Gradient Color Stops Via
       * @see https://tailwindcss.com/docs/gradient-color-stops
       */
      "gradient-via": [{
        via: L()
      }],
      /**
       * Gradient Color Stops To
       * @see https://tailwindcss.com/docs/gradient-color-stops
       */
      "gradient-to": [{
        to: L()
      }],
      // ---------------
      // --- Borders ---
      // ---------------
      /**
       * Border Radius
       * @see https://tailwindcss.com/docs/border-radius
       */
      rounded: [{
        rounded: K()
      }],
      /**
       * Border Radius Start
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-s": [{
        "rounded-s": K()
      }],
      /**
       * Border Radius End
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-e": [{
        "rounded-e": K()
      }],
      /**
       * Border Radius Top
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-t": [{
        "rounded-t": K()
      }],
      /**
       * Border Radius Right
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-r": [{
        "rounded-r": K()
      }],
      /**
       * Border Radius Bottom
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-b": [{
        "rounded-b": K()
      }],
      /**
       * Border Radius Left
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-l": [{
        "rounded-l": K()
      }],
      /**
       * Border Radius Start Start
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-ss": [{
        "rounded-ss": K()
      }],
      /**
       * Border Radius Start End
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-se": [{
        "rounded-se": K()
      }],
      /**
       * Border Radius End End
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-ee": [{
        "rounded-ee": K()
      }],
      /**
       * Border Radius End Start
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-es": [{
        "rounded-es": K()
      }],
      /**
       * Border Radius Top Left
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-tl": [{
        "rounded-tl": K()
      }],
      /**
       * Border Radius Top Right
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-tr": [{
        "rounded-tr": K()
      }],
      /**
       * Border Radius Bottom Right
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-br": [{
        "rounded-br": K()
      }],
      /**
       * Border Radius Bottom Left
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-bl": [{
        "rounded-bl": K()
      }],
      /**
       * Border Width
       * @see https://tailwindcss.com/docs/border-width
       */
      "border-w": [{
        border: U()
      }],
      /**
       * Border Width Inline
       * @see https://tailwindcss.com/docs/border-width
       */
      "border-w-x": [{
        "border-x": U()
      }],
      /**
       * Border Width Block
       * @see https://tailwindcss.com/docs/border-width
       */
      "border-w-y": [{
        "border-y": U()
      }],
      /**
       * Border Width Inline Start
       * @see https://tailwindcss.com/docs/border-width
       */
      "border-w-s": [{
        "border-s": U()
      }],
      /**
       * Border Width Inline End
       * @see https://tailwindcss.com/docs/border-width
       */
      "border-w-e": [{
        "border-e": U()
      }],
      /**
       * Border Width Block Start
       * @see https://tailwindcss.com/docs/border-width
       */
      "border-w-bs": [{
        "border-bs": U()
      }],
      /**
       * Border Width Block End
       * @see https://tailwindcss.com/docs/border-width
       */
      "border-w-be": [{
        "border-be": U()
      }],
      /**
       * Border Width Top
       * @see https://tailwindcss.com/docs/border-width
       */
      "border-w-t": [{
        "border-t": U()
      }],
      /**
       * Border Width Right
       * @see https://tailwindcss.com/docs/border-width
       */
      "border-w-r": [{
        "border-r": U()
      }],
      /**
       * Border Width Bottom
       * @see https://tailwindcss.com/docs/border-width
       */
      "border-w-b": [{
        "border-b": U()
      }],
      /**
       * Border Width Left
       * @see https://tailwindcss.com/docs/border-width
       */
      "border-w-l": [{
        "border-l": U()
      }],
      /**
       * Divide Width X
       * @see https://tailwindcss.com/docs/border-width#between-children
       */
      "divide-x": [{
        "divide-x": U()
      }],
      /**
       * Divide Width X Reverse
       * @see https://tailwindcss.com/docs/border-width#between-children
       */
      "divide-x-reverse": ["divide-x-reverse"],
      /**
       * Divide Width Y
       * @see https://tailwindcss.com/docs/border-width#between-children
       */
      "divide-y": [{
        "divide-y": U()
      }],
      /**
       * Divide Width Y Reverse
       * @see https://tailwindcss.com/docs/border-width#between-children
       */
      "divide-y-reverse": ["divide-y-reverse"],
      /**
       * Border Style
       * @see https://tailwindcss.com/docs/border-style
       */
      "border-style": [{
        border: [...ae(), "hidden", "none"]
      }],
      /**
       * Divide Style
       * @see https://tailwindcss.com/docs/border-style#setting-the-divider-style
       */
      "divide-style": [{
        divide: [...ae(), "hidden", "none"]
      }],
      /**
       * Border Color
       * @see https://tailwindcss.com/docs/border-color
       */
      "border-color": [{
        border: L()
      }],
      /**
       * Border Color Inline
       * @see https://tailwindcss.com/docs/border-color
       */
      "border-color-x": [{
        "border-x": L()
      }],
      /**
       * Border Color Block
       * @see https://tailwindcss.com/docs/border-color
       */
      "border-color-y": [{
        "border-y": L()
      }],
      /**
       * Border Color Inline Start
       * @see https://tailwindcss.com/docs/border-color
       */
      "border-color-s": [{
        "border-s": L()
      }],
      /**
       * Border Color Inline End
       * @see https://tailwindcss.com/docs/border-color
       */
      "border-color-e": [{
        "border-e": L()
      }],
      /**
       * Border Color Block Start
       * @see https://tailwindcss.com/docs/border-color
       */
      "border-color-bs": [{
        "border-bs": L()
      }],
      /**
       * Border Color Block End
       * @see https://tailwindcss.com/docs/border-color
       */
      "border-color-be": [{
        "border-be": L()
      }],
      /**
       * Border Color Top
       * @see https://tailwindcss.com/docs/border-color
       */
      "border-color-t": [{
        "border-t": L()
      }],
      /**
       * Border Color Right
       * @see https://tailwindcss.com/docs/border-color
       */
      "border-color-r": [{
        "border-r": L()
      }],
      /**
       * Border Color Bottom
       * @see https://tailwindcss.com/docs/border-color
       */
      "border-color-b": [{
        "border-b": L()
      }],
      /**
       * Border Color Left
       * @see https://tailwindcss.com/docs/border-color
       */
      "border-color-l": [{
        "border-l": L()
      }],
      /**
       * Divide Color
       * @see https://tailwindcss.com/docs/divide-color
       */
      "divide-color": [{
        divide: L()
      }],
      /**
       * Outline Style
       * @see https://tailwindcss.com/docs/outline-style
       */
      "outline-style": [{
        outline: [...ae(), "none", "hidden"]
      }],
      /**
       * Outline Offset
       * @see https://tailwindcss.com/docs/outline-offset
       */
      "outline-offset": [{
        "outline-offset": [Q, j, V]
      }],
      /**
       * Outline Width
       * @see https://tailwindcss.com/docs/outline-width
       */
      "outline-w": [{
        outline: ["", Q, on, wt]
      }],
      /**
       * Outline Color
       * @see https://tailwindcss.com/docs/outline-color
       */
      "outline-color": [{
        outline: L()
      }],
      // ---------------
      // --- Effects ---
      // ---------------
      /**
       * Box Shadow
       * @see https://tailwindcss.com/docs/box-shadow
       */
      shadow: [{
        shadow: [
          // Deprecated since Tailwind CSS v4.0.0
          "",
          // Deprecated since Tailwind CSS v4.0.0
          "inner",
          "none",
          m,
          kn,
          Sn
        ]
      }],
      /**
       * Box Shadow Color
       * @see https://tailwindcss.com/docs/box-shadow#setting-the-shadow-color
       */
      "shadow-color": [{
        shadow: L()
      }],
      /**
       * Inset Box Shadow
       * @see https://tailwindcss.com/docs/box-shadow#adding-an-inset-shadow
       */
      "inset-shadow": [{
        "inset-shadow": ["none", l, kn, Sn]
      }],
      /**
       * Inset Box Shadow Color
       * @see https://tailwindcss.com/docs/box-shadow#setting-the-inset-shadow-color
       */
      "inset-shadow-color": [{
        "inset-shadow": L()
      }],
      /**
       * Ring Width
       * @see https://tailwindcss.com/docs/box-shadow#adding-a-ring
       */
      "ring-w": [{
        ring: U()
      }],
      /**
       * Ring Width Inset
       * @see https://v3.tailwindcss.com/docs/ring-width#inset-rings
       * @deprecated since Tailwind CSS v4.0.0
       * @see https://github.com/tailwindlabs/tailwindcss/blob/v4.0.0/packages/tailwindcss/src/utilities.ts#L4158
       */
      "ring-w-inset": ["ring-inset"],
      /**
       * Ring Color
       * @see https://tailwindcss.com/docs/box-shadow#setting-the-ring-color
       */
      "ring-color": [{
        ring: L()
      }],
      /**
       * Ring Offset Width
       * @see https://v3.tailwindcss.com/docs/ring-offset-width
       * @deprecated since Tailwind CSS v4.0.0
       * @see https://github.com/tailwindlabs/tailwindcss/blob/v4.0.0/packages/tailwindcss/src/utilities.ts#L4158
       */
      "ring-offset-w": [{
        "ring-offset": [Q, wt]
      }],
      /**
       * Ring Offset Color
       * @see https://v3.tailwindcss.com/docs/ring-offset-color
       * @deprecated since Tailwind CSS v4.0.0
       * @see https://github.com/tailwindlabs/tailwindcss/blob/v4.0.0/packages/tailwindcss/src/utilities.ts#L4158
       */
      "ring-offset-color": [{
        "ring-offset": L()
      }],
      /**
       * Inset Ring Width
       * @see https://tailwindcss.com/docs/box-shadow#adding-an-inset-ring
       */
      "inset-ring-w": [{
        "inset-ring": U()
      }],
      /**
       * Inset Ring Color
       * @see https://tailwindcss.com/docs/box-shadow#setting-the-inset-ring-color
       */
      "inset-ring-color": [{
        "inset-ring": L()
      }],
      /**
       * Text Shadow
       * @see https://tailwindcss.com/docs/text-shadow
       */
      "text-shadow": [{
        "text-shadow": ["none", p, kn, Sn]
      }],
      /**
       * Text Shadow Color
       * @see https://tailwindcss.com/docs/text-shadow#setting-the-shadow-color
       */
      "text-shadow-color": [{
        "text-shadow": L()
      }],
      /**
       * Opacity
       * @see https://tailwindcss.com/docs/opacity
       */
      opacity: [{
        opacity: [Q, j, V]
      }],
      /**
       * Mix Blend Mode
       * @see https://tailwindcss.com/docs/mix-blend-mode
       */
      "mix-blend": [{
        "mix-blend": [...G(), "plus-darker", "plus-lighter"]
      }],
      /**
       * Background Blend Mode
       * @see https://tailwindcss.com/docs/background-blend-mode
       */
      "bg-blend": [{
        "bg-blend": G()
      }],
      /**
       * Mask Clip
       * @see https://tailwindcss.com/docs/mask-clip
       */
      "mask-clip": [{
        "mask-clip": ["border", "padding", "content", "fill", "stroke", "view"]
      }, "mask-no-clip"],
      /**
       * Mask Composite
       * @see https://tailwindcss.com/docs/mask-composite
       */
      "mask-composite": [{
        mask: ["add", "subtract", "intersect", "exclude"]
      }],
      /**
       * Mask Image
       * @see https://tailwindcss.com/docs/mask-image
       */
      "mask-image-linear-pos": [{
        "mask-linear": [Q]
      }],
      "mask-image-linear-from-pos": [{
        "mask-linear-from": B()
      }],
      "mask-image-linear-to-pos": [{
        "mask-linear-to": B()
      }],
      "mask-image-linear-from-color": [{
        "mask-linear-from": L()
      }],
      "mask-image-linear-to-color": [{
        "mask-linear-to": L()
      }],
      "mask-image-t-from-pos": [{
        "mask-t-from": B()
      }],
      "mask-image-t-to-pos": [{
        "mask-t-to": B()
      }],
      "mask-image-t-from-color": [{
        "mask-t-from": L()
      }],
      "mask-image-t-to-color": [{
        "mask-t-to": L()
      }],
      "mask-image-r-from-pos": [{
        "mask-r-from": B()
      }],
      "mask-image-r-to-pos": [{
        "mask-r-to": B()
      }],
      "mask-image-r-from-color": [{
        "mask-r-from": L()
      }],
      "mask-image-r-to-color": [{
        "mask-r-to": L()
      }],
      "mask-image-b-from-pos": [{
        "mask-b-from": B()
      }],
      "mask-image-b-to-pos": [{
        "mask-b-to": B()
      }],
      "mask-image-b-from-color": [{
        "mask-b-from": L()
      }],
      "mask-image-b-to-color": [{
        "mask-b-to": L()
      }],
      "mask-image-l-from-pos": [{
        "mask-l-from": B()
      }],
      "mask-image-l-to-pos": [{
        "mask-l-to": B()
      }],
      "mask-image-l-from-color": [{
        "mask-l-from": L()
      }],
      "mask-image-l-to-color": [{
        "mask-l-to": L()
      }],
      "mask-image-x-from-pos": [{
        "mask-x-from": B()
      }],
      "mask-image-x-to-pos": [{
        "mask-x-to": B()
      }],
      "mask-image-x-from-color": [{
        "mask-x-from": L()
      }],
      "mask-image-x-to-color": [{
        "mask-x-to": L()
      }],
      "mask-image-y-from-pos": [{
        "mask-y-from": B()
      }],
      "mask-image-y-to-pos": [{
        "mask-y-to": B()
      }],
      "mask-image-y-from-color": [{
        "mask-y-from": L()
      }],
      "mask-image-y-to-color": [{
        "mask-y-to": L()
      }],
      "mask-image-radial": [{
        "mask-radial": [j, V]
      }],
      "mask-image-radial-from-pos": [{
        "mask-radial-from": B()
      }],
      "mask-image-radial-to-pos": [{
        "mask-radial-to": B()
      }],
      "mask-image-radial-from-color": [{
        "mask-radial-from": L()
      }],
      "mask-image-radial-to-color": [{
        "mask-radial-to": L()
      }],
      "mask-image-radial-shape": [{
        "mask-radial": ["circle", "ellipse"]
      }],
      "mask-image-radial-size": [{
        "mask-radial": [{
          closest: ["side", "corner"],
          farthest: ["side", "corner"]
        }]
      }],
      "mask-image-radial-pos": [{
        "mask-radial-at": x()
      }],
      "mask-image-conic-pos": [{
        "mask-conic": [Q]
      }],
      "mask-image-conic-from-pos": [{
        "mask-conic-from": B()
      }],
      "mask-image-conic-to-pos": [{
        "mask-conic-to": B()
      }],
      "mask-image-conic-from-color": [{
        "mask-conic-from": L()
      }],
      "mask-image-conic-to-color": [{
        "mask-conic-to": L()
      }],
      /**
       * Mask Mode
       * @see https://tailwindcss.com/docs/mask-mode
       */
      "mask-mode": [{
        mask: ["alpha", "luminance", "match"]
      }],
      /**
       * Mask Origin
       * @see https://tailwindcss.com/docs/mask-origin
       */
      "mask-origin": [{
        "mask-origin": ["border", "padding", "content", "fill", "stroke", "view"]
      }],
      /**
       * Mask Position
       * @see https://tailwindcss.com/docs/mask-position
       */
      "mask-position": [{
        mask: ie()
      }],
      /**
       * Mask Repeat
       * @see https://tailwindcss.com/docs/mask-repeat
       */
      "mask-repeat": [{
        mask: J()
      }],
      /**
       * Mask Size
       * @see https://tailwindcss.com/docs/mask-size
       */
      "mask-size": [{
        mask: se()
      }],
      /**
       * Mask Type
       * @see https://tailwindcss.com/docs/mask-type
       */
      "mask-type": [{
        "mask-type": ["alpha", "luminance"]
      }],
      /**
       * Mask Image
       * @see https://tailwindcss.com/docs/mask-image
       */
      "mask-image": [{
        mask: ["none", j, V]
      }],
      // ---------------
      // --- Filters ---
      // ---------------
      /**
       * Filter
       * @see https://tailwindcss.com/docs/filter
       */
      filter: [{
        filter: [
          // Deprecated since Tailwind CSS v3.0.0
          "",
          "none",
          j,
          V
        ]
      }],
      /**
       * Blur
       * @see https://tailwindcss.com/docs/blur
       */
      blur: [{
        blur: ce()
      }],
      /**
       * Brightness
       * @see https://tailwindcss.com/docs/brightness
       */
      brightness: [{
        brightness: [Q, j, V]
      }],
      /**
       * Contrast
       * @see https://tailwindcss.com/docs/contrast
       */
      contrast: [{
        contrast: [Q, j, V]
      }],
      /**
       * Drop Shadow
       * @see https://tailwindcss.com/docs/drop-shadow
       */
      "drop-shadow": [{
        "drop-shadow": [
          // Deprecated since Tailwind CSS v4.0.0
          "",
          "none",
          h,
          kn,
          Sn
        ]
      }],
      /**
       * Drop Shadow Color
       * @see https://tailwindcss.com/docs/filter-drop-shadow#setting-the-shadow-color
       */
      "drop-shadow-color": [{
        "drop-shadow": L()
      }],
      /**
       * Grayscale
       * @see https://tailwindcss.com/docs/grayscale
       */
      grayscale: [{
        grayscale: ["", Q, j, V]
      }],
      /**
       * Hue Rotate
       * @see https://tailwindcss.com/docs/hue-rotate
       */
      "hue-rotate": [{
        "hue-rotate": [Q, j, V]
      }],
      /**
       * Invert
       * @see https://tailwindcss.com/docs/invert
       */
      invert: [{
        invert: ["", Q, j, V]
      }],
      /**
       * Saturate
       * @see https://tailwindcss.com/docs/saturate
       */
      saturate: [{
        saturate: [Q, j, V]
      }],
      /**
       * Sepia
       * @see https://tailwindcss.com/docs/sepia
       */
      sepia: [{
        sepia: ["", Q, j, V]
      }],
      /**
       * Backdrop Filter
       * @see https://tailwindcss.com/docs/backdrop-filter
       */
      "backdrop-filter": [{
        "backdrop-filter": [
          // Deprecated since Tailwind CSS v3.0.0
          "",
          "none",
          j,
          V
        ]
      }],
      /**
       * Backdrop Blur
       * @see https://tailwindcss.com/docs/backdrop-blur
       */
      "backdrop-blur": [{
        "backdrop-blur": ce()
      }],
      /**
       * Backdrop Brightness
       * @see https://tailwindcss.com/docs/backdrop-brightness
       */
      "backdrop-brightness": [{
        "backdrop-brightness": [Q, j, V]
      }],
      /**
       * Backdrop Contrast
       * @see https://tailwindcss.com/docs/backdrop-contrast
       */
      "backdrop-contrast": [{
        "backdrop-contrast": [Q, j, V]
      }],
      /**
       * Backdrop Grayscale
       * @see https://tailwindcss.com/docs/backdrop-grayscale
       */
      "backdrop-grayscale": [{
        "backdrop-grayscale": ["", Q, j, V]
      }],
      /**
       * Backdrop Hue Rotate
       * @see https://tailwindcss.com/docs/backdrop-hue-rotate
       */
      "backdrop-hue-rotate": [{
        "backdrop-hue-rotate": [Q, j, V]
      }],
      /**
       * Backdrop Invert
       * @see https://tailwindcss.com/docs/backdrop-invert
       */
      "backdrop-invert": [{
        "backdrop-invert": ["", Q, j, V]
      }],
      /**
       * Backdrop Opacity
       * @see https://tailwindcss.com/docs/backdrop-opacity
       */
      "backdrop-opacity": [{
        "backdrop-opacity": [Q, j, V]
      }],
      /**
       * Backdrop Saturate
       * @see https://tailwindcss.com/docs/backdrop-saturate
       */
      "backdrop-saturate": [{
        "backdrop-saturate": [Q, j, V]
      }],
      /**
       * Backdrop Sepia
       * @see https://tailwindcss.com/docs/backdrop-sepia
       */
      "backdrop-sepia": [{
        "backdrop-sepia": ["", Q, j, V]
      }],
      // --------------
      // --- Tables ---
      // --------------
      /**
       * Border Collapse
       * @see https://tailwindcss.com/docs/border-collapse
       */
      "border-collapse": [{
        border: ["collapse", "separate"]
      }],
      /**
       * Border Spacing
       * @see https://tailwindcss.com/docs/border-spacing
       */
      "border-spacing": [{
        "border-spacing": S()
      }],
      /**
       * Border Spacing X
       * @see https://tailwindcss.com/docs/border-spacing
       */
      "border-spacing-x": [{
        "border-spacing-x": S()
      }],
      /**
       * Border Spacing Y
       * @see https://tailwindcss.com/docs/border-spacing
       */
      "border-spacing-y": [{
        "border-spacing-y": S()
      }],
      /**
       * Table Layout
       * @see https://tailwindcss.com/docs/table-layout
       */
      "table-layout": [{
        table: ["auto", "fixed"]
      }],
      /**
       * Caption Side
       * @see https://tailwindcss.com/docs/caption-side
       */
      caption: [{
        caption: ["top", "bottom"]
      }],
      // ---------------------------------
      // --- Transitions and Animation ---
      // ---------------------------------
      /**
       * Transition Property
       * @see https://tailwindcss.com/docs/transition-property
       */
      transition: [{
        transition: ["", "all", "colors", "opacity", "shadow", "transform", "none", j, V]
      }],
      /**
       * Transition Behavior
       * @see https://tailwindcss.com/docs/transition-behavior
       */
      "transition-behavior": [{
        transition: ["normal", "discrete"]
      }],
      /**
       * Transition Duration
       * @see https://tailwindcss.com/docs/transition-duration
       */
      duration: [{
        duration: [Q, "initial", j, V]
      }],
      /**
       * Transition Timing Function
       * @see https://tailwindcss.com/docs/transition-timing-function
       */
      ease: [{
        ease: ["linear", "initial", y, j, V]
      }],
      /**
       * Transition Delay
       * @see https://tailwindcss.com/docs/transition-delay
       */
      delay: [{
        delay: [Q, j, V]
      }],
      /**
       * Animation
       * @see https://tailwindcss.com/docs/animation
       */
      animate: [{
        animate: ["none", C, j, V]
      }],
      // ------------------
      // --- Transforms ---
      // ------------------
      /**
       * Backface Visibility
       * @see https://tailwindcss.com/docs/backface-visibility
       */
      backface: [{
        backface: ["hidden", "visible"]
      }],
      /**
       * Perspective
       * @see https://tailwindcss.com/docs/perspective
       */
      perspective: [{
        perspective: [v, j, V]
      }],
      /**
       * Perspective Origin
       * @see https://tailwindcss.com/docs/perspective-origin
       */
      "perspective-origin": [{
        "perspective-origin": E()
      }],
      /**
       * Rotate
       * @see https://tailwindcss.com/docs/rotate
       */
      rotate: [{
        rotate: te()
      }],
      /**
       * Rotate X
       * @see https://tailwindcss.com/docs/rotate
       */
      "rotate-x": [{
        "rotate-x": te()
      }],
      /**
       * Rotate Y
       * @see https://tailwindcss.com/docs/rotate
       */
      "rotate-y": [{
        "rotate-y": te()
      }],
      /**
       * Rotate Z
       * @see https://tailwindcss.com/docs/rotate
       */
      "rotate-z": [{
        "rotate-z": te()
      }],
      /**
       * Scale
       * @see https://tailwindcss.com/docs/scale
       */
      scale: [{
        scale: ne()
      }],
      /**
       * Scale X
       * @see https://tailwindcss.com/docs/scale
       */
      "scale-x": [{
        "scale-x": ne()
      }],
      /**
       * Scale Y
       * @see https://tailwindcss.com/docs/scale
       */
      "scale-y": [{
        "scale-y": ne()
      }],
      /**
       * Scale Z
       * @see https://tailwindcss.com/docs/scale
       */
      "scale-z": [{
        "scale-z": ne()
      }],
      /**
       * Scale 3D
       * @see https://tailwindcss.com/docs/scale
       */
      "scale-3d": ["scale-3d"],
      /**
       * Skew
       * @see https://tailwindcss.com/docs/skew
       */
      skew: [{
        skew: oe()
      }],
      /**
       * Skew X
       * @see https://tailwindcss.com/docs/skew
       */
      "skew-x": [{
        "skew-x": oe()
      }],
      /**
       * Skew Y
       * @see https://tailwindcss.com/docs/skew
       */
      "skew-y": [{
        "skew-y": oe()
      }],
      /**
       * Transform
       * @see https://tailwindcss.com/docs/transform
       */
      transform: [{
        transform: [j, V, "", "none", "gpu", "cpu"]
      }],
      /**
       * Transform Origin
       * @see https://tailwindcss.com/docs/transform-origin
       */
      "transform-origin": [{
        origin: E()
      }],
      /**
       * Transform Style
       * @see https://tailwindcss.com/docs/transform-style
       */
      "transform-style": [{
        transform: ["3d", "flat"]
      }],
      /**
       * Translate
       * @see https://tailwindcss.com/docs/translate
       */
      translate: [{
        translate: me()
      }],
      /**
       * Translate X
       * @see https://tailwindcss.com/docs/translate
       */
      "translate-x": [{
        "translate-x": me()
      }],
      /**
       * Translate Y
       * @see https://tailwindcss.com/docs/translate
       */
      "translate-y": [{
        "translate-y": me()
      }],
      /**
       * Translate Z
       * @see https://tailwindcss.com/docs/translate
       */
      "translate-z": [{
        "translate-z": me()
      }],
      /**
       * Translate None
       * @see https://tailwindcss.com/docs/translate
       */
      "translate-none": ["translate-none"],
      /**
       * Zoom
       * @see https://tailwindcss.com/docs/zoom
       */
      zoom: [{
        zoom: [He, j, V]
      }],
      // ---------------------
      // --- Interactivity ---
      // ---------------------
      /**
       * Accent Color
       * @see https://tailwindcss.com/docs/accent-color
       */
      accent: [{
        accent: L()
      }],
      /**
       * Appearance
       * @see https://tailwindcss.com/docs/appearance
       */
      appearance: [{
        appearance: ["none", "auto"]
      }],
      /**
       * Caret Color
       * @see https://tailwindcss.com/docs/just-in-time-mode#caret-color-utilities
       */
      "caret-color": [{
        caret: L()
      }],
      /**
       * Color Scheme
       * @see https://tailwindcss.com/docs/color-scheme
       */
      "color-scheme": [{
        scheme: ["normal", "dark", "light", "light-dark", "only-dark", "only-light"]
      }],
      /**
       * Cursor
       * @see https://tailwindcss.com/docs/cursor
       */
      cursor: [{
        cursor: ["auto", "default", "pointer", "wait", "text", "move", "help", "not-allowed", "none", "context-menu", "progress", "cell", "crosshair", "vertical-text", "alias", "copy", "no-drop", "grab", "grabbing", "all-scroll", "col-resize", "row-resize", "n-resize", "e-resize", "s-resize", "w-resize", "ne-resize", "nw-resize", "se-resize", "sw-resize", "ew-resize", "ns-resize", "nesw-resize", "nwse-resize", "zoom-in", "zoom-out", j, V]
      }],
      /**
       * Field Sizing
       * @see https://tailwindcss.com/docs/field-sizing
       */
      "field-sizing": [{
        "field-sizing": ["fixed", "content"]
      }],
      /**
       * Pointer Events
       * @see https://tailwindcss.com/docs/pointer-events
       */
      "pointer-events": [{
        "pointer-events": ["auto", "none"]
      }],
      /**
       * Resize
       * @see https://tailwindcss.com/docs/resize
       */
      resize: [{
        resize: ["none", "", "y", "x"]
      }],
      /**
       * Scroll Behavior
       * @see https://tailwindcss.com/docs/scroll-behavior
       */
      "scroll-behavior": [{
        scroll: ["auto", "smooth"]
      }],
      /**
       * Scrollbar Thumb Color
       * @see https://tailwindcss.com/docs/scrollbar-color
       */
      "scrollbar-thumb-color": [{
        "scrollbar-thumb": L()
      }],
      /**
       * Scrollbar Track Color
       * @see https://tailwindcss.com/docs/scrollbar-color
       */
      "scrollbar-track-color": [{
        "scrollbar-track": L()
      }],
      /**
       * Scrollbar Gutter
       * @see https://tailwindcss.com/docs/scrollbar-gutter
       */
      "scrollbar-gutter": [{
        "scrollbar-gutter": ["auto", "stable", "both"]
      }],
      /**
       * Scrollbar Width
       * @see https://tailwindcss.com/docs/scrollbar-width
       */
      "scrollbar-w": [{
        scrollbar: ["auto", "thin", "none"]
      }],
      /**
       * Scroll Margin
       * @see https://tailwindcss.com/docs/scroll-margin
       */
      "scroll-m": [{
        "scroll-m": S()
      }],
      /**
       * Scroll Margin Inline
       * @see https://tailwindcss.com/docs/scroll-margin
       */
      "scroll-mx": [{
        "scroll-mx": S()
      }],
      /**
       * Scroll Margin Block
       * @see https://tailwindcss.com/docs/scroll-margin
       */
      "scroll-my": [{
        "scroll-my": S()
      }],
      /**
       * Scroll Margin Inline Start
       * @see https://tailwindcss.com/docs/scroll-margin
       */
      "scroll-ms": [{
        "scroll-ms": S()
      }],
      /**
       * Scroll Margin Inline End
       * @see https://tailwindcss.com/docs/scroll-margin
       */
      "scroll-me": [{
        "scroll-me": S()
      }],
      /**
       * Scroll Margin Block Start
       * @see https://tailwindcss.com/docs/scroll-margin
       */
      "scroll-mbs": [{
        "scroll-mbs": S()
      }],
      /**
       * Scroll Margin Block End
       * @see https://tailwindcss.com/docs/scroll-margin
       */
      "scroll-mbe": [{
        "scroll-mbe": S()
      }],
      /**
       * Scroll Margin Top
       * @see https://tailwindcss.com/docs/scroll-margin
       */
      "scroll-mt": [{
        "scroll-mt": S()
      }],
      /**
       * Scroll Margin Right
       * @see https://tailwindcss.com/docs/scroll-margin
       */
      "scroll-mr": [{
        "scroll-mr": S()
      }],
      /**
       * Scroll Margin Bottom
       * @see https://tailwindcss.com/docs/scroll-margin
       */
      "scroll-mb": [{
        "scroll-mb": S()
      }],
      /**
       * Scroll Margin Left
       * @see https://tailwindcss.com/docs/scroll-margin
       */
      "scroll-ml": [{
        "scroll-ml": S()
      }],
      /**
       * Scroll Padding
       * @see https://tailwindcss.com/docs/scroll-padding
       */
      "scroll-p": [{
        "scroll-p": S()
      }],
      /**
       * Scroll Padding Inline
       * @see https://tailwindcss.com/docs/scroll-padding
       */
      "scroll-px": [{
        "scroll-px": S()
      }],
      /**
       * Scroll Padding Block
       * @see https://tailwindcss.com/docs/scroll-padding
       */
      "scroll-py": [{
        "scroll-py": S()
      }],
      /**
       * Scroll Padding Inline Start
       * @see https://tailwindcss.com/docs/scroll-padding
       */
      "scroll-ps": [{
        "scroll-ps": S()
      }],
      /**
       * Scroll Padding Inline End
       * @see https://tailwindcss.com/docs/scroll-padding
       */
      "scroll-pe": [{
        "scroll-pe": S()
      }],
      /**
       * Scroll Padding Block Start
       * @see https://tailwindcss.com/docs/scroll-padding
       */
      "scroll-pbs": [{
        "scroll-pbs": S()
      }],
      /**
       * Scroll Padding Block End
       * @see https://tailwindcss.com/docs/scroll-padding
       */
      "scroll-pbe": [{
        "scroll-pbe": S()
      }],
      /**
       * Scroll Padding Top
       * @see https://tailwindcss.com/docs/scroll-padding
       */
      "scroll-pt": [{
        "scroll-pt": S()
      }],
      /**
       * Scroll Padding Right
       * @see https://tailwindcss.com/docs/scroll-padding
       */
      "scroll-pr": [{
        "scroll-pr": S()
      }],
      /**
       * Scroll Padding Bottom
       * @see https://tailwindcss.com/docs/scroll-padding
       */
      "scroll-pb": [{
        "scroll-pb": S()
      }],
      /**
       * Scroll Padding Left
       * @see https://tailwindcss.com/docs/scroll-padding
       */
      "scroll-pl": [{
        "scroll-pl": S()
      }],
      /**
       * Scroll Snap Align
       * @see https://tailwindcss.com/docs/scroll-snap-align
       */
      "snap-align": [{
        snap: ["start", "end", "center", "align-none"]
      }],
      /**
       * Scroll Snap Stop
       * @see https://tailwindcss.com/docs/scroll-snap-stop
       */
      "snap-stop": [{
        snap: ["normal", "always"]
      }],
      /**
       * Scroll Snap Type
       * @see https://tailwindcss.com/docs/scroll-snap-type
       */
      "snap-type": [{
        snap: ["none", "x", "y", "both"]
      }],
      /**
       * Scroll Snap Type Strictness
       * @see https://tailwindcss.com/docs/scroll-snap-type
       */
      "snap-strictness": [{
        snap: ["mandatory", "proximity"]
      }],
      /**
       * Touch Action
       * @see https://tailwindcss.com/docs/touch-action
       */
      touch: [{
        touch: ["auto", "none", "manipulation"]
      }],
      /**
       * Touch Action X
       * @see https://tailwindcss.com/docs/touch-action
       */
      "touch-x": [{
        "touch-pan": ["x", "left", "right"]
      }],
      /**
       * Touch Action Y
       * @see https://tailwindcss.com/docs/touch-action
       */
      "touch-y": [{
        "touch-pan": ["y", "up", "down"]
      }],
      /**
       * Touch Action Pinch Zoom
       * @see https://tailwindcss.com/docs/touch-action
       */
      "touch-pz": ["touch-pinch-zoom"],
      /**
       * User Select
       * @see https://tailwindcss.com/docs/user-select
       */
      select: [{
        select: ["none", "text", "all", "auto"]
      }],
      /**
       * Will Change
       * @see https://tailwindcss.com/docs/will-change
       */
      "will-change": [{
        "will-change": ["auto", "scroll", "contents", "transform", j, V]
      }],
      // -----------
      // --- SVG ---
      // -----------
      /**
       * Fill
       * @see https://tailwindcss.com/docs/fill
       */
      fill: [{
        fill: ["none", ...L()]
      }],
      /**
       * Stroke Width
       * @see https://tailwindcss.com/docs/stroke-width
       */
      "stroke-w": [{
        stroke: [Q, on, wt, Rs]
      }],
      /**
       * Stroke
       * @see https://tailwindcss.com/docs/stroke
       */
      stroke: [{
        stroke: ["none", ...L()]
      }],
      // ---------------------
      // --- Accessibility ---
      // ---------------------
      /**
       * Forced Color Adjust
       * @see https://tailwindcss.com/docs/forced-color-adjust
       */
      "forced-color-adjust": [{
        "forced-color-adjust": ["auto", "none"]
      }]
    },
    conflictingClassGroups: {
      "container-named": ["container-type"],
      overflow: ["overflow-x", "overflow-y"],
      overscroll: ["overscroll-x", "overscroll-y"],
      inset: ["inset-x", "inset-y", "inset-bs", "inset-be", "start", "end", "top", "right", "bottom", "left"],
      "inset-x": ["start", "end", "right", "left"],
      "inset-y": ["inset-bs", "inset-be", "top", "bottom"],
      flex: ["basis", "grow", "shrink"],
      gap: ["gap-x", "gap-y"],
      p: ["px", "py", "ps", "pe", "pbs", "pbe", "pt", "pr", "pb", "pl"],
      px: ["ps", "pe", "pr", "pl"],
      py: ["pbs", "pbe", "pt", "pb"],
      m: ["mx", "my", "ms", "me", "mbs", "mbe", "mt", "mr", "mb", "ml"],
      mx: ["ms", "me", "mr", "ml"],
      my: ["mbs", "mbe", "mt", "mb"],
      size: ["w", "h"],
      "font-size": ["leading"],
      "fvn-normal": ["fvn-ordinal", "fvn-slashed-zero", "fvn-figure", "fvn-spacing", "fvn-fraction"],
      "fvn-ordinal": ["fvn-normal"],
      "fvn-slashed-zero": ["fvn-normal"],
      "fvn-figure": ["fvn-normal"],
      "fvn-spacing": ["fvn-normal"],
      "fvn-fraction": ["fvn-normal"],
      "line-clamp": ["display", "overflow"],
      rounded: ["rounded-s", "rounded-e", "rounded-t", "rounded-r", "rounded-b", "rounded-l", "rounded-ss", "rounded-se", "rounded-ee", "rounded-es", "rounded-tl", "rounded-tr", "rounded-br", "rounded-bl"],
      "rounded-s": ["rounded-ss", "rounded-es"],
      "rounded-e": ["rounded-se", "rounded-ee"],
      "rounded-t": ["rounded-tl", "rounded-tr"],
      "rounded-r": ["rounded-tr", "rounded-br"],
      "rounded-b": ["rounded-br", "rounded-bl"],
      "rounded-l": ["rounded-tl", "rounded-bl"],
      "border-spacing": ["border-spacing-x", "border-spacing-y"],
      "border-w": ["border-w-x", "border-w-y", "border-w-s", "border-w-e", "border-w-bs", "border-w-be", "border-w-t", "border-w-r", "border-w-b", "border-w-l"],
      "border-w-x": ["border-w-s", "border-w-e", "border-w-r", "border-w-l"],
      "border-w-y": ["border-w-bs", "border-w-be", "border-w-t", "border-w-b"],
      "border-color": ["border-color-x", "border-color-y", "border-color-s", "border-color-e", "border-color-bs", "border-color-be", "border-color-t", "border-color-r", "border-color-b", "border-color-l"],
      "border-color-x": ["border-color-s", "border-color-e", "border-color-r", "border-color-l"],
      "border-color-y": ["border-color-bs", "border-color-be", "border-color-t", "border-color-b"],
      translate: ["translate-x", "translate-y", "translate-none"],
      "translate-none": ["translate", "translate-x", "translate-y", "translate-z"],
      "scroll-m": ["scroll-mx", "scroll-my", "scroll-ms", "scroll-me", "scroll-mbs", "scroll-mbe", "scroll-mt", "scroll-mr", "scroll-mb", "scroll-ml"],
      "scroll-mx": ["scroll-ms", "scroll-me", "scroll-mr", "scroll-ml"],
      "scroll-my": ["scroll-mbs", "scroll-mbe", "scroll-mt", "scroll-mb"],
      "scroll-p": ["scroll-px", "scroll-py", "scroll-ps", "scroll-pe", "scroll-pbs", "scroll-pbe", "scroll-pt", "scroll-pr", "scroll-pb", "scroll-pl"],
      "scroll-px": ["scroll-ps", "scroll-pe", "scroll-pr", "scroll-pl"],
      "scroll-py": ["scroll-pbs", "scroll-pbe", "scroll-pt", "scroll-pb"],
      touch: ["touch-x", "touch-y", "touch-pz"],
      "touch-x": ["touch"],
      "touch-y": ["touch"],
      "touch-pz": ["touch"]
    },
    conflictingClassGroupModifiers: {
      "font-size": ["leading"]
    },
    postfixLookupClassGroups: ["container-type"],
    orderSensitiveModifiers: ["*", "**", "after", "backdrop", "before", "details-content", "file", "first-letter", "first-line", "marker", "placeholder", "selection"]
  };
}, Ku = (e, {
  cacheSize: t,
  prefix: n,
  experimentalParseClassName: r,
  extend: o = {},
  override: s = {}
}) => (Ht(e, "cacheSize", t), Ht(e, "prefix", n), Ht(e, "experimentalParseClassName", r), En(e.theme, s.theme), En(e.classGroups, s.classGroups), En(e.conflictingClassGroups, s.conflictingClassGroups), En(e.conflictingClassGroupModifiers, s.conflictingClassGroupModifiers), Ht(e, "postfixLookupClassGroups", s.postfixLookupClassGroups), Ht(e, "orderSensitiveModifiers", s.orderSensitiveModifiers), Nn(e.theme, o.theme), Nn(e.classGroups, o.classGroups), Nn(e.conflictingClassGroups, o.conflictingClassGroups), Nn(e.conflictingClassGroupModifiers, o.conflictingClassGroupModifiers), Br(e, o, "postfixLookupClassGroups"), Br(e, o, "orderSensitiveModifiers"), e), Ht = (e, t, n) => {
  n !== void 0 && (e[t] = n);
}, En = (e, t) => {
  if (t)
    for (const n in t)
      Ht(e, n, t[n]);
}, Nn = (e, t) => {
  if (t)
    for (const n in t)
      Br(e, t, n);
}, Br = (e, t, n) => {
  const r = t[n];
  r !== void 0 && (e[n] = e[n] ? e[n].concat(r) : r);
}, Yu = (e, ...t) => typeof e == "function" ? Ns(_s, e, ...t) : Ns(() => Ku(_s(), e), ...t), Xu = Yu({
  extend: { classGroups: { "font-size": [{ text: ["ui"] }] } }
});
function I(...e) {
  return Xu(Pa(e));
}
const qu = Xt(
  "inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 min-w-0 overflow-hidden",
  {
    variants: {
      variant: {
        // Standard Variants
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive: "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90",
        outline: "border border-input bg-transparent text-foreground dark:text-foreground hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 underline hover:text-primary/80 !h-auto !py-0",
        // Semantic / Feedback Variants
        success: "bg-success text-success-foreground shadow-sm hover:bg-success/90",
        warning: "bg-warning text-warning-foreground shadow-sm hover:bg-warning/90",
        info: "bg-info text-info-text shadow-sm hover:bg-info/90",
        // Outline Variations
        "outline-success": "border border-success text-success dark:text-success hover:bg-success/10",
        "outline-warning": "border border-warning text-warning dark:text-warning hover:bg-warning/10",
        "outline-destructive": "border border-destructive text-destructive dark:text-destructive hover:bg-destructive/10",
        // Special Shapes
        fab: "rounded-full h-14 w-14 p-0 shadow-lg hover:shadow-xl bg-primary text-primary-foreground hover:bg-primary/90",
        "circle-help": "bg-muted text-muted-foreground shadow-sm hover:bg-muted/90 rounded-full",
        "circle-alert": "bg-warning text-warning-foreground shadow-sm hover:bg-warning/90 rounded-full",
        // Option Buttons
        option: "border border-input bg-background text-foreground shadow-none hover:bg-accent/30 hover:text-foreground",
        "option-active": "border-2 border-primary bg-primary/10 text-foreground shadow-none hover:bg-primary/20"
      },
      size: {
        default: "h-ui px-ui-button py-ui-button text-ui min-h-ui-touch",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-8",
        icon: "h-ui w-[var(--ui-component-height)] min-h-ui-touch min-w-[var(--ui-touch-target-min)]",
        circle: "h-8 w-8 rounded-full p-0"
      }
    },
    defaultVariants: {
      variant: "default",
      size: "default"
    }
  }
), ye = u.forwardRef(
  ({
    className: e,
    variant: t = "default",
    size: n,
    children: r,
    loading: o = !1,
    success: s = !1,
    error: a = !1,
    icon: i,
    asChild: d = !1,
    disabled: c,
    maxLabelLength: m = 14,
    ...l
  }, p) => {
    const h = d ? xa : "button", b = s ? "success" : a ? "destructive" : t, v = () => {
      if (o) return /* @__PURE__ */ f(Bd, { className: "h-4 w-4 animate-spin" });
      if (s) return /* @__PURE__ */ f(jn, { className: "h-4 w-4" });
      if (a) return /* @__PURE__ */ f(Pt, { className: "h-4 w-4" });
      const g = typeof r == "string" && r.length > m ? `${r.slice(0, Math.max(0, m - 1))}…` : r, C = typeof r == "string" ? /* @__PURE__ */ f(
        "span",
        {
          className: "min-w-0 flex-1 whitespace-nowrap",
          title: typeof r == "string" && typeof g == "string" && g !== r ? r : void 0,
          children: g
        }
      ) : r;
      return /* @__PURE__ */ O("span", { className: "flex min-w-0 items-center", children: [
        i && /* @__PURE__ */ f(i, { className: I("mr-2 h-4 w-4", !r && "mr-0") }),
        C
      ] });
    };
    return /* @__PURE__ */ f(
      h,
      {
        className: I(
          qu({ variant: b, size: n }),
          e
        ),
        ref: p,
        disabled: c || o || s || a,
        ...l,
        children: v()
      }
    );
  }
);
ye.displayName = "Button";
const Is = 768;
function Zu() {
  const [e, t] = u.useState(() => typeof window < "u" && window.matchMedia ? window.matchMedia(`(max-width: ${Is - 1}px)`).matches : !1);
  return u.useEffect(() => {
    if (typeof window > "u" || !window.matchMedia) return;
    const n = window.matchMedia(`(max-width: ${Is - 1}px)`), r = (o) => {
      t(o.matches);
    };
    return n.addEventListener ? n.addEventListener("change", r) : n.addListener(r), t(n.matches), () => {
      n.removeEventListener ? n.removeEventListener("change", r) : n.removeListener(r);
    };
  }, []), e;
}
const qt = R.forwardRef(
  ({
    variant: e = "default",
    mobileVariant: t,
    label: n,
    icon: r,
    mobileIcon: o,
    iconOnly: s = !1,
    alwaysFull: a = !1,
    isFab: i = !1,
    className: d,
    children: c,
    size: m,
    ...l
  }, p) => {
    const h = Zu(), b = h && t ? t : e, v = h && o ? o : r, g = s || h && !a;
    return h && i ? /* @__PURE__ */ f(
      ye,
      {
        ref: p,
        variant: "fab",
        size: "icon",
        className: I("fixed bottom-6 right-6 z-50", d),
        icon: v,
        "aria-label": n,
        ...l
      }
    ) : /* @__PURE__ */ f(
      ye,
      {
        ref: p,
        variant: b,
        size: g ? "icon" : m || "default",
        className: d,
        icon: v,
        "aria-label": g ? n : void 0,
        ...l,
        children: g ? void 0 : n ?? c
      }
    );
  }
);
qt.displayName = "ActionButton";
const Qu = ({
  label: e = "Cancel",
  icon: t = Pt,
  variant: n = "secondary",
  ...r
}) => /* @__PURE__ */ f(qt, { label: e, icon: t, variant: n, ...r });
Qu.displayName = "CancelButton";
const Ju = ({
  label: e = "Create New",
  position: t = "inline",
  icon: n = Oa,
  variant: r = "default",
  ...o
}) => /* @__PURE__ */ f(
  qt,
  {
    label: e,
    icon: n,
    variant: r,
    isFab: t === "fab",
    ...o
  }
);
Ju.displayName = "CreateButton";
const ef = ({
  label: e = "Delete",
  icon: t = tu,
  variant: n = "destructive",
  ...r
}) => /* @__PURE__ */ f(qt, { label: e, icon: t, variant: n, ...r });
ef.displayName = "DeleteButton";
const tf = ({
  label: e = "Edit",
  icon: t = Gd,
  variant: n = "secondary",
  ...r
}) => /* @__PURE__ */ f(qt, { label: e, icon: t, variant: n, ...r });
tf.displayName = "EditButton";
const nf = ({
  label: e = "Save",
  icon: t = Zd,
  variant: n = "default",
  ...r
}) => /* @__PURE__ */ f(qt, { label: e, icon: t, variant: n, ...r });
nf.displayName = "SaveButton";
const Wn = ({
  text: e,
  width: t,
  className: n = "",
  style: r = {},
  as: o = "div"
}) => {
  const s = an(null), a = an(null), [i, d] = Ge(1), [c, m] = Ge(!1);
  ga(() => {
    const h = s.current, b = a.current;
    if (!h || !b) return;
    const v = () => {
      d(1), m(!1);
      let g = 0;
      if (typeof t == "number" ? g = t : typeof t == "string" && t.endsWith("px") ? g = Number.parseFloat(t) : g = h.clientWidth, g <= 0) return;
      const C = b.scrollWidth / g;
      C <= 1 ? (d(1), m(!1)) : C <= 1.3 ? (d(1 / C), m(!1)) : (d(1), m(!0));
    };
    if (v(), !t) {
      const g = new ResizeObserver(() => {
        v();
      });
      return g.observe(h), () => g.disconnect();
    }
  }, [e, t]);
  const l = {
    ...r,
    width: t,
    whiteSpace: "nowrap",
    overflow: c ? "hidden" : "visible",
    textOverflow: c ? "ellipsis" : "clip",
    display: "block"
    // Ensure block/inline-block for width to apply
  }, p = {
    display: "inline-block",
    transform: i < 1 ? `scale(${i})` : "none",
    transformOrigin: "left center",
    width: i < 1 ? `${1 / i * 100}%` : "auto"
    // Compensate width when scaled
  };
  return /* @__PURE__ */ f(
    o,
    {
      ref: s,
      className: `adaptive-text-container ${n}`,
      style: l,
      title: c ? e : void 0,
      children: /* @__PURE__ */ f("span", { ref: a, style: p, children: e })
    }
  );
}, rf = ({
  error: e,
  onRetry: t,
  className: n = "",
  title: r,
  message: o,
  retryText: s = "再読み込み"
}) => {
  const a = (l) => ({
    title: "Error",
    message: l?.message ?? "Something went wrong."
  }), { title: i, message: d } = a(e), c = r || i, m = o || d;
  return /* @__PURE__ */ O(
    "div",
    {
      className: I(
        "flex flex-col items-center justify-center p-8 text-center bg-card rounded-lg border border-border/50",
        n
      ),
      children: [
        /* @__PURE__ */ f("div", { className: "bg-destructive/10 p-4 rounded-full mb-4", children: /* @__PURE__ */ f(Ia, { className: "h-8 w-8 text-destructive" }) }),
        /* @__PURE__ */ f("h3", { className: "text-lg font-semibold text-foreground mb-2", children: c }),
        /* @__PURE__ */ f("p", { className: "text-sm text-muted-foreground mb-6 max-w-sm", children: m }),
        t && /* @__PURE__ */ O(ye, { onClick: t, variant: "outline", className: "gap-2", children: [
          /* @__PURE__ */ f(Xd, { className: "h-4 w-4" }),
          s
        ] })
      ]
    }
  );
}, of = {
  xs: "h-4 w-4 border-2",
  sm: "h-6 w-6 border-2",
  md: "h-8 w-8 border-[3px]",
  lg: "h-12 w-12 border-[3px]",
  xl: "h-16 w-16 border-4"
}, sf = {
  primary: "border-theme-object-primary border-t-transparent",
  secondary: "border-theme-text-secondary border-t-transparent",
  accent: "border-theme-accent border-t-transparent"
}, St = u.memo(
  ({ size: e = "md", variant: t = "primary", className: n, ...r }) => {
    const o = (s, a) => a ?? s;
    return /* @__PURE__ */ O(
      "output",
      {
        "aria-live": "polite",
        "aria-label": "Loading",
        className: I("inline-block", n),
        ...r,
        children: [
          /* @__PURE__ */ f(
            "div",
            {
              className: I(
                "animate-spin rounded-full",
                of[e],
                sf[t]
              )
            }
          ),
          /* @__PURE__ */ f("span", { className: "sr-only", children: o("loading") })
        ]
      }
    );
  }
);
St.displayName = "Spinner";
const Ka = u.memo(
  ({
    className: e,
    showSpinner: t = !1,
    spinnerSize: n = "md",
    spinnerVariant: r = "primary",
    ...o
  }) => /* @__PURE__ */ f(
    "div",
    {
      className: I(
        "animate-pulse rounded-md bg-card opacity-50",
        t && "relative flex items-center justify-center",
        e
      ),
      ...o,
      children: t && /* @__PURE__ */ f("div", { className: "absolute inset-0 flex items-center justify-center", children: /* @__PURE__ */ f(St, { size: n, variant: r }) })
    }
  )
);
Ka.displayName = "Skeleton";
const ey = ({
  isLoading: e,
  isError: t,
  refetch: n,
  children: r,
  isFetching: o,
  className: s,
  isEmpty: a,
  emptyMessage: i,
  useSkeletonLoading: d = !0,
  loadingText: c = "Loading...",
  noDataText: m = "No data available",
  refreshText: l = "Refresh data"
}) => {
  if (t)
    return /* @__PURE__ */ f(
      "div",
      {
        className: I("h-full flex items-center justify-center p-8", s),
        children: /* @__PURE__ */ f(rf, { error: t, onRetry: () => n() })
      }
    );
  if (e) {
    if (d) {
      const p = [
        "skeleton-1",
        "skeleton-2",
        "skeleton-3",
        "skeleton-4",
        "skeleton-5"
      ];
      return /* @__PURE__ */ O(
        "div",
        {
          className: I(
            "relative h-full w-full overflow-hidden p-4 space-y-4",
            s
          ),
          children: [
            /* @__PURE__ */ f("div", { className: "space-y-4 opacity-50", children: p.map((h) => /* @__PURE__ */ f(Ka, { className: "h-16 w-full rounded-lg" }, h)) }),
            /* @__PURE__ */ O("div", { className: "absolute inset-0 flex flex-col items-center justify-center gap-2 z-10", children: [
              /* @__PURE__ */ f(St, { size: "lg" }),
              /* @__PURE__ */ f("div", { className: "text-muted-foreground font-medium", children: c })
            ] })
          ]
        }
      );
    }
    return /* @__PURE__ */ O(
      "div",
      {
        className: I(
          "flex flex-col h-64 items-center justify-center gap-2",
          s
        ),
        children: [
          /* @__PURE__ */ f(St, { size: "lg" }),
          /* @__PURE__ */ f("div", { className: "text-muted-foreground", children: c })
        ]
      }
    );
  }
  return a ? /* @__PURE__ */ O(
    "div",
    {
      className: I(
        "flex flex-col h-64 items-center justify-center gap-4 text-center p-8 border-2 border-dashed rounded-lg bg-muted/20",
        s
      ),
      children: [
        /* @__PURE__ */ f("div", { className: "text-muted-foreground", children: i || m }),
        /* @__PURE__ */ f(
          "button",
          {
            type: "button",
            onClick: () => n(),
            className: "text-sm text-primary hover:underline hover:text-primary/80 transition-colors",
            children: l
          }
        )
      ]
    }
  ) : /* @__PURE__ */ O("div", { className: I("relative", s), children: [
    o && !e && /* @__PURE__ */ O("div", { className: "absolute right-4 top-3 flex items-center gap-2 text-xs text-muted-foreground z-20 pointer-events-none", children: [
      /* @__PURE__ */ f(St, { size: "sm", variant: "secondary" }),
      /* @__PURE__ */ f("span", { children: c })
    ] }),
    r
  ] });
}, af = {
  xs: "h-7 w-7 text-xs",
  sm: "h-8 w-8 text-xs",
  md: "h-11 w-11 text-sm",
  lg: "h-16 w-16 text-lg",
  xl: "h-20 w-20 text-xl"
}, lf = u.memo(
  u.forwardRef(
    ({ src: e, alt: t, fallback: n, size: r = "md", className: o, ...s }, a) => {
      const [i, d] = u.useState(!1), c = () => !n && !t ? "?" : typeof n == "string" ? n.split(" ").map((m) => m[0]).join("").toUpperCase().slice(0, 2) : t ? t.split(" ").map((m) => m[0]).join("").toUpperCase().slice(0, 2) : "?";
      return /* @__PURE__ */ f(
        "div",
        {
          ref: a,
          className: I(
            "relative flex shrink-0 overflow-hidden rounded-full",
            af[r],
            o
          ),
          ...s,
          children: e && !i ? /* @__PURE__ */ f(
            "img",
            {
              src: e,
              alt: t || "Avatar",
              className: "h-full w-full object-cover",
              onError: () => d(!0)
            }
          ) : /* @__PURE__ */ f("div", { className: "flex h-full w-full items-center justify-center bg-muted text-muted-foreground", children: u.isValidElement(n) ? n : c() })
        }
      );
    }
  )
);
lf.displayName = "Avatar";
const cf = Xt(
  "inline-flex items-center rounded-full border px-[var(--ui-badge-padding-x)] py-[var(--ui-badge-padding-y)] text-ui font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 whitespace-nowrap",
  {
    variants: {
      variant: {
        default: "border-transparent bg-accent text-accent-foreground hover:bg-accent/80",
        secondary: "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
        destructive: "border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/80",
        outline: "text-foreground border-border",
        success: "border-transparent bg-success text-success-foreground hover:bg-success/80",
        warning: "border-transparent bg-warning text-warning-foreground hover:bg-warning/80",
        // Additional variants for patient list - light backgrounds with dark text
        sky: "border-transparent bg-sky-200 text-sky-900 dark:bg-sky-900 dark:text-sky-100 hover:bg-sky-300 dark:hover:bg-sky-800",
        pink: "border-transparent bg-pink-200 text-pink-800 dark:bg-pink-900 dark:text-pink-100 hover:bg-pink-300 dark:hover:bg-pink-800",
        gray: "border-transparent bg-stone-200 text-stone-800 dark:bg-stone-800 dark:text-stone-200 hover:bg-stone-300 dark:hover:bg-stone-700",
        green: "border-transparent bg-teal-200 text-gray-900 dark:bg-teal-900 dark:text-teal-100 hover:bg-teal-300 dark:hover:bg-teal-800",
        yellow: "border-transparent bg-amber-200 text-amber-800 dark:bg-amber-900 dark:text-amber-100 hover:bg-amber-300 dark:hover:bg-amber-800",
        red: "border-transparent bg-rose-200 text-rose-800 dark:bg-rose-900 dark:text-rose-100 hover:bg-rose-300 dark:hover:bg-rose-800"
      }
    },
    defaultVariants: {
      variant: "default"
    }
  }
), ty = u.memo(
  ({ className: e, variant: t, label: n, pill: r, children: o, ...s }) => /* @__PURE__ */ f("div", { className: I(cf({ variant: t }), e), ...s, children: n ?? o })
);
var df = Object.defineProperty, Zt = (e, t) => df(e, "name", { value: t, configurable: !0 }), Ya = !!(typeof window < "u" && window.document && window.document.createElement);
function Y(e, t, { checkForDefaultPrevented: n = !0 } = {}) {
  return /* @__PURE__ */ Zt(function(o) {
    if (e?.(o), n === !1 || !o || !o.defaultPrevented)
      return t?.(o);
  }, "handleEvent");
}
Zt(Y, "composeEventHandlers");
function uf(e) {
  if (!Ya)
    throw new Error("Cannot access window outside of the DOM");
  return e?.ownerDocument?.defaultView ?? window;
}
Zt(uf, "getOwnerWindow");
function Vr(e) {
  if (!Ya)
    throw new Error("Cannot access document outside of the DOM");
  return e?.ownerDocument ?? document;
}
Zt(Vr, "getOwnerDocument");
function Xa(e, t = !1) {
  const { activeElement: n } = Vr(e);
  if (!n?.nodeName)
    return null;
  if (qa(n) && n.contentDocument)
    return Xa(n.contentDocument.body, t);
  if (t) {
    const r = n.getAttribute("aria-activedescendant");
    if (r) {
      const o = Vr(n).getElementById(r);
      if (o)
        return o;
    }
  }
  return n;
}
Zt(Xa, "getActiveElement");
function qa(e) {
  return e.tagName === "IFRAME";
}
Zt(qa, "isFrame");
var ff = Object.defineProperty, Ae = (e, t) => ff(e, "name", { value: t, configurable: !0 });
// @__NO_SIDE_EFFECTS__
function mf(e, t) {
  const n = u.createContext(t);
  n.displayName = e + "Context";
  const r = /* @__PURE__ */ Ae((s) => {
    const { children: a, ...i } = s, d = u.useMemo(() => i, Object.values(i));
    return /* @__PURE__ */ f(n.Provider, { value: d, children: a });
  }, "Provider");
  r.displayName = e + "Provider";
  function o(s, a = {}) {
    const { optional: i = !1 } = a, d = u.useContext(n);
    if (d) return d;
    if (t !== void 0) return t;
    if (!i)
      throw new Error(`\`${s}\` must be used within \`${e}\``);
  }
  return Ae(o, "useContext"), [r, o];
}
Ae(mf, "createContext");
// @__NO_SIDE_EFFECTS__
function _e(e, t = []) {
  let n = [];
  function r(s, a) {
    const i = u.createContext(a);
    i.displayName = s + "Context";
    const d = n.length;
    n = [...n, a];
    const c = /* @__PURE__ */ Ae((l) => {
      const { scope: p, children: h, ...b } = l, v = p?.[e]?.[d] || i, g = u.useMemo(() => b, Object.values(b));
      return /* @__PURE__ */ f(v.Provider, { value: g, children: h });
    }, "Provider");
    c.displayName = s + "Provider";
    function m(l, p, h = {}) {
      const { optional: b = !1 } = h, v = p?.[e]?.[d] || i, g = u.useContext(v);
      if (g) return g;
      if (a !== void 0) return a;
      if (!b)
        throw new Error(`\`${l}\` must be used within \`${s}\``);
    }
    return Ae(m, "useContext"), [c, m];
  }
  Ae(r, "createContext");
  const o = /* @__PURE__ */ Ae(() => {
    const s = n.map((a) => u.createContext(a));
    return /* @__PURE__ */ Ae(function(i) {
      const d = i?.[e] || s;
      return u.useMemo(
        () => ({ [`__scope${e}`]: { ...i, [e]: d } }),
        [i, d]
      );
    }, "useScope");
  }, "createScope");
  return o.scopeName = e, [r, Za(o, ...t)];
}
Ae(_e, "createContextScope");
function Za(...e) {
  const t = e[0];
  if (e.length === 1) return t;
  const n = /* @__PURE__ */ Ae(() => {
    const r = e.map((o) => ({
      useScope: o(),
      scopeName: o.scopeName
    }));
    return /* @__PURE__ */ Ae(function(s) {
      const a = r.reduce((i, { useScope: d, scopeName: c }) => {
        const l = d(s)[`__scope${c}`];
        return { ...i, ...l };
      }, {});
      return u.useMemo(() => ({ [`__scope${t.scopeName}`]: a }), [a]);
    }, "useComposedScopes");
  }, "createScope");
  return n.scopeName = t.scopeName, n;
}
Ae(Za, "composeContextScopes");
var de = globalThis?.document ? u.useLayoutEffect : () => {
}, pf = Object.defineProperty, hf = (e, t) => pf(e, "name", { value: t, configurable: !0 }), gf = u[" useId ".trim().toString()] || (() => {
}), vf = 0;
function De(e) {
  const [t, n] = u.useState(gf());
  return de(() => {
    e || n((r) => r ?? String(vf++));
  }, [e]), e || (t ? `radix-${t}` : "");
}
hf(De, "useId");
var bf = Object.defineProperty, yf = (e, t) => bf(e, "name", { value: t, configurable: !0 }), Os = u[" useEffectEvent ".trim().toString()], As = u[" useInsertionEffect ".trim().toString()];
function Qa(e) {
  if (typeof Os == "function")
    return Os(e);
  const t = u.useRef(() => {
    throw new Error("Cannot call an event handler while rendering.");
  });
  return typeof As == "function" ? As(() => {
    t.current = e;
  }) : de(() => {
    t.current = e;
  }), u.useMemo(() => ((...n) => t.current?.(...n)), []);
}
yf(Qa, "useEffectEvent");
var xf = Object.defineProperty, hn = (e, t) => xf(e, "name", { value: t, configurable: !0 }), wf = u[" useInsertionEffect ".trim().toString()] || de;
function Ye({
  prop: e,
  defaultProp: t,
  onChange: n = /* @__PURE__ */ hn(() => {
  }, "onChange"),
  caller: r
}) {
  const [o, s, a] = Ja({
    defaultProp: t,
    onChange: n
  }), i = e !== void 0, d = i ? e : o, c = u.useCallback(
    (m) => {
      if (i) {
        const l = ei(m) ? m(e) : m;
        l !== e && a.current?.(l);
      } else
        s(m);
    },
    [i, e, s, a]
  );
  return [d, c];
}
hn(Ye, "useControllableState");
function Ja({
  defaultProp: e,
  onChange: t
}) {
  const [n, r] = u.useState(e), o = u.useRef(n), s = u.useRef(t);
  return wf(() => {
    s.current = t;
  }, [t]), u.useEffect(() => {
    o.current !== n && (s.current?.(n), o.current = n);
  }, [n, o]), [n, r, s];
}
hn(Ja, "useUncontrolledState");
function ei(e) {
  return typeof e == "function";
}
hn(ei, "isFunction");
var Ds = /* @__PURE__ */ Symbol("RADIX:SYNC_STATE");
function Cf(e, t, n, r) {
  const { prop: o, defaultProp: s, onChange: a, caller: i } = t, d = o !== void 0, c = Qa(a), m = [{ ...n, state: s }];
  r && m.push(r);
  const [l, p] = u.useReducer(
    (g, y) => {
      if (y.type === Ds)
        return { ...g, state: y.state };
      const C = e(g, y);
      return d && !Object.is(C.state, g.state) && c(C.state), C;
    },
    ...m
  ), h = l.state, b = u.useRef(h);
  u.useEffect(() => {
    b.current !== h && (b.current = h, d || c(h));
  }, [h, b, d]);
  const v = u.useMemo(() => o !== void 0 ? { ...l, state: o } : l, [l, o]);
  return u.useEffect(() => {
    d && !Object.is(o, l.state) && p({ type: Ds, state: o });
  }, [o, l.state, d]), [v, p];
}
hn(Cf, "useControllableStateReducer");
var Sf = Object.defineProperty, kf = (e, t) => Sf(e, "name", { value: t, configurable: !0 }), Ef = [
  "a",
  "button",
  "div",
  "form",
  "h2",
  "h3",
  "img",
  "input",
  "label",
  "li",
  "nav",
  "ol",
  "p",
  "select",
  "span",
  "svg",
  "ul"
], Z = Ef.reduce((e, t) => {
  const n = /* @__PURE__ */ Ke(`Primitive.${t}`), r = u.forwardRef((o, s) => {
    const { asChild: a, ...i } = o, d = a ? n : t;
    return typeof window < "u" && (window[/* @__PURE__ */ Symbol.for("radix-ui")] = !0), /* @__PURE__ */ f(d, { ...i, ref: s });
  });
  return r.displayName = `Primitive.${t}`, { ...e, [t]: r };
}, {});
function ti(e, t) {
  e && pn.flushSync(() => e.dispatchEvent(t));
}
kf(ti, "dispatchDiscreteCustomEvent");
var Nf = Object.defineProperty, Rf = (e, t) => Nf(e, "name", { value: t, configurable: !0 });
function Le(e) {
  const t = u.useRef(e);
  return u.useEffect(() => {
    t.current = e;
  }), u.useMemo(() => ((...n) => t.current?.(...n)), []);
}
Rf(Le, "useCallbackRef");
var Pf = Object.defineProperty, he = (e, t) => Pf(e, "name", { value: t, configurable: !0 }), jr = "dismissableLayer.update", Tf = "dismissableLayer.pointerDownOutside", _f = "dismissableLayer.focusOutside", Ms, ni = u.createContext({
  layers: /* @__PURE__ */ new Set(),
  layersWithOutsidePointerEventsDisabled: /* @__PURE__ */ new Set(),
  branches: /* @__PURE__ */ new Set(),
  // Outside elements that belong to a layer's own dismiss affordance (eg, a
  // dialog overlay). Pressing them should dismiss the layer regardless of
  // whether or not they stop propagation.
  //
  // See https://github.com/radix-ui/primitives/issues/3346
  dismissableSurfaces: /* @__PURE__ */ new Set()
}), Qn = /* @__PURE__ */ u.forwardRef(
  // blank line to reduce diff noise
  /* @__PURE__ */ he(function(t, n) {
    const {
      disableOutsidePointerEvents: r = !1,
      deferPointerDownOutside: o = !1,
      onEscapeKeyDown: s,
      onPointerDownOutside: a,
      onFocusOutside: i,
      onInteractOutside: d,
      onDismiss: c,
      ...m
    } = t, l = u.useContext(ni), [p, h] = u.useState(null), b = p?.ownerDocument ?? globalThis?.document, [, v] = u.useState({}), g = re(n, h), y = Array.from(l.layers), [C] = [
      ...l.layersWithOutsidePointerEventsDisabled
    ].slice(-1), w = C ? y.indexOf(C) : -1, x = p ? y.indexOf(p) : -1, E = l.layersWithOutsidePointerEventsDisabled.size > 0, N = x >= w, k = u.useRef(!1), S = oi(
      (A) => {
        a?.(A), d?.(A), A.defaultPrevented || c?.();
      },
      {
        ownerDocument: b,
        deferPointerDownOutside: o,
        isDeferredPointerDownOutsideRef: k,
        dismissableSurfaces: l.dismissableSurfaces,
        shouldHandlePointerDownOutside: u.useCallback(
          (A) => {
            if (!(A instanceof Node))
              return !1;
            const T = [...l.branches].some(
              (D) => D.contains(A)
            );
            return N && !T;
          },
          [l.branches, N]
        )
      }
    ), P = si((A) => {
      if (o && k.current)
        return;
      const T = A.target;
      [...l.branches].some((W) => W.contains(T)) || (i?.(A), d?.(A), A.defaultPrevented || c?.());
    }, b), _ = p ? x === y.length - 1 : !1, M = Le((A) => {
      A.key === "Escape" && (s?.(A), !A.defaultPrevented && c && (A.preventDefault(), c()));
    });
    return u.useEffect(() => {
      if (_)
        return b.addEventListener("keydown", M, { capture: !0 }), () => b.removeEventListener("keydown", M, { capture: !0 });
    }, [b, _, M]), u.useEffect(() => {
      if (p)
        return r && (l.layersWithOutsidePointerEventsDisabled.size === 0 && (Ms = b.body.style.pointerEvents, b.body.style.pointerEvents = "none"), l.layersWithOutsidePointerEventsDisabled.add(p)), l.layers.add(p), Hr(), () => {
          r && (l.layersWithOutsidePointerEventsDisabled.delete(p), l.layersWithOutsidePointerEventsDisabled.size === 0 && (b.body.style.pointerEvents = Ms));
        };
    }, [p, b, r, l]), u.useEffect(() => () => {
      p && (l.layers.delete(p), l.layersWithOutsidePointerEventsDisabled.delete(p), Hr());
    }, [p, l]), u.useEffect(() => {
      const A = /* @__PURE__ */ he(() => v({}), "handleUpdate");
      return document.addEventListener(jr, A), () => document.removeEventListener(jr, A);
    }, []), /* @__PURE__ */ f(
      Z.div,
      {
        ...m,
        ref: g,
        style: {
          pointerEvents: E ? N ? "auto" : "none" : void 0,
          ...t.style
        },
        onFocusCapture: Y(t.onFocusCapture, P.onFocusCapture),
        onBlurCapture: Y(t.onBlurCapture, P.onBlurCapture),
        onPointerDownCapture: Y(
          t.onPointerDownCapture,
          S.onPointerDownCapture
        )
      }
    );
  }, "DismissableLayer")
);
function ri() {
  const e = u.useContext(ni), [t, n] = u.useState(null);
  return u.useEffect(() => {
    if (t)
      return e.dismissableSurfaces.add(t), () => {
        e.dismissableSurfaces.delete(t);
      };
  }, [t, e.dismissableSurfaces]), n;
}
he(ri, "useDismissableLayerSurface");
var If = /* @__PURE__ */ he(() => !0, "IS_TRUE");
function oi(e, t) {
  const {
    ownerDocument: n = globalThis?.document,
    deferPointerDownOutside: r = !1,
    isDeferredPointerDownOutsideRef: o,
    dismissableSurfaces: s,
    shouldHandlePointerDownOutside: a = If
  } = t, i = Le(e), d = u.useRef(!1), c = u.useRef(!1), m = u.useRef(/* @__PURE__ */ new Map()), l = u.useRef(() => {
  });
  return u.useEffect(() => {
    function p() {
      c.current = !1, o.current = !1, m.current.clear();
    }
    he(p, "resetOutsideInteraction");
    function h() {
      return Array.from(m.current.values()).some(Boolean);
    }
    he(h, "isOutsideInteractionIntercepted");
    function b(w) {
      if (!c.current)
        return;
      const x = w.target;
      x instanceof Node && [...s].some((N) => N.contains(x)) || m.current.set(w.type, !0), w.type === "click" && window.setTimeout(() => {
        c.current && l.current();
      }, 0);
    }
    he(b, "handleInteractionCapture");
    function v(w) {
      c.current && m.current.set(w.type, !1);
    }
    he(v, "handleInteractionBubble");
    const g = /* @__PURE__ */ he((w) => {
      if (w.target && !d.current) {
        let x = function() {
          n.removeEventListener("click", l.current);
          const N = h();
          p(), N || uo(
            Tf,
            i,
            E,
            { discrete: !0 }
          );
        };
        if (he(x, "handleAndDispatchPointerDownOutsideEvent"), !a(w.target)) {
          n.removeEventListener("click", l.current), p(), d.current = !1;
          return;
        }
        const E = { originalEvent: w };
        c.current = !0, o.current = r && w.button === 0, m.current.clear(), !r || w.button !== 0 ? x() : (n.removeEventListener("click", l.current), l.current = x, n.addEventListener("click", l.current, { once: !0 }));
      } else
        n.removeEventListener("click", l.current), p();
      d.current = !1;
    }, "handlePointerDown"), y = [
      "pointerup",
      "mousedown",
      "mouseup",
      "touchstart",
      "touchend",
      "click"
    ];
    for (const w of y)
      n.addEventListener(w, b, !0), n.addEventListener(w, v);
    const C = window.setTimeout(() => {
      n.addEventListener("pointerdown", g);
    }, 0);
    return () => {
      window.clearTimeout(C), n.removeEventListener("pointerdown", g), n.removeEventListener("click", l.current);
      for (const w of y)
        n.removeEventListener(w, b, !0), n.removeEventListener(w, v);
    };
  }, [
    n,
    i,
    r,
    o,
    s,
    a
  ]), {
    // ensures we check React component tree (not just DOM tree)
    onPointerDownCapture: /* @__PURE__ */ he(() => d.current = !0, "onPointerDownCapture")
  };
}
he(oi, "usePointerDownOutside");
function si(e, t = globalThis?.document) {
  const n = Le(e), r = u.useRef(!1);
  return u.useEffect(() => {
    const o = /* @__PURE__ */ he((s) => {
      s.target && !r.current && uo(_f, n, { originalEvent: s }, {
        discrete: !1
      });
    }, "handleFocus");
    return t.addEventListener("focusin", o), () => t.removeEventListener("focusin", o);
  }, [t, n]), {
    onFocusCapture: /* @__PURE__ */ he(() => r.current = !0, "onFocusCapture"),
    onBlurCapture: /* @__PURE__ */ he(() => r.current = !1, "onBlurCapture")
  };
}
he(si, "useFocusOutside");
function Hr() {
  const e = new CustomEvent(jr);
  document.dispatchEvent(e);
}
he(Hr, "dispatchUpdate");
function uo(e, t, n, { discrete: r }) {
  const o = n.originalEvent.target, s = new CustomEvent(e, { bubbles: !1, cancelable: !0, detail: n });
  t && o.addEventListener(e, t, { once: !0 }), r ? ti(o, s) : o.dispatchEvent(s);
}
he(uo, "handleAndDispatchCustomEvent");
var Of = Object.defineProperty, Se = (e, t) => Of(e, "name", { value: t, configurable: !0 }), xr = "focusScope.autoFocusOnMount", wr = "focusScope.autoFocusOnUnmount", Ls = { bubbles: !1, cancelable: !0 }, fo = /* @__PURE__ */ u.forwardRef(
  /* @__PURE__ */ Se(function(t, n) {
    const {
      loop: r = !1,
      trapped: o = !1,
      onMountAutoFocus: s,
      onUnmountAutoFocus: a,
      ...i
    } = t, [d, c] = u.useState(null), m = Le(s), l = Le(a), p = u.useRef(null), h = re(n, c), b = u.useRef({
      paused: !1,
      pause() {
        this.paused = !0;
      },
      resume() {
        this.paused = !1;
      }
    }).current;
    u.useEffect(() => {
      if (o) {
        let g = function(x) {
          if (b.paused || !d) return;
          const E = x.target;
          d.contains(E) ? p.current = E : tt(p.current, { select: !0 });
        }, y = function(x) {
          if (b.paused || !d) return;
          const E = x.relatedTarget;
          E !== null && (d.contains(E) || tt(p.current, { select: !0 }));
        }, C = function(x) {
          if (document.activeElement === document.body)
            for (const N of x)
              N.removedNodes.length > 0 && tt(d);
        };
        Se(g, "handleFocusIn"), Se(y, "handleFocusOut"), Se(C, "handleMutations"), document.addEventListener("focusin", g), document.addEventListener("focusout", y);
        const w = new MutationObserver(C);
        return d && w.observe(d, { childList: !0, subtree: !0 }), () => {
          document.removeEventListener("focusin", g), document.removeEventListener("focusout", y), w.disconnect();
        };
      }
    }, [o, d, b.paused]), u.useEffect(() => {
      if (d) {
        $s.add(b);
        const g = document.activeElement;
        if (!d.contains(g)) {
          const C = new CustomEvent(xr, Ls);
          d.addEventListener(xr, m), d.dispatchEvent(C), C.defaultPrevented || (ai(ui(mo(d)), { select: !0 }), document.activeElement === g && tt(d));
        }
        return () => {
          d.removeEventListener(xr, m), setTimeout(() => {
            const C = new CustomEvent(wr, Ls);
            d.addEventListener(wr, l), d.dispatchEvent(C), C.defaultPrevented || tt(g ?? document.body, { select: !0 }), d.removeEventListener(wr, l), $s.remove(b);
          }, 0);
        };
      }
    }, [d, m, l, b]);
    const v = u.useCallback(
      (g) => {
        if (!r && !o || b.paused) return;
        const y = g.key === "Tab" && !g.altKey && !g.ctrlKey && !g.metaKey, C = document.activeElement;
        if (y && C) {
          const w = g.currentTarget, [x, E] = ii(w);
          x && E ? !g.shiftKey && C === E ? (g.preventDefault(), r && tt(x, { select: !0 })) : g.shiftKey && C === x && (g.preventDefault(), r && tt(E, { select: !0 })) : C === w && g.preventDefault();
        }
      },
      [r, o, b.paused]
    );
    return /* @__PURE__ */ f(Z.div, { tabIndex: -1, ...i, ref: h, onKeyDown: v });
  }, "FocusScope")
);
function ai(e, { select: t = !1 } = {}) {
  const n = document.activeElement;
  for (const r of e)
    if (tt(r, { select: t }), document.activeElement !== n) return;
}
Se(ai, "focusFirst");
function ii(e) {
  const t = mo(e), n = Wr(t, e), r = Wr(t.reverse(), e);
  return [n, r];
}
Se(ii, "getTabbableEdges");
function mo(e) {
  const t = [], n = document.createTreeWalker(e, NodeFilter.SHOW_ELEMENT, {
    acceptNode: /* @__PURE__ */ Se((r) => {
      const o = r.tagName === "INPUT" && r.type === "hidden";
      return r.disabled || r.hidden || o ? NodeFilter.FILTER_SKIP : r.tabIndex >= 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    }, "acceptNode")
  });
  for (; n.nextNode(); ) t.push(n.currentNode);
  return t;
}
Se(mo, "getTabbableCandidates");
function Wr(e, t) {
  const n = typeof t.checkVisibility == "function" && t.checkVisibility({ checkVisibilityCSS: !0 });
  for (const r of e)
    if (!(n ? !r.checkVisibility({ checkVisibilityCSS: !0 }) : li(r, { upTo: t })))
      return r;
}
Se(Wr, "findVisible");
function li(e, { upTo: t }) {
  if (getComputedStyle(e).visibility === "hidden") return !0;
  for (; e; ) {
    if (t !== void 0 && e === t) return !1;
    if (getComputedStyle(e).display === "none") return !0;
    e = e.parentElement;
  }
  return !1;
}
Se(li, "isHidden");
function ci(e) {
  return e instanceof HTMLInputElement && "select" in e;
}
Se(ci, "isSelectableInput");
function tt(e, { select: t = !1 } = {}) {
  if (e && e.focus) {
    const n = document.activeElement;
    e.focus({ preventScroll: !0 }), e !== n && ci(e) && t && e.select();
  }
}
Se(tt, "focus");
var $s = di();
function di() {
  let e = [];
  return {
    add(t) {
      const n = e[0];
      t !== n && n?.pause(), e = Ur(e, t), e.unshift(t);
    },
    remove(t) {
      e = Ur(e, t), e[0]?.resume();
    }
  };
}
Se(di, "createFocusScopesStack");
function Ur(e, t) {
  const n = [...e], r = n.indexOf(t);
  return r !== -1 && n.splice(r, 1), n;
}
Se(Ur, "arrayRemove");
function ui(e) {
  return e.filter((t) => t.tagName !== "A");
}
Se(ui, "removeLinks");
var Af = Object.defineProperty, Df = (e, t) => Af(e, "name", { value: t, configurable: !0 }), po = /* @__PURE__ */ u.forwardRef(
  /* @__PURE__ */ Df(function(t, n) {
    const { container: r, ...o } = t, [s, a] = u.useState(!1);
    de(() => a(!0), []);
    const i = r || s && globalThis?.document?.body;
    return i ? pn.createPortal(/* @__PURE__ */ f(Z.div, { ...o, ref: n }), i) : null;
  }, "Portal")
), Mf = Object.defineProperty, at = (e, t) => Mf(e, "name", { value: t, configurable: !0 });
function fi(e, t) {
  return u.useReducer((n, r) => t[n][r] ?? n, e);
}
at(fi, "useStateMachine");
var lt = /* @__PURE__ */ at((e) => {
  const { present: t, children: n } = e, r = mi(t), o = typeof n == "function" ? n({ present: r.isPresent }) : u.Children.only(n), s = pi(r.ref, hi(o));
  return typeof n == "function" || r.isPresent ? u.cloneElement(o, { ref: s }) : null;
}, "Presence");
function mi(e) {
  const [t, n] = u.useState(), r = u.useRef(null), o = u.useRef(e), s = u.useRef("none"), a = u.useRef(void 0), i = e ? "mounted" : "unmounted", [d, c] = fi(i, {
    mounted: {
      UNMOUNT: "unmounted",
      ANIMATION_OUT: "unmountSuspended"
    },
    unmountSuspended: {
      MOUNT: "mounted",
      ANIMATION_END: "unmounted"
    },
    unmounted: {
      MOUNT: "mounted"
    }
  });
  return u.useEffect(() => {
    d === "mounted" ? (s.current = a.current ?? Wt(r.current), a.current = void 0) : s.current = "none";
  }, [d]), de(() => {
    const m = r.current, l = o.current;
    if (l !== e) {
      const h = s.current, b = Wt(m);
      e ? (a.current = b, c("MOUNT")) : b === "none" || m?.display === "none" ? c("UNMOUNT") : c(l && h !== b ? "ANIMATION_OUT" : "UNMOUNT"), o.current = e;
    }
  }, [e, c]), de(() => {
    if (t) {
      let m;
      const l = t.ownerDocument.defaultView ?? window, p = /* @__PURE__ */ at((b) => {
        const g = Wt(r.current).includes(CSS.escape(b.animationName));
        if (b.target === t && g && (c("ANIMATION_END"), !o.current)) {
          const y = t.style.animationFillMode;
          t.style.animationFillMode = "forwards", m = l.setTimeout(() => {
            t.style.animationFillMode === "forwards" && (t.style.animationFillMode = y);
          });
        }
      }, "handleAnimationEnd"), h = /* @__PURE__ */ at((b) => {
        b.target === t && (s.current = Wt(r.current));
      }, "handleAnimationStart");
      return t.addEventListener("animationstart", h), t.addEventListener("animationcancel", p), t.addEventListener("animationend", p), () => {
        l.clearTimeout(m), t.removeEventListener("animationstart", h), t.removeEventListener("animationcancel", p), t.removeEventListener("animationend", p);
      };
    } else
      c("ANIMATION_END");
  }, [t, c]), {
    isPresent: ["mounted", "unmountSuspended"].includes(d),
    ref: u.useCallback((m) => {
      if (m) {
        const l = getComputedStyle(m);
        r.current = l, a.current = Wt(l);
      } else
        r.current = null;
      n(m);
    }, [])
  };
}
at(mi, "usePresence");
function Gr(e, t) {
  if (typeof e == "function")
    return e(t);
  e != null && (e.current = t);
}
at(Gr, "setRef");
function pi(...e) {
  const t = u.useRef(e);
  return t.current = e, u.useCallback((n) => {
    const r = t.current;
    let o = !1;
    const s = r.map((a) => {
      const i = Gr(a, n);
      return !o && typeof i == "function" && (o = !0), i;
    });
    if (o)
      return () => {
        for (let a = 0; a < s.length; a++) {
          const i = s[a];
          typeof i == "function" ? i() : Gr(r[a], null);
        }
      };
  }, []);
}
at(pi, "useStableComposedRefs");
function Wt(e) {
  return e?.animationName || "none";
}
at(Wt, "getAnimationName");
function hi(e) {
  let t = Object.getOwnPropertyDescriptor(e.props, "ref")?.get, n = t && "isReactWarning" in t && t.isReactWarning;
  return n ? e.ref : (t = Object.getOwnPropertyDescriptor(e, "ref")?.get, n = t && "isReactWarning" in t && t.isReactWarning, n ? e.props.ref : e.props.ref || e.ref);
}
at(hi, "getElementRef");
var Lf = Object.defineProperty, ho = (e, t) => Lf(e, "name", { value: t, configurable: !0 }), Rn = 0, zt = null;
function $f(e) {
  return gn(), e.children;
}
ho($f, "FocusGuards");
function gn() {
  u.useEffect(() => {
    zt || (zt = { start: Kr(), end: Kr() });
    const { start: e, end: t } = zt;
    return document.body.firstElementChild !== e && document.body.insertAdjacentElement("afterbegin", e), document.body.lastElementChild !== t && document.body.insertAdjacentElement("beforeend", t), Rn++, () => {
      Rn === 1 && (zt?.start.remove(), zt?.end.remove(), zt = null), Rn = Math.max(0, Rn - 1);
    };
  }, []);
}
ho(gn, "useFocusGuards");
function Kr() {
  const e = document.createElement("span");
  return e.setAttribute("data-radix-focus-guard", ""), e.tabIndex = 0, e.style.outline = "none", e.style.opacity = "0", e.style.position = "fixed", e.style.pointerEvents = "none", e;
}
ho(Kr, "createFocusGuard");
var We = function() {
  return We = Object.assign || function(t) {
    for (var n, r = 1, o = arguments.length; r < o; r++) {
      n = arguments[r];
      for (var s in n) Object.prototype.hasOwnProperty.call(n, s) && (t[s] = n[s]);
    }
    return t;
  }, We.apply(this, arguments);
};
function gi(e, t) {
  var n = {};
  for (var r in e) Object.prototype.hasOwnProperty.call(e, r) && t.indexOf(r) < 0 && (n[r] = e[r]);
  if (e != null && typeof Object.getOwnPropertySymbols == "function")
    for (var o = 0, r = Object.getOwnPropertySymbols(e); o < r.length; o++)
      t.indexOf(r[o]) < 0 && Object.prototype.propertyIsEnumerable.call(e, r[o]) && (n[r[o]] = e[r[o]]);
  return n;
}
function Ff(e, t, n) {
  if (n || arguments.length === 2) for (var r = 0, o = t.length, s; r < o; r++)
    (s || !(r in t)) && (s || (s = Array.prototype.slice.call(t, 0, r)), s[r] = t[r]);
  return e.concat(s || Array.prototype.slice.call(t));
}
var Mn = "right-scroll-bar-position", Ln = "width-before-scroll-bar", zf = "with-scroll-bars-hidden", Bf = "--removed-body-scroll-bar-size";
function Cr(e, t) {
  return typeof e == "function" ? e(t) : e && (e.current = t), e;
}
function Vf(e, t) {
  var n = Ge(function() {
    return {
      // value
      value: e,
      // last callback
      callback: t,
      // "memoized" public interface
      facade: {
        get current() {
          return n.value;
        },
        set current(r) {
          var o = n.value;
          o !== r && (n.value = r, n.callback(r, o));
        }
      }
    };
  })[0];
  return n.callback = t, n.facade;
}
var jf = typeof window < "u" ? u.useLayoutEffect : u.useEffect, Fs = /* @__PURE__ */ new WeakMap();
function Hf(e, t) {
  var n = Vf(null, function(r) {
    return e.forEach(function(o) {
      return Cr(o, r);
    });
  });
  return jf(function() {
    var r = Fs.get(n);
    if (r) {
      var o = new Set(r), s = new Set(e), a = n.current;
      o.forEach(function(i) {
        s.has(i) || Cr(i, null);
      }), s.forEach(function(i) {
        o.has(i) || Cr(i, a);
      });
    }
    Fs.set(n, e);
  }, [e]), n;
}
function Wf(e) {
  return e;
}
function Uf(e, t) {
  t === void 0 && (t = Wf);
  var n = [], r = !1, o = {
    read: function() {
      if (r)
        throw new Error("Sidecar: could not `read` from an `assigned` medium. `read` could be used only with `useMedium`.");
      return n.length ? n[n.length - 1] : e;
    },
    useMedium: function(s) {
      var a = t(s, r);
      return n.push(a), function() {
        n = n.filter(function(i) {
          return i !== a;
        });
      };
    },
    assignSyncMedium: function(s) {
      for (r = !0; n.length; ) {
        var a = n;
        n = [], a.forEach(s);
      }
      n = {
        push: function(i) {
          return s(i);
        },
        filter: function() {
          return n;
        }
      };
    },
    assignMedium: function(s) {
      r = !0;
      var a = [];
      if (n.length) {
        var i = n;
        n = [], i.forEach(s), a = n;
      }
      var d = function() {
        var m = a;
        a = [], m.forEach(s);
      }, c = function() {
        return Promise.resolve().then(d);
      };
      c(), n = {
        push: function(m) {
          a.push(m), c();
        },
        filter: function(m) {
          return a = a.filter(m), n;
        }
      };
    }
  };
  return o;
}
function Gf(e) {
  e === void 0 && (e = {});
  var t = Uf(null);
  return t.options = We({ async: !0, ssr: !1 }, e), t;
}
var vi = function(e) {
  var t = e.sideCar, n = gi(e, ["sideCar"]);
  if (!t)
    throw new Error("Sidecar: please provide `sideCar` property to import the right car");
  var r = t.read();
  if (!r)
    throw new Error("Sidecar medium not found");
  return u.createElement(r, We({}, n));
};
vi.isSideCarExport = !0;
function Kf(e, t) {
  return e.useMedium(t), vi;
}
var bi = Gf(), Sr = function() {
}, Jn = u.forwardRef(function(e, t) {
  var n = u.useRef(null), r = u.useState({
    onScrollCapture: Sr,
    onWheelCapture: Sr,
    onTouchMoveCapture: Sr
  }), o = r[0], s = r[1], a = e.forwardProps, i = e.children, d = e.className, c = e.removeScrollBar, m = e.enabled, l = e.shards, p = e.sideCar, h = e.noRelative, b = e.noIsolation, v = e.inert, g = e.allowPinchZoom, y = e.as, C = y === void 0 ? "div" : y, w = e.gapMode, x = gi(e, ["forwardProps", "children", "className", "removeScrollBar", "enabled", "shards", "sideCar", "noRelative", "noIsolation", "inert", "allowPinchZoom", "as", "gapMode"]), E = p, N = Hf([n, t]), k = We(We({}, x), o);
  return u.createElement(
    u.Fragment,
    null,
    m && u.createElement(E, { sideCar: bi, removeScrollBar: c, shards: l, noRelative: h, noIsolation: b, inert: v, setCallbacks: s, allowPinchZoom: !!g, lockRef: n, gapMode: w }),
    a ? u.cloneElement(u.Children.only(i), We(We({}, k), { ref: N })) : u.createElement(C, We({}, k, { className: d, ref: N }), i)
  );
});
Jn.defaultProps = {
  enabled: !0,
  removeScrollBar: !0,
  inert: !1
};
Jn.classNames = {
  fullWidth: Ln,
  zeroRight: Mn
};
var Yf = function() {
  if (typeof __webpack_nonce__ < "u")
    return __webpack_nonce__;
};
function Xf() {
  if (!document)
    return null;
  var e = document.createElement("style");
  e.type = "text/css";
  var t = Yf();
  return t && e.setAttribute("nonce", t), e;
}
function qf(e, t) {
  e.styleSheet ? e.styleSheet.cssText = t : e.appendChild(document.createTextNode(t));
}
function Zf(e) {
  var t = document.head || document.getElementsByTagName("head")[0];
  t.appendChild(e);
}
var Qf = function() {
  var e = 0, t = null;
  return {
    add: function(n) {
      e == 0 && (t = Xf()) && (qf(t, n), Zf(t)), e++;
    },
    remove: function() {
      e--, !e && t && (t.parentNode && t.parentNode.removeChild(t), t = null);
    }
  };
}, Jf = function() {
  var e = Qf();
  return function(t, n) {
    u.useEffect(function() {
      return e.add(t), function() {
        e.remove();
      };
    }, [t && n]);
  };
}, yi = function() {
  var e = Jf(), t = function(n) {
    var r = n.styles, o = n.dynamic;
    return e(r, o), null;
  };
  return t;
}, em = {
  left: 0,
  top: 0,
  right: 0,
  gap: 0
}, kr = function(e) {
  return parseInt(e || "", 10) || 0;
}, tm = function(e) {
  var t = window.getComputedStyle(document.body), n = t[e === "padding" ? "paddingLeft" : "marginLeft"], r = t[e === "padding" ? "paddingTop" : "marginTop"], o = t[e === "padding" ? "paddingRight" : "marginRight"];
  return [kr(n), kr(r), kr(o)];
}, nm = function(e) {
  if (e === void 0 && (e = "margin"), typeof window > "u")
    return em;
  var t = tm(e), n = document.documentElement.clientWidth, r = window.innerWidth;
  return {
    left: t[0],
    top: t[1],
    right: t[2],
    gap: Math.max(0, r - n + t[2] - t[0])
  };
}, rm = yi(), Gt = "data-scroll-locked", om = function(e, t, n, r) {
  var o = e.left, s = e.top, a = e.right, i = e.gap;
  return n === void 0 && (n = "margin"), `
  .`.concat(zf, ` {
   overflow: hidden `).concat(r, `;
   padding-right: `).concat(i, "px ").concat(r, `;
  }
  body[`).concat(Gt, `] {
    overflow: hidden `).concat(r, `;
    overscroll-behavior: contain;
    `).concat([
    t && "position: relative ".concat(r, ";"),
    n === "margin" && `
    padding-left: `.concat(o, `px;
    padding-top: `).concat(s, `px;
    padding-right: `).concat(a, `px;
    margin-left:0;
    margin-top:0;
    margin-right: `).concat(i, "px ").concat(r, `;
    `),
    n === "padding" && "padding-right: ".concat(i, "px ").concat(r, ";")
  ].filter(Boolean).join(""), `
  }
  
  .`).concat(Mn, ` {
    right: `).concat(i, "px ").concat(r, `;
  }
  
  .`).concat(Ln, ` {
    margin-right: `).concat(i, "px ").concat(r, `;
  }
  
  .`).concat(Mn, " .").concat(Mn, ` {
    right: 0 `).concat(r, `;
  }
  
  .`).concat(Ln, " .").concat(Ln, ` {
    margin-right: 0 `).concat(r, `;
  }
  
  body[`).concat(Gt, `] {
    `).concat(Bf, ": ").concat(i, `px;
  }
`);
}, zs = function() {
  var e = parseInt(document.body.getAttribute(Gt) || "0", 10);
  return isFinite(e) ? e : 0;
}, sm = function() {
  u.useEffect(function() {
    return document.body.setAttribute(Gt, (zs() + 1).toString()), function() {
      var e = zs() - 1;
      e <= 0 ? document.body.removeAttribute(Gt) : document.body.setAttribute(Gt, e.toString());
    };
  }, []);
}, am = function(e) {
  var t = e.noRelative, n = e.noImportant, r = e.gapMode, o = r === void 0 ? "margin" : r;
  sm();
  var s = u.useMemo(function() {
    return nm(o);
  }, [o]);
  return u.createElement(rm, { styles: om(s, !t, o, n ? "" : "!important") });
}, Yr = !1;
if (typeof window < "u")
  try {
    var Pn = Object.defineProperty({}, "passive", {
      get: function() {
        return Yr = !0, !0;
      }
    });
    window.addEventListener("test", Pn, Pn), window.removeEventListener("test", Pn, Pn);
  } catch {
    Yr = !1;
  }
var Bt = Yr ? { passive: !1 } : !1, im = function(e) {
  return e.tagName === "TEXTAREA";
}, xi = function(e, t) {
  if (!(e instanceof Element))
    return !1;
  var n = window.getComputedStyle(e);
  return (
    // not-not-scrollable
    n[t] !== "hidden" && // contains scroll inside self
    !(n.overflowY === n.overflowX && !im(e) && n[t] === "visible")
  );
}, lm = function(e) {
  return xi(e, "overflowY");
}, cm = function(e) {
  return xi(e, "overflowX");
}, Bs = function(e, t) {
  var n = t.ownerDocument, r = t;
  do {
    typeof ShadowRoot < "u" && r instanceof ShadowRoot && (r = r.host);
    var o = wi(e, r);
    if (o) {
      var s = Ci(e, r), a = s[1], i = s[2];
      if (a > i)
        return !0;
    }
    r = r.parentNode;
  } while (r && r !== n.body);
  return !1;
}, dm = function(e) {
  var t = e.scrollTop, n = e.scrollHeight, r = e.clientHeight;
  return [
    t,
    n,
    r
  ];
}, um = function(e) {
  var t = e.scrollLeft, n = e.scrollWidth, r = e.clientWidth;
  return [
    t,
    n,
    r
  ];
}, wi = function(e, t) {
  return e === "v" ? lm(t) : cm(t);
}, Ci = function(e, t) {
  return e === "v" ? dm(t) : um(t);
}, fm = function(e, t) {
  return e === "h" && t === "rtl" ? -1 : 1;
}, mm = function(e, t, n, r, o) {
  var s = fm(e, window.getComputedStyle(t).direction), a = s * r, i = n.target, d = t.contains(i), c = !1, m = a > 0, l = 0, p = 0;
  do {
    if (!i)
      break;
    var h = Ci(e, i), b = h[0], v = h[1], g = h[2], y = v - g - s * b;
    (b || y) && wi(e, i) && (l += y, p += b);
    var C = i.parentNode;
    i = C && C.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? C.host : C;
  } while (
    // portaled content
    !d && i !== document.body || // self content
    d && (t.contains(i) || t === i)
  );
  return (m && Math.abs(l) < 1 || !m && Math.abs(p) < 1) && (c = !0), c;
}, Tn = function(e) {
  return "changedTouches" in e ? [e.changedTouches[0].clientX, e.changedTouches[0].clientY] : [0, 0];
}, Vs = function(e) {
  return [e.deltaX, e.deltaY];
}, js = function(e) {
  return e && "current" in e ? e.current : e;
}, pm = function(e, t) {
  return e[0] === t[0] && e[1] === t[1];
}, hm = function(e) {
  return `
  .block-interactivity-`.concat(e, ` {pointer-events: none;}
  .allow-interactivity-`).concat(e, ` {pointer-events: all;}
`);
}, gm = 0, Vt = [];
function vm(e) {
  var t = u.useRef([]), n = u.useRef([0, 0]), r = u.useRef(), o = u.useState(gm++)[0], s = u.useState(yi)[0], a = u.useRef(e);
  u.useEffect(function() {
    a.current = e;
  }, [e]), u.useEffect(function() {
    if (e.inert) {
      document.body.classList.add("block-interactivity-".concat(o));
      var v = Ff([e.lockRef.current], (e.shards || []).map(js), !0).filter(Boolean);
      return v.forEach(function(g) {
        return g.classList.add("allow-interactivity-".concat(o));
      }), function() {
        document.body.classList.remove("block-interactivity-".concat(o)), v.forEach(function(g) {
          return g.classList.remove("allow-interactivity-".concat(o));
        });
      };
    }
  }, [e.inert, e.lockRef.current, e.shards]);
  var i = u.useCallback(function(v, g) {
    if ("touches" in v && v.touches.length === 2 || v.type === "wheel" && v.ctrlKey)
      return !a.current.allowPinchZoom;
    var y = Tn(v), C = n.current, w = "deltaX" in v ? v.deltaX : C[0] - y[0], x = "deltaY" in v ? v.deltaY : C[1] - y[1], E, N = v.target, k = Math.abs(w) > Math.abs(x) ? "h" : "v";
    if ("touches" in v && k === "h" && N.type === "range")
      return !1;
    var S = window.getSelection(), P = S && S.anchorNode, _ = P ? P === N || P.contains(N) : !1;
    if (_)
      return !1;
    var M = Bs(k, N);
    if (!M)
      return !0;
    if (M ? E = k : (E = k === "v" ? "h" : "v", M = Bs(k, N)), !M)
      return !1;
    if (!r.current && "changedTouches" in v && (w || x) && (r.current = E), !E)
      return !0;
    var A = r.current || E;
    return mm(A, g, v, A === "h" ? w : x);
  }, []), d = u.useCallback(function(v) {
    var g = v;
    if (!(!Vt.length || Vt[Vt.length - 1] !== s)) {
      var y = "deltaY" in g ? Vs(g) : Tn(g), C = t.current.filter(function(E) {
        return E.name === g.type && (E.target === g.target || g.target === E.shadowParent) && pm(E.delta, y);
      })[0];
      if (C && C.should) {
        g.cancelable && g.preventDefault();
        return;
      }
      if (!C) {
        var w = (a.current.shards || []).map(js).filter(Boolean).filter(function(E) {
          return E.contains(g.target);
        }), x = w.length > 0 ? i(g, w[0]) : !a.current.noIsolation;
        x && g.cancelable && g.preventDefault();
      }
    }
  }, []), c = u.useCallback(function(v, g, y, C) {
    var w = { name: v, delta: g, target: y, should: C, shadowParent: bm(y) };
    t.current.push(w), setTimeout(function() {
      t.current = t.current.filter(function(x) {
        return x !== w;
      });
    }, 1);
  }, []), m = u.useCallback(function(v) {
    n.current = Tn(v), r.current = void 0;
  }, []), l = u.useCallback(function(v) {
    c(v.type, Vs(v), v.target, i(v, e.lockRef.current));
  }, []), p = u.useCallback(function(v) {
    c(v.type, Tn(v), v.target, i(v, e.lockRef.current));
  }, []);
  u.useEffect(function() {
    return Vt.push(s), e.setCallbacks({
      onScrollCapture: l,
      onWheelCapture: l,
      onTouchMoveCapture: p
    }), document.addEventListener("wheel", d, Bt), document.addEventListener("touchmove", d, Bt), document.addEventListener("touchstart", m, Bt), function() {
      Vt = Vt.filter(function(v) {
        return v !== s;
      }), document.removeEventListener("wheel", d, Bt), document.removeEventListener("touchmove", d, Bt), document.removeEventListener("touchstart", m, Bt);
    };
  }, []);
  var h = e.removeScrollBar, b = e.inert;
  return u.createElement(
    u.Fragment,
    null,
    b ? u.createElement(s, { styles: hm(o) }) : null,
    h ? u.createElement(am, { noRelative: e.noRelative, gapMode: e.gapMode }) : null
  );
}
function bm(e) {
  for (var t = null; e !== null; )
    e instanceof ShadowRoot && (t = e.host, e = e.host), e = e.parentNode;
  return t;
}
const ym = Kf(bi, vm);
var er = u.forwardRef(function(e, t) {
  return u.createElement(Jn, We({}, e, { ref: t, sideCar: ym }));
});
er.classNames = Jn.classNames;
var xm = function(e) {
  if (typeof document > "u")
    return null;
  var t = Array.isArray(e) ? e[0] : e;
  return t.ownerDocument.body;
}, jt = /* @__PURE__ */ new WeakMap(), _n = /* @__PURE__ */ new WeakMap(), In = {}, Er = 0, Si = function(e) {
  return e && (e.host || Si(e.parentNode));
}, wm = function(e, t) {
  return t.map(function(n) {
    if (e.contains(n))
      return n;
    var r = Si(n);
    return r && e.contains(r) ? r : (console.error("aria-hidden", n, "in not contained inside", e, ". Doing nothing"), null);
  }).filter(function(n) {
    return !!n;
  });
}, Cm = function(e, t, n, r) {
  var o = wm(t, Array.isArray(e) ? e : [e]);
  In[n] || (In[n] = /* @__PURE__ */ new WeakMap());
  var s = In[n], a = [], i = /* @__PURE__ */ new Set(), d = new Set(o), c = function(l) {
    !l || i.has(l) || (i.add(l), c(l.parentNode));
  };
  o.forEach(c);
  var m = function(l) {
    !l || d.has(l) || Array.prototype.forEach.call(l.children, function(p) {
      if (i.has(p))
        m(p);
      else
        try {
          var h = p.getAttribute(r), b = h !== null && h !== "false", v = (jt.get(p) || 0) + 1, g = (s.get(p) || 0) + 1;
          jt.set(p, v), s.set(p, g), a.push(p), v === 1 && b && _n.set(p, !0), g === 1 && p.setAttribute(n, "true"), b || p.setAttribute(r, "true");
        } catch (y) {
          console.error("aria-hidden: cannot operate on ", p, y);
        }
    });
  };
  return m(t), i.clear(), Er++, function() {
    a.forEach(function(l) {
      var p = jt.get(l) - 1, h = s.get(l) - 1;
      jt.set(l, p), s.set(l, h), p || (_n.has(l) || l.removeAttribute(r), _n.delete(l)), h || l.removeAttribute(n);
    }), Er--, Er || (jt = /* @__PURE__ */ new WeakMap(), jt = /* @__PURE__ */ new WeakMap(), _n = /* @__PURE__ */ new WeakMap(), In = {});
  };
}, go = function(e, t, n) {
  n === void 0 && (n = "data-aria-hidden");
  var r = Array.from(Array.isArray(e) ? e : [e]), o = xm(e);
  return o ? (r.push.apply(r, Array.from(o.querySelectorAll("[aria-live], script"))), Cm(r, o, n, "aria-hidden")) : function() {
    return null;
  };
}, Sm = Object.defineProperty, Ie = (e, t) => Sm(e, "name", { value: t, configurable: !0 }), vo = "Dialog", [ki, ny] = /* @__PURE__ */ _e(vo), [km, Fe] = ki(vo), Ei = /* @__PURE__ */ Ie((e) => {
  const {
    __scopeDialog: t,
    children: n,
    open: r,
    defaultOpen: o,
    onOpenChange: s,
    modal: a = !0
  } = e, i = u.useRef(null), d = u.useRef(null), [c, m] = Ye({
    prop: r,
    defaultProp: o ?? !1,
    onChange: s,
    caller: vo
  }), [l, p] = u.useState(0), [h, b] = u.useState(0);
  return /* @__PURE__ */ f(
    km,
    {
      scope: t,
      triggerRef: i,
      contentRef: d,
      contentId: De(),
      titleId: De(),
      descriptionId: De(),
      titlePresent: l > 0,
      descriptionPresent: h > 0,
      setTitleCount: p,
      setDescriptionCount: b,
      open: c,
      onOpenChange: m,
      onOpenToggle: u.useCallback(() => m((v) => !v), [m]),
      modal: a,
      children: n
    }
  );
}, "Dialog"), Em = "DialogTrigger", Ni = /* @__PURE__ */ u.forwardRef(
  /* @__PURE__ */ Ie(function(t, n) {
    const { __scopeDialog: r, ...o } = t, s = Fe(Em, r), a = re(n, s.triggerRef);
    return /* @__PURE__ */ f(
      Z.button,
      {
        type: "button",
        "aria-haspopup": "dialog",
        "aria-expanded": s.open,
        "aria-controls": s.open ? s.contentId : void 0,
        "data-state": tr(s.open),
        ...o,
        ref: a,
        onClick: Y(t.onClick, s.onOpenToggle)
      }
    );
  }, "DialogTrigger")
), Ri = "DialogPortal", [Nm, Pi] = ki(Ri, {
  forceMount: void 0
}), Ti = /* @__PURE__ */ Ie((e) => {
  const { __scopeDialog: t, forceMount: n, children: r, container: o } = e, s = Fe(Ri, t);
  return /* @__PURE__ */ f(Nm, { scope: t, forceMount: n, children: u.Children.map(r, (a) => /* @__PURE__ */ f(lt, { present: n || s.open, children: /* @__PURE__ */ f(po, { asChild: !0, container: o, children: a }) })) });
}, "DialogPortal"), Xr = "DialogOverlay", _i = /* @__PURE__ */ u.forwardRef(
  /* @__PURE__ */ Ie(function(t, n) {
    const r = Pi(Xr, t.__scopeDialog), { forceMount: o = r.forceMount, ...s } = t, a = Fe(Xr, t.__scopeDialog);
    return a.modal ? /* @__PURE__ */ f(lt, { present: o || a.open, children: /* @__PURE__ */ f(Pm, { ...s, ref: n }) }) : null;
  }, "DialogOverlay")
), Rm = /* @__PURE__ */ Ke("DialogOverlay.RemoveScroll"), Pm = /* @__PURE__ */ u.forwardRef(
  // blank line to reduce diff noise
  /* @__PURE__ */ Ie(function(t, n) {
    const { __scopeDialog: r, ...o } = t, s = Fe(Xr, r), a = ri(), i = re(n, a);
    return (
      // Make sure `Content` is scrollable even when it doesn't live inside `RemoveScroll`
      // ie. when `Overlay` and `Content` are siblings
      /* @__PURE__ */ f(er, { as: Rm, allowPinchZoom: !0, shards: [s.contentRef], children: /* @__PURE__ */ f(
        Z.div,
        {
          "data-state": tr(s.open),
          ...o,
          ref: i,
          style: { pointerEvents: "auto", ...o.style }
        }
      ) })
    );
  }, "DialogOverlayImpl")
), ln = "DialogContent", Ii = /* @__PURE__ */ u.forwardRef(
  /* @__PURE__ */ Ie(function(t, n) {
    const r = Pi(ln, t.__scopeDialog), { forceMount: o = r.forceMount, ...s } = t, a = Fe(ln, t.__scopeDialog);
    return /* @__PURE__ */ f(lt, { present: o || a.open, children: a.modal ? /* @__PURE__ */ f(Tm, { ...s, ref: n }) : /* @__PURE__ */ f(_m, { ...s, ref: n }) });
  }, "DialogContent")
), Tm = /* @__PURE__ */ u.forwardRef(
  // blank line to reduce diff noise
  /* @__PURE__ */ Ie(function(t, n) {
    const r = Fe(ln, t.__scopeDialog), o = u.useRef(null), s = re(n, r.contentRef, o);
    return u.useEffect(() => {
      const a = o.current;
      if (a) return go(a);
    }, []), /* @__PURE__ */ f(
      Oi,
      {
        ...t,
        ref: s,
        trapFocus: r.open,
        disableOutsidePointerEvents: r.open,
        onCloseAutoFocus: Y(t.onCloseAutoFocus, (a) => {
          a.preventDefault(), r.triggerRef.current?.focus();
        }),
        onPointerDownOutside: Y(t.onPointerDownOutside, (a) => {
          const i = a.detail.originalEvent, d = i.button === 0 && i.ctrlKey === !0;
          (i.button === 2 || d) && a.preventDefault();
        }),
        onFocusOutside: Y(
          t.onFocusOutside,
          (a) => a.preventDefault()
        )
      }
    );
  }, "DialogContentModal")
), _m = /* @__PURE__ */ u.forwardRef(
  // blank line to reduce diff noise
  /* @__PURE__ */ Ie(function(t, n) {
    const r = Fe(ln, t.__scopeDialog), o = u.useRef(!1), s = u.useRef(!1);
    return /* @__PURE__ */ f(
      Oi,
      {
        ...t,
        ref: n,
        trapFocus: !1,
        disableOutsidePointerEvents: !1,
        onCloseAutoFocus: (a) => {
          t.onCloseAutoFocus?.(a), a.defaultPrevented || (o.current || r.triggerRef.current?.focus(), a.preventDefault()), o.current = !1, s.current = !1;
        },
        onInteractOutside: (a) => {
          t.onInteractOutside?.(a), a.defaultPrevented || (o.current = !0, a.detail.originalEvent.type === "pointerdown" && (s.current = !0));
          const i = a.target;
          r.triggerRef.current?.contains(i) && a.preventDefault(), a.detail.originalEvent.type === "focusin" && s.current && a.preventDefault();
        }
      }
    );
  }, "DialogContentNonModal")
), Oi = /* @__PURE__ */ u.forwardRef(
  // blank line to reduce diff noise
  /* @__PURE__ */ Ie(function(t, n) {
    const { __scopeDialog: r, trapFocus: o, onOpenAutoFocus: s, onCloseAutoFocus: a, ...i } = t, d = Fe(ln, r);
    return gn(), /* @__PURE__ */ f(Ze, { children: /* @__PURE__ */ f(
      fo,
      {
        asChild: !0,
        loop: !0,
        trapped: o,
        onMountAutoFocus: s,
        onUnmountAutoFocus: a,
        children: /* @__PURE__ */ f(
          Qn,
          {
            role: "dialog",
            id: d.contentId,
            "aria-describedby": d.descriptionPresent ? d.descriptionId : void 0,
            "aria-labelledby": d.titlePresent ? d.titleId : void 0,
            "data-state": tr(d.open),
            ...i,
            ref: n,
            deferPointerDownOutside: !0,
            onDismiss: () => d.onOpenChange(!1)
          }
        )
      }
    ) });
  }, "DialogContentImpl")
), Im = "DialogTitle", Ai = /* @__PURE__ */ u.forwardRef(
  /* @__PURE__ */ Ie(function(t, n) {
    const { __scopeDialog: r, ...o } = t, s = Fe(Im, r), { setTitleCount: a } = s;
    return de(() => (a((i) => i + 1), () => a((i) => i - 1)), [a]), /* @__PURE__ */ f(Z.h2, { id: s.titleId, ...o, ref: n });
  }, "DialogTitle")
), Om = "DialogDescription", $n = /* @__PURE__ */ u.forwardRef(
  // blank line to reduce diff noise
  /* @__PURE__ */ Ie(function(t, n) {
    const { __scopeDialog: r, ...o } = t, s = Fe(Om, r), { setDescriptionCount: a } = s;
    return de(() => (a((i) => i + 1), () => a((i) => i - 1)), [a]), /* @__PURE__ */ f(Z.p, { id: s.descriptionId, ...o, ref: n });
  }, "DialogDescription")
), Am = "DialogClose", Di = /* @__PURE__ */ u.forwardRef(
  /* @__PURE__ */ Ie(function(t, n) {
    const { __scopeDialog: r, ...o } = t, s = Fe(Am, r);
    return /* @__PURE__ */ f(
      Z.button,
      {
        type: "button",
        ...o,
        ref: n,
        onClick: Y(t.onClick, () => s.onOpenChange(!1))
      }
    );
  }, "DialogClose")
);
function tr(e) {
  return e ? "open" : "closed";
}
Ie(tr, "getState");
const vn = u.memo(
  u.forwardRef(
    ({
      children: e,
      trigger: t,
      title: n,
      description: r,
      footer: o,
      footerClassName: s,
      className: a,
      contentClassName: i,
      open: d,
      onOpenChange: c,
      onClose: m,
      defaultOpen: l,
      draggable: p = !0,
      ...h
    }, b) => {
      const [v, g] = u.useState({ x: 0, y: 0 }), [y, C] = u.useState(!1), w = u.useRef({ x: 0, y: 0 }), [x, E] = u.useState(
        l || !1
      ), N = d !== void 0, k = N ? d : x;
      u.useEffect(() => {
        k || (g({ x: 0, y: 0 }), C(!1));
      }, [k]);
      const S = (T) => {
        N || E(T), c?.(T), !T && m && m();
      }, P = (T) => {
        p && (C(!0), w.current = {
          x: T.clientX - v.x,
          y: T.clientY - v.y
        });
      };
      u.useEffect(() => {
        if (!y) return;
        let T;
        const D = ($) => {
          T = requestAnimationFrame(() => {
            g({
              x: $.clientX - w.current.x,
              y: $.clientY - w.current.y
            });
          });
        }, W = () => {
          C(!1);
        };
        return document.addEventListener("mousemove", D), document.addEventListener("mouseup", W), () => {
          cancelAnimationFrame(T), document.removeEventListener("mousemove", D), document.removeEventListener("mouseup", W);
        };
      }, [y]);
      const M = u.useId(), A = /* @__PURE__ */ O(Ze, { children: [
        !h.noHeader && /* @__PURE__ */ O(
          "div",
          {
            "data-testid": "modal-header",
            className: I(
              "relative flex flex-col space-y-1.5 border-b border-border bg-card/50 flex-shrink-0",
              p && "cursor-move",
              h.noPadding ? "p-1" : "p-[var(--ui-component-padding-y)]"
            ),
            children: [
              p && /* @__PURE__ */ f(
                "button",
                {
                  type: "button",
                  "aria-label": "Drag modal",
                  className: "absolute inset-0 cursor-move",
                  onMouseDown: P
                }
              ),
              /* @__PURE__ */ O("div", { className: "relative z-10 w-full", children: [
                /* @__PURE__ */ O("div", { className: "flex items-center justify-between", children: [
                  /* @__PURE__ */ f(
                    Ai,
                    {
                      className: I(
                        "text-lg font-semibold leading-none tracking-tight text-foreground",
                        !n && "sr-only"
                      ),
                      children: n || "Dialog"
                    }
                  ),
                  /* @__PURE__ */ O(Di, { className: "rounded-full p-1 opacity-70 ring-offset-background transition-all hover:opacity-100 hover:bg-accent focus:outline-none disabled:pointer-events-none cursor-pointer", children: [
                    /* @__PURE__ */ f(Pt, { className: "h-5 w-5 text-foreground" }),
                    /* @__PURE__ */ f("span", { className: "sr-only", children: "Close" })
                  ] })
                ] }),
                r ? /* @__PURE__ */ f(
                  $n,
                  {
                    id: M,
                    className: "text-sm text-muted-foreground mt-1.5",
                    children: r
                  }
                ) : /* @__PURE__ */ f(
                  $n,
                  {
                    id: M,
                    className: "sr-only",
                    children: "Dialog Content"
                  }
                )
              ] })
            ]
          }
        ),
        h.noHeader && /* @__PURE__ */ f($n, { id: M, className: "sr-only", children: "Dialog Content" }),
        /* @__PURE__ */ f(
          "div",
          {
            className: I(
              "flex-1 overflow-y-auto",
              h.noPadding ? "p-0" : "p-[var(--ui-modal-padding)]",
              i
            ),
            children: e
          }
        ),
        o && /* @__PURE__ */ f(
          "div",
          {
            className: I(
              "flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2 bg-background flex-shrink-0",
              "p-[var(--ui-component-padding-y)]",
              s
            ),
            children: o
          }
        )
      ] });
      return /* @__PURE__ */ O(
        Ei,
        {
          open: k,
          onOpenChange: S,
          ...h,
          children: [
            t && /* @__PURE__ */ f(Ni, { asChild: !0, children: t }),
            /* @__PURE__ */ O(Ti, { children: [
              /* @__PURE__ */ f(_i, { className: "fixed inset-0 z-50 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" }),
              /* @__PURE__ */ f(
                Ii,
                {
                  ref: b,
                  "aria-describedby": M,
                  className: I(
                    "fixed z-50 flex flex-col gap-0 bg-background",
                    !p && "duration-200",
                    !p && "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
                    !p && "bottom-0 left-0 right-0 w-full h-[90vh] rounded-t-xl border-t border-border",
                    !p && "data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom",
                    p && "left-[50%] top-[50%] h-auto max-h-[90vh] w-[90vw] max-w-lg rounded-md border border-border",
                    !p && "sm:left-[50%] sm:top-[50%] sm:bottom-auto sm:right-auto sm:h-auto sm:max-h-[90vh] sm:max-w-lg sm:rounded-md sm:border sm:border-border",
                    !p && "sm:data-[state=closed]:zoom-out-95 sm:data-[state=open]:zoom-in-95",
                    !p && "sm:data-[state=closed]:slide-out-to-left-1/2 sm:data-[state=closed]:slide-out-to-top-[48%]",
                    !p && "sm:data-[state=open]:slide-in-from-left-1/2 sm:data-[state=open]:slide-in-from-top-[48%]",
                    a
                  ),
                  style: p ? {
                    transform: `translate(calc(-50% + ${v.x}px), calc(-50% + ${v.y}px))`,
                    cursor: y ? "grabbing" : void 0
                  } : {
                    transform: "translate(-50%, -50%)"
                  },
                  children: A
                }
              )
            ] })
          ]
        }
      );
    }
  )
);
vn.displayName = "Modal";
const Dm = ({ children: e, className: t }) => /* @__PURE__ */ f(
  "div",
  {
    className: I(
      "flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2 gap-2 bg-background flex-shrink-0 p-[var(--ui-component-padding-y)]",
      t
    ),
    children: e
  }
);
Dm.displayName = "ModalFooter";
const ry = ({
  onResult: e,
  className: t,
  buttonLabel: n = "Calculator"
}) => {
  const [r, o] = Ge(!1), [s, a] = Ge("0"), i = (p) => ["+", "-", "*", "/"].includes(p), d = (p) => {
    const h = p.replace(/\s+/g, "");
    if (!/^[0-9.+\-*/]+$/.test(h))
      throw new Error("invalid");
    const b = [], v = [], g = {
      "+": 1,
      "-": 1,
      "*": 2,
      "/": 2
    }, y = () => {
      const x = v.pop();
      if (!x) return;
      const E = b.pop(), N = b.pop();
      if (N === void 0 || E === void 0)
        throw new Error("invalid");
      switch (x) {
        case "+":
          b.push(N + E);
          break;
        case "-":
          b.push(N - E);
          break;
        case "*":
          b.push(N * E);
          break;
        case "/":
          if (E === 0) throw new Error("div0");
          b.push(N / E);
          break;
        default:
          throw new Error("invalid");
      }
    }, C = h.match(/(\d+(?:\.\d+)?|[+\-*/])/g);
    if (!C)
      throw new Error("invalid");
    for (const x of C)
      if (i(x)) {
        for (; v.length > 0 && (() => {
          const E = v[v.length - 1];
          if (!E)
            return !1;
          const N = g[E], k = g[x];
          return N !== void 0 && k !== void 0 && N >= k;
        })(); )
          y();
        v.push(x);
      } else
        b.push(Number(x));
    for (; v.length > 0; )
      y();
    if (b.length !== 1 || Number.isNaN(b[0]))
      throw new Error("invalid");
    const [w] = b;
    if (w === void 0)
      throw new Error("invalid");
    return w;
  }, c = (p) => {
    if (p === "=")
      try {
        const h = d(s);
        a(h.toString()), e && e(h);
      } catch {
        a("Error");
      }
    else if (p === "C")
      a("0");
    else {
      if (s === "Error") {
        a(p);
        return;
      }
      const h = s === "0" && !i(p) ? p : `${s}${p}`;
      a(h);
    }
  }, m = rt(
    () => [
      "7",
      "8",
      "9",
      "/",
      "4",
      "5",
      "6",
      "*",
      "1",
      "2",
      "3",
      "-",
      "0",
      ".",
      "=",
      "+",
      "C"
    ],
    []
  ), l = /* @__PURE__ */ O("div", { className: `space-y-4 ${t || ""}`, children: [
    /* @__PURE__ */ f("div", { className: "bg-muted p-4 rounded text-right text-2xl font-mono text-foreground", children: s }),
    /* @__PURE__ */ f("div", { className: "grid grid-cols-4 gap-2", children: m.map((p) => /* @__PURE__ */ f(
      ye,
      {
        onClick: () => c(p),
        variant: p === "=" ? "default" : "outline",
        className: p === "C" ? "col-span-4" : "h-auto aspect-[5/4]",
        children: p
      },
      p
    )) })
  ] });
  return e ? l : /* @__PURE__ */ O("div", { className: "space-y-4", children: [
    /* @__PURE__ */ O(ye, { variant: "outline", size: "lg", onClick: () => o(!0), children: [
      /* @__PURE__ */ f(yd, { className: "me-2 h-4 w-4" }),
      n
    ] }),
    /* @__PURE__ */ f(vn, { open: r, onOpenChange: o, title: n, children: l })
  ] });
}, Mi = Xt("rounded-lg border", {
  variants: {
    variant: {
      default: "bg-card text-card-foreground border-border",
      destructive: "border-destructive/50 bg-destructive/10 text-destructive-foreground border-2",
      warning: "border-warning/50 bg-warning/10 text-warning-foreground border-2"
    }
  },
  defaultVariants: {
    variant: "default"
  }
}), Mm = u.memo(
  u.forwardRef(
    ({ className: e, variant: t, ...n }, r) => /* @__PURE__ */ f(
      "div",
      {
        ref: r,
        className: I(Mi({ variant: t }), e),
        ...n
      }
    )
  )
);
Mm.displayName = "Card";
const Lm = u.memo(
  u.forwardRef(
    ({ className: e, ...t }, n) => /* @__PURE__ */ f(
      "div",
      {
        ref: n,
        className: I(
          "flex flex-col space-y-1.5 p-[var(--ui-card-padding)]",
          e
        ),
        ...t
      }
    )
  )
);
Lm.displayName = "CardHeader";
const $m = u.memo(
  u.forwardRef(
    ({ className: e, ...t }, n) => /* @__PURE__ */ f(
      "div",
      {
        ref: n,
        className: I(
          "text-2xl font-semibold leading-none tracking-tight text-foreground",
          e
        ),
        ...t
      }
    )
  )
);
$m.displayName = "CardTitle";
const Fm = u.memo(
  u.forwardRef(
    ({ className: e, ...t }, n) => /* @__PURE__ */ f(
      "div",
      {
        ref: n,
        className: I("text-sm text-muted-foreground", e),
        ...t
      }
    )
  )
);
Fm.displayName = "CardDescription";
const zm = u.memo(
  u.forwardRef(
    ({ className: e, ...t }, n) => /* @__PURE__ */ f(
      "div",
      {
        ref: n,
        className: I("p-[var(--ui-card-padding)] pt-0", e),
        ...t
      }
    )
  )
);
zm.displayName = "CardContent";
const Bm = u.memo(
  u.forwardRef(
    ({ className: e, ...t }, n) => /* @__PURE__ */ f(
      "div",
      {
        ref: n,
        className: I(
          "flex items-center p-[var(--ui-card-padding)] pt-0",
          e
        ),
        ...t
      }
    )
  )
);
Bm.displayName = "CardFooter";
const oy = u.memo(
  ({
    isOpen: e,
    onOpen: t,
    onClose: n,
    title: r = "chatbot",
    buttonLabel: o = "Chatbot",
    children: s,
    className: a,
    panelClassName: i,
    bodyClassName: d,
    buttonClassName: c,
    footer: m,
    footerClassName: l,
    bodyRef: p
  }) => /* @__PURE__ */ O(
    "div",
    {
      className: I(
        "fixed bottom-4 right-4 z-50 flex flex-col items-end gap-3",
        a
      ),
      children: [
        e && /* @__PURE__ */ O(
          "div",
          {
            className: I(
              "flex w-[320px] max-w-[92vw] flex-col overflow-hidden rounded-2xl border border-border/70 bg-background shadow-[0_18px_40px_rgba(15,23,42,0.22)]",
              i
            ),
            children: [
              /* @__PURE__ */ O("div", { className: "flex items-center justify-between border-b border-border/60 bg-muted/40 px-4 py-3", children: [
                /* @__PURE__ */ f("div", { className: "text-sm font-semibold text-foreground", children: r }),
                /* @__PURE__ */ f(
                  "button",
                  {
                    type: "button",
                    onClick: n,
                    className: "rounded-full border border-border/70 bg-background/80 p-1 text-muted-foreground transition hover:text-foreground",
                    "aria-label": "チャットを閉じる",
                    children: /* @__PURE__ */ f(Pt, { className: "h-4 w-4" })
                  }
                )
              ] }),
              /* @__PURE__ */ O(
                "div",
                {
                  ref: p,
                  className: I("flex-1 overflow-y-auto px-4 py-3", d),
                  children: [
                    s,
                    m && /* @__PURE__ */ f(
                      "div",
                      {
                        className: I(
                          "mt-4 -mx-4 border-t border-border/60 bg-background/50 p-4 backdrop-blur supports-[backdrop-filter]:bg-background/50",
                          l
                        ),
                        children: m
                      }
                    )
                  ]
                }
              )
            ]
          }
        ),
        /* @__PURE__ */ O(
          "button",
          {
            type: "button",
            onClick: e ? n : t,
            className: I(
              "inline-flex items-center gap-2 rounded-full border border-border/70 bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-[0_12px_28px_rgba(15,23,42,0.25)] transition hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              c
            ),
            "aria-expanded": e,
            "aria-label": "チャットを開閉",
            children: [
              /* @__PURE__ */ f(jd, { className: "h-4 w-4" }),
              o
            ]
          }
        )
      ]
    }
  )
), Vm = u.memo(
  u.forwardRef(
    ({
      id: e,
      checked: t,
      onChange: n,
      label: r,
      className: o,
      disabled: s = !1,
      variant: a = "default"
    }, i) => {
      const d = (c) => {
        n(c.target.checked);
      };
      return a === "card" ? /* @__PURE__ */ O(
        "label",
        {
          className: I(
            Mi({ variant: "default" }),
            "w-full flex items-center gap-3 p-[var(--ui-component-padding-x)] transition-all min-h-[var(--ui-component-height)] cursor-pointer",
            t ? "border-theme-success/50" : "hover:bg-muted",
            s && "opacity-50 cursor-not-allowed",
            o
          ),
          children: [
            /* @__PURE__ */ f(
              "input",
              {
                ref: i,
                id: e,
                type: "checkbox",
                checked: t,
                onChange: d,
                disabled: s,
                className: "sr-only"
              }
            ),
            /* @__PURE__ */ f(
              "div",
              {
                className: I(
                  "text-[length:calc(var(--ui-checkbox-size)*1.5)] flex-shrink-0 transition-colors",
                  t ? "text-success" : "text-theme-border"
                ),
                children: t ? /* @__PURE__ */ f(Pd, { size: "1em" }) : /* @__PURE__ */ f(Od, { size: "1em" })
              }
            ),
            /* @__PURE__ */ f(
              "span",
              {
                className: I(
                  "text-ui font-medium",
                  t ? "text-foreground" : "text-muted-foreground"
                ),
                children: r
              }
            )
          ]
        }
      ) : /* @__PURE__ */ O(
        "label",
        {
          className: I(
            "flex items-center gap-2 min-h-[44px] cursor-pointer hover:bg-accent rounded px-2",
            s && "opacity-50 cursor-not-allowed",
            o
          ),
          children: [
            /* @__PURE__ */ f(
              "input",
              {
                ref: i,
                id: e,
                type: "checkbox",
                checked: t,
                onChange: d,
                disabled: s,
                className: "w-[var(--ui-checkbox-size)] h-[var(--ui-checkbox-size)] rounded border-2 border-border text-accent-foreground focus:ring-2 focus:ring-ring focus:ring-offset-2 cursor-pointer disabled:cursor-not-allowed"
              }
            ),
            /* @__PURE__ */ f("span", { className: "text-ui select-none text-foreground", children: r })
          ]
        }
      );
    }
  )
);
Vm.displayName = "Checkbox";
var jm = Object.defineProperty, bn = (e, t) => jm(e, "name", { value: t, configurable: !0 }), bo = "Collapsible", [Hm, sy] = /* @__PURE__ */ _e(bo), [Wm, yo] = Hm(bo), Um = /* @__PURE__ */ u.forwardRef(
  /* @__PURE__ */ bn(function(t, n) {
    const {
      __scopeCollapsible: r,
      open: o,
      defaultOpen: s,
      disabled: a,
      onOpenChange: i,
      ...d
    } = t, [c, m] = Ye({
      prop: o,
      defaultProp: s ?? !1,
      onChange: i,
      caller: bo
    });
    return /* @__PURE__ */ f(
      Wm,
      {
        scope: r,
        disabled: a,
        contentId: De(),
        open: c,
        onOpenToggle: u.useCallback(() => m((l) => !l), [m]),
        children: /* @__PURE__ */ f(
          Z.div,
          {
            "data-state": nr(c),
            "data-disabled": a ? "" : void 0,
            ...d,
            ref: n
          }
        )
      }
    );
  }, "Collapsible")
), Gm = "CollapsibleTrigger", Km = /* @__PURE__ */ u.forwardRef(
  // blank line to reduce diff noise
  /* @__PURE__ */ bn(function(t, n) {
    const { __scopeCollapsible: r, ...o } = t, s = yo(Gm, r);
    return /* @__PURE__ */ f(
      Z.button,
      {
        type: "button",
        "aria-controls": s.open ? s.contentId : void 0,
        "aria-expanded": s.open || !1,
        "data-state": nr(s.open),
        "data-disabled": s.disabled ? "" : void 0,
        disabled: s.disabled,
        ...o,
        ref: n,
        onClick: Y(t.onClick, s.onOpenToggle)
      }
    );
  }, "CollapsibleTrigger")
), Li = "CollapsibleContent", Ym = /* @__PURE__ */ u.forwardRef(
  // blank line to reduce diff noise
  /* @__PURE__ */ bn(function(t, n) {
    const { forceMount: r, ...o } = t, s = yo(Li, t.__scopeCollapsible);
    return /* @__PURE__ */ f(lt, { present: r || s.open, children: ({ present: a }) => /* @__PURE__ */ f(Xm, { ...o, ref: n, present: a }) });
  }, "CollapsibleContent")
), Xm = /* @__PURE__ */ u.forwardRef(/* @__PURE__ */ bn(function(t, n) {
  const { __scopeCollapsible: r, present: o, children: s, ...a } = t, i = yo(Li, r), [d, c] = u.useState(o), m = u.useRef(null), l = re(n, m), p = u.useRef(0), h = p.current, b = u.useRef(0), v = b.current, g = i.open || d, y = u.useRef(g), C = u.useRef(void 0);
  return u.useEffect(() => {
    const w = requestAnimationFrame(() => y.current = !1);
    return () => cancelAnimationFrame(w);
  }, []), de(() => {
    const w = m.current;
    if (w) {
      C.current = C.current || {
        transitionDuration: w.style.transitionDuration,
        animationName: w.style.animationName
      }, w.style.transitionDuration = "0s", w.style.animationName = "none";
      const x = w.getBoundingClientRect();
      p.current = x.height, b.current = x.width, y.current || (w.style.transitionDuration = C.current.transitionDuration, w.style.animationName = C.current.animationName), c(o);
    }
  }, [i.open, o]), /* @__PURE__ */ f(
    Z.div,
    {
      "data-state": nr(i.open),
      "data-disabled": i.disabled ? "" : void 0,
      id: i.contentId,
      hidden: !g,
      ...a,
      ref: l,
      style: {
        "--radix-collapsible-content-height": h ? `${h}px` : void 0,
        "--radix-collapsible-content-width": v ? `${v}px` : void 0,
        ...t.style
      },
      children: g && s
    }
  );
}, "CollapsibleContentImpl"));
function nr(e) {
  return e ? "open" : "closed";
}
bn(nr, "getState");
var qm = Um;
const ay = qm, iy = Km, ly = Ym, cy = ({
  open: e,
  onOpenChange: t,
  title: n,
  description: r,
  onConfirm: o,
  onCancel: s,
  confirmText: a = "Confirm",
  cancelText: i = "Cancel",
  variant: d = "default",
  loading: c = !1,
  showCancel: m = !0
}) => /* @__PURE__ */ f(
  vn,
  {
    open: e,
    onOpenChange: t,
    title: n,
    description: r,
    footer: /* @__PURE__ */ O(Ze, { children: [
      m && /* @__PURE__ */ f(ye, { variant: "outline", onClick: () => {
        s?.(), t(!1);
      }, disabled: c, children: i }),
      /* @__PURE__ */ f(ye, { variant: d, onClick: () => {
        o();
      }, loading: c, children: a })
    ] })
  }
), dy = ({
  patientName: e,
  patientId: t,
  additionalInfo: n,
  className: r = "",
  navigationBack: o,
  onBack: s,
  backLabel: a
}) => /* @__PURE__ */ f(
  "header",
  {
    className: `w-full border-b border-border bg-background ${r}`,
    children: /* @__PURE__ */ f("div", { className: "flex items-center justify-between gap-4 px-ui py-ui", children: /* @__PURE__ */ O("div", { className: "flex items-center gap-3 min-w-0", children: [
      s ? /* @__PURE__ */ O(ye, { variant: "link", className: "px-2 -ml-2", onClick: s, children: [
        /* @__PURE__ */ f(_a, { className: "h-4 w-4 mr-2" }),
        a || "戻る"
      ] }) : o,
      /* @__PURE__ */ O("div", { className: "min-w-0", children: [
        /* @__PURE__ */ O("div", { className: "flex items-center gap-2 min-w-0", children: [
          /* @__PURE__ */ f("h1", { className: "text-xl font-semibold text-foreground truncate", children: e }),
          t && /* @__PURE__ */ f("span", { className: "text-sm text-muted-foreground bg-card rounded px-2 py-1 flex items-center max-w-[120px]", children: /* @__PURE__ */ f(
            Wn,
            {
              text: t.length > 8 ? `${t.slice(0, 8)}...` : t,
              className: "w-full"
            }
          ) })
        ] }),
        n && /* @__PURE__ */ f("div", { className: "text-sm text-muted-foreground truncate", children: n })
      ] })
    ] }) })
  }
), uy = ({
  text: e,
  copyValue: t,
  className: n,
  onCopied: r,
  onCopyError: o
}) => {
  const s = (i) => i, a = async (i) => {
    i.stopPropagation();
    const d = t || e;
    try {
      await navigator.clipboard.writeText(d), r?.(d);
    } catch (c) {
      o?.(c);
    }
  };
  return /* @__PURE__ */ O(
    ye,
    {
      variant: "link",
      className: `p-0 h-auto font-normal hover:no-underline hover:text-primary items-center gap-1 ${n || ""}`,
      onClick: a,
      title: s("click_to_copy"),
      children: [
        e,
        /* @__PURE__ */ f(Dd, { className: "h-3 w-3 opacity-50" })
      ]
    }
  );
}, fy = R.memo(
  ({ date: e, format: t = "full", className: n, locale: r }) => {
    const o = r || "en", s = o === "ja" ? "ja-JP" : "en-GB";
    return /* @__PURE__ */ f("span", { className: n, children: (() => {
      switch (t) {
        case "weekday":
          return e.toLocaleDateString(s, { weekday: "long" });
        case "weekdayShort":
          return e.toLocaleDateString(s, { weekday: "short" });
        case "yearMonth":
          return o === "ja" ? `${e.getFullYear()}年${e.getMonth() + 1}月` : e.toLocaleDateString(s, {
            year: "numeric",
            month: "long"
          });
        case "monthDay":
          return o === "ja" ? `${e.getMonth() + 1}月${e.getDate()}日` : e.toLocaleDateString(s, {
            day: "numeric",
            month: "long"
          });
        case "monthDayShort": {
          if (o === "ja") {
            const c = e.toLocaleDateString(s, {
              weekday: "short"
            });
            return `${e.getMonth() + 1}/${e.getDate()} (${c})`;
          }
          const i = e.toLocaleDateString(s, {
            month: "short"
          }), d = e.toLocaleDateString(s, {
            weekday: "short"
          });
          return `${e.getDate()} ${i} (${d})`;
        }
        case "compact": {
          if (o === "ja") {
            const d = e.toLocaleDateString(s, {
              weekday: "short"
            });
            return `${e.getMonth() + 1}/${e.getDate()}
(${d})`;
          }
          const i = e.toLocaleDateString(s, {
            weekday: "short"
          });
          return `${e.getDate()}
${i}`;
        }
        case "date":
          return o === "ja" ? e.toLocaleDateString(s, {
            year: "numeric",
            month: "long",
            day: "numeric"
          }) : e.toLocaleDateString(s, {
            day: "numeric",
            month: "long",
            year: "numeric"
          });
        default:
          if (o === "ja") {
            const i = e.toLocaleDateString(s, {
              year: "numeric",
              month: "long",
              day: "numeric"
            }), d = e.toLocaleDateString(s, {
              weekday: "long"
            });
            return `${i}（${d}）`;
          }
          return e.toLocaleDateString(s, {
            weekday: "long",
            day: "numeric",
            month: "long",
            year: "numeric"
          });
      }
    })() });
  }
);
function Zm(e, t = "auto") {
  const n = Number.isFinite(e) && e > 0 ? Math.floor(e) : 0, r = t === "hh:mm:ss" || t === "auto" && n >= 3600, o = Math.floor(n / 3600), s = Math.floor(r ? n % 3600 / 60 : n / 60), a = n % 60, i = (d) => String(d).padStart(2, "0");
  return r ? `${i(o)}:${i(s)}:${i(a)}` : `${i(s)}:${i(a)}`;
}
function Qm(e) {
  const t = Number.isFinite(e) && e > 0 ? Math.floor(e) : 0, n = Math.floor(t / 3600), r = Math.floor(t % 3600 / 60), o = t % 60, s = [];
  return n && s.push(`${n}時間`), r && s.push(`${r}分`), (o || s.length === 0) && s.push(`${o}秒`), `残り${s.join("")}`;
}
function my({
  seconds: e,
  format: t = "auto",
  size: n = "md",
  tone: r = "default",
  label: o,
  className: s
}) {
  const a = Zm(e, t);
  return /* @__PURE__ */ f(
    "div",
    {
      className: ["digital-clock", `digital-clock-${n}`, `digital-clock-${r}`, s].filter(Boolean).join(" "),
      role: "timer",
      "aria-live": "off",
      "aria-label": o ?? Qm(e),
      children: /* @__PURE__ */ f("span", { className: "digital-clock-digits", children: a })
    }
  );
}
const $i = kc(
  void 0
), py = ({
  children: e,
  defaultSecondaryCalendar: t = "none",
  defaultPreferLocalCalendar: n = !1
}) => {
  const [r, o] = R.useState(t), [s, a] = R.useState(
    n
  ), i = rt(
    () => ({
      secondaryCalendar: r,
      preferLocalCalendar: s,
      setSecondaryCalendar: o,
      setPreferLocalCalendar: a
    }),
    [r, s]
  );
  return /* @__PURE__ */ f($i.Provider, { value: i, children: e });
}, Jm = () => {
  const e = Sc($i);
  return e || {
    secondaryCalendar: "none",
    preferLocalCalendar: !1,
    setSecondaryCalendar: () => {
    },
    setPreferLocalCalendar: () => {
    }
  };
}, ep = () => typeof navigator < "u" && navigator.language ? navigator.language : "en-US", Hs = (e, t) => {
  const n = t.toLowerCase();
  switch (e) {
    case "japanese":
      return n.startsWith("ja") ? t : "ja-JP";
    case "buddhist":
      return n.startsWith("th") ? t : "th-TH";
    case "islamic":
      return n.startsWith("ar") ? t : "ar-SA";
    case "chinese":
      return n.startsWith("zh") ? t : "zh-CN";
    default:
      return t;
  }
}, Ws = (e, t, n, r) => {
  const o = {
    year: "numeric",
    month: t.startsWith("ja") ? "2-digit" : "short",
    day: "2-digit"
  };
  return e === "japanese" && t.startsWith("ja") && (o.era = "long", o.month = "long", o.day = "numeric"), n && (o.hour = "2-digit", o.minute = "2-digit"), r && (o.weekday = "short"), o;
}, Nr = /* @__PURE__ */ new Map(), Us = (e, t) => {
  const n = `${e}-${JSON.stringify(t)}`;
  return Nr.has(n) || Nr.set(n, new Intl.DateTimeFormat(e, t)), Nr.get(n);
}, Gs = (e, t, n, r, o) => {
  const s = (a) => o === "islamic" ? a.formatToParts(e).filter((c) => c.type !== "era").map((c) => c.value).join("").replace(/\s{2,}/g, " ").trim() : a.format(e);
  try {
    return s(Us(t, r));
  } catch {
    return s(Us(n, r));
  }
}, hy = ({
  date: e,
  showDayOfWeek: t = !1,
  showTime: n = !1,
  className: r,
  calendar: o,
  showSecondary: s = !1,
  locale: a
}) => {
  const { secondaryCalendar: i, preferLocalCalendar: d } = Jm(), c = a || ep(), m = rt(() => {
    if (!e) return null;
    if (e instanceof Date) return e;
    const b = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(e);
    if (b) {
      const v = Number(b[1]), g = Number(b[2]), y = Number(b[3]);
      return new Date(v, g - 1, y);
    }
    return new Date(e);
  }, [e]), l = rt(() => o || (d ? c.startsWith("ja") ? "japanese" : c.startsWith("ar") ? "islamic" : c.startsWith("th") ? "buddhist" : c.startsWith("zh") ? "chinese" : "gregorian" : "gregorian"), [o, d, c]), p = rt(() => {
    if (!m || Number.isNaN(m.getTime()))
      return "-";
    let b = c;
    l !== "gregorian" && (b = `${Hs(l, c)}-u-ca-${{
      japanese: "japanese",
      buddhist: "buddhist",
      islamic: "islamic",
      chinese: "chinese"
    }[l]}`);
    const v = Ws(
      l,
      c,
      n,
      t
    );
    return Gs(
      m,
      b,
      c,
      v,
      l
    );
  }, [l, c, n, t, m]), h = rt(() => {
    if (!m || Number.isNaN(m.getTime()))
      return null;
    if (s && !d && i !== "none" && i !== l) {
      const b = {
        japanese: "japanese",
        buddhist: "buddhist",
        islamic: "islamic",
        chinese: "chinese"
      }, g = `${Hs(
        i,
        c
      )}-u-ca-${b[i]}`, y = Ws(
        i,
        c,
        n,
        t
      );
      return Gs(
        m,
        g,
        c,
        y,
        i
      );
    }
    return null;
  }, [
    s,
    d,
    i,
    l,
    c,
    n,
    t,
    m
  ]);
  return p === "-" ? /* @__PURE__ */ f("span", { className: r, children: "-" }) : /* @__PURE__ */ O("span", { className: r, children: [
    p,
    h && /* @__PURE__ */ O("span", { className: "text-muted-foreground ms-2", children: [
      "(",
      h,
      ")"
    ] })
  ] });
}, tp = Xt(
  "fixed z-50 gap-[var(--ui-gap-base)] bg-background p-[var(--ui-modal-padding)] shadow-lg data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:duration-300 data-[state=open]:duration-500",
  {
    variants: {
      side: {
        top: "inset-x-0 top-0 border-b data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top",
        bottom: "inset-x-0 bottom-0 border-t data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom",
        left: "inset-y-0 left-0 h-full w-3/4 border-r data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left sm:max-w-sm",
        right: "inset-y-0 right-0 h-full w-3/4 border-l data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right sm:max-w-sm"
      }
    },
    defaultVariants: {
      side: "right"
    }
  }
), gy = u.memo(
  ({
    isOpen: e,
    onClose: t,
    children: n,
    position: r = "right",
    noPadding: o = !1,
    title: s,
    description: a,
    className: i,
    width: d,
    trigger: c,
    overlayClassName: m,
    closeLabel: l = "Close"
  }) => /* @__PURE__ */ O(
    Ei,
    {
      open: e,
      onOpenChange: (p) => !p && t(),
      children: [
        c && /* @__PURE__ */ f(Ni, { asChild: !0, children: c }),
        /* @__PURE__ */ O(Ti, { children: [
          /* @__PURE__ */ f(
            _i,
            {
              className: I(
                "fixed inset-0 z-50 bg-black/40 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
                m
              )
            }
          ),
          /* @__PURE__ */ O(
            Ii,
            {
              className: I(
                tp({ side: r }),
                o && "p-0",
                i
              ),
              style: d ? { width: d, maxWidth: "100vw" } : void 0,
              children: [
                /* @__PURE__ */ O(
                  "div",
                  {
                    className: I(
                      "flex flex-col space-y-2 text-center sm:text-left",
                      o ? "px-6 pt-6 mb-4" : "mb-4"
                    ),
                    children: [
                      /* @__PURE__ */ f(
                        Ai,
                        {
                          className: I(
                            "text-lg font-semibold text-foreground",
                            !s && "sr-only"
                          ),
                          children: s || "Drawer"
                        }
                      ),
                      a && /* @__PURE__ */ f($n, { className: "text-sm text-muted-foreground", children: a })
                    ]
                  }
                ),
                /* @__PURE__ */ f("div", { className: "flex-1 overflow-y-auto -mx-[var(--ui-modal-padding)] px-[var(--ui-modal-padding)]", children: n }),
                /* @__PURE__ */ O(Di, { className: "absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-secondary", children: [
                  /* @__PURE__ */ f(Pt, { className: "h-4 w-4" }),
                  /* @__PURE__ */ f("span", { className: "sr-only", children: l })
                ] })
              ]
            }
          )
        ] })
      ]
    }
  )
), vy = u.memo(
  ({
    trigger: e,
    items: t,
    align: n = "left",
    side: r = "bottom",
    autoFlip: o = !0,
    autoSide: s = !0,
    offset: a = 8,
    minWidthPx: i = 160,
    className: d = ""
  }) => {
    const [c, m] = Ge(!1), l = an(null), p = an(null), [h, b] = Ge({
      position: "fixed",
      top: -9999,
      left: -9999,
      visibility: "hidden",
      zIndex: 50
    }), v = u.useCallback(() => {
      const S = l.current?.getBoundingClientRect(), P = S ? Math.max(i, S.width) : i;
      b({
        position: "fixed",
        top: -9999,
        left: -9999,
        minWidth: P,
        visibility: "hidden",
        zIndex: 50
      });
    }, [i]), g = u.useCallback(() => {
      const k = l.current, S = p.current;
      if (!k || !S) return;
      const P = k.getBoundingClientRect(), _ = S.getBoundingClientRect(), M = window.innerWidth, A = window.innerHeight, T = 8, D = A - P.bottom - T, W = P.top - T;
      let $ = r;
      s && (D >= _.height ? $ = "bottom" : W >= _.height ? $ = "top" : $ = D >= W ? "bottom" : "top");
      const z = Math.max(i, P.width);
      let H = $ === "bottom" ? P.bottom + a : P.top - _.height - a;
      const F = Math.max(_.width, z), L = P.left, ie = P.right - F;
      let J = n;
      if (o) {
        const U = n === "left" ? L : ie, ae = U < T, G = U + F > M - T;
        n === "left" && G || n === "right" && ae ? J = n === "left" ? "right" : "left" : (ae || G) && (J = n);
      }
      const se = J === "left" ? L : ie, X = Math.min(
        M - T - F,
        Math.max(T, se)
      );
      if (s) {
        if ($ === "bottom" && H + _.height > A - T) {
          const U = P.top - _.height - a;
          U >= T && (H = U);
        } else if ($ === "top" && H < T) {
          const U = P.bottom + a;
          U + _.height <= A - T && (H = U);
        }
      }
      const K = $ === "bottom" ? Math.max(120, A - H - T) : Math.max(120, P.top - T);
      b({
        position: "fixed",
        top: H,
        left: X,
        minWidth: z,
        maxHeight: K,
        overflowY: "auto",
        zIndex: 50,
        visibility: "visible"
      });
    }, [n, o, s, i, a, r]);
    Ut(() => {
      const k = (S) => {
        const P = S.target;
        c && !l.current?.contains(P) && !p.current?.contains(P) && m(!1);
      };
      return c && document.addEventListener("mousedown", k), () => {
        document.removeEventListener("mousedown", k);
      };
    }, [c]), Ut(() => {
      if (!c) return;
      let k = 0;
      const S = () => {
        k || (k = window.requestAnimationFrame(() => {
          k = 0, g();
        }));
      };
      v(), S(), window.addEventListener("resize", S), window.addEventListener("scroll", S, !0);
      const P = p.current, _ = P ? new ResizeObserver(() => {
        S();
      }) : null;
      return P && _ && _.observe(P), () => {
        k && window.cancelAnimationFrame(k), window.removeEventListener("resize", S), window.removeEventListener("scroll", S, !0), _?.disconnect();
      };
    }, [g, c, v]), Ut(() => {
      if (!c) return;
      const k = (S) => {
        S.key === "Escape" && m(!1);
      };
      return window.addEventListener("keydown", k), () => window.removeEventListener("keydown", k);
    }, [c]);
    const y = (k) => {
      k.onClick(), m(!1);
    }, C = () => {
      m((k) => (k || v(), !k));
    }, w = (k) => {
      k?.defaultPrevented || C();
    }, x = (k) => {
      k.defaultPrevented || (k.key === "Enter" || k.key === " ") && (k.preventDefault(), C());
    }, E = {
      "aria-haspopup": "menu",
      "aria-expanded": c,
      onClick: w,
      onKeyDown: x,
      ref: (k) => {
        l.current = k;
      }
    }, N = u.isValidElement(e) ? u.cloneElement(e, {
      ...E,
      onClick: (k) => {
        e.props?.onClick?.(k), w(k);
      },
      onKeyDown: (k) => {
        e.props?.onKeyDown?.(k), x(k);
      },
      ...e.type === "button" ? { type: "button" } : {}
    }) : /* @__PURE__ */ f("button", { type: "button", ...E, children: e });
    return /* @__PURE__ */ O("div", { className: d, children: [
      /* @__PURE__ */ f("div", { style: { display: "inline-block" }, children: N }),
      c && Rc(
        /* @__PURE__ */ f(
          "div",
          {
            ref: p,
            role: "menu",
            style: h,
            className: "rounded-md border border-border bg-background shadow-lg",
            children: /* @__PURE__ */ f("div", { className: "py-[var(--ui-component-padding-y)]", children: t.map((k) => /* @__PURE__ */ O(
              "button",
              {
                type: "button",
                role: "menuitem",
                onClick: () => y(k),
                className: "flex w-full items-center gap-ui px-ui text-left text-ui text-foreground hover:bg-accent focus:bg-accent focus:outline-none min-h-[var(--ui-list-row-height)]",
                children: [
                  k.icon && /* @__PURE__ */ f("span", { className: "text-muted-foreground", children: k.icon }),
                  /* @__PURE__ */ f("span", { children: k.label })
                ]
              },
              k.label
            )) })
          }
        ),
        document.body
      )
    ] });
  }
), Fi = Xt(
  [
    "w-full inline-flex items-center justify-between gap-2 whitespace-nowrap",
    "rounded-[calc(var(--radius,0.5rem)-2px)]",
    "border border-solid border-border",
    "bg-background text-foreground",
    "transition-[border-color,box-shadow,background-color,color] duration-150 ease-in-out",
    "focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
    "disabled:cursor-not-allowed disabled:opacity-50"
  ].join(" "),
  {
    variants: {
      variant: {
        default: "",
        outline: "bg-transparent",
        ghost: "bg-transparent border-transparent shadow-none"
      },
      size: {
        sm: "min-h-[32px] px-3 py-1 text-sm",
        md: "h-ui px-3 text-ui min-h-ui-touch",
        lg: "h-12 px-5 py-3 text-lg"
      }
    },
    defaultVariants: {
      variant: "default",
      size: "md"
    }
  }
), zi = Xt(
  [
    "relative flex w-full select-none items-center rounded-sm",
    "outline-none",
    "focus:bg-accent focus:text-accent-foreground",
    "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
    "border-b border-border last:border-b-0"
  ].join(" "),
  {
    variants: {
      indicator: {
        none: "",
        check: ""
      },
      size: {
        sm: "min-h-[32px] py-1.5 text-sm",
        md: "h-auto text-ui min-h-[var(--ui-list-row-height)]",
        lg: "min-h-[48px] py-3 text-lg"
      },
      padding: {
        plain: "px-ui",
        withIndicator: "pl-[calc(var(--ui-component-padding-x)+1.5rem)] pr-ui"
      }
    },
    defaultVariants: {
      size: "md",
      indicator: "none",
      padding: "plain"
    }
  }
), np = u.forwardRef(
  ({
    value: e,
    onChange: t,
    options: n,
    className: r,
    placeholder: o,
    disabled: s = !1,
    variant: a = "default",
    size: i = "md"
  }, d) => {
    const [c, m] = u.useState(!1), l = u.useRef(null);
    u.useEffect(() => {
      const h = (b) => {
        l.current && !l.current.contains(b.target) && m(!1);
      };
      return document.addEventListener("mousedown", h), () => document.removeEventListener("mousedown", h);
    }, []);
    const p = (h) => {
      t(String(h)), m(!1);
    };
    return /* @__PURE__ */ O("div", { className: I("relative", r), ref: l, children: [
      /* @__PURE__ */ O(
        "div",
        {
          className: I(
            Fi({ variant: a, size: i }),
            "cursor-text",
            "focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2",
            s && "pointer-events-none"
          ),
          "aria-disabled": s,
          children: [
            /* @__PURE__ */ f(
              "input",
              {
                ref: d,
                type: "text",
                value: e,
                onChange: (h) => t(h.target.value),
                placeholder: o,
                disabled: s,
                className: I(
                  "w-full bg-transparent border-none text-foreground text-left appearance-none focus:outline-none p-0 m-0",
                  "placeholder:text-muted-foreground"
                ),
                onFocus: () => m(!0)
              }
            ),
            /* @__PURE__ */ f(
              "button",
              {
                type: "button",
                onClick: () => m((h) => !h),
                className: I(
                  "inline-flex items-center justify-center rounded",
                  "text-muted-foreground hover:bg-accent focus:outline-none"
                ),
                tabIndex: -1,
                "aria-label": "Toggle options",
                children: /* @__PURE__ */ f(
                  Zn,
                  {
                    className: I(i === "lg" ? "h-5 w-5" : "h-4 w-4")
                  }
                )
              }
            )
          ]
        }
      ),
      c && /* @__PURE__ */ f("div", { className: "absolute z-50 w-full mt-1 max-h-60 overflow-y-auto bg-background border border-border rounded-md shadow-lg scrollbar-thin", children: n.map((h) => /* @__PURE__ */ f(
        "button",
        {
          type: "button",
          onClick: () => p(h),
          className: I(
            zi({
              size: i,
              indicator: "none",
              padding: "plain"
            }),
            "w-full text-left text-foreground hover:bg-accent hover:text-accent-foreground"
          ),
          children: h
        },
        h
      )) })
    ] });
  }
);
np.displayName = "EditableSelect";
var rp = Object.defineProperty, op = (e, t) => rp(e, "name", { value: t, configurable: !0 }), sp = /* @__PURE__ */ u.forwardRef(
  /* @__PURE__ */ op(function(t, n) {
    return /* @__PURE__ */ f(
      Z.label,
      {
        ...t,
        ref: n,
        onMouseDown: (r) => {
          r.target.closest("button, input, select, textarea") || (t.onMouseDown?.(r), !r.defaultPrevented && r.detail > 1 && r.preventDefault());
        }
      }
    );
  }, "Label")
), Bi = sp, ap = (e) => e.type === "checkbox", sn = (e) => e instanceof Date, xo = (e) => e == null;
const Vi = (e) => typeof e == "object";
var kt = (e) => !xo(e) && !Array.isArray(e) && Vi(e) && !sn(e), ip = (e) => kt(e) && e.target ? ap(e.target) ? e.target.checked : e.target.value : e, lp = (e) => e.substring(0, e.search(/\.\d+(\.|$)/)) || e, cp = (e, t) => e.has(lp(t)), dp = (e) => {
  const t = e.constructor && e.constructor.prototype;
  return kt(t) && t.hasOwnProperty("isPrototypeOf");
}, up = typeof window < "u" && typeof window.HTMLElement < "u" && typeof document < "u";
function ji(e) {
  if (e instanceof Date)
    return new Date(e);
  const t = typeof FileList < "u" && e instanceof FileList;
  if (up && (e instanceof Blob || t))
    return e;
  const n = Array.isArray(e);
  if (!n && !(kt(e) && dp(e)))
    return e;
  const r = n ? [] : Object.create(Object.getPrototypeOf(e));
  for (const o in e)
    Object.prototype.hasOwnProperty.call(e, o) && (r[o] = ji(e[o]));
  return r;
}
var Hi = (e) => /^\w*$/.test(e), qr = (e) => e === void 0, fp = (e) => Array.isArray(e) ? e.filter(Boolean) : [], Wi = (e) => fp(e.replace(/["|']|\]/g, "").split(/\.|\[/)), Ne = (e, t, n) => {
  if (!t || !kt(e))
    return n;
  const r = (Hi(t) ? [t] : Wi(t)).reduce((o, s) => xo(o) ? o : o[s], e);
  return qr(r) || r === e ? qr(e[t]) ? n : e[t] : r;
}, Rr = (e) => typeof e == "boolean", On = (e) => typeof e == "function", Ks = (e, t, n) => {
  let r = -1;
  const o = Hi(t) ? [t] : Wi(t), s = o.length, a = s - 1;
  for (; ++r < s; ) {
    const i = o[r];
    let d = n;
    if (r !== a) {
      const c = e[i];
      d = kt(c) || Array.isArray(c) ? c : isNaN(+o[r + 1]) ? {} : [];
    }
    if (i === "__proto__" || i === "constructor" || i === "prototype")
      return;
    e[i] = d, e = e[i];
  }
};
const Ys = {
  BLUR: "blur",
  CHANGE: "change"
}, Xs = {
  all: "all"
}, wo = R.createContext(null);
wo.displayName = "HookFormControlContext";
const Co = () => R.useContext(wo);
var mp = (e, t, n, r = !0) => {
  const o = {
    defaultValues: t._defaultValues
  };
  for (const s in e)
    Object.defineProperty(o, s, {
      get: () => {
        const a = s;
        return t._proxyFormState[a] !== Xs.all && (t._proxyFormState[a] = !r || Xs.all), n && (n[a] = !0), e[a];
      }
    });
  return o;
};
const Ui = typeof window < "u" ? R.useLayoutEffect : R.useEffect;
function pp(e) {
  const t = Co(), { control: n = t, disabled: r, name: o, exact: s } = e || {}, [a, i] = R.useState(n._formState), d = R.useRef({
    isDirty: !1,
    isLoading: !1,
    dirtyFields: !1,
    touchedFields: !1,
    validatingFields: !1,
    isValidating: !1,
    isValid: !1,
    errors: !1
  });
  return Ui(() => n._subscribe({
    name: o,
    formState: d.current,
    exact: s,
    callback: (c) => {
      !r && i({
        ...n._formState,
        ...c
      });
    }
  }), [o, r, s]), R.useEffect(() => {
    d.current.isValid && n._setValid(!0);
  }, [n]), R.useMemo(() => mp(a, n, d.current, !1), [a, n]);
}
var hp = (e) => typeof e == "string", qs = (e, t, n, r, o) => hp(e) ? Ne(n, e, o) : Array.isArray(e) ? e.map((s) => Ne(n, s)) : n, Zs = (e) => xo(e) || !Vi(e);
function Fn(e, t, n = /* @__PURE__ */ new WeakSet()) {
  if (Zs(e) || Zs(t))
    return Object.is(e, t);
  if (sn(e) && sn(t))
    return Object.is(e.getTime(), t.getTime());
  const r = Object.keys(e), o = Object.keys(t);
  if (r.length !== o.length)
    return !1;
  if (n.has(e) || n.has(t))
    return !0;
  n.add(e), n.add(t);
  for (const s of r) {
    const a = e[s];
    if (!o.includes(s))
      return !1;
    if (s !== "ref") {
      const i = t[s];
      if (sn(a) && sn(i) || kt(a) && kt(i) || Array.isArray(a) && Array.isArray(i) ? !Fn(a, i, n) : !Object.is(a, i))
        return !1;
    }
  }
  return !0;
}
function gp(e) {
  const t = Co(), { control: n = t, name: r, defaultValue: o, disabled: s, exact: a, compute: i } = e || {}, d = R.useRef(o), c = R.useRef(i), m = R.useRef(void 0), l = R.useRef(n), p = R.useRef(r);
  c.current = i;
  const [h, b] = R.useState(() => {
    const x = n._getWatch(r, d.current);
    return c.current ? c.current(x) : x;
  }), v = R.useCallback((x) => {
    const E = qs(r, n._names, x || n._formValues, !1, d.current);
    return c.current ? c.current(E) : E;
  }, [n._formValues, n._names, r]), g = R.useCallback((x) => {
    if (!s) {
      const E = qs(r, n._names, x || n._formValues, !1, d.current);
      if (c.current) {
        const N = c.current(E);
        Fn(N, m.current) || (b(N), m.current = N);
      } else
        b(E);
    }
  }, [n._formValues, n._names, s, r]);
  Ui(() => ((l.current !== n || !Fn(p.current, r)) && (l.current = n, p.current = r, g()), n._subscribe({
    name: r,
    formState: {
      values: !0
    },
    exact: a,
    callback: (x) => {
      g(x.values);
    }
  })), [n, a, r, g]), R.useEffect(() => n._removeUnmounted());
  const y = l.current !== n, C = p.current, w = R.useMemo(() => {
    if (s)
      return null;
    const x = !y && !Fn(C, r);
    return y || x ? v() : null;
  }, [s, y, r, C, v]);
  return w !== null ? w : h;
}
function vp(e) {
  const t = Co(), { name: n, disabled: r, control: o = t, shouldUnregister: s, defaultValue: a, exact: i = !0 } = e, d = cp(o._names.array, n), c = R.useMemo(() => Ne(o._formValues, n, Ne(o._defaultValues, n, a)), [o, n, a]), m = gp({
    control: o,
    name: n,
    defaultValue: c,
    exact: i
  }), l = pp({
    control: o,
    name: n,
    exact: i
  }), p = R.useRef(e), h = R.useRef(void 0), b = R.useRef(o.register(n, {
    ...e.rules,
    value: m,
    ...Rr(e.disabled) ? { disabled: e.disabled } : {}
  }));
  p.current = e;
  const v = R.useMemo(() => Object.defineProperties({}, {
    invalid: {
      enumerable: !0,
      get: () => !!Ne(l.errors, n)
    },
    isDirty: {
      enumerable: !0,
      get: () => !!Ne(l.dirtyFields, n)
    },
    isTouched: {
      enumerable: !0,
      get: () => !!Ne(l.touchedFields, n)
    },
    isValidating: {
      enumerable: !0,
      get: () => !!Ne(l.validatingFields, n)
    },
    error: {
      enumerable: !0,
      get: () => Ne(l.errors, n)
    }
  }), [l, n]), g = R.useCallback((x) => b.current.onChange({
    target: {
      value: ip(x),
      name: n
    },
    type: Ys.CHANGE
  }), [n]), y = R.useCallback(() => b.current.onBlur({
    target: {
      value: Ne(o._formValues, n),
      name: n
    },
    type: Ys.BLUR
  }), [n, o._formValues]), C = R.useCallback((x) => {
    const E = Ne(o._fields, n);
    E && E._f && x && (E._f.ref = {
      focus: () => On(x.focus) && x.focus(),
      select: () => On(x.select) && x.select(),
      setCustomValidity: (N) => On(x.setCustomValidity) && x.setCustomValidity(N),
      reportValidity: () => On(x.reportValidity) && x.reportValidity()
    });
  }, [o._fields, n]), w = R.useMemo(() => ({
    name: n,
    value: m,
    ...Rr(r) || l.disabled ? { disabled: l.disabled || r } : {},
    onChange: g,
    onBlur: y,
    ref: C
  }), [n, r, l.disabled, g, y, C, m]);
  return R.useEffect(() => {
    const x = o._options.shouldUnregister || s, E = h.current;
    E && E !== n && !d && o.unregister(E), o.register(n, {
      ...p.current.rules,
      ...Rr(p.current.disabled) ? { disabled: p.current.disabled } : {}
    });
    const N = (k, S) => {
      const P = Ne(o._fields, k);
      P && P._f && (P._f.mount = S);
    };
    if (N(n, !0), x) {
      const k = ji(Ne(o._options.defaultValues, n, p.current.defaultValue));
      Ks(o._defaultValues, n, k), qr(Ne(o._formValues, n)) && Ks(o._formValues, n, k);
    }
    return !d && o.register(n), h.current = n, () => {
      (d ? x && !o._state.action : x) ? o.unregister(n) : N(n, !1);
    };
  }, [n, o, d, s]), R.useEffect(() => {
    o._setDisabledField({
      disabled: r,
      name: n
    });
  }, [r, n, o]), R.useMemo(() => ({
    field: w,
    formState: l,
    fieldState: v
  }), [w, l, v]);
}
const bp = (e) => e.render(vp(e)), So = R.createContext(null);
So.displayName = "HookFormContext";
const yp = () => R.useContext(So), xp = (e) => {
  const { children: t, watch: n, getValues: r, getFieldState: o, setError: s, clearErrors: a, setValue: i, trigger: d, formState: c, resetField: m, reset: l, handleSubmit: p, unregister: h, control: b, register: v, setFocus: g, subscribe: y } = e;
  return R.createElement(
    So.Provider,
    { value: R.useMemo(() => ({
      watch: n,
      getValues: r,
      getFieldState: o,
      setError: s,
      clearErrors: a,
      setValue: i,
      trigger: d,
      formState: c,
      resetField: m,
      reset: l,
      handleSubmit: p,
      unregister: h,
      control: b,
      register: v,
      setFocus: g,
      subscribe: y
    }), [
      a,
      b,
      c,
      o,
      r,
      p,
      v,
      l,
      m,
      s,
      g,
      i,
      y,
      d,
      h,
      n
    ]) },
    R.createElement(wo.Provider, { value: b }, t)
  );
}, by = xp, Gi = u.createContext(
  void 0
);
function rr() {
  const e = u.useContext(Gi), t = u.useContext(Ki), { getFieldState: n, formState: r } = yp();
  if (!e)
    throw new Error("useFormField should be used within <FormField>");
  const o = n(e.name, r), s = t.id;
  return {
    id: s,
    name: e.name,
    formItemId: `${s}-form-item`,
    formDescriptionId: `${s}-form-item-description`,
    formMessageId: `${s}-form-item-message`,
    ...o
  };
}
const Ki = u.createContext(
  {}
);
function yy(e) {
  return /* @__PURE__ */ f(Gi.Provider, { value: { name: e.name }, children: /* @__PURE__ */ f(bp, { ...e }) });
}
const wp = u.forwardRef(({ className: e, ...t }, n) => {
  const r = u.useId();
  return /* @__PURE__ */ f(Ki.Provider, { value: { id: r }, children: /* @__PURE__ */ f("div", { ref: n, className: I("space-y-2", e), ...t }) });
}), Cp = u.memo(wp);
Cp.displayName = "FormItem";
const Sp = u.forwardRef(({ className: e, ...t }, n) => {
  const { formItemId: r } = rr();
  return /* @__PURE__ */ f(
    Bi,
    {
      ref: n,
      className: I(
        "text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
        e
      ),
      htmlFor: r,
      ...t
    }
  );
}), kp = u.memo(Sp);
kp.displayName = "FormLabel";
const Ep = u.forwardRef(({ ...e }, t) => {
  const { error: n, formItemId: r, formDescriptionId: o, formMessageId: s } = rr();
  return /* @__PURE__ */ f(
    xa,
    {
      ref: t,
      id: r,
      "aria-describedby": n ? `${o} ${s}` : o,
      "aria-invalid": !!n,
      "aria-errormessage": s,
      ...e
    }
  );
}), Np = u.memo(Ep);
Np.displayName = "FormControl";
const Rp = u.forwardRef(({ className: e, ...t }, n) => {
  const { formDescriptionId: r } = rr();
  return /* @__PURE__ */ f(
    "p",
    {
      ref: n,
      id: r,
      className: I("text-sm text-muted-foreground", e),
      ...t
    }
  );
}), Pp = u.memo(Rp);
Pp.displayName = "FormDescription";
const Tp = u.forwardRef(({ className: e, children: t, ...n }, r) => {
  const { error: o, formMessageId: s } = rr(), a = o ? String(o?.message) : t;
  return a ? /* @__PURE__ */ f(
    "p",
    {
      ref: r,
      id: s,
      className: I(
        "text-sm font-medium text-destructive-foreground",
        e
      ),
      ...n,
      children: a
    }
  ) : null;
}), _p = u.memo(Tp);
_p.displayName = "FormMessage";
const Ip = R.memo(
  ({ src: e, alt: t, open: n, onOpenChange: r, maxWidthPx: o = 900 }) => {
    const s = an(null);
    return Ut(() => {
      const a = (i) => {
        i.key === "Escape" && n && r(!1);
      };
      return window.addEventListener("keydown", a), () => window.removeEventListener("keydown", a);
    }, [n, r]), /* @__PURE__ */ f(
      vn,
      {
        open: n,
        onOpenChange: r,
        noHeader: !0,
        noPadding: !0,
        contentClassName: "bg-black/90 border border-black/40 shadow-xl focus:outline-none flex items-center justify-center max-h-[90vh]",
        className: "p-2 md:p-4 bg-transparent border-none shadow-none",
        children: /* @__PURE__ */ f("div", { className: "w-full h-full flex items-center justify-center", children: /* @__PURE__ */ f(
          "img",
          {
            ref: s,
            src: e || void 0,
            alt: t || "Image",
            className: I(
              "rounded-md object-contain shadow-lg",
              "max-h-[80vh] w-auto",
              "transition-opacity duration-200"
            ),
            style: { maxWidth: `${o}px` }
          }
        ) })
      }
    );
  }
), xy = () => {
  const [e, t] = R.useState(!1), [n, r] = R.useState(null), [o, s] = R.useState(void 0);
  return { open: e, show: (d, c) => {
    r(d), s(c), t(!0);
  }, hide: () => t(!1), src: n, alt: o };
}, wy = ({
  src: e,
  alt: t,
  className: n,
  width: r,
  height: o,
  children: s
}) => {
  const [a, i] = R.useState(!1), d = t || "Image";
  return /* @__PURE__ */ O(Ze, { children: [
    /* @__PURE__ */ f(
      "button",
      {
        type: "button",
        className: I("cursor-pointer border-0 bg-transparent p-0", n),
        "aria-label": d,
        onClick: (c) => {
          c.stopPropagation(), i(!0);
        },
        onKeyDown: (c) => {
          (c.key === "Enter" || c.key === " ") && (c.preventDefault(), i(!0));
        },
        style: { width: r, height: o },
        children: s || /* @__PURE__ */ f(
          "img",
          {
            src: e || void 0,
            alt: t || "Image",
            className: "w-full h-full object-cover"
          }
        )
      }
    ),
    /* @__PURE__ */ f(
      Ip,
      {
        src: e,
        alt: t,
        open: a,
        onOpenChange: i
      }
    )
  ] });
}, Cy = ({
  title: e = "List",
  items: t,
  selectedId: n,
  onSelect: r,
  onLoadMore: o,
  hasMore: s = !1,
  isLoading: a = !1,
  loadMoreOffset: i = 120,
  emptyText: d = "No items available.",
  loadingText: c = "Loading more...",
  endText: m = "All items loaded.",
  headerMeta: l,
  hideHeader: p = !1,
  resizable: h = !1,
  resizeMinWidth: b = 240,
  resizeMaxWidth: v = "100%",
  className: g,
  listClassName: y,
  showDividers: C = !1,
  enableAdaptiveText: w = !1,
  width: x,
  onResize: E,
  selectedItem: N
}) => {
  const k = u.useRef(null), S = u.useRef(null), P = u.useRef(!1), _ = t?.length ?? 0, M = _ > 0, [A, T] = u.useState(
    void 0
  ), D = u.useRef(!1), W = x !== void 0 ? x : A, $ = u.useCallback(() => {
    if (!o || !s || a || P.current) return;
    const F = S.current;
    if (!F) return;
    F.scrollHeight - F.scrollTop - F.clientHeight <= i && (P.current = !0, o());
  }, [s, a, i, o]);
  u.useEffect(() => {
    a || (P.current = !1);
  }, [a]), u.useEffect(() => {
    P.current = !1;
  }, [_]), u.useEffect(() => {
    const F = S.current;
    if (!F) return;
    const L = () => $();
    return F.addEventListener("scroll", L, { passive: !0 }), $(), () => {
      F.removeEventListener("scroll", L);
    };
  }, [$]), u.useEffect(() => {
    (_ > 0 || s) && $();
  }, [s, _, $]);
  const z = (F) => {
    if (!h) return;
    F.preventDefault(), D.current = !0;
    const L = F.clientX, ie = k.current?.getBoundingClientRect().width || 0, J = (X) => {
      if (!D.current) return;
      const K = X.clientX - L;
      let U = ie + K;
      typeof b == "number" && (U = Math.max(U, b)), typeof v == "number" && (U = Math.min(U, v)), x !== void 0 ? E?.(U) : T(U);
    }, se = () => {
      D.current = !1, document.removeEventListener("mousemove", J), document.removeEventListener("mouseup", se);
    };
    document.addEventListener("mousemove", J), document.addEventListener("mouseup", se);
  }, H = "px-ui py-ui";
  return /* @__PURE__ */ O(
    "div",
    {
      ref: k,
      className: I(
        "relative h-full min-h-0 flex flex-col transition-width duration-0",
        // duration-0 to avoid lag during drag
        h || W !== void 0 ? "flex-none" : "w-full",
        g
      ),
      style: h || W !== void 0 ? {
        width: W,
        minWidth: b,
        maxWidth: v
      } : void 0,
      children: [
        !p && /* @__PURE__ */ O("div", { className: "flex items-center bg-primary px-ui py-ui w-full mb-2 shrink-0 flex-nowrap", children: [
          /* @__PURE__ */ f("div", { className: "flex items-center font-bold flex-grow ps-2 text-primary-foreground min-w-0", children: /* @__PURE__ */ f("span", { className: "truncate", children: e }) }),
          l && /* @__PURE__ */ f("div", { className: "text-xs text-primary-foreground/80 shrink-0 ml-2", children: l })
        ] }),
        /* @__PURE__ */ O(
          "div",
          {
            ref: S,
            "data-testid": "infinite-list-menu-scroll",
            className: I(
              "bg-background w-full flex-1 min-h-0 overflow-y-auto",
              y
            ),
            children: [
              M ? /* @__PURE__ */ f(
                "div",
                {
                  role: "listbox",
                  className: I(
                    !C && "space-y-0.5",
                    C && "divide-y divide-border"
                  ),
                  children: (t ?? []).map((F) => {
                    const L = N ? N.id === F.id : n === F.id;
                    return /* @__PURE__ */ O(
                      "button",
                      {
                        type: "button",
                        role: "option",
                        "aria-selected": L,
                        disabled: F.disabled,
                        "aria-disabled": F.disabled || void 0,
                        onClick: () => r?.(F.id, F),
                        className: I(
                          "w-full flex items-center gap-3 transition-colors duration-150 text-start",
                          H,
                          "text-sm",
                          F.disabled && "opacity-50 pointer-events-none",
                          L ? "bg-primary text-primary-foreground font-semibold" : "hover:bg-primary/20 hover:text-foreground",
                          !C && "rounded-md"
                          // removing rounded-md if dividers are shown usually looks better, but let's keep it consistent or check user preference.
                          // If showing dividers, usually we don't have gaps. The original had space-y-0.5.
                          // If showDividers is true, we should probably remove space-y-0.5 or set it to 0.
                        ),
                        children: [
                          F.icon && /* @__PURE__ */ f(
                            "span",
                            {
                              className: I(
                                "shrink-0",
                                L ? "text-primary-foreground" : "text-muted-foreground"
                              ),
                              children: F.icon
                            }
                          ),
                          /* @__PURE__ */ O("span", { className: "min-w-0 flex-1", children: [
                            /* @__PURE__ */ f("span", { className: "block truncate", children: w && typeof F.label == "string" ? /* @__PURE__ */ f(Wn, { text: F.label }) : F.label }),
                            F.description && /* @__PURE__ */ f("span", { className: "block truncate text-xs text-muted-foreground", children: F.description })
                          ] }),
                          F.meta !== void 0 && /* @__PURE__ */ f(
                            "span",
                            {
                              className: I(
                                "text-xs",
                                L ? "text-primary-foreground/80" : "text-muted-foreground"
                              ),
                              children: F.meta
                            }
                          ),
                          F.badge !== void 0 && /* @__PURE__ */ f(
                            "span",
                            {
                              className: I(
                                "ms-2 text-xs px-2 py-0.5 rounded",
                                L ? "bg-primary-foreground/20 text-primary-foreground" : "bg-muted text-muted-foreground"
                              ),
                              children: F.badge
                            }
                          )
                        ]
                      },
                      F.id
                    );
                  })
                }
              ) : /* @__PURE__ */ f("div", { className: "px-ui py-ui", children: a ? /* @__PURE__ */ O("div", { className: "flex items-center gap-2 text-xs text-muted-foreground", children: [
                /* @__PURE__ */ f(St, { size: "xs", variant: "secondary" }),
                /* @__PURE__ */ f("span", { children: c })
              ] }) : /* @__PURE__ */ f("div", { className: "text-xs text-muted-foreground", children: d }) }),
              M && /* @__PURE__ */ f("div", { className: "px-ui py-ui", children: a ? /* @__PURE__ */ O("div", { className: "flex items-center gap-2 text-xs text-muted-foreground", children: [
                /* @__PURE__ */ f(St, { size: "xs", variant: "secondary" }),
                /* @__PURE__ */ f("span", { children: c })
              ] }) : s ? null : /* @__PURE__ */ f("div", { className: "text-xs text-muted-foreground", children: m }) })
            ]
          }
        ),
        h && /* @__PURE__ */ f(
          "div",
          {
            "data-testid": "infinite-list-menu-resize-handle",
            className: "absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-primary/50 z-50 transition-colors",
            onMouseDown: z,
            "aria-hidden": "true"
          }
        )
      ]
    }
  );
}, Un = u.forwardRef(
  ({ className: e, type: t, ...n }, r) => /* @__PURE__ */ f(
    "input",
    {
      type: t,
      className: I(
        "flex h-ui w-full rounded-md border border-input bg-background px-3 text-foreground text-ui ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 min-h-ui-touch",
        e
      ),
      ref: r,
      ...n
    }
  )
);
Un.displayName = "Input";
const nt = 4, Op = (e) => e ? e.replace(/[^0-9]/g, "").slice(0, nt) : "", Ap = (e) => {
  const t = e.padEnd(nt, "_");
  return `${t.slice(0, 2)}:${t.slice(2, 4)}`;
}, Dp = (e) => {
  if (e.length !== nt) return !1;
  const t = Number.parseInt(e.slice(0, 2), 10), n = Number.parseInt(e.slice(2, 4), 10);
  return t >= 0 && t <= 23 && n >= 0 && n <= 59;
}, Mp = (e) => `${e.slice(0, 2)}:${e.slice(2, 4)}`, Lp = R.memo(
  ({
    open: e,
    title: t,
    onClose: n,
    displayContent: r,
    errorMessage: o,
    onNumberClick: s,
    onBackspace: a,
    onClear: i,
    onConfirm: d,
    additionalButton: c
  }) => /* @__PURE__ */ f(
    vn,
    {
      open: e,
      onOpenChange: (m) => !m && n(),
      title: t,
      onClose: n,
      children: /* @__PURE__ */ O("div", { className: "flex flex-col gap-4", children: [
        /* @__PURE__ */ f("div", { className: "bg-card border-2 border-theme-text-primary rounded-lg p-[var(--ui-modal-padding)] min-h-[60px] flex items-center justify-center text-lg font-semibold text-foreground", children: r }),
        o && /* @__PURE__ */ f("div", { className: "text-destructive-foreground text-sm text-center p-2 bg-red-50 dark:bg-red-950 rounded-md border-l-[3px] border-theme-danger", children: o }),
        /* @__PURE__ */ O("div", { className: "grid grid-cols-3 gap-2", children: [
          [1, 2, 3, 4, 5, 6, 7, 8, 9].map((m) => /* @__PURE__ */ f(
            "button",
            {
              type: "button",
              onClick: () => s(m.toString()),
              className: "min-h-[var(--ui-keypad-button-height)] text-lg font-semibold bg-background text-foreground border-2 border-theme-text-primary rounded-lg cursor-pointer transition-all active:scale-95 active:brightness-90 hover:brightness-110",
              children: m
            },
            m
          )),
          c || /* @__PURE__ */ f("div", { className: "min-h-[var(--ui-keypad-button-height)] bg-card rounded-lg" }),
          /* @__PURE__ */ f(
            "button",
            {
              type: "button",
              onClick: () => s("0"),
              className: "min-h-[var(--ui-keypad-button-height)] text-lg font-semibold bg-background text-foreground border-2 border-theme-text-primary rounded-lg cursor-pointer transition-all active:scale-95 active:brightness-90 hover:brightness-110",
              children: "0"
            }
          ),
          /* @__PURE__ */ f(
            "button",
            {
              type: "button",
              onClick: a,
              className: "min-h-[var(--ui-keypad-button-height)] text-base font-semibold bg-background text-foreground border-2 border-theme-text-primary rounded-lg cursor-pointer transition-all active:scale-95 active:brightness-90 hover:brightness-110",
              children: "⌫"
            }
          )
        ] }),
        /* @__PURE__ */ O("div", { className: "grid grid-cols-2 gap-2 mt-2", children: [
          /* @__PURE__ */ f(
            "button",
            {
              type: "button",
              onClick: i,
              className: "min-h-[var(--ui-keypad-button-height)] text-base font-semibold bg-background text-foreground border-2 border-theme-text-primary rounded-lg cursor-pointer transition-all active:scale-95 active:bg-destructive active:text-white active:border-theme-danger hover:bg-destructive hover:text-white hover:border-theme-danger",
              children: "C"
            }
          ),
          /* @__PURE__ */ f(
            "button",
            {
              type: "button",
              onClick: d,
              className: "min-h-[var(--ui-keypad-button-height)] text-base font-semibold bg-background text-foreground border-2 border-theme-text-primary rounded-lg cursor-pointer transition-all active:scale-95 active:brightness-90 hover:brightness-110",
              children: "OK"
            }
          )
        ] })
      ] })
    }
  )
), $p = {
  number: {
    title: "数値を入力",
    placeholder: "",
    maxLength: 10
  },
  phone: {
    title: "電話番号を入力",
    placeholder: "090-0000-0000",
    maxLength: 13
  },
  time: {
    title: "時刻を入力",
    placeholder: "__:__",
    maxLength: nt
  }
}, zn = R.memo(
  ({
    open: e,
    onClose: t,
    onSubmit: n,
    variant: r = "number",
    initialValue: o = "",
    title: s,
    placeholder: a,
    maxLength: i,
    allowDecimal: d = !1
  }) => {
    const c = rt(
      () => r === "time" ? Op(o) : o,
      [r, o]
    ), [m, l] = Ge(c), [p, h] = Ge(""), b = rt(() => $p[r], [r]), v = s ?? b.title, g = a ?? b.placeholder, y = r === "time" ? nt : i ?? b.maxLength, C = r === "number" && d, w = r === "phone", x = r === "time";
    Ut(() => {
      e && (l(c), h(""));
    }, [e, c]);
    const E = Ft(
      (T) => {
        if (x) {
          l((D) => D.length >= nt ? (h(`最大${nt}文字まで入力できます`), D) : (h(""), D.length === 0 && Number.parseInt(T, 10) >= 3 ? `0${T}` : (D + T).slice(0, nt)));
          return;
        }
        l((D) => D.length >= y ? (h(`最大${y}文字まで入力できます`), D) : (h(""), `${D}${T}`));
      },
      [y, x]
    ), N = Ft(() => {
      w && l((T) => T.length >= y ? (h(`最大${y}文字まで入力できます`), T) : T.endsWith("-") ? (h("ハイフンを連続して入力することはできません"), T) : (h(""), `${T}-`));
    }, [w, y]), k = Ft(() => {
      C && l((T) => T.includes(".") ? (h("小数点は1つまでです"), T) : (h(""), `${T}.`));
    }, [C]), S = Ft(() => {
      l((T) => T.slice(0, -1)), h("");
    }, []), P = Ft(() => {
      l(""), h("");
    }, []), _ = Ft(() => {
      if (x) {
        l((T) => Dp(T) ? (n(Mp(T)), T) : (h("有効な時刻を 4 桁で入力してください（例: 0930）"), T));
        return;
      }
      l((T) => T === "" ? (h("値を入力してください"), T) : C && T.endsWith(".") ? (h("小数点で終わることはできません"), T) : w && T.endsWith("-") ? (h("ハイフンで終わることはできません"), T) : (n(T), T));
    }, [C, w, x, n]);
    Ut(() => {
      if (!e) return;
      const T = (D) => {
        D.key >= "0" && D.key <= "9" || D.code >= "Numpad0" && D.code <= "Numpad9" ? (D.preventDefault(), E(D.key)) : w && (D.key === "-" || D.code === "NumpadSubtract" || D.key === "Minus") ? (D.preventDefault(), N()) : C && (D.key === "." || D.code === "NumpadDecimal") ? (D.preventDefault(), k()) : D.key === "Backspace" ? (D.preventDefault(), S()) : D.key === "Enter" ? (D.preventDefault(), _()) : D.key === "Escape" && (D.preventDefault(), t());
      };
      return window.addEventListener("keydown", T), () => window.removeEventListener("keydown", T);
    }, [
      e,
      w,
      C,
      t,
      E,
      N,
      k,
      S,
      _
    ]);
    const M = x ? /* @__PURE__ */ O("div", { className: "flex flex-col items-center justify-center gap-2 w-full", children: [
      /* @__PURE__ */ f(
        "span",
        {
          style: {
            fontSize: "24px",
            fontFamily: "monospace",
            color: "hsl(var(--foreground))",
            letterSpacing: "2px",
            fontWeight: 600
          },
          children: Ap(m)
        }
      ),
      /* @__PURE__ */ O(
        "span",
        {
          style: { fontSize: "12px", color: "var(--theme-text-secondary)" },
          children: [
            "入力: ",
            m.padEnd(nt, "・")
          ]
        }
      )
    ] }) : /* @__PURE__ */ f(
      "span",
      {
        style: {
          fontSize: "24px",
          fontFamily: "monospace",
          color: "hsl(var(--foreground))",
          fontWeight: 600
        },
        children: m || /* @__PURE__ */ f("span", { style: { color: "var(--theme-text-secondary)" }, children: g })
      }
    ), A = rt(() => {
      if (w || C)
        return /* @__PURE__ */ f(
          "button",
          {
            type: "button",
            onClick: w ? N : k,
            className: "min-h-[var(--ui-keypad-button-height)] text-lg font-semibold bg-background text-foreground border-2 border-theme-text-primary rounded-lg cursor-pointer transition-all active:scale-95 active:brightness-90 hover:brightness-110",
            children: w ? "-" : "."
          }
        );
    }, [w, C, N, k]);
    return /* @__PURE__ */ f(
      Lp,
      {
        open: e,
        title: v,
        onClose: t,
        displayContent: M,
        errorMessage: p,
        onNumberClick: E,
        onBackspace: S,
        onClear: P,
        onConfirm: _,
        additionalButton: A
      }
    );
  }
);
zn.displayName = "KeypadModal";
const Fp = u.memo(
  u.forwardRef(({ className: e, ...t }, n) => /* @__PURE__ */ f(
    Bi,
    {
      ref: n,
      className: I(
        "text-ui font-medium leading-none text-foreground peer-disabled:cursor-not-allowed peer-disabled:opacity-70 peer-disabled:text-theme-disabled-text",
        e
      ),
      ...t
    }
  ))
);
Fp.displayName = "Label";
var zp = Object.defineProperty, Bp = (e, t) => zp(e, "name", { value: t, configurable: !0 });
function Zr(e, [t, n]) {
  return Math.min(n, Math.max(t, e));
}
Bp(Zr, "clamp");
var Vp = Object.defineProperty, ge = (e, t) => Vp(e, "name", { value: t, configurable: !0 });
// @__NO_SIDE_EFFECTS__
function ko(e) {
  const t = e + "CollectionProvider", [n, r] = /* @__PURE__ */ _e(t), [o, s] = n(
    t,
    { collectionRef: { current: null }, itemMap: /* @__PURE__ */ new Map() }
  ), a = /* @__PURE__ */ ge((v) => {
    const { scope: g, children: y } = v, C = u.useRef(null), w = u.useRef(/* @__PURE__ */ new Map()).current;
    return /* @__PURE__ */ f(o, { scope: g, itemMap: w, collectionRef: C, children: y });
  }, "CollectionProvider");
  a.displayName = t;
  const i = e + "CollectionSlot", d = /* @__PURE__ */ Ke(i), c = u.forwardRef(
    (v, g) => {
      const { scope: y, children: C } = v, w = s(i, y), x = re(g, w.collectionRef);
      return /* @__PURE__ */ f(d, { ref: x, children: C });
    }
  );
  c.displayName = i;
  const m = e + "CollectionItemSlot", l = "data-radix-collection-item", p = /* @__PURE__ */ Ke(m), h = u.forwardRef(
    (v, g) => {
      const { scope: y, children: C, ...w } = v, x = u.useRef(null), E = re(g, x), N = s(m, y);
      return u.useEffect(() => (N.itemMap.set(x, { ref: x, ...w }), () => {
        N.itemMap.delete(x);
      })), /* @__PURE__ */ f(p, { [l]: "", ref: E, children: C });
    }
  );
  h.displayName = m;
  function b(v) {
    const g = s(e + "CollectionConsumer", v);
    return u.useCallback(() => {
      const C = g.collectionRef.current;
      if (!C) return [];
      const w = Array.from(C.querySelectorAll(`[${l}]`));
      return Array.from(g.itemMap.values()).sort(
        (N, k) => w.indexOf(N.ref.current) - w.indexOf(k.ref.current)
      );
    }, [g.collectionRef, g.itemMap]);
  }
  return ge(b, "useCollection"), [
    { Provider: a, Slot: c, ItemSlot: h },
    b,
    r
  ];
}
ge(ko, "createCollection");
var Qs = /* @__PURE__ */ new WeakMap(), ue, Te, Pr = (Te = class extends Map {
  constructor(n) {
    super(n);
    gs(this, ue);
    br(this, ue, [...super.keys()]), Qs.set(this, !0);
  }
  set(n, r) {
    return Qs.get(this) && (this.has(n) ? we(this, ue)[we(this, ue).indexOf(n)] = n : we(this, ue).push(n)), super.set(n, r), this;
  }
  insert(n, r, o) {
    const s = this.has(r), a = we(this, ue).length, i = Eo(n);
    let d = i >= 0 ? i : a + i;
    const c = d < 0 || d >= a ? -1 : d;
    if (c === this.size || s && c === this.size - 1 || c === -1)
      return this.set(r, o), this;
    const m = this.size + (s ? 0 : 1);
    i < 0 && d++;
    const l = [...we(this, ue)];
    let p, h = !1;
    for (let b = d; b < m; b++)
      if (d === b) {
        let v = l[b];
        l[b] === r && (v = l[b + 1]), s && this.delete(r), p = this.get(v), this.set(r, o);
      } else {
        !h && l[b - 1] === r && (h = !0);
        const v = l[h ? b : b - 1], g = p;
        p = this.get(v), this.delete(v), this.set(v, g);
      }
    return this;
  }
  with(n, r, o) {
    const s = new Te(this);
    return s.insert(n, r, o), s;
  }
  before(n) {
    const r = we(this, ue).indexOf(n) - 1;
    if (!(r < 0))
      return this.entryAt(r);
  }
  /**
   * Sets a new key-value pair at the position before the given key.
   */
  setBefore(n, r, o) {
    const s = we(this, ue).indexOf(n);
    return s === -1 ? this : this.insert(s, r, o);
  }
  after(n) {
    let r = we(this, ue).indexOf(n);
    if (r = r === -1 || r === this.size - 1 ? -1 : r + 1, r !== -1)
      return this.entryAt(r);
  }
  /**
   * Sets a new key-value pair at the position after the given key.
   */
  setAfter(n, r, o) {
    const s = we(this, ue).indexOf(n);
    return s === -1 ? this : this.insert(s + 1, r, o);
  }
  first() {
    return this.entryAt(0);
  }
  last() {
    return this.entryAt(-1);
  }
  clear() {
    return br(this, ue, []), super.clear();
  }
  delete(n) {
    const r = super.delete(n);
    return r && we(this, ue).splice(we(this, ue).indexOf(n), 1), r;
  }
  deleteAt(n) {
    const r = this.keyAt(n);
    return r !== void 0 ? this.delete(r) : !1;
  }
  at(n) {
    const r = Bn(we(this, ue), n);
    if (r !== void 0)
      return this.get(r);
  }
  entryAt(n) {
    const r = Bn(we(this, ue), n);
    if (r !== void 0)
      return [r, this.get(r)];
  }
  indexOf(n) {
    return we(this, ue).indexOf(n);
  }
  keyAt(n) {
    return Bn(we(this, ue), n);
  }
  from(n, r) {
    const o = this.indexOf(n);
    if (o === -1)
      return;
    let s = o + r;
    return s < 0 && (s = 0), s >= this.size && (s = this.size - 1), this.at(s);
  }
  keyFrom(n, r) {
    const o = this.indexOf(n);
    if (o === -1)
      return;
    let s = o + r;
    return s < 0 && (s = 0), s >= this.size && (s = this.size - 1), this.keyAt(s);
  }
  find(n, r) {
    let o = 0;
    for (const s of this) {
      if (Reflect.apply(n, r, [s, o, this]))
        return s;
      o++;
    }
  }
  findIndex(n, r) {
    let o = 0;
    for (const s of this) {
      if (Reflect.apply(n, r, [s, o, this]))
        return o;
      o++;
    }
    return -1;
  }
  filter(n, r) {
    const o = [];
    let s = 0;
    for (const a of this)
      Reflect.apply(n, r, [a, s, this]) && o.push(a), s++;
    return new Te(o);
  }
  map(n, r) {
    const o = [];
    let s = 0;
    for (const a of this)
      o.push([a[0], Reflect.apply(n, r, [a, s, this])]), s++;
    return new Te(o);
  }
  reduce(...n) {
    const [r, o] = n;
    let s = 0, a = o ?? this.at(0);
    for (const i of this)
      s === 0 && n.length === 1 ? a = i : a = Reflect.apply(r, this, [a, i, s, this]), s++;
    return a;
  }
  reduceRight(...n) {
    const [r, o] = n;
    let s = o ?? this.at(-1);
    for (let a = this.size - 1; a >= 0; a--) {
      const i = this.at(a);
      a === this.size - 1 && n.length === 1 ? s = i : s = Reflect.apply(r, this, [s, i, a, this]);
    }
    return s;
  }
  toSorted(n) {
    const r = [...this.entries()].sort(n);
    return new Te(r);
  }
  toReversed() {
    const n = new Te();
    for (let r = this.size - 1; r >= 0; r--) {
      const o = this.keyAt(r), s = this.get(o);
      n.set(o, s);
    }
    return n;
  }
  toSpliced(...n) {
    const r = [...this.entries()];
    return r.splice(...n), new Te(r);
  }
  slice(n, r) {
    const o = new Te();
    let s = this.size - 1;
    if (n === void 0)
      return o;
    n < 0 && (n = n + this.size), r !== void 0 && r > 0 && (s = r - 1);
    for (let a = n; a <= s; a++) {
      const i = this.keyAt(a), d = this.get(i);
      o.set(i, d);
    }
    return o;
  }
  every(n, r) {
    let o = 0;
    for (const s of this) {
      if (!Reflect.apply(n, r, [s, o, this]))
        return !1;
      o++;
    }
    return !0;
  }
  some(n, r) {
    let o = 0;
    for (const s of this) {
      if (Reflect.apply(n, r, [s, o, this]))
        return !0;
      o++;
    }
    return !1;
  }
}, ue = new WeakMap(), ge(Te, "OrderedDict"), Te);
function Bn(e, t) {
  if ("at" in Array.prototype)
    return Array.prototype.at.call(e, t);
  const n = Yi(e, t);
  return n === -1 ? void 0 : e[n];
}
ge(Bn, "at");
function Yi(e, t) {
  const n = e.length, r = Eo(t), o = r >= 0 ? r : n + r;
  return o < 0 || o >= n ? -1 : o;
}
ge(Yi, "toSafeIndex");
function Eo(e) {
  return e !== e || e === 0 ? 0 : Math.trunc(e);
}
ge(Eo, "toSafeInteger");
// @__NO_SIDE_EFFECTS__
function jp(e) {
  const t = e + "CollectionProvider", [n, r] = /* @__PURE__ */ _e(t), [o, s] = n(
    t,
    {
      collectionElement: null,
      collectionRef: { current: null },
      collectionRefObject: { current: null },
      itemMap: new Pr(),
      setItemMap: /* @__PURE__ */ ge(() => {
      }, "setItemMap")
    }
  ), a = /* @__PURE__ */ ge(({ state: w, ...x }) => w ? /* @__PURE__ */ f(d, { ...x, state: w }) : /* @__PURE__ */ f(i, { ...x }), "CollectionProvider");
  a.displayName = t;
  const i = /* @__PURE__ */ ge((w) => {
    const x = g();
    return /* @__PURE__ */ f(d, { ...w, state: x });
  }, "CollectionInit");
  i.displayName = t + "Init";
  const d = /* @__PURE__ */ ge((w) => {
    const { scope: x, children: E, state: N } = w, k = u.useRef(null), [S, P] = u.useState(
      null
    ), _ = re(k, P), [M, A] = N;
    return u.useEffect(() => {
      if (!S) return;
      const T = Zi(() => {
      });
      return T.observe(S, {
        childList: !0,
        subtree: !0
      }), () => {
        T.disconnect();
      };
    }, [S]), /* @__PURE__ */ f(
      o,
      {
        scope: x,
        itemMap: M,
        setItemMap: A,
        collectionRef: _,
        collectionRefObject: k,
        collectionElement: S,
        children: E
      }
    );
  }, "CollectionProviderImpl");
  d.displayName = t + "Impl";
  const c = e + "CollectionSlot", m = /* @__PURE__ */ Ke(c), l = u.forwardRef(
    (w, x) => {
      const { scope: E, children: N } = w, k = s(c, E), S = re(x, k.collectionRef);
      return /* @__PURE__ */ f(m, { ref: S, children: N });
    }
  );
  l.displayName = c;
  const p = e + "CollectionItemSlot", h = "data-radix-collection-item", b = /* @__PURE__ */ Ke(p), v = u.forwardRef(
    (w, x) => {
      const { scope: E, children: N, ...k } = w, S = u.useRef(null), [P, _] = u.useState(null), M = re(x, S, _), A = s(p, E), { setItemMap: T } = A, D = u.useRef(k);
      Xi(D.current, k) || (D.current = k);
      const W = D.current;
      return u.useEffect(() => {
        const $ = W;
        return T((z) => P ? z.has(P) ? z.set(P, { ...$, element: P }).toSorted(Qr) : (z.set(P, { ...$, element: P }), z.toSorted(Qr)) : z), () => {
          T((z) => !P || !z.has(P) ? z : (z.delete(P), new Pr(z)));
        };
      }, [P, W, T]), /* @__PURE__ */ f(b, { [h]: "", ref: M, children: N });
    }
  );
  v.displayName = p;
  function g() {
    return u.useState(new Pr());
  }
  ge(g, "useInitCollection");
  function y(w) {
    const { itemMap: x } = s(e + "CollectionConsumer", w);
    return x;
  }
  return ge(y, "useCollection"), [
    { Provider: a, Slot: l, ItemSlot: v },
    {
      createCollectionScope: r,
      useCollection: y,
      useInitCollection: g
    }
  ];
}
ge(jp, "createCollection");
function Xi(e, t) {
  if (e === t) return !0;
  if (typeof e != "object" || typeof t != "object" || e == null || t == null) return !1;
  const n = Object.keys(e), r = Object.keys(t);
  if (n.length !== r.length) return !1;
  for (const o of n)
    if (!Object.prototype.hasOwnProperty.call(t, o) || e[o] !== t[o]) return !1;
  return !0;
}
ge(Xi, "shallowEqual");
function qi(e, t) {
  return !!(t.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_PRECEDING);
}
ge(qi, "isElementPreceding");
function Qr(e, t) {
  return !e[1].element || !t[1].element ? 0 : qi(e[1].element, t[1].element) ? -1 : 1;
}
ge(Qr, "sortByDocumentPosition");
function Zi(e) {
  return new MutationObserver((n) => {
    for (const r of n)
      if (r.type === "childList") {
        e();
        return;
      }
  });
}
ge(Zi, "getChildListObserver");
const Hp = ["top", "right", "bottom", "left"], pt = Math.min, ot = Math.max, Gn = Math.round, An = Math.floor, st = (e) => ({
  x: e,
  y: e
}), Wp = {
  left: "right",
  right: "left",
  bottom: "top",
  top: "bottom"
};
function Qi(e, t, n) {
  return ot(e, pt(t, n));
}
function it(e, t) {
  return typeof e == "function" ? e(t) : e;
}
function ht(e) {
  return e.split("-")[0];
}
function Qt(e) {
  return e.split("-")[1];
}
function No(e) {
  return e === "x" ? "y" : "x";
}
function Ro(e) {
  return e === "y" ? "height" : "width";
}
function Ue(e) {
  const t = e[0];
  return t === "t" || t === "b" ? "y" : "x";
}
function Po(e) {
  return No(Ue(e));
}
function Up(e, t, n) {
  n === void 0 && (n = !1);
  const r = Qt(e), o = Po(e), s = Ro(o);
  let a = o === "x" ? r === (n ? "end" : "start") ? "right" : "left" : r === "start" ? "bottom" : "top";
  return t.reference[s] > t.floating[s] && (a = Kn(a)), [a, Kn(a)];
}
function Gp(e) {
  const t = Kn(e);
  return [Jr(e), t, Jr(t)];
}
function Jr(e) {
  return e.includes("start") ? e.replace("start", "end") : e.replace("end", "start");
}
const Js = ["left", "right"], ea = ["right", "left"], Kp = ["top", "bottom"], Yp = ["bottom", "top"];
function Xp(e, t, n) {
  switch (e) {
    case "top":
    case "bottom":
      return n ? t ? ea : Js : t ? Js : ea;
    case "left":
    case "right":
      return t ? Kp : Yp;
    default:
      return [];
  }
}
function qp(e, t, n, r) {
  const o = Qt(e);
  let s = Xp(ht(e), n === "start", r);
  return o && (s = s.map((a) => a + "-" + o), t && (s = s.concat(s.map(Jr)))), s;
}
function Kn(e) {
  const t = ht(e);
  return Wp[t] + e.slice(t.length);
}
function Zp(e) {
  var t, n, r, o;
  return {
    top: (t = e.top) != null ? t : 0,
    right: (n = e.right) != null ? n : 0,
    bottom: (r = e.bottom) != null ? r : 0,
    left: (o = e.left) != null ? o : 0
  };
}
function Ji(e) {
  return typeof e != "number" ? Zp(e) : {
    top: e,
    right: e,
    bottom: e,
    left: e
  };
}
function Yn(e) {
  const {
    x: t,
    y: n,
    width: r,
    height: o
  } = e;
  return {
    width: r,
    height: o,
    top: n,
    left: t,
    right: t + r,
    bottom: n + o,
    x: t,
    y: n
  };
}
function ta(e, t, n) {
  let {
    reference: r,
    floating: o
  } = e;
  const s = Ue(t), a = Po(t), i = Ro(a), d = ht(t), c = s === "y", m = r.x + r.width / 2 - o.width / 2, l = r.y + r.height / 2 - o.height / 2, p = r[i] / 2 - o[i] / 2;
  let h;
  switch (d) {
    case "top":
      h = {
        x: m,
        y: r.y - o.height
      };
      break;
    case "bottom":
      h = {
        x: m,
        y: r.y + r.height
      };
      break;
    case "right":
      h = {
        x: r.x + r.width,
        y: l
      };
      break;
    case "left":
      h = {
        x: r.x - o.width,
        y: l
      };
      break;
    default:
      h = {
        x: r.x,
        y: r.y
      };
  }
  const b = Qt(t);
  return b && (h[a] += p * (b === "end" ? 1 : -1) * (n && c ? -1 : 1)), h;
}
async function Qp(e, t) {
  var n;
  t === void 0 && (t = {});
  const {
    x: r,
    y: o,
    platform: s,
    rects: a,
    elements: i,
    strategy: d
  } = e, {
    boundary: c = "clippingAncestors",
    rootBoundary: m = "viewport",
    elementContext: l = "floating",
    altBoundary: p = !1,
    padding: h = 0
  } = it(t, e), b = Ji(h), g = i[p ? l === "floating" ? "reference" : "floating" : l], y = Yn(await s.getClippingRect({
    element: (n = await (s.isElement == null ? void 0 : s.isElement(g))) == null || n ? g : g.contextElement || await (s.getDocumentElement == null ? void 0 : s.getDocumentElement(i.floating)),
    boundary: c,
    rootBoundary: m,
    strategy: d
  })), C = l === "floating" ? {
    x: r,
    y: o,
    width: a.floating.width,
    height: a.floating.height
  } : a.reference, w = await (s.getOffsetParent == null ? void 0 : s.getOffsetParent(i.floating)), x = await (s.isElement == null ? void 0 : s.isElement(w)) && await (s.getScale == null ? void 0 : s.getScale(w)) || {
    x: 1,
    y: 1
  }, E = Yn(s.convertOffsetParentRelativeRectToViewportRelativeRect ? await s.convertOffsetParentRelativeRectToViewportRelativeRect({
    elements: i,
    rect: C,
    offsetParent: w,
    strategy: d
  }) : C);
  return {
    top: (y.top - E.top + b.top) / x.y,
    bottom: (E.bottom - y.bottom + b.bottom) / x.y,
    left: (y.left - E.left + b.left) / x.x,
    right: (E.right - y.right + b.right) / x.x
  };
}
const Jp = 50, eh = async (e, t, n) => {
  const {
    placement: r = "bottom",
    strategy: o = "absolute",
    middleware: s = [],
    platform: a
  } = n, i = a.detectOverflow ? a : {
    ...a,
    detectOverflow: Qp
  }, d = await (a.isRTL == null ? void 0 : a.isRTL(t));
  let c = await a.getElementRects({
    reference: e,
    floating: t,
    strategy: o
  }), {
    x: m,
    y: l
  } = ta(c, r, d), p = r, h = 0;
  const b = {};
  for (let v = 0; v < s.length; v++) {
    const g = s[v];
    if (!g)
      continue;
    const {
      name: y,
      fn: C
    } = g, {
      x: w,
      y: x,
      data: E,
      reset: N
    } = await C({
      x: m,
      y: l,
      initialPlacement: r,
      placement: p,
      strategy: o,
      middlewareData: b,
      rects: c,
      platform: i,
      elements: {
        reference: e,
        floating: t
      }
    });
    m = w ?? m, l = x ?? l, b[y] = {
      ...b[y],
      ...E
    }, N && h < Jp && (h++, typeof N == "object" && (N.placement && (p = N.placement), N.rects && (c = N.rects === !0 ? await a.getElementRects({
      reference: e,
      floating: t,
      strategy: o
    }) : N.rects), {
      x: m,
      y: l
    } = ta(c, p, d)), v = -1);
  }
  return {
    x: m,
    y: l,
    placement: p,
    strategy: o,
    middlewareData: b
  };
}, th = (e) => ({
  name: "arrow",
  options: e,
  async fn(t) {
    const {
      x: n,
      y: r,
      placement: o,
      rects: s,
      platform: a,
      elements: i,
      middlewareData: d
    } = t, {
      element: c,
      padding: m = 0
    } = it(e, t) || {};
    if (c == null)
      return {};
    const l = Ji(m), p = {
      x: n,
      y: r
    }, h = Po(o), b = Ro(h), v = await a.getDimensions(c), g = h === "y", y = g ? "top" : "left", C = g ? "bottom" : "right", w = g ? "clientHeight" : "clientWidth", x = s.reference[b] + s.reference[h] - p[h] - s.floating[b], E = p[h] - s.reference[h], N = await (a.getOffsetParent == null ? void 0 : a.getOffsetParent(c));
    let k = N ? N[w] : 0;
    (!k || !await (a.isElement == null ? void 0 : a.isElement(N))) && (k = i.floating[w] || s.floating[b]);
    const S = x / 2 - E / 2, P = k / 2 - v[b] / 2 - 1, _ = pt(l[y], P), M = pt(l[C], P), A = k - v[b] - M, T = k / 2 - v[b] / 2 + S, D = Qi(_, T, A), W = !d.arrow && Qt(o) != null && T !== D && s.reference[b] / 2 - (T < _ ? _ : M) - v[b] / 2 < 0, $ = W ? T < _ ? T - _ : T - A : 0;
    return {
      [h]: p[h] + $,
      data: {
        [h]: D,
        centerOffset: T - D - $,
        ...W && {
          alignmentOffset: $
        }
      },
      reset: W
    };
  }
}), nh = function(e) {
  return e === void 0 && (e = {}), {
    name: "flip",
    options: e,
    async fn(t) {
      var n, r;
      const {
        placement: o,
        middlewareData: s,
        rects: a,
        initialPlacement: i,
        platform: d,
        elements: c
      } = t, {
        mainAxis: m = !0,
        crossAxis: l = !0,
        fallbackPlacements: p,
        fallbackStrategy: h = "bestFit",
        fallbackAxisSideDirection: b = "none",
        flipAlignment: v = !0,
        ...g
      } = it(e, t);
      if ((n = s.arrow) != null && n.alignmentOffset)
        return {};
      const y = ht(o), C = Ue(i), w = ht(i) === i, x = await (d.isRTL == null ? void 0 : d.isRTL(c.floating)), E = p || (w || !v ? [Kn(i)] : Gp(i)), N = b !== "none";
      !p && N && E.push(...qp(i, v, b, x));
      const k = [i, ...E], S = await d.detectOverflow(t, g), P = [];
      let _ = ((r = s.flip) == null ? void 0 : r.overflows) || [];
      if (m && P.push(S[y]), l) {
        const D = Up(o, a, x);
        P.push(S[D[0]], S[D[1]]);
      }
      if (_ = [..._, {
        placement: o,
        overflows: P
      }], !P.every((D) => D <= 0)) {
        var M, A;
        const D = (((M = s.flip) == null ? void 0 : M.index) || 0) + 1, W = k[D];
        if (W && (!(l === "alignment" ? C !== Ue(W) : !1) || // We leave the current main axis only if every placement on that axis
        // overflows the main axis.
        _.every((H) => Ue(H.placement) === C ? H.overflows[0] > 0 : !0)))
          return {
            data: {
              index: D,
              overflows: _
            },
            reset: {
              placement: W
            }
          };
        let $ = (A = _.filter((z) => z.overflows[0] <= 0).sort((z, H) => z.overflows[1] - H.overflows[1])[0]) == null ? void 0 : A.placement;
        if (!$)
          switch (h) {
            case "bestFit": {
              var T;
              const z = (T = _.filter((H) => {
                if (N) {
                  const F = Ue(H.placement);
                  return F === C || // Create a bias to the `y` side axis due to horizontal
                  // reading directions favoring greater width.
                  F === "y";
                }
                return !0;
              }).map((H) => [H.placement, H.overflows.filter((F) => F > 0).reduce((F, L) => F + L, 0)]).sort((H, F) => H[1] - F[1])[0]) == null ? void 0 : T[0];
              z && ($ = z);
              break;
            }
            case "initialPlacement":
              $ = i;
              break;
          }
        if (o !== $)
          return {
            reset: {
              placement: $
            }
          };
      }
      return {};
    }
  };
};
function na(e, t) {
  return {
    top: e.top - t.height,
    right: e.right - t.width,
    bottom: e.bottom - t.height,
    left: e.left - t.width
  };
}
function ra(e) {
  return Hp.some((t) => e[t] >= 0);
}
const rh = function(e) {
  return e === void 0 && (e = {}), {
    name: "hide",
    options: e,
    async fn(t) {
      const {
        rects: n,
        platform: r
      } = t, {
        strategy: o = "referenceHidden",
        ...s
      } = it(e, t);
      switch (o) {
        case "referenceHidden": {
          const a = await r.detectOverflow(t, {
            ...s,
            elementContext: "reference"
          }), i = na(a, n.reference);
          return {
            data: {
              referenceHiddenOffsets: i,
              referenceHidden: ra(i)
            }
          };
        }
        case "escaped": {
          const a = await r.detectOverflow(t, {
            ...s,
            altBoundary: !0
          }), i = na(a, n.floating);
          return {
            data: {
              escapedOffsets: i,
              escaped: ra(i)
            }
          };
        }
        default:
          return {};
      }
    }
  };
}, el = /* @__PURE__ */ new Set(["left", "top"]);
async function oh(e, t) {
  const {
    placement: n,
    platform: r,
    elements: o
  } = e, s = await (r.isRTL == null ? void 0 : r.isRTL(o.floating)), a = ht(n), i = Qt(n), d = Ue(n) === "y", c = el.has(a) ? -1 : 1, m = s && d ? -1 : 1, l = it(t, e);
  let {
    mainAxis: p,
    crossAxis: h,
    alignmentAxis: b
  } = typeof l == "number" ? {
    mainAxis: l,
    crossAxis: 0,
    alignmentAxis: null
  } : {
    mainAxis: l.mainAxis || 0,
    crossAxis: l.crossAxis || 0,
    alignmentAxis: l.alignmentAxis
  };
  return i && typeof b == "number" && (h = i === "end" ? b * -1 : b), d ? {
    x: h * m,
    y: p * c
  } : {
    x: p * c,
    y: h * m
  };
}
const sh = function(e) {
  return e === void 0 && (e = 0), {
    name: "offset",
    options: e,
    async fn(t) {
      var n, r;
      const {
        x: o,
        y: s,
        placement: a,
        middlewareData: i
      } = t, d = await oh(t, e);
      return a === ((n = i.offset) == null ? void 0 : n.placement) && (r = i.arrow) != null && r.alignmentOffset ? {} : {
        x: o + d.x,
        y: s + d.y,
        data: {
          ...d,
          placement: a
        }
      };
    }
  };
}, ah = function(e) {
  return e === void 0 && (e = {}), {
    name: "shift",
    options: e,
    async fn(t) {
      const {
        x: n,
        y: r,
        placement: o,
        platform: s
      } = t, {
        mainAxis: a = !0,
        crossAxis: i = !1,
        limiter: d = {
          fn: (C) => {
            let {
              x: w,
              y: x
            } = C;
            return {
              x: w,
              y: x
            };
          }
        },
        ...c
      } = it(e, t), m = {
        x: n,
        y: r
      }, l = await s.detectOverflow(t, c), p = Ue(o), h = No(p);
      let b = m[h], v = m[p];
      const g = (C, w) => Qi(w + l[C === "y" ? "top" : "left"], w, w - l[C === "y" ? "bottom" : "right"]);
      a && (b = g(h, b)), i && (v = g(p, v));
      const y = d.fn({
        ...t,
        [h]: b,
        [p]: v
      });
      return {
        ...y,
        data: {
          x: y.x - n,
          y: y.y - r,
          enabled: {
            [h]: a,
            [p]: i
          }
        }
      };
    }
  };
}, ih = function(e) {
  return e === void 0 && (e = {}), {
    options: e,
    fn(t) {
      var n, r;
      const {
        x: o,
        y: s,
        placement: a,
        rects: i,
        middlewareData: d
      } = t, {
        offset: c = 0,
        mainAxis: m = !0,
        crossAxis: l = !0
      } = it(e, t), p = {
        x: o,
        y: s
      }, h = Ue(a), b = No(h);
      let v = p[b], g = p[h];
      const y = it(c, t), C = typeof y == "number" ? {
        mainAxis: y,
        crossAxis: 0
      } : {
        mainAxis: (n = y.mainAxis) != null ? n : 0,
        crossAxis: (r = y.crossAxis) != null ? r : 0
      };
      if (m) {
        const E = b === "y" ? "height" : "width", N = i.reference[b] - i.floating[E] + C.mainAxis, k = i.reference[b] + i.reference[E] - C.mainAxis;
        v < N ? v = N : v > k && (v = k);
      }
      if (l) {
        var w, x;
        const E = b === "y" ? "width" : "height", N = el.has(ht(a)), k = i.reference[h] - i.floating[E] + (N && ((w = d.offset) == null ? void 0 : w[h]) || 0) + (N ? 0 : C.crossAxis), S = i.reference[h] + i.reference[E] + (N ? 0 : ((x = d.offset) == null ? void 0 : x[h]) || 0) - (N ? C.crossAxis : 0);
        g < k ? g = k : g > S && (g = S);
      }
      return {
        [b]: v,
        [h]: g
      };
    }
  };
}, lh = function(e) {
  return e === void 0 && (e = {}), {
    name: "size",
    options: e,
    async fn(t) {
      const {
        placement: n,
        rects: r,
        platform: o,
        elements: s
      } = t, {
        apply: a = () => {
        },
        ...i
      } = it(e, t), d = await o.detectOverflow(t, i), c = ht(n), m = Qt(n), l = Ue(n) === "y", {
        width: p,
        height: h
      } = r.floating;
      let b, v;
      c === "top" || c === "bottom" ? (b = c, v = m === (await (o.isRTL == null ? void 0 : o.isRTL(s.floating)) ? "start" : "end") ? "left" : "right") : (v = c, b = m === "end" ? "top" : "bottom");
      const g = h - d.top - d.bottom, y = p - d.left - d.right, C = pt(h - d[b], g), w = pt(p - d[v], y), x = t.middlewareData.shift, E = !x;
      let N = C, k = w;
      x != null && x.enabled.x && (k = y), x != null && x.enabled.y && (N = g), E && !m && (l ? k = p - 2 * ot(d.left, d.right) : N = h - 2 * ot(d.top, d.bottom)), await a({
        ...t,
        availableWidth: k,
        availableHeight: N
      });
      const S = await o.getDimensions(s.floating);
      return p !== S.width || h !== S.height ? {
        reset: {
          rects: !0
        }
      } : {};
    }
  };
};
function or() {
  return typeof window < "u";
}
function Jt(e) {
  return tl(e) ? (e.nodeName || "").toLowerCase() : "#document";
}
function Pe(e) {
  var t;
  return (e == null || (t = e.ownerDocument) == null ? void 0 : t.defaultView) || window;
}
function ct(e) {
  var t;
  return (t = (tl(e) ? e.ownerDocument : e.document) || window.document) == null ? void 0 : t.documentElement;
}
function tl(e) {
  return or() ? e instanceof Node || e instanceof Pe(e).Node : !1;
}
function Xe(e) {
  return or() ? e instanceof Element || e instanceof Pe(e).Element : !1;
}
function bt(e) {
  return or() ? e instanceof HTMLElement || e instanceof Pe(e).HTMLElement : !1;
}
function oa(e) {
  return !or() || typeof ShadowRoot > "u" ? !1 : e instanceof ShadowRoot || e instanceof Pe(e).ShadowRoot;
}
function sr(e) {
  const {
    overflow: t,
    overflowX: n,
    overflowY: r,
    display: o
  } = qe(e);
  return /auto|scroll|overlay|hidden|clip/.test(t + r + n) && o !== "inline" && o !== "contents";
}
function ch(e) {
  return /^(table|td|th)$/.test(Jt(e));
}
function ar(e) {
  try {
    if (e.matches(":popover-open"))
      return !0;
  } catch {
  }
  try {
    return e.matches(":modal");
  } catch {
    return !1;
  }
}
const dh = /transform|translate|scale|rotate|perspective|filter/, uh = /paint|layout|strict|content/, Ct = (e) => !!e && e !== "none";
let Tr;
function To(e) {
  const t = Xe(e) ? qe(e) : e;
  return Ct(t.transform) || Ct(t.translate) || Ct(t.scale) || Ct(t.rotate) || Ct(t.perspective) || !_o() && (Ct(t.backdropFilter) || Ct(t.filter)) || dh.test(t.willChange || "") || uh.test(t.contain || "");
}
function fh(e) {
  let t = Et(e);
  for (; bt(t) && !cn(t); ) {
    if (To(t))
      return t;
    if (ar(t))
      return null;
    t = Et(t);
  }
  return null;
}
function _o() {
  return Tr == null && (Tr = typeof CSS < "u" && CSS.supports && CSS.supports("-webkit-backdrop-filter", "none")), Tr;
}
function cn(e) {
  return /^(html|body|#document)$/.test(Jt(e));
}
function qe(e) {
  return Pe(e).getComputedStyle(e);
}
function ir(e) {
  return Xe(e) ? {
    scrollLeft: e.scrollLeft,
    scrollTop: e.scrollTop
  } : {
    scrollLeft: e.scrollX,
    scrollTop: e.scrollY
  };
}
function Et(e) {
  if (Jt(e) === "html")
    return e;
  const t = (
    // Step into the shadow DOM of the parent of a slotted node.
    e.assignedSlot || // DOM Element detected.
    e.parentNode || // ShadowRoot detected.
    oa(e) && e.host || // Fallback.
    ct(e)
  );
  return oa(t) ? t.host : t;
}
function nl(e) {
  const t = Et(e);
  return cn(t) ? (e.ownerDocument || e).body : bt(t) && sr(t) ? t : nl(t);
}
function dn(e, t, n) {
  var r;
  t === void 0 && (t = []), n === void 0 && (n = !0);
  const o = nl(e), s = o === ((r = e.ownerDocument) == null ? void 0 : r.body), a = Pe(o);
  if (s) {
    const i = eo(a);
    return t.concat(a, a.visualViewport || [], sr(o) ? o : [], i && n ? dn(i) : []);
  } else
    return t.concat(o, dn(o, [], n));
}
function eo(e) {
  return e.parent && Object.getPrototypeOf(e.parent) ? e.frameElement : null;
}
function rl(e) {
  const t = qe(e);
  let n = parseFloat(t.width) || 0, r = parseFloat(t.height) || 0;
  const o = bt(e), s = o ? e.offsetWidth : n, a = o ? e.offsetHeight : r, i = Gn(n) !== s || Gn(r) !== a;
  return i && (n = s, r = a), {
    width: n,
    height: r,
    $: i
  };
}
function Io(e) {
  return Xe(e) ? e : e.contextElement;
}
function Kt(e) {
  const t = Io(e);
  if (!bt(t))
    return st(1);
  const n = t.getBoundingClientRect(), {
    width: r,
    height: o,
    $: s
  } = rl(t);
  let a = (s ? Gn(n.width) : n.width) / r, i = (s ? Gn(n.height) : n.height) / o;
  return (!a || !Number.isFinite(a)) && (a = 1), (!i || !Number.isFinite(i)) && (i = 1), {
    x: a,
    y: i
  };
}
const mh = /* @__PURE__ */ st(0);
function ol(e) {
  const t = Pe(e);
  return !_o() || !t.visualViewport ? mh : {
    x: t.visualViewport.offsetLeft,
    y: t.visualViewport.offsetTop
  };
}
function ph(e, t, n) {
  return t === void 0 && (t = !1), !!n && t && n === Pe(e);
}
function Nt(e, t, n, r) {
  t === void 0 && (t = !1), n === void 0 && (n = !1);
  const o = e.getBoundingClientRect(), s = Io(e);
  let a = st(1);
  t && (r ? Xe(r) && (a = Kt(r)) : a = Kt(e));
  const i = ph(s, n, r) ? ol(s) : st(0);
  let d = (o.left + i.x) / a.x, c = (o.top + i.y) / a.y, m = o.width / a.x, l = o.height / a.y;
  if (s && r) {
    const p = Pe(s), h = Xe(r) ? Pe(r) : r;
    let b = p, v = eo(b);
    for (; v && h !== b; ) {
      const g = Kt(v), y = v.getBoundingClientRect(), C = qe(v), w = y.left + (v.clientLeft + parseFloat(C.paddingLeft)) * g.x, x = y.top + (v.clientTop + parseFloat(C.paddingTop)) * g.y;
      d *= g.x, c *= g.y, m *= g.x, l *= g.y, d += w, c += x, b = Pe(v), v = eo(b);
    }
  }
  return Yn({
    width: m,
    height: l,
    x: d,
    y: c
  });
}
function lr(e, t) {
  const n = ir(e).scrollLeft;
  return t ? t.left + n : Nt(ct(e)).left + n;
}
function sl(e, t) {
  const n = e.getBoundingClientRect(), r = n.left + t.scrollLeft - lr(e, n), o = n.top + t.scrollTop;
  return {
    x: r,
    y: o
  };
}
function hh(e) {
  let {
    elements: t,
    rect: n,
    offsetParent: r,
    strategy: o
  } = e;
  const s = o === "fixed", a = ct(r), i = t ? ar(t.floating) : !1;
  if (r === a || i && s)
    return n;
  let d = {
    scrollLeft: 0,
    scrollTop: 0
  }, c = st(1);
  const m = st(0), l = bt(r);
  if ((l || !s) && ((Jt(r) !== "body" || sr(a)) && (d = ir(r)), l)) {
    const h = Nt(r);
    c = Kt(r), m.x = h.x + r.clientLeft, m.y = h.y + r.clientTop;
  }
  const p = a && !l && !s ? sl(a, d) : st(0);
  return {
    width: n.width * c.x,
    height: n.height * c.y,
    x: n.x * c.x - d.scrollLeft * c.x + m.x + p.x,
    y: n.y * c.y - d.scrollTop * c.y + m.y + p.y
  };
}
function gh(e) {
  return e.getClientRects ? Array.from(e.getClientRects()) : [];
}
function vh(e) {
  const t = ir(e), n = e.ownerDocument.body, r = ot(e.scrollWidth, e.clientWidth, n.scrollWidth, n.clientWidth), o = ot(e.scrollHeight, e.clientHeight, n.scrollHeight, n.clientHeight);
  let s = -t.scrollLeft + lr(e);
  const a = -t.scrollTop;
  return qe(n).direction === "rtl" && (s += ot(e.clientWidth, n.clientWidth) - r), {
    width: r,
    height: o,
    x: s,
    y: a
  };
}
const bh = 25;
function yh(e, t, n) {
  n === void 0 && (n = "viewport");
  const r = n === "layoutViewport", o = Pe(e), s = ct(e), a = o.visualViewport;
  let i = s.clientWidth, d = s.clientHeight, c = 0, m = 0;
  if (a) {
    const p = !_o() || t === "fixed";
    r ? p || (c = -a.offsetLeft, m = -a.offsetTop) : (i = a.width, d = a.height, p && (c = a.offsetLeft, m = a.offsetTop));
  }
  if (lr(s) <= 0) {
    const p = s.ownerDocument, h = p.body, b = getComputedStyle(h), v = p.compatMode === "CSS1Compat" && parseFloat(b.marginLeft) + parseFloat(b.marginRight) || 0, g = Math.abs(s.clientWidth - h.clientWidth - v), y = getComputedStyle(s).scrollbarGutter === "stable both-edges" ? g / 2 : g;
    y <= bh && (i -= y);
  }
  return {
    width: i,
    height: d,
    x: c,
    y: m
  };
}
function xh(e, t) {
  const n = Nt(e, !0, t === "fixed"), r = n.top + e.clientTop, o = n.left + e.clientLeft, s = Kt(e), a = e.clientWidth * s.x, i = e.clientHeight * s.y, d = o * s.x, c = r * s.y;
  return {
    width: a,
    height: i,
    x: d,
    y: c
  };
}
function sa(e, t, n) {
  let r;
  if (t === "viewport" || t === "layoutViewport")
    r = yh(e, n, t);
  else if (t === "document")
    r = vh(ct(e));
  else if (Xe(t))
    r = xh(t, n);
  else {
    const o = ol(e);
    r = {
      x: t.x - o.x,
      y: t.y - o.y,
      width: t.width,
      height: t.height
    };
  }
  return Yn(r);
}
function wh(e, t) {
  const n = t.get(e);
  if (n)
    return n;
  let r = dn(e, [], !1).filter((i) => Xe(i) && Jt(i) !== "body"), o = null;
  const s = qe(e).position === "fixed";
  let a = s ? Et(e) : e;
  for (; Xe(a) && !cn(a); ) {
    const i = qe(a), d = To(a), c = o ? o.position : s ? "fixed" : "";
    !d && (c === "fixed" || c === "absolute" && i.position === "static") ? r = r.filter((l) => l !== a) : o = i, a = Et(a);
  }
  return t.set(e, r), r;
}
function Ch(e) {
  let {
    element: t,
    boundary: n,
    rootBoundary: r,
    strategy: o
  } = e;
  const a = [...n === "clippingAncestors" ? ar(t) ? [] : wh(t, this._c) : [].concat(n), r], i = sa(t, a[0], o);
  let d = i.top, c = i.right, m = i.bottom, l = i.left;
  for (let p = 1; p < a.length; p++) {
    const h = sa(t, a[p], o);
    d = ot(h.top, d), c = pt(h.right, c), m = pt(h.bottom, m), l = ot(h.left, l);
  }
  return {
    width: c - l,
    height: m - d,
    x: l,
    y: d
  };
}
function Sh(e) {
  const {
    width: t,
    height: n
  } = rl(e);
  return {
    width: t,
    height: n
  };
}
function kh(e, t, n) {
  const r = bt(t), o = ct(t), s = n === "fixed", a = Nt(e, !0, s, t);
  let i = {
    scrollLeft: 0,
    scrollTop: 0
  };
  const d = st(0);
  if ((r || !s) && ((Jt(t) !== "body" || sr(o)) && (i = ir(t)), r)) {
    const p = Nt(t, !0, s, t);
    d.x = p.x + t.clientLeft, d.y = p.y + t.clientTop;
  }
  !r && o && (d.x = lr(o));
  const c = o && !r && !s ? sl(o, i) : st(0), m = a.left + i.scrollLeft - d.x - c.x, l = a.top + i.scrollTop - d.y - c.y;
  return {
    x: m,
    y: l,
    width: a.width,
    height: a.height
  };
}
function _r(e) {
  return qe(e).position === "static";
}
function aa(e, t) {
  if (!bt(e) || qe(e).position === "fixed")
    return null;
  if (t)
    return t(e);
  let n = e.offsetParent;
  return ct(e) === n && (n = n.ownerDocument.body), n;
}
function al(e, t) {
  const n = Pe(e);
  if (ar(e))
    return n;
  if (!bt(e)) {
    let o = Et(e);
    for (; o && !cn(o); ) {
      if (Xe(o) && !_r(o))
        return o;
      o = Et(o);
    }
    return n;
  }
  let r = aa(e, t);
  for (; r && ch(r) && _r(r); )
    r = aa(r, t);
  return r && cn(r) && _r(r) && !To(r) ? n : r || fh(e) || n;
}
const Eh = async function(e) {
  const t = this.getOffsetParent || al, n = this.getDimensions, r = await n(e.floating);
  return {
    reference: kh(e.reference, await t(e.floating), e.strategy),
    floating: {
      x: 0,
      y: 0,
      width: r.width,
      height: r.height
    }
  };
};
function Nh(e) {
  return qe(e).direction === "rtl";
}
const Rh = {
  convertOffsetParentRelativeRectToViewportRelativeRect: hh,
  getDocumentElement: ct,
  getClippingRect: Ch,
  getOffsetParent: al,
  getElementRects: Eh,
  getClientRects: gh,
  getDimensions: Sh,
  getScale: Kt,
  isElement: Xe,
  isRTL: Nh
};
function il(e, t) {
  return e.x === t.x && e.y === t.y && e.width === t.width && e.height === t.height;
}
function Ph(e, t, n) {
  let r = null, o;
  const s = ct(e);
  function a() {
    var m;
    clearTimeout(o), (m = r) == null || m.disconnect(), r = null;
  }
  function i(m, l) {
    m === void 0 && (m = !1), l === void 0 && (l = 1), a();
    const p = e.getBoundingClientRect(), {
      left: h,
      top: b,
      width: v,
      height: g
    } = p;
    if (m || t(), !v || !g)
      return;
    const y = An(b), C = An(s.clientWidth - (h + v)), w = An(s.clientHeight - (b + g)), x = An(h), N = {
      rootMargin: -y + "px " + -C + "px " + -w + "px " + -x + "px",
      threshold: ot(0, pt(1, l)) || 1
    };
    let k = !0;
    function S(P) {
      const _ = P[0].intersectionRatio;
      if (!il(p, e.getBoundingClientRect()))
        return i();
      if (_ !== l) {
        if (!k)
          return i();
        _ ? i(!1, _) : o = setTimeout(() => {
          i(!1, 1e-7);
        }, 1e3);
      }
      k = !1;
    }
    try {
      r = new IntersectionObserver(S, {
        ...N,
        // Handle <iframe>s
        root: s.ownerDocument
      });
    } catch {
      r = new IntersectionObserver(S, N);
    }
    r.observe(e);
  }
  const d = Pe(e), c = () => i(n);
  return d.addEventListener("resize", c), i(!0), () => {
    d.removeEventListener("resize", c), a();
  };
}
function Th(e, t, n, r) {
  r === void 0 && (r = {});
  const {
    ancestorScroll: o = !0,
    ancestorResize: s = !0,
    elementResize: a = typeof ResizeObserver == "function",
    layoutShift: i = typeof IntersectionObserver == "function",
    animationFrame: d = !1
  } = r, c = Io(e), m = o || s ? [...c ? dn(c) : [], ...t ? dn(t) : []] : [];
  m.forEach((y) => {
    o && y.addEventListener("scroll", n), s && y.addEventListener("resize", n);
  });
  const l = c && i ? Ph(c, n, s) : null;
  let p = -1, h = null;
  a && (h = new ResizeObserver((y) => {
    let [C] = y;
    C && C.target === c && h && t && (h.unobserve(t), cancelAnimationFrame(p), p = requestAnimationFrame(() => {
      var w;
      (w = h) == null || w.observe(t);
    })), n();
  }), c && !d && h.observe(c), t && h.observe(t));
  let b, v = d ? Nt(e) : null;
  d && g();
  function g() {
    const y = Nt(e);
    v && !il(v, y) && n(), v = y, b = requestAnimationFrame(g);
  }
  return n(), () => {
    var y;
    m.forEach((C) => {
      o && C.removeEventListener("scroll", n), s && C.removeEventListener("resize", n);
    }), l?.(), (y = h) == null || y.disconnect(), h = null, d && cancelAnimationFrame(b);
  };
}
const _h = sh, Ih = ah, Oh = nh, Ah = lh, Dh = rh, ia = th, Mh = ih, Lh = (e, t, n) => {
  const r = /* @__PURE__ */ new Map(), o = n ?? {}, s = {
    ...Rh,
    ...o.platform,
    _c: r
  };
  return eh(e, t, {
    ...o,
    platform: s
  });
};
var $h = typeof document < "u", Fh = function() {
}, Vn = $h ? ga : Fh;
function Xn(e, t) {
  if (e === t)
    return !0;
  if (typeof e != typeof t)
    return !1;
  if (typeof e == "function" && e.toString() === t.toString())
    return !0;
  let n, r, o;
  if (e && t && typeof e == "object") {
    if (Array.isArray(e)) {
      if (n = e.length, n !== t.length) return !1;
      for (r = n; r-- !== 0; )
        if (!Xn(e[r], t[r]))
          return !1;
      return !0;
    }
    if (o = Object.keys(e), n = o.length, n !== Object.keys(t).length)
      return !1;
    for (r = n; r-- !== 0; )
      if (!{}.hasOwnProperty.call(t, o[r]))
        return !1;
    for (r = n; r-- !== 0; ) {
      const s = o[r];
      if (!(s === "_owner" && e.$$typeof) && !Xn(e[s], t[s]))
        return !1;
    }
    return !0;
  }
  return e !== e && t !== t;
}
function ll(e) {
  return typeof window > "u" ? 1 : (e.ownerDocument.defaultView || window).devicePixelRatio || 1;
}
function la(e, t) {
  const n = ll(e);
  return Math.round(t * n) / n;
}
function Ir(e) {
  const t = u.useRef(e);
  return Vn(() => {
    t.current = e;
  }), t;
}
function zh(e) {
  e === void 0 && (e = {});
  const {
    placement: t = "bottom",
    strategy: n = "absolute",
    middleware: r = [],
    platform: o,
    elements: {
      reference: s,
      floating: a
    } = {},
    transform: i = !0,
    whileElementsMounted: d,
    open: c
  } = e, [m, l] = u.useState({
    x: 0,
    y: 0,
    strategy: n,
    placement: t,
    middlewareData: {},
    isPositioned: !1
  }), [p, h] = u.useState(r);
  Xn(p, r) || h(r);
  const [b, v] = u.useState(null), [g, y] = u.useState(null), C = u.useCallback((H) => {
    H !== N.current && (N.current = H, v(H));
  }, []), w = u.useCallback((H) => {
    H !== k.current && (k.current = H, y(H));
  }, []), x = s || b, E = a || g, N = u.useRef(null), k = u.useRef(null), S = u.useRef(m), P = d != null, _ = Ir(d), M = Ir(o), A = Ir(c), T = u.useCallback(() => {
    if (!N.current || !k.current)
      return;
    const H = {
      placement: t,
      strategy: n,
      middleware: p
    };
    M.current && (H.platform = M.current), Lh(N.current, k.current, H).then((F) => {
      const L = {
        ...F,
        // The floating element's position may be recomputed while it's closed
        // but still mounted (such as when transitioning out). To ensure
        // `isPositioned` will be `false` initially on the next open, avoid
        // setting it to `true` when `open === false` (must be specified).
        isPositioned: A.current !== !1
      };
      D.current && !Xn(S.current, L) && (S.current = L, pn.flushSync(() => {
        l(L);
      }));
    });
  }, [p, t, n, M, A]);
  Vn(() => {
    c === !1 && S.current.isPositioned && (S.current.isPositioned = !1, l((H) => ({
      ...H,
      isPositioned: !1
    })));
  }, [c]);
  const D = u.useRef(!1);
  Vn(() => (D.current = !0, () => {
    D.current = !1;
  }), []), Vn(() => {
    if (x && (N.current = x), E && (k.current = E), x && E) {
      if (_.current)
        return _.current(x, E, T);
      T();
    }
  }, [x, E, T, _, P]);
  const W = u.useMemo(() => ({
    reference: N,
    floating: k,
    setReference: C,
    setFloating: w
  }), [C, w]), $ = u.useMemo(() => ({
    reference: x,
    floating: E
  }), [x, E]), z = u.useMemo(() => {
    const H = {
      position: n,
      left: 0,
      top: 0
    };
    if (!$.floating)
      return H;
    const F = la($.floating, m.x), L = la($.floating, m.y);
    return i ? {
      ...H,
      transform: "translate(" + F + "px, " + L + "px)",
      ...ll($.floating) >= 1.5 && {
        willChange: "transform"
      }
    } : {
      position: n,
      left: F,
      top: L
    };
  }, [n, i, $.floating, m.x, m.y]);
  return u.useMemo(() => ({
    ...m,
    update: T,
    refs: W,
    elements: $,
    floatingStyles: z
  }), [m, T, W, $, z]);
}
const Bh = (e) => {
  function t(n) {
    return {}.hasOwnProperty.call(n, "current");
  }
  return {
    name: "arrow",
    options: e,
    fn(n) {
      const {
        element: r,
        padding: o
      } = typeof e == "function" ? e(n) : e;
      return r && t(r) ? r.current != null ? ia({
        element: r.current,
        padding: o
      }).fn(n) : {} : r ? ia({
        element: r,
        padding: o
      }).fn(n) : {};
    }
  };
}, Vh = (e, t) => {
  const n = _h(e);
  return {
    name: n.name,
    fn: n.fn,
    options: [e, t]
  };
}, jh = (e, t) => {
  const n = Ih(e);
  return {
    name: n.name,
    fn: n.fn,
    options: [e, t]
  };
}, Hh = (e, t) => ({
  fn: Mh(e).fn,
  options: [e, t]
}), Wh = (e, t) => {
  const n = Oh(e);
  return {
    name: n.name,
    fn: n.fn,
    options: [e, t]
  };
}, Uh = (e, t) => {
  const n = Ah(e);
  return {
    name: n.name,
    fn: n.fn,
    options: [e, t]
  };
}, Gh = (e, t) => {
  const n = Dh(e);
  return {
    name: n.name,
    fn: n.fn,
    options: [e, t]
  };
}, Kh = (e, t) => {
  const n = Bh(e);
  return {
    name: n.name,
    fn: n.fn,
    options: [e, t]
  };
};
var Yh = Object.defineProperty, Xh = (e, t) => Yh(e, "name", { value: t, configurable: !0 });
function Oo(e) {
  const [t, n] = u.useState(void 0);
  return de(() => {
    if (e) {
      n({ width: e.offsetWidth, height: e.offsetHeight });
      const r = new ResizeObserver((o) => {
        if (!Array.isArray(o) || !o.length)
          return;
        const s = o[0];
        let a, i;
        if ("borderBoxSize" in s) {
          const d = s.borderBoxSize, c = Array.isArray(d) ? d[0] : d;
          a = c.inlineSize, i = c.blockSize;
        } else
          a = e.offsetWidth, i = e.offsetHeight;
        n({ width: a, height: i });
      });
      return r.observe(e, { box: "border-box" }), () => r.unobserve(e);
    } else
      n(void 0);
  }, [e]), t;
}
Xh(Oo, "useSize");
var qh = Object.defineProperty, mt = (e, t) => qh(e, "name", { value: t, configurable: !0 }), cl = "Popper", [dl, en] = /* @__PURE__ */ _e(cl), [Zh, ul] = dl(cl), Qh = /* @__PURE__ */ mt((e) => {
  const { __scopePopper: t, children: n } = e, [r, o] = u.useState(null), [s, a] = u.useState(void 0);
  return /* @__PURE__ */ f(
    Zh,
    {
      scope: t,
      anchor: r,
      onAnchorChange: o,
      placementState: s,
      setPlacementState: a,
      children: n
    }
  );
}, "Popper"), Jh = "PopperAnchor", eg = /* @__PURE__ */ u.forwardRef(
  /* @__PURE__ */ mt(function(t, n) {
    const { __scopePopper: r, virtualRef: o, ...s } = t, a = ul(Jh, r), i = u.useRef(null), d = a.onAnchorChange, c = u.useCallback(
      (v) => {
        i.current = v, v && d(v);
      },
      [d]
    ), m = re(n, c), l = u.useRef(null);
    u.useEffect(() => {
      if (!o)
        return;
      const v = l.current;
      l.current = o.current, v !== l.current && d(l.current);
    });
    const p = a.placementState && cr(a.placementState), h = p?.[0], b = p?.[1];
    return o ? null : /* @__PURE__ */ f(
      Z.div,
      {
        "data-radix-popper-side": h,
        "data-radix-popper-align": b,
        ...s,
        ref: m
      }
    );
  }, "PopperAnchor")
), fl = "PopperContent", [tg, Sy] = dl(fl), ng = /* @__PURE__ */ u.forwardRef(
  /* @__PURE__ */ mt(function(t, n) {
    const {
      __scopePopper: r,
      side: o = "bottom",
      sideOffset: s = 0,
      align: a = "center",
      alignOffset: i = 0,
      arrowPadding: d = 0,
      avoidCollisions: c = !0,
      collisionBoundary: m = [],
      collisionPadding: l = 0,
      sticky: p = "partial",
      hideWhenDetached: h = !1,
      updatePositionStrategy: b = "optimized",
      onPlaced: v,
      ...g
    } = t, y = ul(fl, r), [C, w] = u.useState(null), x = re(n, w), [E, N] = u.useState(null), k = Oo(E), S = k?.width ?? 0, P = k?.height ?? 0, _ = o + (a !== "center" ? "-" + a : ""), M = typeof l == "number" ? l : { top: 0, right: 0, bottom: 0, left: 0, ...l }, A = Array.isArray(m) ? m : [m], T = A.length > 0, D = {
      padding: M,
      boundary: A.filter(ml),
      // with `strategy: 'fixed'`, this is the only way to get it to respect boundaries
      altBoundary: T
    }, { refs: W, floatingStyles: $, placement: z, isPositioned: H, middlewareData: F } = zh({
      // default to `fixed` strategy so users don't have to pick and we also avoid focus scroll issues
      strategy: "fixed",
      placement: _,
      whileElementsMounted: /* @__PURE__ */ mt((...B) => Th(...B, {
        animationFrame: b === "always"
      }), "whileElementsMounted"),
      elements: {
        reference: y.anchor
      },
      middleware: [
        Vh({ mainAxis: s + P, alignmentAxis: i }),
        c && jh({
          mainAxis: !0,
          crossAxis: !1,
          limiter: p === "partial" ? Hh() : void 0,
          ...D
        }),
        c && Wh({ ...D }),
        Uh({
          ...D,
          apply: /* @__PURE__ */ mt(({ elements: B, rects: ce, availableWidth: te, availableHeight: ne }) => {
            const { width: oe, height: me } = ce.reference, ke = B.floating.style;
            ke.setProperty("--radix-popper-available-width", `${te}px`), ke.setProperty("--radix-popper-available-height", `${ne}px`), ke.setProperty("--radix-popper-anchor-width", `${oe}px`), ke.setProperty("--radix-popper-anchor-height", `${me}px`);
          }, "apply")
        }),
        E && Kh({ element: E, padding: d }),
        rg({ arrowWidth: S, arrowHeight: P }),
        h && Gh({
          strategy: "referenceHidden",
          ...D,
          // `hide` detects whether the anchor (reference) is clipped, so when
          // no explicit `collisionBoundary` is set we fall back to Floating
          // UI's default clipping ancestors (e.g. a scrollable menu). This
          // lets an occluded submenu hide once its anchor scrolls out of view
          // (#3237). The collision/size middlewares deliberately keep the
          // viewport-based default to avoid clamping content rendered inside
          // transformed or overflow-clipping portal containers.
          boundary: T ? D.boundary : void 0
        })
      ]
    }), L = y.setPlacementState;
    de(() => (L(z), () => {
      L(void 0);
    }), [z, L]);
    const [ie, J] = cr(z), se = Le(v);
    de(() => {
      H && se?.();
    }, [H, se]);
    const X = F.arrow?.x, K = F.arrow?.y, U = F.arrow?.centerOffset !== 0, [ae, G] = u.useState();
    return de(() => {
      C && G(window.getComputedStyle(C).zIndex);
    }, [C]), /* @__PURE__ */ f(
      "div",
      {
        ref: W.setFloating,
        "data-radix-popper-content-wrapper": "",
        style: {
          ...$,
          transform: H ? $.transform : "translate(0, -200%)",
          // keep off the page when measuring
          minWidth: "max-content",
          zIndex: ae,
          "--radix-popper-transform-origin": [
            F.transformOrigin?.x,
            F.transformOrigin?.y
          ].join(" "),
          // hide the content if using the hide middleware and should be hidden
          // set visibility to hidden and disable pointer events so the UI behaves
          // as if the PopperContent isn't there at all
          ...F.hide?.referenceHidden && {
            visibility: "hidden",
            pointerEvents: "none"
          }
        },
        dir: t.dir,
        children: /* @__PURE__ */ f(
          tg,
          {
            scope: r,
            placedSide: ie,
            placedAlign: J,
            onArrowChange: N,
            arrowX: X,
            arrowY: K,
            shouldHideArrow: U,
            children: /* @__PURE__ */ f(
              Z.div,
              {
                "data-side": ie,
                "data-align": J,
                ...g,
                ref: x,
                style: {
                  ...g.style,
                  // if the PopperContent hasn't been placed yet (not all
                  // measurements done) we prevent animations so that users'
                  // animations don't kick in too early from the wrong sides.
                  animation: H ? g.style?.animation : "none"
                }
              }
            )
          }
        )
      }
    );
  }, "PopperContent")
);
function ml(e) {
  return e !== null;
}
mt(ml, "isNotNull");
var rg = /* @__PURE__ */ mt((e) => ({
  name: "transformOrigin",
  options: e,
  fn(t) {
    const { placement: n, rects: r, middlewareData: o } = t, a = o.arrow?.centerOffset !== 0, i = a ? 0 : e.arrowWidth, d = a ? 0 : e.arrowHeight, [c, m] = cr(n), l = { start: "0%", center: "50%", end: "100%" }[m], p = (o.arrow?.x ?? 0) + i / 2, h = (o.arrow?.y ?? 0) + d / 2;
    let b = "", v = "";
    return c === "bottom" ? (b = a ? l : `${p}px`, v = `${-d}px`) : c === "top" ? (b = a ? l : `${p}px`, v = `${r.floating.height + d}px`) : c === "right" ? (b = `${-d}px`, v = a ? l : `${h}px`) : c === "left" && (b = `${r.floating.width + d}px`, v = a ? l : `${h}px`), { data: { x: b, y: v } };
  }
}), "transformOrigin");
function cr(e) {
  const [t, n = "center"] = e.split("-");
  return [t, n];
}
mt(cr, "getSideAndAlignFromPlacement");
var Ao = Qh, Do = eg, Mo = ng, og = Object.defineProperty, sg = (e, t) => og(e, "name", { value: t, configurable: !0 });
function pl(e) {
  const t = u.useRef({ value: e, previous: e });
  return u.useMemo(() => (t.current.value !== e && (t.current.previous = t.current.value, t.current.value = e), t.current.previous), [e]);
}
sg(pl, "usePrevious");
var ag = Object.defineProperty, ig = (e, t) => ag(e, "name", { value: t, configurable: !0 }), hl = Object.freeze({
  // See: https://github.com/twbs/bootstrap/blob/main/scss/mixins/_visually-hidden.scss
  position: "absolute",
  border: 0,
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  wordWrap: "normal"
}), lg = /* @__PURE__ */ u.forwardRef(
  /* @__PURE__ */ ig(function(t, n) {
    return /* @__PURE__ */ f(
      Z.span,
      {
        ...t,
        ref: n,
        style: { ...hl, ...t.style }
      }
    );
  }, "VisuallyHidden")
), cg = lg, dg = Object.defineProperty, ee = (e, t) => dg(e, "name", { value: t, configurable: !0 }), ug = [" ", "Enter", "ArrowUp", "ArrowDown"], fg = [" ", "Enter"], Yt = "Select", [dr, ur, mg] = /* @__PURE__ */ ko(Yt), [_t, ky] = /* @__PURE__ */ _e(Yt, [
  mg,
  en
]), Lo = en(), [pg, yt] = _t(Yt), [hg, gg] = _t(Yt);
function gl(e) {
  const {
    __scopeSelect: t,
    children: n,
    open: r,
    defaultOpen: o,
    onOpenChange: s,
    value: a,
    defaultValue: i,
    onValueChange: d,
    dir: c,
    name: m,
    autoComplete: l,
    disabled: p,
    required: h,
    form: b,
    // @ts-expect-error internal render prop used by `Select` to compose its default parts
    internal_do_not_use_render: v
  } = e, g = Lo(t), [y, C] = u.useState(null), [w, x] = u.useState(null), [E, N] = u.useState(!1), k = qn(c), [S, P] = Ye({
    prop: r,
    defaultProp: o ?? !1,
    onChange: s,
    caller: Yt
  }), [_, M] = Ye({
    prop: a,
    defaultProp: i,
    onChange: d,
    caller: Yt
  }), A = u.useRef(null), T = u.useRef(_);
  u.useEffect(() => {
    const J = b ? y?.ownerDocument.getElementById(b) : y?.form;
    if (J instanceof HTMLFormElement) {
      const se = /* @__PURE__ */ ee(() => M(T.current), "reset");
      return J.addEventListener("reset", se), () => J.removeEventListener("reset", se);
    }
  }, [b, y, M]);
  const D = y ? !!b || !!y.closest("form") : !0, [W, $] = u.useState(/* @__PURE__ */ new Set()), z = De(), H = Array.from(W).map((J) => J.props.value).join(";"), F = u.useCallback((J) => {
    $((se) => new Set(se).add(J));
  }, []), L = u.useCallback((J) => {
    $((se) => {
      const X = new Set(se);
      return X.delete(J), X;
    });
  }, []), ie = {
    required: h,
    trigger: y,
    onTriggerChange: C,
    valueNode: w,
    onValueNodeChange: x,
    valueNodeHasChildren: E,
    onValueNodeHasChildrenChange: N,
    contentId: z,
    value: _,
    onValueChange: M,
    open: S,
    onOpenChange: P,
    dir: k,
    triggerPointerDownPosRef: A,
    disabled: p,
    name: m,
    autoComplete: l,
    form: b,
    nativeOptions: W,
    nativeSelectKey: H,
    isFormControl: D
  };
  return /* @__PURE__ */ f(Ao, { ...g, children: /* @__PURE__ */ f(pg, { scope: t, ...ie, children: /* @__PURE__ */ f(dr.Provider, { scope: t, children: /* @__PURE__ */ f(
    hg,
    {
      scope: t,
      onNativeOptionAdd: F,
      onNativeOptionRemove: L,
      children: El(v) ? v(ie) : n
    }
  ) }) }) });
}
ee(gl, "SelectProvider");
var vg = /* @__PURE__ */ ee((e) => {
  const { __scopeSelect: t, children: n, ...r } = e;
  return /* @__PURE__ */ f(
    gl,
    {
      __scopeSelect: t,
      ...r,
      internal_do_not_use_render: ({ isFormControl: o }) => /* @__PURE__ */ O(Ze, { children: [
        n,
        o ? /* @__PURE__ */ f(
          Wg,
          {
            __scopeSelect: t
          }
        ) : null
      ] })
    }
  );
}, "Select"), bg = "SelectTrigger", vl = /* @__PURE__ */ u.forwardRef(
  /* @__PURE__ */ ee(function(t, n) {
    const { __scopeSelect: r, disabled: o = !1, ...s } = t, a = Lo(r), i = yt(bg, r), d = i.disabled || o, c = re(n, i.onTriggerChange), m = ur(r), l = u.useRef("touch"), [p, h, b] = Fo((g) => {
      const y = m().filter((x) => !x.disabled), C = y.find((x) => x.value === i.value), w = zo(y, g, C);
      w !== void 0 && i.onValueChange(w.value);
    }), v = /* @__PURE__ */ ee((g) => {
      d || (i.onOpenChange(!0), b()), g && (i.triggerPointerDownPosRef.current = {
        x: Math.round(g.pageX),
        y: Math.round(g.pageY)
      });
    }, "handleOpen");
    return /* @__PURE__ */ f(Do, { asChild: !0, ...a, children: /* @__PURE__ */ f(
      Z.button,
      {
        type: "button",
        role: "combobox",
        "aria-controls": i.open ? i.contentId : void 0,
        "aria-expanded": i.open,
        "aria-required": i.required,
        "aria-autocomplete": "none",
        dir: i.dir,
        "data-state": i.open ? "open" : "closed",
        disabled: d,
        "data-disabled": d ? "" : void 0,
        "data-placeholder": yn(i.value) ? "" : void 0,
        ...s,
        ref: c,
        onClick: Y(s.onClick, (g) => {
          g.currentTarget.focus(), l.current !== "mouse" && v(g);
        }),
        onPointerDown: Y(s.onPointerDown, (g) => {
          l.current = g.pointerType;
          const y = g.target;
          y.hasPointerCapture(g.pointerId) && y.releasePointerCapture(g.pointerId), g.button === 0 && g.ctrlKey === !1 && g.pointerType === "mouse" && (v(g), g.preventDefault());
        }),
        onKeyDown: Y(s.onKeyDown, (g) => {
          const y = p.current !== "";
          !(g.ctrlKey || g.altKey || g.metaKey) && g.key.length === 1 && h(g.key), !(y && g.key === " ") && ug.includes(g.key) && (v(), g.preventDefault());
        })
      }
    ) });
  }, "SelectTrigger")
), yg = "SelectValue", xg = /* @__PURE__ */ u.forwardRef(
  /* @__PURE__ */ ee(function(t, n) {
    const { __scopeSelect: r, className: o, style: s, children: a, placeholder: i = "", ...d } = t, c = yt(yg, r), { onValueNodeHasChildrenChange: m } = c, l = a !== void 0, p = re(n, c.onValueNodeChange);
    de(() => {
      m(l);
    }, [m, l]);
    const h = yn(c.value);
    return /* @__PURE__ */ f(
      Z.span,
      {
        ...d,
        asChild: h ? !1 : d.asChild,
        ref: p,
        style: { pointerEvents: "none" },
        children: /* @__PURE__ */ f(u.Fragment, { children: h ? i : a }, h ? "placeholder" : "value")
      }
    );
  }, "SelectValue")
), wg = /* @__PURE__ */ u.forwardRef(
  /* @__PURE__ */ ee(function(t, n) {
    const { __scopeSelect: r, children: o, ...s } = t;
    return /* @__PURE__ */ f(Z.span, { "aria-hidden": !0, ...s, ref: n, children: o || "▼" });
  }, "SelectIcon")
), Cg = "SelectPortal", [Sg, kg] = _t(Cg, {
  forceMount: void 0
}), Eg = /* @__PURE__ */ ee((e) => {
  const { __scopeSelect: t, forceMount: n, ...r } = e;
  return /* @__PURE__ */ f(Sg, { scope: e.__scopeSelect, forceMount: n, children: /* @__PURE__ */ f(po, { asChild: !0, ...r }) });
}, "SelectPortal"), Rt = "SelectContent", bl = /* @__PURE__ */ u.forwardRef(
  /* @__PURE__ */ ee(function(t, n) {
    const r = kg(Rt, t.__scopeSelect), { forceMount: o = r.forceMount, ...s } = t, a = yt(Rt, t.__scopeSelect), [i, d] = u.useState();
    return de(() => {
      d(new DocumentFragment());
    }, []), /* @__PURE__ */ f(lt, { present: o || a.open, children: ({ present: c }) => c ? /* @__PURE__ */ f(Pg, { ...s, ref: n }) : /* @__PURE__ */ f(Ng, { ...s, fragment: i }) });
  }, "SelectContent")
), Ng = /* @__PURE__ */ u.forwardRef(/* @__PURE__ */ ee(function(t, n) {
  const { __scopeSelect: r, children: o, fragment: s } = t;
  return s ? pn.createPortal(
    /* @__PURE__ */ f(yl, { scope: r, children: /* @__PURE__ */ f(dr.Slot, { scope: r, children: /* @__PURE__ */ f("div", { ref: n, children: o }) }) }),
    s
  ) : null;
}, "SelectContentFragment")), Me = 10, [yl, It] = _t(Rt), Rg = /* @__PURE__ */ Ke("SelectContent.RemoveScroll"), Pg = /* @__PURE__ */ u.forwardRef(
  // blank line to reduce diff noise
  /* @__PURE__ */ ee(function(t, n) {
    const { __scopeSelect: r } = t, {
      position: o = "item-aligned",
      onCloseAutoFocus: s,
      onEscapeKeyDown: a,
      onPointerDownOutside: i,
      //
      // PopperContent props
      side: d,
      sideOffset: c,
      align: m,
      alignOffset: l,
      arrowPadding: p,
      collisionBoundary: h,
      collisionPadding: b,
      sticky: v,
      hideWhenDetached: g,
      avoidCollisions: y,
      //
      ...C
    } = t, w = yt(Rt, r), [x, E] = u.useState(null), [N, k] = u.useState(null), S = re(n, E), [P, _] = u.useState(null), [M, A] = u.useState(
      null
    ), T = ur(r), [D, W] = u.useState(!1), $ = u.useRef(!1);
    u.useEffect(() => {
      if (x) return go(x);
    }, [x]), gn();
    const z = u.useCallback(
      (G) => {
        const [B, ...ce] = T().map((oe) => oe.ref.current), [te] = ce.slice(-1), ne = document.activeElement;
        for (const oe of G)
          if (oe === ne || (oe?.scrollIntoView({ block: "nearest" }), oe === B && N && (N.scrollTop = 0), oe === te && N && (N.scrollTop = N.scrollHeight), oe?.focus(), document.activeElement !== ne)) return;
      },
      [T, N]
    ), H = u.useCallback(
      () => z([P, x]),
      [z, P, x]
    );
    u.useEffect(() => {
      D && H();
    }, [D, H]);
    const { onOpenChange: F, triggerPointerDownPosRef: L } = w;
    u.useEffect(() => {
      if (x) {
        let G = { x: 0, y: 0 };
        const B = /* @__PURE__ */ ee((te) => {
          G = {
            x: Math.abs(Math.round(te.pageX) - (L.current?.x ?? 0)),
            y: Math.abs(Math.round(te.pageY) - (L.current?.y ?? 0))
          };
        }, "handlePointerMove"), ce = /* @__PURE__ */ ee((te) => {
          G.x <= 10 && G.y <= 10 ? te.preventDefault() : te.composedPath().includes(x) || F(!1), document.removeEventListener("pointermove", B), L.current = null;
        }, "handlePointerUp");
        return L.current !== null && (document.addEventListener("pointermove", B), document.addEventListener("pointerup", ce, { capture: !0, once: !0 })), () => {
          document.removeEventListener("pointermove", B), document.removeEventListener("pointerup", ce, { capture: !0 });
        };
      }
    }, [x, F, L]), u.useEffect(() => {
      const G = /* @__PURE__ */ ee(() => F(!1), "close");
      return window.addEventListener("blur", G), window.addEventListener("resize", G), () => {
        window.removeEventListener("blur", G), window.removeEventListener("resize", G);
      };
    }, [F]);
    const [ie, J] = Fo((G) => {
      const B = T().filter((ne) => !ne.disabled), ce = B.find((ne) => ne.ref.current === document.activeElement), te = zo(B, G, ce);
      te && setTimeout(() => te.ref.current?.focus());
    }), se = u.useCallback(
      (G, B, ce) => {
        const te = !$.current && !ce;
        (w.value !== void 0 && w.value === B || te) && (_(G), te && ($.current = !0));
      },
      [w.value]
    ), X = u.useCallback(() => x?.focus(), [x]), K = u.useCallback(
      (G, B, ce) => {
        const te = !$.current && !ce;
        (w.value !== void 0 && w.value === B || te) && A(G);
      },
      [w.value]
    ), U = o === "popper" ? ca : Tg, ae = U === ca ? {
      side: d,
      sideOffset: c,
      align: m,
      alignOffset: l,
      arrowPadding: p,
      collisionBoundary: h,
      collisionPadding: b,
      sticky: v,
      hideWhenDetached: g,
      avoidCollisions: y
    } : {};
    return /* @__PURE__ */ f(
      yl,
      {
        scope: r,
        content: x,
        viewport: N,
        onViewportChange: k,
        itemRefCallback: se,
        selectedItem: P,
        onItemLeave: X,
        itemTextRefCallback: K,
        focusSelectedItem: H,
        selectedItemText: M,
        position: o,
        isPositioned: D,
        searchRef: ie,
        children: /* @__PURE__ */ f(er, { as: Rg, allowPinchZoom: !0, children: /* @__PURE__ */ f(
          fo,
          {
            asChild: !0,
            trapped: w.open,
            onMountAutoFocus: (G) => {
              G.preventDefault();
            },
            onUnmountAutoFocus: Y(s, (G) => {
              w.trigger?.focus({ preventScroll: !0 }), G.preventDefault();
            }),
            children: /* @__PURE__ */ f(
              Qn,
              {
                asChild: !0,
                disableOutsidePointerEvents: !0,
                onEscapeKeyDown: a,
                onPointerDownOutside: i,
                onFocusOutside: (G) => G.preventDefault(),
                onDismiss: () => w.onOpenChange(!1),
                children: /* @__PURE__ */ f(
                  U,
                  {
                    role: "listbox",
                    id: w.contentId,
                    "data-state": w.open ? "open" : "closed",
                    dir: w.dir,
                    onContextMenu: (G) => G.preventDefault(),
                    ...C,
                    ...ae,
                    onPlaced: () => W(!0),
                    ref: S,
                    style: {
                      // flex layout so we can place the scroll buttons properly
                      display: "flex",
                      flexDirection: "column",
                      // reset the outline by default as the content MAY get focused
                      outline: "none",
                      ...C.style
                    },
                    onKeyDown: Y(C.onKeyDown, (G) => {
                      const B = G.ctrlKey || G.altKey || G.metaKey;
                      if (G.key === "Tab" && G.preventDefault(), !B && G.key.length === 1 && J(G.key), ["ArrowUp", "ArrowDown", "Home", "End"].includes(G.key)) {
                        let te = T().filter((ne) => !ne.disabled).map((ne) => ne.ref.current);
                        if (["ArrowUp", "End"].includes(G.key) && (te = te.slice().reverse()), ["ArrowUp", "ArrowDown"].includes(G.key)) {
                          const ne = G.target, oe = te.indexOf(ne);
                          te = te.slice(oe + 1);
                        }
                        setTimeout(() => z(te)), G.preventDefault();
                      }
                    })
                  }
                )
              }
            )
          }
        ) })
      }
    );
  }, "SelectContentImpl")
), Tg = /* @__PURE__ */ u.forwardRef(/* @__PURE__ */ ee(function(t, n) {
  const { __scopeSelect: r, onPlaced: o, ...s } = t, a = yt(Rt, r), i = It(Rt, r), [d, c] = u.useState(null), [m, l] = u.useState(null), p = re(n, l), h = ur(r), b = u.useRef(!1), v = u.useRef(!0), { viewport: g, selectedItem: y, selectedItemText: C, focusSelectedItem: w } = i, x = u.useCallback(() => {
    if (a.trigger && a.valueNode && d && m && g && y && C) {
      const S = a.trigger.getBoundingClientRect(), P = m.getBoundingClientRect(), _ = a.valueNode.getBoundingClientRect(), M = C.getBoundingClientRect();
      if (a.dir !== "rtl") {
        const ne = M.left - P.left, oe = _.left - ne, me = S.left - oe, ke = S.width + me, At = Math.max(ke, P.width), Qe = window.innerWidth - Me, Dt = Zr(oe, [
          Me,
          // Prevents the content from going off the starting edge of the
          // viewport. It may still go off the ending edge, but this can be
          // controlled by the user since they may want to manage overflow in a
          // specific way.
          // https://github.com/radix-ui/primitives/issues/2049
          Math.max(Me, Qe - At)
        ]);
        d.style.minWidth = ke + "px", d.style.left = Dt + "px";
      } else {
        const ne = P.right - M.right, oe = window.innerWidth - _.right - ne, me = window.innerWidth - S.right - oe, ke = S.width + me, At = Math.max(ke, P.width), Qe = window.innerWidth - Me, Dt = Zr(oe, [
          Me,
          Math.max(Me, Qe - At)
        ]);
        d.style.minWidth = ke + "px", d.style.right = Dt + "px";
      }
      const A = h(), T = window.innerHeight - Me * 2, D = g.scrollHeight, W = window.getComputedStyle(m), $ = parseInt(W.borderTopWidth, 10), z = parseInt(W.paddingTop, 10), H = parseInt(W.borderBottomWidth, 10), F = parseInt(W.paddingBottom, 10), L = $ + z + D + F + H, ie = Math.min(y.offsetHeight * 5, L), J = window.getComputedStyle(g), se = parseInt(J.paddingTop, 10), X = parseInt(J.paddingBottom, 10), K = S.top + S.height / 2 - Me, U = T - K, ae = y.offsetHeight / 2, G = y.offsetTop + ae, B = $ + z + G, ce = L - B;
      if (B <= K) {
        const ne = A.length > 0 && y === A[A.length - 1].ref.current;
        d.style.bottom = "0px";
        const oe = m.clientHeight - g.offsetTop - g.offsetHeight, me = Math.max(
          U,
          ae + // viewport might have padding bottom, include it to avoid a scrollable viewport
          (ne ? X : 0) + oe + H
        ), ke = B + me;
        d.style.height = ke + "px";
      } else {
        const ne = A.length > 0 && y === A[0].ref.current;
        d.style.top = "0px";
        const me = Math.max(
          K,
          $ + g.offsetTop + // viewport might have padding top, include it to avoid a scrollable viewport
          (ne ? se : 0) + ae
        ) + ce;
        d.style.height = me + "px", g.scrollTop = B - K + g.offsetTop;
      }
      d.style.margin = `${Me}px 0`, d.style.minHeight = ie + "px", d.style.maxHeight = T + "px", o?.(), requestAnimationFrame(() => b.current = !0);
    }
  }, [
    h,
    a.trigger,
    a.valueNode,
    d,
    m,
    g,
    y,
    C,
    a.dir,
    o
  ]);
  de(() => x(), [x]);
  const [E, N] = u.useState();
  de(() => {
    m && N(window.getComputedStyle(m).zIndex);
  }, [m]);
  const k = u.useCallback(
    (S) => {
      S && v.current === !0 && (x(), w?.(), v.current = !1);
    },
    [x, w]
  );
  return /* @__PURE__ */ f(
    _g,
    {
      scope: r,
      contentWrapper: d,
      shouldExpandOnScrollRef: b,
      onScrollButtonChange: k,
      children: /* @__PURE__ */ f(
        "div",
        {
          ref: c,
          style: {
            display: "flex",
            flexDirection: "column",
            position: "fixed",
            zIndex: E
          },
          children: /* @__PURE__ */ f(
            Z.div,
            {
              ...s,
              ref: p,
              style: {
                // When we get the height of the content, it includes borders. If we were to set
                // the height without having `boxSizing: 'border-box'` it would be too big.
                boxSizing: "border-box",
                // We need to ensure the content doesn't get taller than the wrapper
                maxHeight: "100%",
                ...s.style
              }
            }
          )
        }
      )
    }
  );
}, "SelectItemAlignedPosition")), ca = /* @__PURE__ */ u.forwardRef(/* @__PURE__ */ ee(function(t, n) {
  const {
    __scopeSelect: r,
    align: o = "start",
    collisionPadding: s = Me,
    ...a
  } = t, i = Lo(r);
  return /* @__PURE__ */ f(
    Mo,
    {
      ...i,
      ...a,
      ref: n,
      align: o,
      collisionPadding: s,
      style: {
        // Ensure border-box for floating-ui calculations
        boxSizing: "border-box",
        ...a.style,
        "--radix-select-content-transform-origin": "var(--radix-popper-transform-origin)",
        "--radix-select-content-available-width": "var(--radix-popper-available-width)",
        "--radix-select-content-available-height": "var(--radix-popper-available-height)",
        "--radix-select-trigger-width": "var(--radix-popper-anchor-width)",
        "--radix-select-trigger-height": "var(--radix-popper-anchor-height)"
      }
    }
  );
}, "SelectPopperPosition")), [_g, $o] = _t(Rt, {}), da = "SelectViewport", Ig = /* @__PURE__ */ u.forwardRef(
  /* @__PURE__ */ ee(function(t, n) {
    const { __scopeSelect: r, nonce: o, ...s } = t, a = It(da, r), i = $o(da, r), d = re(n, a.onViewportChange), c = u.useRef(0);
    return /* @__PURE__ */ O(Ze, { children: [
      /* @__PURE__ */ f(
        "style",
        {
          dangerouslySetInnerHTML: {
            __html: "[data-radix-select-viewport]{scrollbar-width:none;-ms-overflow-style:none;-webkit-overflow-scrolling:touch;}[data-radix-select-viewport]::-webkit-scrollbar{display:none}"
          },
          nonce: o
        }
      ),
      /* @__PURE__ */ f(dr.Slot, { scope: r, children: /* @__PURE__ */ f(
        Z.div,
        {
          "data-radix-select-viewport": "",
          role: "presentation",
          ...s,
          ref: d,
          style: {
            // we use position: 'relative' here on the `viewport` so that when we call
            // `selectedItem.offsetTop` in calculations, the offset is relative to the viewport
            // (independent of the scrollUpButton).
            position: "relative",
            flex: 1,
            // Viewport should only be scrollable in the vertical direction.
            // This won't work in vertical writing modes, so we'll need to
            // revisit this if/when that is supported
            // https://developer.chrome.com/blog/vertical-form-controls
            overflow: "hidden auto",
            ...s.style
          },
          onScroll: Y(s.onScroll, (m) => {
            const l = m.currentTarget, { contentWrapper: p, shouldExpandOnScrollRef: h } = i;
            if (h?.current && p) {
              const b = Math.abs(c.current - l.scrollTop);
              if (b > 0) {
                const v = window.innerHeight - Me * 2, g = parseFloat(p.style.minHeight), y = parseFloat(p.style.height), C = Math.max(g, y);
                if (C < v) {
                  const w = C + b, x = Math.min(v, w), E = w - x;
                  p.style.height = x + "px", p.style.bottom === "0px" && (l.scrollTop = E > 0 ? E : 0, p.style.justifyContent = "flex-end");
                }
              }
            }
            c.current = l.scrollTop;
          })
        }
      ) })
    ] });
  }, "SelectViewport")
), Og = "SelectGroup", [Ag, Dg] = _t(Og), Mg = /* @__PURE__ */ u.forwardRef(
  /* @__PURE__ */ ee(function(t, n) {
    const { __scopeSelect: r, ...o } = t, s = De();
    return /* @__PURE__ */ f(Ag, { scope: r, id: s, children: /* @__PURE__ */ f(Z.div, { role: "group", "aria-labelledby": s, ...o, ref: n }) });
  }, "SelectGroup")
), Lg = "SelectLabel", xl = /* @__PURE__ */ u.forwardRef(
  /* @__PURE__ */ ee(function(t, n) {
    const { __scopeSelect: r, ...o } = t, s = Dg(Lg, r);
    return /* @__PURE__ */ f(Z.div, { id: s.id, ...o, ref: n });
  }, "SelectLabel")
), to = "SelectItem", [$g, wl] = _t(to), Cl = /* @__PURE__ */ u.forwardRef(
  /* @__PURE__ */ ee(function(t, n) {
    const {
      __scopeSelect: r,
      value: o,
      disabled: s = !1,
      textValue: a,
      ...i
    } = t, d = yt(to, r), c = It(to, r), m = d.value === o, [l, p] = u.useState(a ?? ""), [h, b] = u.useState(!1), v = Le(
      (x) => c.itemRefCallback?.(x, o, s)
    ), g = re(n, v), y = De(), C = u.useRef("touch"), w = /* @__PURE__ */ ee(() => {
      s || (d.onValueChange(o), d.onOpenChange(!1));
    }, "handleSelect");
    return /* @__PURE__ */ f(
      $g,
      {
        scope: r,
        value: o,
        disabled: s,
        textId: y,
        isSelected: m,
        onItemTextChange: u.useCallback((x) => {
          p((E) => E || (x?.textContent ?? "").trim());
        }, []),
        children: /* @__PURE__ */ f(
          dr.ItemSlot,
          {
            scope: r,
            value: o,
            disabled: s,
            textValue: l,
            children: /* @__PURE__ */ f(
              Z.div,
              {
                role: "option",
                "aria-labelledby": y,
                "data-highlighted": h ? "" : void 0,
                "aria-selected": m && h,
                "data-state": m ? "checked" : "unchecked",
                "aria-disabled": s || void 0,
                "data-disabled": s ? "" : void 0,
                tabIndex: s ? void 0 : -1,
                ...i,
                ref: g,
                onFocus: Y(i.onFocus, () => b(!0)),
                onBlur: Y(i.onBlur, () => b(!1)),
                onClick: Y(i.onClick, () => {
                  C.current !== "mouse" && w();
                }),
                onPointerUp: Y(i.onPointerUp, () => {
                  C.current === "mouse" && w();
                }),
                onPointerDown: Y(i.onPointerDown, (x) => {
                  C.current = x.pointerType;
                }),
                onPointerMove: Y(i.onPointerMove, (x) => {
                  C.current = x.pointerType, s ? c.onItemLeave?.() : C.current === "mouse" && x.currentTarget.focus({ preventScroll: !0 });
                }),
                onPointerLeave: Y(i.onPointerLeave, (x) => {
                  x.currentTarget === document.activeElement && c.onItemLeave?.();
                }),
                onKeyDown: Y(i.onKeyDown, (x) => {
                  s || x.target !== x.currentTarget || c.searchRef?.current !== "" && x.key === " " || (fg.includes(x.key) && w(), x.key === " " && x.preventDefault());
                })
              }
            )
          }
        )
      }
    );
  }, "SelectItem")
), Dn = "SelectItemText", Fg = /* @__PURE__ */ u.forwardRef(
  /* @__PURE__ */ ee(function(t, n) {
    const { __scopeSelect: r, className: o, style: s, ...a } = t, i = yt(Dn, r), d = It(Dn, r), c = wl(Dn, r), m = gg(Dn, r), [l, p] = u.useState(null), h = Le(
      (w) => d.itemTextRefCallback?.(w, c.value, c.disabled)
    ), b = re(
      n,
      p,
      c.onItemTextChange,
      h
    ), v = l?.textContent, g = u.useMemo(
      () => /* @__PURE__ */ f("option", { value: c.value, disabled: c.disabled, children: v }, c.value),
      [c.disabled, c.value, v]
    ), { onNativeOptionAdd: y, onNativeOptionRemove: C } = m;
    return de(() => (y(g), () => C(g)), [y, C, g]), /* @__PURE__ */ O(Ze, { children: [
      /* @__PURE__ */ f(Z.span, { id: c.textId, ...a, ref: b }),
      c.isSelected && i.valueNode && !i.valueNodeHasChildren && !yn(i.value) ? pn.createPortal(a.children, i.valueNode) : null
    ] });
  }, "SelectItemText")
), zg = "SelectItemIndicator", Bg = /* @__PURE__ */ u.forwardRef(
  // blank line to reduce diff noise
  /* @__PURE__ */ ee(function(t, n) {
    const { __scopeSelect: r, ...o } = t;
    return wl(zg, r).isSelected ? /* @__PURE__ */ f(Z.span, { "aria-hidden": !0, ...o, ref: n }) : null;
  }, "SelectItemIndicator")
), ua = "SelectScrollUpButton", Vg = /* @__PURE__ */ u.forwardRef(/* @__PURE__ */ ee(function(t, n) {
  const r = It(ua, t.__scopeSelect), o = $o(ua, t.__scopeSelect), [s, a] = u.useState(!1), i = re(n, o.onScrollButtonChange);
  return de(() => {
    if (r.viewport && r.isPositioned) {
      let d = function() {
        const m = c.scrollTop > 0;
        a(m);
      };
      ee(d, "handleScroll");
      const c = r.viewport;
      return d(), c.addEventListener("scroll", d), () => c.removeEventListener("scroll", d);
    }
  }, [r.viewport, r.isPositioned]), s ? /* @__PURE__ */ f(
    Sl,
    {
      ...t,
      ref: i,
      onAutoScroll: () => {
        const { viewport: d, selectedItem: c } = r;
        d && c && (d.scrollTop = d.scrollTop - c.offsetHeight);
      }
    }
  ) : null;
}, "SelectScrollUpButton")), fa = "SelectScrollDownButton", jg = /* @__PURE__ */ u.forwardRef(/* @__PURE__ */ ee(function(t, n) {
  const r = It(fa, t.__scopeSelect), o = $o(fa, t.__scopeSelect), [s, a] = u.useState(!1), i = re(n, o.onScrollButtonChange);
  return de(() => {
    if (r.viewport && r.isPositioned) {
      let d = function() {
        const m = c.scrollHeight - c.clientHeight, l = Math.ceil(c.scrollTop) < m;
        a(l);
      };
      ee(d, "handleScroll");
      const c = r.viewport;
      return d(), c.addEventListener("scroll", d), () => c.removeEventListener("scroll", d);
    }
  }, [r.viewport, r.isPositioned]), s ? /* @__PURE__ */ f(
    Sl,
    {
      ...t,
      ref: i,
      onAutoScroll: () => {
        const { viewport: d, selectedItem: c } = r;
        d && c && (d.scrollTop = d.scrollTop + c.offsetHeight);
      }
    }
  ) : null;
}, "SelectScrollDownButton")), Sl = /* @__PURE__ */ u.forwardRef(/* @__PURE__ */ ee(function(t, n) {
  const { __scopeSelect: r, onAutoScroll: o, ...s } = t, a = It("SelectScrollButton", r), i = u.useRef(null), d = ur(r), c = u.useCallback(() => {
    i.current !== null && (window.clearInterval(i.current), i.current = null);
  }, []);
  return u.useEffect(() => () => c(), [c]), de(() => {
    d().find((l) => l.ref.current === document.activeElement)?.ref.current?.scrollIntoView({ block: "nearest" });
  }, [d]), /* @__PURE__ */ f(
    Z.div,
    {
      "aria-hidden": !0,
      ...s,
      ref: n,
      style: { flexShrink: 0, ...s.style },
      onPointerDown: Y(s.onPointerDown, () => {
        i.current === null && (i.current = window.setInterval(o, 50));
      }),
      onPointerMove: Y(s.onPointerMove, () => {
        a.onItemLeave?.(), i.current === null && (i.current = window.setInterval(o, 50));
      }),
      onPointerLeave: Y(s.onPointerLeave, () => {
        c();
      })
    }
  );
}, "SelectScrollButtonImpl")), kl = /* @__PURE__ */ u.forwardRef(
  // blank line to reduce diff noise
  /* @__PURE__ */ ee(function(t, n) {
    const { __scopeSelect: r, ...o } = t;
    return /* @__PURE__ */ f(Z.div, { "aria-hidden": !0, ...o, ref: n });
  }, "SelectSeparator")
), Hg = "SelectBubbleInput", Wg = /* @__PURE__ */ u.forwardRef(
  // blank line to reduce diff noise
  /* @__PURE__ */ ee(function({ __scopeSelect: t, ...n }, r) {
    const o = yt(Hg, t), { value: s, onValueChange: a, required: i, disabled: d, name: c, autoComplete: m, form: l } = o, { nativeOptions: p, nativeSelectKey: h } = o, b = u.useRef(null), v = re(r, b), g = s ?? "", y = pl(g), C = Array.from(p).some(
      (w) => (w.props.value ?? "") === ""
    );
    return u.useEffect(() => {
      const w = b.current;
      if (!w) return;
      const x = window.HTMLSelectElement.prototype, N = Object.getOwnPropertyDescriptor(
        x,
        "value"
      ).set;
      if (y !== g && N) {
        const k = new Event("change", { bubbles: !0 });
        N.call(w, g), w.dispatchEvent(k);
      }
    }, [y, g]), /* @__PURE__ */ O(
      Z.select,
      {
        "aria-hidden": !0,
        required: i,
        tabIndex: -1,
        name: c,
        autoComplete: m,
        disabled: d,
        form: l,
        onChange: (w) => a(w.target.value),
        ...n,
        style: { ...hl, ...n.style },
        ref: v,
        defaultValue: g,
        children: [
          yn(s) && !C ? /* @__PURE__ */ f("option", { value: "" }) : null,
          Array.from(p)
        ]
      },
      h
    );
  }, "SelectBubbleInput")
);
function El(e) {
  return typeof e == "function";
}
ee(El, "isFunction");
function yn(e) {
  return e === "" || e === void 0;
}
ee(yn, "shouldShowPlaceholder");
function Fo(e) {
  const t = Le(e), n = u.useRef(""), r = u.useRef(0), o = u.useCallback(
    (a) => {
      const i = n.current + a;
      t(i), (/* @__PURE__ */ ee((function d(c) {
        n.current = c, window.clearTimeout(r.current), c !== "" && (r.current = window.setTimeout(() => d(""), 1e3));
      }), "updateSearch"))(i);
    },
    [t]
  ), s = u.useCallback(() => {
    n.current = "", window.clearTimeout(r.current);
  }, []);
  return u.useEffect(() => () => window.clearTimeout(r.current), []), [n, o, s];
}
ee(Fo, "useTypeaheadSearch");
function zo(e, t, n) {
  const o = t.length > 1 && Array.from(t).every((c) => c === t[0]) ? t[0] : t, s = n ? e.indexOf(n) : -1;
  let a = Nl(e, Math.max(s, 0));
  o.length === 1 && (a = a.filter((c) => c !== n));
  const d = a.find(
    (c) => c.textValue.toLowerCase().startsWith(o.toLowerCase())
  );
  return d !== n ? d : void 0;
}
ee(zo, "findNextItem");
function Nl(e, t) {
  return e.map((n, r) => e[(t + r) % e.length]);
}
ee(Nl, "wrapArray");
const Ug = vg, Ey = Mg, Gg = xg, Rl = u.memo(
  u.forwardRef(
    ({ className: e, children: t, disabled: n, style: r, variant: o, size: s, ...a }, i) => /* @__PURE__ */ O(
      vl,
      {
        ref: i,
        disabled: n,
        style: r,
        className: I(Fi({ variant: o, size: s }), e),
        ...a,
        children: [
          t,
          /* @__PURE__ */ f(wg, { asChild: !0, children: /* @__PURE__ */ f(
            Zn,
            {
              className: "h-5 w-5 shrink-0",
              style: { opacity: 0.5 }
            }
          ) })
        ]
      }
    )
  )
);
Rl.displayName = vl.displayName;
const Pl = u.memo(
  u.forwardRef(
    ({ className: e, children: t, position: n = "popper", width: r = "content", ...o }, s) => /* @__PURE__ */ f(Eg, { children: /* @__PURE__ */ O(
      bl,
      {
        ref: s,
        position: n,
        className: I(
          "relative z-50 min-w-[8rem] overflow-hidden rounded-[calc(var(--radius,0.5rem)-2px)] border border-border bg-background text-foreground shadow-md",
          "data-[state=open]:animate-in data-[state=closed]:animate-out",
          "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
          "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
          "data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2",
          "data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
          n === "popper" && "data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1",
          e
        ),
        ...o,
        children: [
          /* @__PURE__ */ f(
            Ig,
            {
              className: I(
                "p-1",
                "p-1",
                n === "popper" && (r === "stretch" ? "h-[var(--radix-select-trigger-height)] w-[var(--radix-select-trigger-width)]" : "h-[var(--radix-select-trigger-height)] min-w-[var(--radix-select-trigger-width)]")
              ),
              children: t
            }
          ),
          /* @__PURE__ */ f(Vg, { className: "flex cursor-default items-center justify-center py-2 text-foreground", children: /* @__PURE__ */ f(Ed, { className: "h-5 w-5" }) }),
          /* @__PURE__ */ f(jg, { className: "flex cursor-default items-center justify-center py-2 text-foreground", children: /* @__PURE__ */ f(Zn, { className: "h-5 w-5" }) })
        ]
      }
    ) })
  )
);
Pl.displayName = bl.displayName;
const Kg = u.forwardRef(({ className: e, ...t }, n) => /* @__PURE__ */ f(
  xl,
  {
    ref: n,
    className: I("px-2 py-2 text-ui font-semibold text-foreground", e),
    ...t
  }
));
Kg.displayName = xl.displayName;
const Tl = u.memo(
  u.forwardRef(({ className: e, children: t, size: n, ...r }, o) => /* @__PURE__ */ O(
    Cl,
    {
      ref: o,
      className: I(
        zi({
          size: n,
          indicator: "check",
          padding: "withIndicator"
        }),
        "text-foreground transition-colors",
        e
      ),
      ...r,
      children: [
        /* @__PURE__ */ f("span", { className: "absolute left-4 flex h-5 w-5 items-center justify-center", children: /* @__PURE__ */ f(Bg, { children: /* @__PURE__ */ f(jn, { className: "h-4 w-4" }) }) }),
        /* @__PURE__ */ f(Fg, { children: t })
      ]
    }
  ))
);
Tl.displayName = Cl.displayName;
const Yg = u.forwardRef(({ className: e, ...t }, n) => /* @__PURE__ */ f(
  kl,
  {
    ref: n,
    className: I("-mx-1 my-1 h-px bg-border", e),
    ...t
  }
));
Yg.displayName = kl.displayName;
const Xg = [
  { value: "ja", label: "日本語" },
  { value: "en", label: "English" }
], Ny = R.memo(
  ({
    className: e = "",
    buttonClassName: t = "",
    id: n,
    align: r = "right",
    value: o,
    onValueChange: s,
    languages: a = Xg
  }) => {
    const { i18n: i } = Pc(), d = (m) => {
      s ? s(m) : i.changeLanguage(m);
      const l = globalThis.log;
      l && typeof l.info == "function" && l.info("Language changed", { language: m });
    }, c = o ?? i.language ?? "ja";
    return /* @__PURE__ */ f("div", { className: I("relative", e), id: n, children: /* @__PURE__ */ O(Ug, { value: c, onValueChange: d, children: [
      /* @__PURE__ */ f(
        Rl,
        {
          className: I("w-auto min-w-[100px]", t),
          children: /* @__PURE__ */ O("div", { className: "flex items-center gap-2", children: [
            /* @__PURE__ */ f(Ld, { className: "w-[var(--ui-icon-size)] h-[var(--ui-icon-size)]" }),
            /* @__PURE__ */ f(Gg, {})
          ] })
        }
      ),
      /* @__PURE__ */ f(Pl, { align: r === "left" ? "start" : "end", children: a.map((m) => /* @__PURE__ */ f(Tl, { value: m.value, children: m.label }, m.value)) })
    ] }) });
  }
);
function qg(e, t) {
  if (e.length === 0 || t <= 0)
    return e.length || 1;
  let n = e.length;
  for (; n > 1; ) {
    const r = [];
    for (let s = 0; s < n; s++) {
      let a = 0;
      for (let i = s; i < e.length; i += n) {
        const d = e[i];
        d !== void 0 && d > a && (a = d);
      }
      r.push(a);
    }
    if (r.reduce((s, a) => s + a, 0) <= t)
      break;
    n--;
  }
  return n;
}
function Zg(e, t) {
  if (t <= 0)
    return {
      lastRowStartIndex: 0,
      lastRowItemCount: e,
      isLastRowFull: !0
    };
  const n = Math.floor(e / t) * t, r = e - n;
  return { lastRowStartIndex: n, lastRowItemCount: r, isLastRowFull: r === t || r === 0 };
}
const Ry = ({
  items: e = [],
  selectedId: t,
  onAction: n,
  className: r,
  stretchLastRow: o = !1,
  _testColumnCount: s
}) => {
  const a = u.useRef(null), i = u.useRef(null), [d, c] = u.useState(
    s ?? 0
  ), [m, l] = u.useState([]), [p, h] = u.useState(
    s !== void 0
  ), b = e?.filter((S) => !S.separator) || [], v = b.map((S) => S.label).join(","), g = s ?? d;
  u.useEffect(() => {
    if (p || s !== void 0) return;
    const P = setTimeout(() => {
      if (!i.current) return;
      const _ = i.current.querySelectorAll(
        '[data-measure="true"]'
      );
      if (_.length === 0) return;
      const M = [];
      _.forEach((A) => {
        M.push(A.offsetWidth);
      }), l(M), h(!0);
    }, 0);
    return () => clearTimeout(P);
  }, [p, s]), u.useEffect(() => {
    if (m.length === 0 || s !== void 0) return;
    const S = () => {
      if (!a.current) return;
      const _ = a.current.offsetWidth;
      if (_ === 0) return;
      const M = qg(m, _);
      c(M);
    };
    S();
    const P = new ResizeObserver(S);
    return a.current && P.observe(a.current), () => P.disconnect();
  }, [m, s]), u.useEffect(() => {
    s === void 0 && (h(!1), l([]), c(0));
  }, [v, s]);
  const y = (S) => {
    S.disabled || (S.onClick?.(), S.action && n && n(S.action));
  }, { lastRowStartIndex: C, isLastRowFull: w } = Zg(
    b.length,
    g
  ), x = (S, P, _) => {
    const M = t && S.action === t;
    let A = "gap-ui justify-start text-ui rounded-none border-b border-r border-border h-auto py-ui px-ui whitespace-nowrap";
    M ? A += " bg-accent text-accent-foreground font-bold" : A += " text-muted-foreground hover:text-foreground hover:bg-muted";
    const T = S.label.length > 16 ? S.label.slice(0, 16) : S.label;
    return /* @__PURE__ */ O(
      ye,
      {
        variant: "ghost",
        disabled: S.disabled,
        onClick: _ ? void 0 : () => y(S),
        className: I(A),
        "data-measure": _ ? "true" : void 0,
        children: [
          S.icon,
          /* @__PURE__ */ f(Wn, { text: T })
        ]
      },
      `${_ ? "measure-" : ""}${S.label}-${P}`
    );
  }, E = g > 0 ? {
    gridTemplateColumns: `repeat(${g}, minmax(max-content, 1fr))`
  } : {}, N = o && !w ? b.slice(0, C) : b, k = o && !w ? b.slice(C) : [];
  return /* @__PURE__ */ O(Ze, { children: [
    !p && /* @__PURE__ */ f(
      "div",
      {
        ref: i,
        className: "absolute invisible flex flex-wrap",
        "aria-hidden": "true",
        "data-testid": "measure-container",
        children: b.map((S, P) => x(S, P, !0))
      }
    ),
    /* @__PURE__ */ O(
      "div",
      {
        ref: a,
        className: I(
          "grid items-center gap-0 border border-border rounded-lg overflow-hidden",
          r
        ),
        style: E,
        children: [
          N.map((S, P) => x(S, P, !1)),
          k.length > 0 && k.map((S, P) => {
            const _ = C + P, M = t && S.action === t;
            let A = "gap-ui justify-start text-ui rounded-none border-b border-r border-border h-auto py-ui px-ui whitespace-nowrap";
            M ? A += " bg-accent text-accent-foreground font-bold" : A += " text-muted-foreground hover:text-foreground hover:bg-muted";
            const D = {
              gridColumn: `span ${Math.ceil(
                g / k.length
              )}`
            }, W = S.label.length > 16 ? S.label.slice(0, 16) : S.label;
            return /* @__PURE__ */ O(
              ye,
              {
                variant: "ghost",
                disabled: S.disabled,
                onClick: () => y(S),
                className: I(A),
                style: D,
                children: [
                  S.icon,
                  /* @__PURE__ */ f(Wn, { text: W })
                ]
              },
              `${S.label}-${_}`
            );
          })
        ]
      }
    )
  ] });
}, Py = ({
  columns: e,
  rows: t,
  dense: n = !1,
  size: r = "sm",
  headerBg: o,
  hideHeader: s = !1
}) => {
  const a = "px-[var(--ui-component-padding-x)] py-[var(--ui-component-padding-y)]", i = "text-ui", d = "text-ui", c = a;
  return /* @__PURE__ */ f("div", { className: "overflow-hidden rounded border border-border bg-card m-0", children: /* @__PURE__ */ O(
    "div",
    {
      className: "grid",
      style: {
        gridTemplateColumns: e.map((m) => m.width || "1fr").join(" ")
      },
      children: [
        !s && e.map((m) => /* @__PURE__ */ f(
          "div",
          {
            className: `${i} font-semibold uppercase tracking-wide text-muted-foreground border-b border-border ${o || ""} ${a}`,
            style: { textAlign: m.align || "left" },
            children: m.label
          },
          m.key
        )),
        t.map(
          (m) => e.map((l) => /* @__PURE__ */ f(
            "div",
            {
              className: `${d} text-foreground border-b border-border/60 last:border-b-0 ${c}`,
              style: { textAlign: l.align || "left" },
              children: m.cells[l.key]
            },
            `${m.key}-${l.key}`
          ))
        )
      ]
    }
  ) });
}, Qg = (e, t, n) => Math.min(Math.max(e, t), n), Ty = R.memo(
  ({
    steps: e,
    activeStep: t,
    onStepChange: n,
    renderStepContent: r,
    orientation: o = "horizontal",
    variant: s = "split",
    compactOnMobile: a = !0,
    inlineContentOnVerticalMobile: i = !0,
    className: d
  }) => {
    const c = Qg(t, 0, Math.max(e.length - 1, 0)), m = (v) => v < c ? "completed" : v === c ? "current" : "upcoming", l = (v, g) => I("h-[var(--ui-step-circle-size)] w-[var(--ui-step-circle-size)] rounded-full border-2 flex items-center justify-center text-xs font-semibold flex-shrink-0 transition-colors", v === "completed" ? "bg-success border-success text-primary-foreground" : v === "current" ? "bg-primary border-primary text-primary-foreground" : "bg-background border-border text-muted-foreground", n ? "cursor-pointer hover:brightness-110" : "", g ? "opacity-50 cursor-not-allowed hover:brightness-100" : ""), p = (v, g, y) => n ? /* @__PURE__ */ f(
      "button",
      {
        type: "button",
        onClick: () => {
          y || n(v);
        },
        disabled: y,
        "aria-current": v === c ? "step" : void 0,
        children: g
      }
    ) : /* @__PURE__ */ f("div", { className: I(y ? "pointer-events-none" : ""), children: g });
    if (e.length === 0)
      return null;
    if (o === "vertical") {
      const v = e[c], g = s === "accordion";
      return /* @__PURE__ */ f("nav", { "aria-label": "Progress", className: I("w-full", d), children: /* @__PURE__ */ O(
        "div",
        {
          className: I(
            "grid gap-3",
            g ? "grid-cols-1" : "grid-cols-1 sm:grid-cols-[192px_1fr]"
          ),
          children: [
            /* @__PURE__ */ f("ol", { className: "flex flex-col", children: e.map((y, C) => {
              const w = m(C), x = C === e.length - 1, E = C === c;
              return /* @__PURE__ */ O("li", { className: "flex flex-col", children: [
                /* @__PURE__ */ O("div", { className: "flex items-start gap-2", children: [
                  /* @__PURE__ */ O("div", { className: "flex flex-col items-center", children: [
                    p(
                      C,
                      /* @__PURE__ */ f("div", { className: l(w, y.disabled), children: w === "completed" ? /* @__PURE__ */ f(jn, { className: "h-4 w-4" }) : C + 1 }),
                      y.disabled
                    ),
                    !x && /* @__PURE__ */ f(
                      "div",
                      {
                        className: I(
                          "w-0.5 flex-1 mt-2",
                          w === "completed" ? "bg-success" : "bg-border"
                        ),
                        style: {
                          minHeight: g && E ? 32 : 16
                        }
                      }
                    )
                  ] }),
                  /* @__PURE__ */ O("div", { className: "min-w-0 pb-3 flex-1", children: [
                    /* @__PURE__ */ O("div", { className: "flex items-center gap-2", children: [
                      /* @__PURE__ */ f(
                        "div",
                        {
                          className: I(
                            "text-sm font-semibold",
                            y.disabled ? "text-muted-foreground/50" : w === "current" ? "text-foreground" : "text-muted-foreground"
                          ),
                          children: y.title
                        }
                      ),
                      w === "current" && /* @__PURE__ */ f("span", { className: "text-xs px-2 py-0.5 rounded bg-card text-muted-foreground", children: "Current" })
                    ] }),
                    y.description && /* @__PURE__ */ f("div", { className: "text-xs text-muted-foreground mt-0.5", children: y.description })
                  ] })
                ] }),
                (i || g) && E && r && /* @__PURE__ */ f(
                  "div",
                  {
                    className: I(
                      "w-full pb-8 pl-9",
                      // Indent content in accordion
                      !g && "sm:hidden"
                    ),
                    children: /* @__PURE__ */ f("div", { className: "w-full", children: r(y, C) })
                  }
                )
              ] }, y.id);
            }) }),
            !g && r && v && /* @__PURE__ */ f("div", { className: "hidden sm:block", children: /* @__PURE__ */ f("div", { className: "rounded-lg border border-border bg-background p-1", children: r(v, c) }) })
          ]
        }
      ) });
    }
    const h = e[c], b = h?.title;
    return /* @__PURE__ */ f("nav", { "aria-label": "Progress", className: I("w-full", d), children: /* @__PURE__ */ O("div", { className: "flex flex-col gap-3", children: [
      a && /* @__PURE__ */ O(
        "div",
        {
          className: "text-sm text-muted-foreground sm:hidden",
          "aria-live": "polite",
          children: [
            c + 1,
            " / ",
            e.length,
            b ? ` - ${b}` : ""
          ]
        }
      ),
      /* @__PURE__ */ f(
        "ol",
        {
          className: I(
            "flex items-center gap-2 overflow-x-auto pb-1",
            a && "sm:overflow-visible"
          ),
          children: e.map((v, g) => {
            const y = m(g), C = g === e.length - 1, w = g === c;
            return /* @__PURE__ */ O(R.Fragment, { children: [
              /* @__PURE__ */ O(
                "li",
                {
                  className: I(
                    "flex flex-col items-center flex-shrink-0",
                    a ? "min-w-[40px] sm:min-w-[120px]" : "min-w-[120px]"
                  ),
                  children: [
                    p(
                      g,
                      /* @__PURE__ */ f("div", { className: l(y, v.disabled), children: y === "completed" ? /* @__PURE__ */ f(jn, { className: "h-4 w-4" }) : g + 1 }),
                      v.disabled
                    ),
                    /* @__PURE__ */ O(
                      "div",
                      {
                        className: I(
                          "mt-2 text-center min-w-0",
                          a ? w ? "sm:block" : "hidden sm:block" : "block"
                        ),
                        children: [
                          /* @__PURE__ */ f(
                            "div",
                            {
                              className: I(
                                "text-xs font-semibold truncate",
                                v.disabled ? "text-muted-foreground/50" : y === "current" ? "text-foreground" : y === "completed" ? "text-muted-foreground" : "text-muted-foreground/50"
                              ),
                              title: v.title,
                              children: v.title
                            }
                          ),
                          v.description && /* @__PURE__ */ f(
                            "div",
                            {
                              className: "hidden sm:block text-xs text-muted-foreground truncate",
                              title: v.description,
                              children: v.description
                            }
                          )
                        ]
                      }
                    )
                  ]
                }
              ),
              !C && /* @__PURE__ */ f(
                "div",
                {
                  className: I(
                    "h-0.5 flex-shrink-0",
                    y === "completed" ? "bg-success" : "bg-border",
                    a ? "w-8 min-w-8 sm:w-16" : "w-16 min-w-16"
                  ),
                  "aria-hidden": "true"
                }
              )
            ] }, v.id);
          })
        }
      ),
      r && h && /* @__PURE__ */ f("div", { className: "rounded-lg border border-border bg-background p-1", children: r(h, c) })
    ] }) });
  }
);
function _y({
  appName: e,
  title: t,
  message: n,
  icon: r,
  timestamp: o,
  dateTime: s,
  status: a,
  actions: i,
  className: d = "",
  ...c
}) {
  return /* @__PURE__ */ O("article", { className: `notification-card ${d}`, ...c, children: [
    /* @__PURE__ */ O("div", { className: "notification-card-heading", children: [
      r && /* @__PURE__ */ f("span", { className: "notification-card-icon", "aria-hidden": "true", children: r }),
      /* @__PURE__ */ f("span", { className: "notification-card-app", children: e }),
      o && /* @__PURE__ */ f("time", { dateTime: s, children: o })
    ] }),
    /* @__PURE__ */ O("div", { className: "notification-card-content", children: [
      /* @__PURE__ */ f("h3", { children: t }),
      /* @__PURE__ */ f("p", { children: n }),
      a && /* @__PURE__ */ f("div", { className: "notification-card-status", children: a })
    ] }),
    i && /* @__PURE__ */ f("div", { className: "notification-card-actions", children: i })
  ] });
}
const Jg = {
  info: "border-l-info",
  success: "border-l-success",
  warning: "border-l-warning",
  error: "border-l-destructive"
}, ev = {
  info: Fd,
  success: _d,
  warning: ru,
  error: Ia
}, tv = {
  info: "text-info",
  success: "text-success",
  warning: "text-warning",
  error: "text-destructive"
}, nv = u.memo(
  ({
    type: e,
    title: t,
    message: n,
    linkLabel: r,
    onClickLink: o,
    onClose: s,
    showCloseButton: a = !0,
    className: i,
    ...d
  }) => {
    const c = (h, b) => b ?? h, m = Jg[e], l = typeof o == "function", p = ev[e];
    return /* @__PURE__ */ O(
      "div",
      {
        className: I(
          "relative w-full max-w-sm bg-background shadow-md rounded-lg border border-border border-l-4",
          "pr-[calc(var(--ui-component-padding-x)+5px)] pl-1 py-[calc(var(--ui-component-padding-y)+5px)]",
          m,
          l ? "hover:shadow-lg" : void 0,
          i
        ),
        role: "alert",
        "aria-live": "polite",
        "aria-atomic": "true",
        ...d,
        children: [
          /* @__PURE__ */ O("div", { className: "flex items-start gap-[var(--ui-gap-base)]", children: [
            /* @__PURE__ */ f(
              "div",
              {
                className: I("shrink-0", tv[e]),
                "aria-hidden": "true",
                children: /* @__PURE__ */ f(p, { className: "h-4 w-4" })
              }
            ),
            /* @__PURE__ */ f("div", { className: "flex-1 min-w-0", children: l ? /* @__PURE__ */ f(
              "button",
              {
                type: "button",
                className: "w-full text-left",
                onClick: o,
                "aria-label": r ? `${t}. ${r}` : t,
                children: /* @__PURE__ */ O("div", { className: "min-w-0", children: [
                  /* @__PURE__ */ f("h4", { className: "text-sm font-bold text-foreground truncate leading-tight", children: t }),
                  /* @__PURE__ */ f("p", { className: "text-xs text-muted-foreground break-words leading-tight", children: n }),
                  /* @__PURE__ */ O("div", { className: "text-xs text-accent-foreground flex items-center gap-1 leading-tight", children: [
                    /* @__PURE__ */ f(vd, { className: "h-3 w-3" }),
                    /* @__PURE__ */ f("span", { children: r || c("details", "詳細を見る") })
                  ] })
                ] })
              }
            ) : /* @__PURE__ */ O("div", { className: "min-w-0", children: [
              /* @__PURE__ */ f("h4", { className: "text-sm font-bold text-foreground truncate leading-tight", children: t }),
              /* @__PURE__ */ f("p", { className: "text-xs text-muted-foreground break-words leading-tight", children: n })
            ] }) })
          ] }),
          a && /* @__PURE__ */ f(
            "button",
            {
              type: "button",
              onClick: (h) => {
                h.stopPropagation(), s?.();
              },
              className: "absolute top-[5px] right-[5px] flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors p-1",
              "aria-label": c("close", "Close"),
              children: /* @__PURE__ */ f(Pt, { className: "h-3 w-3" })
            }
          )
        ]
      }
    );
  }
);
nv.displayName = "NotificationToast";
const Bo = "-", rv = () => {
  if (typeof document > "u") return;
  const e = document.documentElement.getAttribute(
    "data-number-format-locale"
  );
  return e?.trim() ? e : void 0;
}, Vo = (e) => {
  if (e) return e;
  const t = rv();
  return t || (typeof Intl < "u" && Intl.NumberFormat ? new Intl.NumberFormat().resolvedOptions().locale : "en-US");
}, jo = (e, t, n, r) => {
  try {
    return new Intl.NumberFormat(t, n).format(e);
  } catch {
    try {
      return new Intl.NumberFormat("en-US", n).format(e);
    } catch {
      return r ?? String(e);
    }
  }
}, Iy = ({
  value: e,
  className: t,
  locale: n,
  options: r,
  fallback: o = Bo
}) => {
  if (e == null || !Number.isFinite(e))
    return /* @__PURE__ */ f("span", { className: t, children: o });
  const s = Vo(n), a = jo(e, s, r, o);
  return /* @__PURE__ */ f("span", { className: t, children: a });
}, Oy = ({
  value: e,
  className: t,
  locale: n,
  options: r,
  fallback: o = Bo,
  currency: s
}) => {
  if (e == null || !Number.isFinite(e))
    return /* @__PURE__ */ f("span", { className: t, children: o });
  const a = Vo(n), i = {
    ...r,
    style: "currency",
    currency: s
  }, d = jo(
    e,
    a,
    i,
    o
  );
  return /* @__PURE__ */ f("span", { className: t, children: d });
}, ov = ({
  value: e,
  className: t,
  locale: n,
  options: r,
  fallback: o = Bo,
  valueScale: s = "ratio"
}) => {
  if (e == null || !Number.isFinite(e))
    return /* @__PURE__ */ f("span", { className: t, children: o });
  const a = Vo(n), i = s === "percent" ? e / 100 : e, c = {
    maximumFractionDigits: r?.maximumFractionDigits ?? r?.minimumFractionDigits ?? 1,
    ...r,
    style: "percent"
  }, m = jo(
    i,
    a,
    c,
    o
  );
  return /* @__PURE__ */ f("span", { className: t, children: m });
};
function Ay(e) {
  const { options: t, columns: n = 2, className: r = "" } = e, o = {
    1: "grid-cols-1",
    2: "grid-cols-2",
    3: "grid-cols-3",
    4: "grid-cols-4"
  }[n], s = (i) => {
    e.multiple || e.onChange(i);
  }, a = (i) => {
    if (!e.multiple) return;
    const d = e.value, c = d.includes(i) ? d.filter((m) => m !== i) : [...d, i];
    e.onChange(c);
  };
  return /* @__PURE__ */ O("div", { className: `grid ${o} gap-2 ${r}`, children: [
    !e.multiple && e.allowNull && /* @__PURE__ */ f(
      ye,
      {
        type: "button",
        variant: e.value === null ? "option-active" : "option",
        onClick: () => s(null),
        className: "justify-start min-h-[44px] text-left",
        children: /* @__PURE__ */ f("div", { className: "font-medium text-foreground", children: e.nullLabel || "自動" })
      }
    ),
    t.map((i) => {
      const d = e.multiple ? e.value.includes(i.value) : e.value === i.value;
      return /* @__PURE__ */ f(
        ye,
        {
          type: "button",
          variant: d ? "option-active" : "option",
          onClick: () => e.multiple ? a(i.value) : s(i.value),
          className: "justify-start min-h-[44px] text-left",
          children: i.description ? /* @__PURE__ */ O("div", { children: [
            /* @__PURE__ */ f("div", { className: "font-medium text-foreground", children: i.label }),
            /* @__PURE__ */ f("div", { className: "text-xs text-muted-foreground mt-1", children: i.description })
          ] }) : /* @__PURE__ */ f("div", { className: "font-medium text-foreground", children: i.label })
        },
        i.value
      );
    })
  ] });
}
const Dy = R.memo(
  ({
    currentPage: e,
    totalPages: t,
    onPrevPage: n,
    onNextPage: r,
    prevLabel: o = "Previous page",
    nextLabel: s = "Next page",
    prevContent: a = /* @__PURE__ */ f($r, { className: "h-4 w-4" }),
    nextContent: i = /* @__PURE__ */ f(Fr, { className: "h-4 w-4" }),
    pageInfoFormatter: d,
    className: c
  }) => {
    if (t <= 1)
      return null;
    const m = e <= 1, l = e >= t, p = d?.(e, t) ?? `${e} / ${t}`, h = () => {
      m || n();
    }, b = () => {
      l || r();
    };
    return /* @__PURE__ */ O("div", { className: I("flex flex-wrap items-center gap-2", c), children: [
      /* @__PURE__ */ f(
        ye,
        {
          type: "button",
          variant: "outline",
          size: "icon",
          onClick: h,
          disabled: m,
          "aria-label": o,
          children: a
        }
      ),
      /* @__PURE__ */ f(
        "span",
        {
          className: "text-ui text-foreground font-medium whitespace-nowrap",
          "aria-live": "polite",
          children: p
        }
      ),
      /* @__PURE__ */ f(
        ye,
        {
          type: "button",
          variant: "outline",
          size: "icon",
          onClick: b,
          disabled: l,
          "aria-label": s,
          children: i
        }
      )
    ] });
  }
);
var sv = Object.defineProperty, xt = (e, t) => sv(e, "name", { value: t, configurable: !0 }), Ho = "Popover", [_l, My] = /* @__PURE__ */ _e(Ho, [
  en
]), Wo = en(), [av, tn] = _l(Ho), iv = /* @__PURE__ */ xt((e) => {
  const {
    __scopePopover: t,
    children: n,
    open: r,
    defaultOpen: o,
    onOpenChange: s,
    modal: a = !1
  } = e, i = Wo(t), d = u.useRef(null), [c, m] = u.useState(!1), [l, p] = Ye({
    prop: r,
    defaultProp: o ?? !1,
    onChange: s,
    caller: Ho
  });
  return /* @__PURE__ */ f(Ao, { ...i, children: /* @__PURE__ */ f(
    av,
    {
      scope: t,
      contentId: De(),
      triggerRef: d,
      open: l,
      onOpenChange: p,
      onOpenToggle: u.useCallback(() => p((h) => !h), [p]),
      hasCustomAnchor: c,
      onCustomAnchorAdd: u.useCallback(() => m(!0), []),
      onCustomAnchorRemove: u.useCallback(() => m(!1), []),
      modal: a,
      children: n
    }
  ) });
}, "Popover"), lv = "PopoverTrigger", cv = /* @__PURE__ */ u.forwardRef(
  /* @__PURE__ */ xt(function(t, n) {
    const { __scopePopover: r, ...o } = t, s = tn(lv, r), a = Wo(r), i = re(n, s.triggerRef), d = /* @__PURE__ */ f(
      Z.button,
      {
        type: "button",
        "aria-haspopup": "dialog",
        "aria-expanded": s.open,
        "aria-controls": s.open ? s.contentId : void 0,
        "data-state": Uo(s.open),
        ...o,
        ref: i,
        onClick: Y(t.onClick, s.onOpenToggle)
      }
    );
    return s.hasCustomAnchor ? d : /* @__PURE__ */ f(Do, { asChild: !0, ...a, children: d });
  }, "PopoverTrigger")
), Il = "PopoverPortal", [dv, uv] = _l(Il, {
  forceMount: void 0
}), fv = /* @__PURE__ */ xt((e) => {
  const { __scopePopover: t, forceMount: n, children: r, container: o } = e, s = tn(Il, t);
  return /* @__PURE__ */ f(dv, { scope: t, forceMount: n, children: /* @__PURE__ */ f(lt, { present: n || s.open, children: /* @__PURE__ */ f(po, { asChild: !0, container: o, children: r }) }) });
}, "PopoverPortal"), un = "PopoverContent", mv = /* @__PURE__ */ u.forwardRef(
  // blank line to reduce diff noise
  /* @__PURE__ */ xt(function(t, n) {
    const r = uv(un, t.__scopePopover), { forceMount: o = r.forceMount, ...s } = t, a = tn(un, t.__scopePopover);
    return /* @__PURE__ */ f(lt, { present: o || a.open, children: a.modal ? /* @__PURE__ */ f(hv, { ...s, ref: n }) : /* @__PURE__ */ f(gv, { ...s, ref: n }) });
  }, "PopoverContent")
), pv = /* @__PURE__ */ Ke("PopoverContent.RemoveScroll"), hv = /* @__PURE__ */ u.forwardRef(
  // blank line to reduce diff noise
  /* @__PURE__ */ xt(function(t, n) {
    const r = tn(un, t.__scopePopover), o = u.useRef(null), s = re(n, o), a = u.useRef(!1);
    return u.useEffect(() => {
      const i = o.current;
      if (i) return go(i);
    }, []), /* @__PURE__ */ f(er, { as: pv, allowPinchZoom: !0, children: /* @__PURE__ */ f(
      Ol,
      {
        ...t,
        ref: s,
        trapFocus: r.open,
        disableOutsidePointerEvents: !0,
        onCloseAutoFocus: Y(t.onCloseAutoFocus, (i) => {
          i.preventDefault(), a.current || r.triggerRef.current?.focus();
        }),
        onPointerDownOutside: Y(
          t.onPointerDownOutside,
          (i) => {
            const d = i.detail.originalEvent, c = d.button === 0 && d.ctrlKey === !0, m = d.button === 2 || c;
            a.current = m;
          },
          { checkForDefaultPrevented: !1 }
        ),
        onFocusOutside: Y(
          t.onFocusOutside,
          (i) => i.preventDefault(),
          { checkForDefaultPrevented: !1 }
        )
      }
    ) });
  }, "PopoverContentModal")
), gv = /* @__PURE__ */ u.forwardRef(
  // blank line to reduce diff noise
  /* @__PURE__ */ xt(function(t, n) {
    const r = tn(un, t.__scopePopover), o = u.useRef(!1), s = u.useRef(!1);
    return /* @__PURE__ */ f(
      Ol,
      {
        ...t,
        ref: n,
        trapFocus: !1,
        disableOutsidePointerEvents: !1,
        onCloseAutoFocus: (a) => {
          t.onCloseAutoFocus?.(a), a.defaultPrevented || (o.current || r.triggerRef.current?.focus(), a.preventDefault()), o.current = !1, s.current = !1;
        },
        onInteractOutside: (a) => {
          t.onInteractOutside?.(a), a.defaultPrevented || (o.current = !0, a.detail.originalEvent.type === "pointerdown" && (s.current = !0));
          const i = a.target;
          r.triggerRef.current?.contains(i) && a.preventDefault(), a.detail.originalEvent.type === "focusin" && s.current && a.preventDefault();
        }
      }
    );
  }, "PopoverContentNonModal")
), Ol = /* @__PURE__ */ u.forwardRef(
  // blank line to reduce diff noise
  /* @__PURE__ */ xt(function(t, n) {
    const {
      __scopePopover: r,
      trapFocus: o,
      onOpenAutoFocus: s,
      onCloseAutoFocus: a,
      disableOutsidePointerEvents: i,
      onEscapeKeyDown: d,
      onPointerDownOutside: c,
      onFocusOutside: m,
      onInteractOutside: l,
      ...p
    } = t, h = tn(un, r), b = Wo(r);
    return gn(), /* @__PURE__ */ f(
      fo,
      {
        asChild: !0,
        loop: !0,
        trapped: o,
        onMountAutoFocus: s,
        onUnmountAutoFocus: a,
        children: /* @__PURE__ */ f(
          Qn,
          {
            asChild: !0,
            disableOutsidePointerEvents: i,
            onInteractOutside: l,
            onEscapeKeyDown: d,
            onPointerDownOutside: c,
            onFocusOutside: m,
            onDismiss: () => h.onOpenChange(!1),
            deferPointerDownOutside: !0,
            children: /* @__PURE__ */ f(
              Mo,
              {
                "data-state": Uo(h.open),
                role: "dialog",
                id: h.contentId,
                ...b,
                ...p,
                ref: n,
                style: {
                  ...p.style,
                  "--radix-popover-content-transform-origin": "var(--radix-popper-transform-origin)",
                  "--radix-popover-content-available-width": "var(--radix-popper-available-width)",
                  "--radix-popover-content-available-height": "var(--radix-popper-available-height)",
                  "--radix-popover-trigger-width": "var(--radix-popper-anchor-width)",
                  "--radix-popover-trigger-height": "var(--radix-popper-anchor-height)"
                }
              }
            )
          }
        )
      }
    );
  }, "PopoverContentImpl")
);
function Uo(e) {
  return e ? "open" : "closed";
}
xt(Uo, "getState");
var vv = iv, bv = cv, yv = fv, Al = mv;
const Ly = vv, $y = bv, xv = u.forwardRef(({ className: e, align: t = "center", sideOffset: n = 4, ...r }, o) => /* @__PURE__ */ f(yv, { children: /* @__PURE__ */ f(
  Al,
  {
    ref: o,
    align: t,
    sideOffset: n,
    className: I(
      "z-50 rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
      e
    ),
    ...r
  }
) }));
xv.displayName = Al.displayName;
var wv = Object.defineProperty, dt = (e, t) => wv(e, "name", { value: t, configurable: !0 }), Dl = "Progress", Go = 100, [Cv, Fy] = /* @__PURE__ */ _e(Dl), [Sv, kv] = Cv(Dl), Ev = /* @__PURE__ */ u.forwardRef(
  // blank line to reduce diff noise
  /* @__PURE__ */ dt(function(t, n) {
    const {
      __scopeProgress: r,
      value: o = null,
      max: s,
      getValueLabel: a = Ml,
      ...i
    } = t;
    (s || s === 0) && !no(s) && console.error(Ll(`${s}`, "Progress"));
    const d = no(s) ? s : Go;
    o !== null && !ro(o, d) && console.error($l(`${o}`, "Progress"));
    const c = ro(o, d) ? o : null, m = fn(c) ? a(c, d) : void 0;
    return /* @__PURE__ */ f(Sv, { scope: r, value: c, max: d, children: /* @__PURE__ */ f(
      Z.div,
      {
        "aria-valuemax": d,
        "aria-valuemin": 0,
        "aria-valuenow": fn(c) ? c : void 0,
        "aria-valuetext": m,
        role: "progressbar",
        "data-state": Ko(c, d),
        "data-value": c ?? void 0,
        "data-max": d,
        ...i,
        ref: n
      }
    ) });
  }, "Progress")
), Nv = "ProgressIndicator", Rv = /* @__PURE__ */ u.forwardRef(
  // blank line to reduce diff noise
  /* @__PURE__ */ dt(function(t, n) {
    const { __scopeProgress: r, ...o } = t, s = kv(Nv, r);
    return /* @__PURE__ */ f(
      Z.div,
      {
        "data-state": Ko(s.value, s.max),
        "data-value": s.value ?? void 0,
        "data-max": s.max,
        ...o,
        ref: n
      }
    );
  }, "ProgressIndicator")
);
function Ml(e, t) {
  return `${Math.round(e / t * 100)}%`;
}
dt(Ml, "defaultGetValueLabel");
function Ko(e, t) {
  return e == null ? "indeterminate" : e === t ? "complete" : "loading";
}
dt(Ko, "getProgressState");
function fn(e) {
  return typeof e == "number";
}
dt(fn, "isNumber");
function no(e) {
  return fn(e) && !isNaN(e) && e > 0;
}
dt(no, "isValidMaxNumber");
function ro(e, t) {
  return fn(e) && !isNaN(e) && e <= t && e >= 0;
}
dt(ro, "isValidValueNumber");
function Ll(e, t) {
  return `Invalid prop \`max\` of value \`${e}\` supplied to \`${t}\`. Only numbers greater than 0 are valid max values. Defaulting to \`${Go}\`.`;
}
dt(Ll, "getInvalidMaxError");
function $l(e, t) {
  return `Invalid prop \`value\` of value \`${e}\` supplied to \`${t}\`. The \`value\` prop must be:
  - a positive number
  - less than the value passed to \`max\` (or ${Go} if no \`max\` prop is set)
  - \`null\` or \`undefined\` if the progress is indeterminate.

Defaulting to \`null\`.`;
}
dt($l, "getInvalidValueError");
var Fl = Ev, Pv = Rv;
const Tv = u.forwardRef(
  ({
    className: e,
    value: t,
    max: n = 100,
    label: r,
    subLabel: o,
    height: s = "h-[var(--ui-progress-height)]",
    color: a,
    striped: i = !0,
    animated: d = !0,
    status: c = "normal",
    ...m
  }, l) => {
    const p = Number.isFinite(n) && n > 0 ? n : 100, h = Math.min(Math.max(t || 0, 0), p), b = h / p * 100, v = (w, x, E) => `rgb(${w.map((k, S) => {
      const P = x[S] || 0;
      return Math.round(k + (P - k) * E);
    }).join(",")})`, g = () => {
      if (a) return { className: a };
      if (c === "paused") return { className: "bg-yellow-500" };
      if (c === "error") return { className: "bg-red-800" };
      const w = [4, 120, 87], x = [37, 99, 235], E = [34, 211, 238];
      let N = "";
      return b <= 50 ? N = v(w, x, b / 50) : N = v(
        x,
        E,
        (b - 50) / 50
      ), { style: { backgroundColor: N } };
    }, { className: y, style: C } = g();
    return /* @__PURE__ */ O("div", { className: "w-full", children: [
      (r || o) && /* @__PURE__ */ O("div", { className: "flex justify-between mb-1 text-sm", children: [
        /* @__PURE__ */ f("div", { className: "font-medium text-foreground", children: r }),
        /* @__PURE__ */ f("div", { className: "text-muted-foreground", children: o })
      ] }),
      /* @__PURE__ */ f(
        Fl,
        {
          ref: l,
          className: I(
            "relative w-full overflow-hidden rounded-full bg-card",
            s,
            e
          ),
          value: h,
          max: p,
          ...m,
          children: /* @__PURE__ */ f(
            Pv,
            {
              className: I(
                "h-full w-full flex-1 transition-all duration-500 ease-out flex items-center justify-end pr-2",
                y,
                i && "bg-[linear-gradient(45deg,rgba(255,255,255,0.15)_25%,transparent_25%,transparent_50%,rgba(255,255,255,0.15)_50%,rgba(255,255,255,0.15)_75%,transparent_75%,transparent)] bg-[length:1rem_1rem]",
                d && "animate-progress-stripes"
              ),
              style: {
                transform: `translateX(-${100 - b}%)`,
                ...C
              },
              children: s !== "h-1" && s !== "h-2" && /* @__PURE__ */ f(
                ov,
                {
                  value: b,
                  valueScale: "percent",
                  options: { maximumFractionDigits: 0 },
                  className: "text-[10px] font-bold text-white drop-shadow-md opacity-80 pe-1"
                }
              )
            }
          )
        }
      )
    ] });
  }
);
Tv.displayName = Fl.displayName;
function zy({
  label: e,
  options: t,
  value: n,
  onValueChange: r,
  name: o,
  disabled: s = !1,
  required: a = !1,
  className: i
}) {
  const d = Ec();
  return /* @__PURE__ */ O("fieldset", { className: I("ds-radio-group", i), disabled: s, children: [
    /* @__PURE__ */ f("legend", { className: "ds-radio-legend", children: e }),
    /* @__PURE__ */ f("div", { className: "ds-radio-options", children: t.map((c, m) => /* @__PURE__ */ O("label", { className: "ds-radio-option", children: [
      /* @__PURE__ */ f(
        "input",
        {
          className: "ds-radio-input",
          id: `${d}-${m}`,
          type: "radio",
          name: o ?? d,
          value: c.value,
          checked: n === c.value,
          onChange: (l) => r(l.target.value),
          disabled: s || c.disabled,
          required: a
        }
      ),
      /* @__PURE__ */ f("span", { className: "ds-radio-label", children: c.label })
    ] }, c.value)) })
  ] });
}
const _v = u.memo(
  ({
    label: e,
    value: t,
    onChange: n,
    min: r = 0,
    max: o = 10,
    minLabel: s,
    maxLabel: a,
    className: i,
    disabled: d = !1
  }) => {
    const c = u.useMemo(() => {
      const m = [];
      for (let l = r; l <= o; l++)
        m.push(l);
      return m;
    }, [r, o]);
    return /* @__PURE__ */ O("div", { className: I("flex flex-col gap-2", i), children: [
      e && /* @__PURE__ */ f("span", { className: "text-sm font-medium text-muted-foreground", children: e }),
      /* @__PURE__ */ f("div", { className: "flex items-center gap-2 overflow-x-auto pb-2 scrollbar-thin scrollbar-thumb-theme-border scrollbar-track-transparent", children: c.map((m) => /* @__PURE__ */ f(
        "button",
        {
          onClick: () => !d && n(m),
          disabled: d,
          type: "button",
          className: I(
            "w-[var(--ui-component-height)] h-[var(--ui-component-height)] rounded-full flex-shrink-0 flex items-center justify-center font-bold transition-all border",
            t === m ? "bg-primary text-primary-foreground border-theme-object-primary shadow-md scale-110" : "bg-card text-muted-foreground border-border hover:bg-muted",
            d && "opacity-50 cursor-not-allowed hover:bg-card hover:scale-100"
          ),
          children: m
        },
        m
      )) }),
      (s || a) && /* @__PURE__ */ O("div", { className: "flex justify-between text-xs text-muted-foreground px-1 select-none", children: [
        /* @__PURE__ */ f("span", { children: s }),
        /* @__PURE__ */ f("span", { children: a })
      ] })
    ] });
  }
);
_v.displayName = "ScaleInput";
const Iv = u.memo(
  u.forwardRef(
    ({ className: e, children: t, ...n }, r) => /* @__PURE__ */ f(
      "div",
      {
        ref: r,
        className: I("relative overflow-auto", e),
        ...n,
        children: t
      }
    )
  )
);
Iv.displayName = "ScrollArea";
const Ov = u.forwardRef(
  ({
    options: e,
    value: t,
    onChange: n,
    placeholder: r,
    className: o,
    id: s,
    name: a,
    disabled: i = !1,
    required: d = !1,
    noResultsText: c = "No results"
  }, m) => {
    const l = u.useRef(null), p = u.useId(), h = u.useMemo(() => e.find((_) => _.value === t)?.label ?? "", [e, t]), [b, v] = u.useState(h), [g, y] = u.useState(!1), [C, w] = u.useState(-1), x = u.useRef(t), E = u.useRef(null);
    u.useEffect(() => {
      t !== x.current && (x.current = t, E.current = null, g || v(h));
    }, [g, h, t]), u.useEffect(() => {
      if (!g) {
        if (E.current) return;
        v(h);
      }
    }, [g, h]);
    const N = u.useMemo(() => {
      const _ = b.trim().toLowerCase();
      return _ ? e.filter((M) => {
        const A = M.label.toLowerCase(), T = M.value.toLowerCase();
        return A.includes(_) || T.includes(_);
      }) : e;
    }, [e, b]);
    u.useEffect(() => {
      g && w(N.length ? 0 : -1);
    }, [g, N.length]), u.useEffect(() => {
      if (!g) return;
      const _ = (M) => {
        const A = M.target;
        A && l.current && !l.current.contains(A) && y(!1);
      };
      return document.addEventListener("mousedown", _), () => document.removeEventListener("mousedown", _);
    }, [g]);
    const k = u.useCallback(
      (_) => {
        E.current = _.value, n?.(_.value), v(_.label), y(!1);
      },
      [n]
    ), S = () => {
      setTimeout(() => {
        l.current && (l.current.contains(document.activeElement) || y(!1));
      }, 0);
    }, P = (_) => {
      if (!i) {
        if (_.key === "ArrowDown") {
          _.preventDefault(), y(!0), w((M) => Math.min(M + 1, N.length - 1));
          return;
        }
        if (_.key === "ArrowUp") {
          _.preventDefault(), y(!0), w((M) => Math.max(M - 1, 0));
          return;
        }
        if (_.key === "Enter") {
          if (!g) return;
          _.preventDefault();
          const M = N[C];
          M && k(M);
          return;
        }
        if (_.key === "Escape") {
          if (!g) return;
          _.preventDefault(), y(!1);
          return;
        }
      }
    };
    return /* @__PURE__ */ O("div", { className: "relative", ref: l, children: [
      /* @__PURE__ */ f(
        Un,
        {
          ref: m,
          id: s,
          name: a,
          disabled: i,
          required: d,
          value: b,
          placeholder: r,
          autoComplete: "off",
          "aria-label": r,
          role: "combobox",
          "aria-expanded": g,
          "aria-controls": p,
          "aria-autocomplete": "list",
          className: I(o),
          onFocus: () => !i && y(!0),
          onBlur: S,
          onKeyDown: P,
          onChange: (_) => {
            v(_.target.value), i || y(!0);
          }
        }
      ),
      g && /* @__PURE__ */ f(
        "div",
        {
          id: p,
          role: "listbox",
          className: I(
            "absolute z-50 mt-1 w-full overflow-auto rounded-md border border-border bg-background shadow-lg",
            "max-h-60"
          ),
          children: N.length === 0 ? /* @__PURE__ */ f("div", { className: "px-3 py-2 text-sm text-muted-foreground", children: c }) : N.map((_, M) => /* @__PURE__ */ f(
            "button",
            {
              type: "button",
              role: "option",
              "aria-selected": M === C,
              className: I(
                "w-full px-3 py-2 text-left text-sm text-foreground",
                "hover:bg-accent hover:text-accent-foreground focus:outline-none",
                M === C && "bg-accent text-accent-foreground"
              ),
              onMouseDown: (A) => A.preventDefault(),
              onMouseEnter: () => w(M),
              onClick: () => k(_),
              children: _.label
            },
            _.value
          ))
        }
      )
    ] });
  }
);
Ov.displayName = "SearchableSelect";
const By = ({
  options: e,
  value: t,
  onChange: n,
  placeholder: r,
  className: o
}) => /* @__PURE__ */ O("div", { className: o, children: [
  /* @__PURE__ */ f(
    "select",
    {
      className: "mb-1 w-full rounded border border-border bg-background px-3 py-2 text-sm h-10 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
      value: t,
      onChange: (s) => n?.(s.target.value),
      children: e.map((s) => /* @__PURE__ */ f("option", { value: s.value, children: s.label }, s.value))
    }
  ),
  /* @__PURE__ */ f(
    "input",
    {
      type: "text",
      className: "w-full rounded border border-border bg-background px-3 py-2 text-sm h-10 placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
      placeholder: r
    }
  )
] });
var Av = Object.defineProperty, zl = (e, t) => Av(e, "name", { value: t, configurable: !0 }), ma = "horizontal", Dv = ["horizontal", "vertical"], Mv = /* @__PURE__ */ u.forwardRef(
  /* @__PURE__ */ zl(function(t, n) {
    const { decorative: r, orientation: o = ma, ...s } = t, a = Bl(o) ? o : ma, d = r ? { role: "none" } : { "aria-orientation": a === "vertical" ? a : void 0, role: "separator" };
    return /* @__PURE__ */ f(
      Z.div,
      {
        "data-orientation": a,
        ...d,
        ...s,
        ref: n
      }
    );
  }, "Separator")
);
function Bl(e) {
  return Dv.includes(e);
}
zl(Bl, "isValidOrientation");
var Vl = Mv;
const Lv = u.forwardRef(
  ({ className: e, orientation: t = "horizontal", decorative: n = !0, ...r }, o) => /* @__PURE__ */ f(
    Vl,
    {
      ref: o,
      decorative: n,
      orientation: t,
      className: I(
        "shrink-0 bg-border",
        t === "horizontal" ? "h-[1px] w-full" : "h-full w-[1px]",
        e
      ),
      ...r
    }
  )
);
Lv.displayName = Vl.displayName;
const $v = R.memo(
  R.forwardRef(
    ({ onSearch: e, className: t, ...n }, r) => /* @__PURE__ */ O("div", { className: "relative w-full", children: [
      /* @__PURE__ */ f(Jd, { className: "absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" }),
      /* @__PURE__ */ f(
        "input",
        {
          ref: r,
          type: "text",
          className: I(
            "flex h-11 w-full rounded-md border border-input bg-background pl-10 pr-3 py-2 text-base ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
            t
          ),
          placeholder: "Search...",
          onChange: (o) => e?.(o.target.value),
          ...n
        }
      )
    ] })
  )
);
$v.displayName = "SimpleSearchInput";
var Fv = Object.defineProperty, gt = (e, t) => Fv(e, "name", { value: t, configurable: !0 }), Yo = "Switch", [zv, Vy] = /* @__PURE__ */ _e(Yo), [Bv, Xo] = zv(Yo);
function jl(e) {
  const {
    __scopeSwitch: t,
    checked: n,
    children: r,
    defaultChecked: o,
    disabled: s,
    form: a,
    name: i,
    onCheckedChange: d,
    required: c,
    value: m = "on",
    // @ts-expect-error
    internal_do_not_use_render: l
  } = e, [p, h] = Ye({
    prop: n,
    defaultProp: o ?? !1,
    onChange: d,
    caller: Yo
  }), [b, v] = u.useState(null), [g, y] = u.useState(null), C = u.useRef(!1), [w, x] = u.useReducer(
    (k) => k + 1,
    0
  ), E = b ? !!a || !!b.closest("form") : (
    // We set this to true by default so that events bubble to forms without JS (SSR)
    !0
  ), N = {
    checked: p,
    setChecked: h,
    disabled: s,
    control: b,
    setControl: v,
    name: i,
    form: a,
    value: m,
    hasConsumerStoppedPropagationRef: C,
    userInteractionCount: w,
    onUserInteraction: x,
    required: c,
    defaultChecked: o,
    isFormControl: E,
    bubbleInput: g,
    setBubbleInput: y
  };
  return /* @__PURE__ */ f(Bv, { scope: t, ...N, children: Wl(l) ? l(N) : r });
}
gt(jl, "SwitchProvider");
var Vv = "SwitchTrigger", jv = /* @__PURE__ */ u.forwardRef(
  /* @__PURE__ */ gt(function({ __scopeSwitch: t, onClick: n, ...r }, o) {
    const {
      control: s,
      form: a,
      value: i,
      disabled: d,
      checked: c,
      required: m,
      setControl: l,
      setChecked: p,
      hasConsumerStoppedPropagationRef: h,
      onUserInteraction: b,
      isFormControl: v,
      bubbleInput: g
    } = Xo(Vv, t), y = re(o, l), C = u.useRef(c);
    return u.useEffect(() => {
      const w = a ? s?.ownerDocument.getElementById(a) : s?.form;
      if (w instanceof HTMLFormElement) {
        const x = /* @__PURE__ */ gt(() => p(C.current), "reset");
        return w.addEventListener("reset", x), () => w.removeEventListener("reset", x);
      }
    }, [s, a, p]), /* @__PURE__ */ f(
      Z.button,
      {
        type: "button",
        role: "switch",
        "aria-checked": c,
        "aria-required": m,
        "data-state": qo(c),
        "data-disabled": d ? "" : void 0,
        disabled: d,
        value: i,
        ...r,
        ref: y,
        onClick: Y(n, (w) => {
          b(), p((x) => !x), g && v && (h.current = w.isPropagationStopped(), h.current || w.stopPropagation());
        })
      }
    );
  }, "SwitchTrigger")
), Hl = /* @__PURE__ */ u.forwardRef(
  // blank line to reduce diff noise
  /* @__PURE__ */ gt(function(t, n) {
    const {
      __scopeSwitch: r,
      name: o,
      checked: s,
      defaultChecked: a,
      required: i,
      disabled: d,
      value: c,
      onCheckedChange: m,
      form: l,
      ...p
    } = t;
    return /* @__PURE__ */ f(
      jl,
      {
        __scopeSwitch: r,
        checked: s,
        defaultChecked: a,
        disabled: d,
        required: i,
        onCheckedChange: m,
        name: o,
        form: l,
        value: c,
        internal_do_not_use_render: ({ isFormControl: h }) => /* @__PURE__ */ O(Ze, { children: [
          /* @__PURE__ */ f(
            jv,
            {
              ...p,
              ref: n,
              __scopeSwitch: r
            }
          ),
          h && /* @__PURE__ */ f(
            Gv,
            {
              __scopeSwitch: r
            }
          )
        ] })
      }
    );
  }, "Switch")
), Hv = "SwitchThumb", Wv = /* @__PURE__ */ u.forwardRef(
  /* @__PURE__ */ gt(function(t, n) {
    const { __scopeSwitch: r, ...o } = t, s = Xo(Hv, r);
    return /* @__PURE__ */ f(
      Z.span,
      {
        "data-state": qo(s.checked),
        "data-disabled": s.disabled ? "" : void 0,
        ...o,
        ref: n
      }
    );
  }, "SwitchThumb")
), Uv = "SwitchBubbleInput", Gv = /* @__PURE__ */ u.forwardRef(
  // blank line to reduce diff noise
  /* @__PURE__ */ gt(function({ __scopeSwitch: t, onClick: n, ...r }, o) {
    const {
      control: s,
      hasConsumerStoppedPropagationRef: a,
      userInteractionCount: i,
      checked: d,
      defaultChecked: c,
      required: m,
      disabled: l,
      name: p,
      value: h,
      form: b,
      bubbleInput: v,
      setBubbleInput: g
    } = Xo(Uv, t), y = re(o, g), C = Oo(s), w = u.useRef(!1), x = u.useRef(d), E = u.useRef(i);
    u.useEffect(() => {
      const k = v;
      if (!k) return;
      const S = window.HTMLInputElement.prototype, _ = Object.getOwnPropertyDescriptor(
        S,
        "checked"
      ).set, M = i !== E.current;
      E.current = i;
      const A = x.current !== d;
      x.current = d;
      const T = !(M && a.current);
      if (A && _) {
        w.current = !M;
        const D = new Event("click", { bubbles: T });
        _.call(k, d), k.dispatchEvent(D), w.current = !1;
      }
    }, [v, d, a, i]);
    const N = u.useRef(d);
    return /* @__PURE__ */ f(
      Z.input,
      {
        type: "checkbox",
        "aria-hidden": !0,
        defaultChecked: c ?? N.current,
        required: m,
        disabled: l,
        name: p,
        value: h,
        form: b,
        ...r,
        tabIndex: -1,
        ref: y,
        onClick: Y(n, (k) => {
          w.current && k.stopPropagation();
        }),
        style: {
          ...r.style,
          ...C,
          position: "absolute",
          pointerEvents: "none",
          opacity: 0,
          margin: 0,
          // We transform because the input is absolutely positioned but we have
          // rendered it **after** the button. This pulls it back to sit on top
          // of the button.
          transform: "translateX(-100%)"
        }
      }
    );
  }, "SwitchBubbleInput")
);
function Wl(e) {
  return typeof e == "function";
}
gt(Wl, "isFunction");
function qo(e) {
  return e ? "checked" : "unchecked";
}
gt(qo, "getState");
const Kv = u.forwardRef(({ className: e, ...t }, n) => /* @__PURE__ */ f(
  Hl,
  {
    className: I(
      "peer inline-flex h-[var(--ui-switch-height)] w-[var(--ui-switch-width)] shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input",
      e
    ),
    ...t,
    ref: n,
    children: /* @__PURE__ */ f(
      Wv,
      {
        className: I(
          "pointer-events-none block h-[var(--ui-switch-thumb-size)] w-[var(--ui-switch-thumb-size)] rounded-full bg-background shadow-lg ring-0 transition-transform data-[state=checked]:translate-x-[var(--ui-switch-thumb-translate)] data-[state=unchecked]:translate-x-0"
        )
      }
    )
  }
));
Kv.displayName = Hl.displayName;
var Yv = Object.defineProperty, Zo = (e, t) => Yv(e, "name", { value: t, configurable: !0 }), Or = !1;
function Ul() {
  const [e, t] = u.useState(Or);
  return u.useEffect(() => {
    Or || (Or = !0, t(!0));
  }, []), e;
}
Zo(Ul, "useIsHydrated");
var Gl = u[" useSyncExternalStore ".trim().toString()];
function Kl() {
  return () => {
  };
}
Zo(Kl, "subscribe");
function Yl() {
  return Gl(
    Kl,
    () => !0,
    () => !1
  );
}
Zo(Yl, "useIsHydratedModern");
var Xv = typeof Gl == "function" ? Yl : Ul, qv = Object.defineProperty, Ot = (e, t) => qv(e, "name", { value: t, configurable: !0 }), Ar = "rovingFocusGroup.onEntryFocus", Zv = { bubbles: !1, cancelable: !0 }, fr = "RovingFocusGroup", [oo, Xl, Qv] = /* @__PURE__ */ ko(fr), [Jv, ql] = /* @__PURE__ */ _e(
  fr,
  [Qv]
), [eb, tb] = Jv(fr), nb = /* @__PURE__ */ u.forwardRef(
  // blank line to reduce diff noise
  /* @__PURE__ */ Ot(function(t, n) {
    return /* @__PURE__ */ f(oo.Provider, { scope: t.__scopeRovingFocusGroup, children: /* @__PURE__ */ f(oo.Slot, { scope: t.__scopeRovingFocusGroup, children: /* @__PURE__ */ f(rb, { ...t, ref: n }) }) });
  }, "RovingFocusGroup")
), rb = /* @__PURE__ */ u.forwardRef(/* @__PURE__ */ Ot(function(t, n) {
  const {
    __scopeRovingFocusGroup: r,
    orientation: o,
    loop: s = !1,
    dir: a,
    currentTabStopId: i,
    defaultCurrentTabStopId: d,
    onCurrentTabStopIdChange: c,
    onEntryFocus: m,
    preventScrollOnEntryFocus: l = !1,
    ...p
  } = t, h = u.useRef(null), b = re(n, h), v = qn(a), [g, y] = Ye({
    prop: i,
    defaultProp: d ?? null,
    onChange: c,
    caller: fr
  }), [C, w] = u.useState(!1), x = Le(m), E = Xl(r), N = u.useRef(!1), [k, S] = u.useState(0);
  return u.useEffect(() => {
    const P = h.current;
    if (P)
      return P.addEventListener(Ar, x), () => P.removeEventListener(Ar, x);
  }, [x]), /* @__PURE__ */ f(
    eb,
    {
      scope: r,
      orientation: o,
      dir: v,
      loop: s,
      currentTabStopId: g,
      onItemFocus: u.useCallback(
        (P) => y(P),
        [y]
      ),
      onItemShiftTab: u.useCallback(() => w(!0), []),
      onFocusableItemAdd: u.useCallback(
        () => S((P) => P + 1),
        []
      ),
      onFocusableItemRemove: u.useCallback(
        () => S((P) => P - 1),
        []
      ),
      children: /* @__PURE__ */ f(
        Z.div,
        {
          tabIndex: C || k === 0 ? -1 : 0,
          "data-orientation": o,
          ...p,
          ref: b,
          style: { outline: "none", ...t.style },
          onMouseDown: Y(t.onMouseDown, () => {
            N.current = !0;
          }),
          onFocus: Y(t.onFocus, (P) => {
            const _ = !N.current;
            if (P.target === P.currentTarget && _ && !C) {
              const M = new CustomEvent(Ar, Zv);
              if (P.currentTarget.dispatchEvent(M), !M.defaultPrevented) {
                const A = E().filter((z) => z.focusable), T = A.find((z) => z.active), D = A.find((z) => z.id === g), $ = [T, D, ...A].filter(
                  Boolean
                ).map((z) => z.ref.current);
                Qo($, l);
              }
            }
            N.current = !1;
          }),
          onBlur: Y(t.onBlur, () => w(!1))
        }
      )
    }
  );
}, "RovingFocusGroupImpl")), ob = "RovingFocusGroupItem", sb = /* @__PURE__ */ u.forwardRef(
  // blank line to reduce diff noise
  /* @__PURE__ */ Ot(function(t, n) {
    const {
      __scopeRovingFocusGroup: r,
      focusable: o = !0,
      active: s = !1,
      tabStopId: a,
      children: i,
      ...d
    } = t, c = De(), m = a || c, l = tb(ob, r), p = l.currentTabStopId === m, h = Xl(r), { onFocusableItemAdd: b, onFocusableItemRemove: v, currentTabStopId: g } = l, y = Xv();
    return de(() => {
      if (!(!y || !o))
        return b(), () => v();
    }, [y, o, b, v]), u.useEffect(() => {
      if (!(y || !o))
        return b(), () => v();
    }, [y, o, b, v]), /* @__PURE__ */ f(
      oo.ItemSlot,
      {
        scope: r,
        id: m,
        focusable: o,
        active: s,
        children: /* @__PURE__ */ f(
          Z.span,
          {
            tabIndex: p ? 0 : -1,
            "data-orientation": l.orientation,
            ...d,
            ref: n,
            onMouseDown: Y(t.onMouseDown, (C) => {
              o ? l.onItemFocus(m) : C.preventDefault();
            }),
            onFocus: Y(t.onFocus, () => l.onItemFocus(m)),
            onKeyDown: Y(t.onKeyDown, (C) => {
              if (C.key === "Tab" && C.shiftKey) {
                l.onItemShiftTab();
                return;
              }
              if (C.target !== C.currentTarget) return;
              const w = Ql(C, l.orientation, l.dir);
              if (w !== void 0) {
                if (C.metaKey || C.ctrlKey || C.altKey || C.shiftKey) return;
                C.preventDefault();
                let E = h().filter((N) => N.focusable).map((N) => N.ref.current);
                if (w === "last") E.reverse();
                else if (w === "prev" || w === "next") {
                  w === "prev" && E.reverse();
                  const N = E.indexOf(C.currentTarget);
                  E = l.loop ? Jl(E, N + 1) : E.slice(N + 1);
                }
                setTimeout(() => Qo(E));
              }
            }),
            children: typeof i == "function" ? i({ isCurrentTabStop: p, hasTabStop: g != null }) : i
          }
        )
      }
    );
  }, "RovingFocusGroupItem")
), ab = {
  ArrowLeft: "prev",
  ArrowUp: "prev",
  ArrowRight: "next",
  ArrowDown: "next",
  PageUp: "first",
  Home: "first",
  PageDown: "last",
  End: "last"
};
function Zl(e, t) {
  return t !== "rtl" ? e : e === "ArrowLeft" ? "ArrowRight" : e === "ArrowRight" ? "ArrowLeft" : e;
}
Ot(Zl, "getDirectionAwareKey");
function Ql(e, t, n) {
  const r = Zl(e.key, n);
  if (!(t === "vertical" && ["ArrowLeft", "ArrowRight"].includes(r)) && !(t === "horizontal" && ["ArrowUp", "ArrowDown"].includes(r)))
    return ab[r];
}
Ot(Ql, "getFocusIntent");
function Qo(e, t = !1) {
  const n = document.activeElement;
  for (const r of e)
    if (r === n || (r.focus({ preventScroll: t }), document.activeElement !== n)) return;
}
Ot(Qo, "focusFirst");
function Jl(e, t) {
  return e.map((n, r) => e[(t + r) % e.length]);
}
Ot(Jl, "wrapArray");
var ib = nb, lb = sb, cb = Object.defineProperty, nn = (e, t) => cb(e, "name", { value: t, configurable: !0 }), Jo = "Tabs", [db, jy] = /* @__PURE__ */ _e(Jo, [
  ql
]), ec = ql(), [ub, es] = db(Jo), fb = /* @__PURE__ */ u.forwardRef(
  // blank line to reduce diff noise
  /* @__PURE__ */ nn(function(t, n) {
    const {
      __scopeTabs: r,
      value: o,
      onValueChange: s,
      defaultValue: a,
      orientation: i = "horizontal",
      dir: d,
      activationMode: c = "automatic",
      ...m
    } = t, l = qn(d), [p, h] = Ye({
      prop: o,
      onChange: s,
      defaultProp: a ?? "",
      caller: Jo
    });
    return /* @__PURE__ */ f(
      ub,
      {
        scope: r,
        baseId: De(),
        value: p,
        onValueChange: h,
        orientation: i,
        dir: l,
        activationMode: c,
        children: /* @__PURE__ */ f(
          Z.div,
          {
            dir: l,
            "data-orientation": i,
            ...m,
            ref: n
          }
        )
      }
    );
  }, "Tabs")
), mb = "TabsList", pb = /* @__PURE__ */ u.forwardRef(
  // blank line to reduce diff noise
  /* @__PURE__ */ nn(function(t, n) {
    const { __scopeTabs: r, loop: o = !0, ...s } = t, a = es(mb, r), i = ec(r);
    return /* @__PURE__ */ f(
      ib,
      {
        asChild: !0,
        ...i,
        orientation: a.orientation,
        dir: a.dir,
        loop: o,
        children: /* @__PURE__ */ f(
          Z.div,
          {
            role: "tablist",
            "aria-orientation": a.orientation,
            ...s,
            ref: n
          }
        )
      }
    );
  }, "TabsList")
), hb = "TabsTrigger", gb = /* @__PURE__ */ u.forwardRef(
  /* @__PURE__ */ nn(function(t, n) {
    const { __scopeTabs: r, value: o, disabled: s = !1, ...a } = t, i = es(hb, r), d = ec(r), c = ts(i.baseId, o), m = ns(i.baseId, o), l = o === i.value;
    return /* @__PURE__ */ f(
      lb,
      {
        asChild: !0,
        ...d,
        focusable: !s,
        active: l,
        children: /* @__PURE__ */ f(
          Z.button,
          {
            type: "button",
            role: "tab",
            "aria-selected": l,
            "aria-controls": m,
            "data-state": l ? "active" : "inactive",
            "data-disabled": s ? "" : void 0,
            disabled: s,
            id: c,
            ...a,
            ref: n,
            onMouseDown: Y(t.onMouseDown, (p) => {
              !s && p.button === 0 && p.ctrlKey === !1 ? i.onValueChange(o) : p.preventDefault();
            }),
            onKeyDown: Y(t.onKeyDown, (p) => {
              s || p.target !== p.currentTarget || [" ", "Enter"].includes(p.key) && i.onValueChange(o);
            }),
            onFocus: Y(t.onFocus, () => {
              const p = i.activationMode !== "manual";
              !l && !s && p && i.onValueChange(o);
            })
          }
        )
      }
    );
  }, "TabsTrigger")
), vb = "TabsContent", bb = /* @__PURE__ */ u.forwardRef(
  /* @__PURE__ */ nn(function(t, n) {
    const { __scopeTabs: r, value: o, forceMount: s, children: a, ...i } = t, d = es(vb, r), c = ts(d.baseId, o), m = ns(d.baseId, o), l = o === d.value, p = u.useRef(l);
    return u.useEffect(() => {
      const h = requestAnimationFrame(() => p.current = !1);
      return () => cancelAnimationFrame(h);
    }, []), /* @__PURE__ */ f(lt, { present: s || l, children: ({ present: h }) => /* @__PURE__ */ f(
      Z.div,
      {
        "data-state": l ? "active" : "inactive",
        "data-orientation": d.orientation,
        role: "tabpanel",
        "aria-labelledby": c,
        hidden: !h,
        id: m,
        tabIndex: 0,
        ...i,
        ref: n,
        style: {
          ...t.style,
          animationDuration: p.current ? "0s" : void 0
        },
        children: h && a
      }
    ) });
  }, "TabsContent")
);
function ts(e, t) {
  return `${e}-trigger-${t}`;
}
nn(ts, "makeTriggerId");
function ns(e, t) {
  return `${e}-content-${t}`;
}
nn(ns, "makeContentId");
var yb = fb, tc = pb, nc = gb, rc = bb;
const Hy = yb, oc = u.createContext("line"), xb = u.forwardRef(
  ({
    className: e,
    children: t,
    variant: n = "line",
    onBack: r,
    backButtonLabel: o,
    ...s
  }, a) => /* @__PURE__ */ f(oc.Provider, { value: n, children: /* @__PURE__ */ O(
    tc,
    {
      ref: a,
      className: I("ds-tabs-list", e),
      "data-variant": n,
      ...s,
      children: [
        r && /* @__PURE__ */ O(ye, { variant: "ghost", size: "sm", onClick: r, children: [
          /* @__PURE__ */ f(_a, { className: "mr-1 h-4 w-4" }),
          o || "戻る"
        ] }),
        t
      ]
    }
  ) })
);
xb.displayName = tc.displayName;
const wb = u.forwardRef(
  ({
    className: e,
    children: t,
    icon: n,
    onClose: r,
    closeLabel: o,
    disabled: s,
    ...a
  }, i) => {
    const d = u.useContext(oc);
    return /* @__PURE__ */ O("span", { className: "ds-tabs-item", "data-variant": d, children: [
      /* @__PURE__ */ O(
        nc,
        {
          ref: i,
          className: I("ds-tabs-trigger", e),
          disabled: s,
          ...a,
          children: [
            n && /* @__PURE__ */ f(n, { className: "h-4 w-4 shrink-0" }),
            /* @__PURE__ */ f(
              "span",
              {
                className: "ds-tabs-label",
                title: typeof t == "string" ? t : void 0,
                children: t
              }
            )
          ]
        }
      ),
      r && /* @__PURE__ */ f(
        "button",
        {
          type: "button",
          className: "ds-tabs-close",
          "aria-label": o ?? (typeof t == "string" ? `${t}を閉じる` : "タブを閉じる"),
          disabled: s,
          onClick: r,
          children: /* @__PURE__ */ f(Pt, { "aria-hidden": "true", size: 14 })
        }
      )
    ] });
  }
);
wb.displayName = nc.displayName;
const Cb = u.forwardRef(({ className: e, ...t }, n) => /* @__PURE__ */ f(
  rc,
  {
    ref: n,
    className: I("ds-tabs-content", e),
    ...t
  }
));
Cb.displayName = rc.displayName;
const Sb = u.forwardRef(
  ({ className: e, ...t }, n) => /* @__PURE__ */ f(
    "textarea",
    {
      className: I(
        "flex min-h-[80px] w-full rounded-md border border-input bg-background px-ui py-ui text-ui text-foreground ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
        e
      ),
      ref: n,
      ...t
    }
  )
);
Sb.displayName = "Textarea";
const Wy = R.memo(
  ({
    type: e = "text",
    value: t = "",
    onChange: n,
    modalTitle: r,
    className: o,
    disabled: s,
    readOnly: a,
    ...i
  }) => {
    const [d, c] = Ge(!1), m = () => {
      !s && !a && c(!0);
    }, l = () => {
      c(!1);
    }, p = (h) => {
      n?.(h), c(!1);
    };
    return e === "text" ? /* @__PURE__ */ f(
      Un,
      {
        type: "text",
        value: t,
        onChange: (h) => n?.(h.target.value),
        className: o,
        disabled: s,
        readOnly: a,
        ...i
      }
    ) : /* @__PURE__ */ O(Ze, { children: [
      /* @__PURE__ */ f(
        Un,
        {
          type: "text",
          value: t,
          readOnly: !0,
          onClick: m,
          className: `${o} cursor-pointer`,
          disabled: s,
          ...i
        }
      ),
      e === "numeric" && /* @__PURE__ */ f(
        zn,
        {
          open: d,
          onClose: l,
          onSubmit: p,
          initialValue: t,
          title: r,
          placeholder: i.placeholder
        }
      ),
      e === "time" && /* @__PURE__ */ f(
        zn,
        {
          open: d,
          onClose: l,
          onSubmit: p,
          initialValue: t,
          title: r,
          variant: "time"
        }
      ),
      e === "phone" && /* @__PURE__ */ f(
        zn,
        {
          open: d,
          onClose: l,
          onSubmit: p,
          initialValue: t,
          title: r,
          placeholder: i.placeholder,
          variant: "phone"
        }
      )
    ] });
  }
);
var kb = Object.defineProperty, be = (e, t) => kb(e, "name", { value: t, configurable: !0 }), [rs, Uy] = /* @__PURE__ */ _e("Tooltip", [
  en
]), os = en(), Eb = "TooltipProvider", Nb = 700, so = "tooltip.open", [Rb, ss] = rs(Eb), Pb = /* @__PURE__ */ be((e) => {
  const {
    __scopeTooltip: t,
    delayDuration: n = Nb,
    skipDelayDuration: r = 300,
    disableHoverableContent: o = !1,
    children: s
  } = e, a = u.useRef(!0), i = u.useRef(!1), d = u.useRef(0);
  return u.useEffect(() => {
    const c = d.current;
    return () => window.clearTimeout(c);
  }, []), /* @__PURE__ */ f(
    Rb,
    {
      scope: t,
      isOpenDelayedRef: a,
      delayDuration: n,
      onOpen: u.useCallback(() => {
        r <= 0 || (window.clearTimeout(d.current), a.current = !1);
      }, [r]),
      onClose: u.useCallback(() => {
        r <= 0 || (window.clearTimeout(d.current), d.current = window.setTimeout(
          () => a.current = !0,
          r
        ));
      }, [r]),
      isPointerInTransitRef: i,
      onPointerInTransitChange: u.useCallback((c) => {
        i.current = c;
      }, []),
      disableHoverableContent: o,
      children: s
    }
  );
}, "TooltipProvider"), ao = "Tooltip", [Tb, mr] = rs(ao), _b = /* @__PURE__ */ be((e) => {
  const {
    __scopeTooltip: t,
    children: n,
    open: r,
    defaultOpen: o,
    onOpenChange: s,
    disableHoverableContent: a,
    delayDuration: i
  } = e, d = ss(ao, e.__scopeTooltip), c = os(t), [m, l] = u.useState(null), [p, h] = u.useState(void 0), b = De(), v = u.useRef(0), g = a ?? d.disableHoverableContent, y = i ?? d.delayDuration, C = u.useRef(!1), [w, x] = Ye({
    prop: r,
    defaultProp: o ?? !1,
    onChange: /* @__PURE__ */ be((_) => {
      _ ? (d.onOpen(), document.dispatchEvent(new CustomEvent(so))) : d.onClose(), s?.(_);
    }, "onChange"),
    caller: ao
  }), E = u.useMemo(() => w ? C.current ? "delayed-open" : "instant-open" : "closed", [w]), N = u.useCallback(() => {
    window.clearTimeout(v.current), v.current = 0, C.current = !1, x(!0);
  }, [x]), k = u.useCallback(() => {
    window.clearTimeout(v.current), v.current = 0, x(!1);
  }, [x]), S = u.useCallback(() => {
    window.clearTimeout(v.current), v.current = window.setTimeout(() => {
      C.current = !0, x(!0), v.current = 0;
    }, y);
  }, [y, x]);
  return u.useEffect(() => () => {
    v.current && (window.clearTimeout(v.current), v.current = 0);
  }, []), /* @__PURE__ */ f(Ao, { ...c, children: /* @__PURE__ */ f(
    Tb,
    {
      scope: t,
      contentId: p ?? b,
      setContentId: h,
      open: w,
      stateAttribute: E,
      trigger: m,
      onTriggerChange: l,
      onTriggerEnter: u.useCallback(() => {
        d.isOpenDelayedRef.current ? S() : N();
      }, [d.isOpenDelayedRef, S, N]),
      onTriggerLeave: u.useCallback(() => {
        g ? k() : (window.clearTimeout(v.current), v.current = 0);
      }, [k, g]),
      onOpen: N,
      onClose: k,
      disableHoverableContent: g,
      children: n
    }
  ) });
}, "Tooltip"), pa = "TooltipTrigger", Ib = /* @__PURE__ */ u.forwardRef(
  /* @__PURE__ */ be(function(t, n) {
    const { __scopeTooltip: r, ...o } = t, s = mr(pa, r), a = ss(pa, r), i = os(r), d = u.useRef(null), c = re(n, d, s.onTriggerChange), m = u.useRef(!1), l = u.useRef(!1), p = u.useCallback(() => m.current = !1, []);
    return u.useEffect(() => () => document.removeEventListener("pointerup", p), [p]), /* @__PURE__ */ f(Do, { asChild: !0, ...i, children: /* @__PURE__ */ f(
      Z.button,
      {
        "aria-describedby": s.open ? s.contentId : void 0,
        "data-state": s.stateAttribute,
        ...o,
        ref: c,
        onPointerMove: Y(t.onPointerMove, (h) => {
          h.pointerType !== "touch" && !l.current && !a.isPointerInTransitRef.current && (s.onTriggerEnter(), l.current = !0);
        }),
        onPointerLeave: Y(t.onPointerLeave, () => {
          s.onTriggerLeave(), l.current = !1;
        }),
        onPointerDown: Y(t.onPointerDown, () => {
          s.open && s.onClose(), m.current = !0, document.addEventListener("pointerup", p, { once: !0 });
        }),
        onFocus: Y(t.onFocus, () => {
          m.current || s.onOpen();
        }),
        onBlur: Y(t.onBlur, s.onClose),
        onClick: Y(t.onClick, s.onClose)
      }
    ) });
  }, "TooltipTrigger")
), Ob = "TooltipPortal", [Gy, Ab] = rs(Ob, {
  forceMount: void 0
}), mn = "TooltipContent", Db = /* @__PURE__ */ u.forwardRef(
  /* @__PURE__ */ be(function(t, n) {
    const r = Ab(mn, t.__scopeTooltip), { forceMount: o = r.forceMount, side: s = "top", ...a } = t, i = mr(mn, t.__scopeTooltip);
    return /* @__PURE__ */ f(lt, { present: o || i.open, children: i.disableHoverableContent ? /* @__PURE__ */ f(sc, { side: s, ...a, ref: n }) : /* @__PURE__ */ f(Mb, { side: s, ...a, ref: n }) });
  }, "TooltipContent")
), Mb = /* @__PURE__ */ u.forwardRef(/* @__PURE__ */ be(function(t, n) {
  const r = mr(mn, t.__scopeTooltip), o = ss(mn, t.__scopeTooltip), s = u.useRef(null), a = re(n, s), [i, d] = u.useState(null), { trigger: c, onClose: m } = r, l = s.current, { onPointerInTransitChange: p } = o, h = u.useCallback(() => {
    d(null), p(!1);
  }, [p]), b = u.useCallback(
    (v, g) => {
      const y = v.currentTarget, C = { x: v.clientX, y: v.clientY }, w = ac(C, y.getBoundingClientRect()), x = ic(C, w), E = lc(g.getBoundingClientRect()), N = dc([...x, ...E]);
      d(N), p(!0);
    },
    [p]
  );
  return u.useEffect(() => () => h(), [h]), u.useEffect(() => {
    if (c && l) {
      const v = /* @__PURE__ */ be((y) => b(y, l), "handleTriggerLeave"), g = /* @__PURE__ */ be((y) => b(y, c), "handleContentLeave");
      return c.addEventListener("pointerleave", v), l.addEventListener("pointerleave", g), () => {
        c.removeEventListener("pointerleave", v), l.removeEventListener("pointerleave", g);
      };
    }
  }, [c, l, b, h]), u.useEffect(() => {
    if (i) {
      const v = /* @__PURE__ */ be((g) => {
        const y = g.target, C = { x: g.clientX, y: g.clientY }, w = c?.contains(y) || l?.contains(y), x = !cc(C, i);
        w ? h() : x && (h(), m());
      }, "handleTrackPointerGrace");
      return document.addEventListener("pointermove", v), () => document.removeEventListener("pointermove", v);
    }
  }, [c, l, i, m, h]), /* @__PURE__ */ f(sc, { ...t, ref: a });
}, "TooltipContentHoverable")), Lb = /* @__PURE__ */ Ca("TooltipContent"), sc = /* @__PURE__ */ u.forwardRef(
  // blank line to reduce diff noise
  /* @__PURE__ */ be(function(t, n) {
    const {
      __scopeTooltip: r,
      children: o,
      "aria-label": s,
      id: a,
      onEscapeKeyDown: i,
      onPointerDownOutside: d,
      ...c
    } = t, m = mr(mn, r), l = os(r), { onClose: p } = m;
    u.useEffect(() => (document.addEventListener(so, p), () => document.removeEventListener(so, p)), [p]), u.useEffect(() => {
      if (m.trigger) {
        const b = /* @__PURE__ */ be((v) => {
          v.target instanceof Node && v.target.contains(m.trigger) && p();
        }, "handleScroll");
        return window.addEventListener("scroll", b, { capture: !0 }), () => window.removeEventListener("scroll", b, { capture: !0 });
      }
    }, [m.trigger, p]);
    const { setContentId: h } = m;
    return de(() => (h(a), () => {
      h(void 0);
    }), [a, h]), /* @__PURE__ */ f(
      Qn,
      {
        asChild: !0,
        disableOutsidePointerEvents: !1,
        onEscapeKeyDown: i,
        onPointerDownOutside: d,
        onFocusOutside: (b) => b.preventDefault(),
        onDismiss: p,
        children: /* @__PURE__ */ O(
          Mo,
          {
            "data-state": m.stateAttribute,
            role: s ? void 0 : "tooltip",
            id: s ? void 0 : m.contentId,
            ...l,
            ...c,
            ref: n,
            style: {
              ...c.style,
              "--radix-tooltip-content-transform-origin": "var(--radix-popper-transform-origin)",
              "--radix-tooltip-content-available-width": "var(--radix-popper-available-width)",
              "--radix-tooltip-content-available-height": "var(--radix-popper-available-height)",
              "--radix-tooltip-trigger-width": "var(--radix-popper-anchor-width)",
              "--radix-tooltip-trigger-height": "var(--radix-popper-anchor-height)"
            },
            children: [
              /* @__PURE__ */ f(Lb, { children: o }),
              s ? /* @__PURE__ */ f(cg, { id: m.contentId, role: "tooltip", children: s }) : null
            ]
          }
        )
      }
    );
  }, "TooltipContentImpl")
);
function ac(e, t) {
  const n = Math.abs(t.top - e.y), r = Math.abs(t.bottom - e.y), o = Math.abs(t.right - e.x), s = Math.abs(t.left - e.x);
  switch (Math.min(n, r, o, s)) {
    case s:
      return "left";
    case o:
      return "right";
    case n:
      return "top";
    case r:
      return "bottom";
    default:
      throw new Error("unreachable");
  }
}
be(ac, "getExitSideFromRect");
function ic(e, t, n = 5) {
  const r = [];
  switch (t) {
    case "top":
      r.push(
        { x: e.x - n, y: e.y + n },
        { x: e.x + n, y: e.y + n }
      );
      break;
    case "bottom":
      r.push(
        { x: e.x - n, y: e.y - n },
        { x: e.x + n, y: e.y - n }
      );
      break;
    case "left":
      r.push(
        { x: e.x + n, y: e.y - n },
        { x: e.x + n, y: e.y + n }
      );
      break;
    case "right":
      r.push(
        { x: e.x - n, y: e.y - n },
        { x: e.x - n, y: e.y + n }
      );
      break;
  }
  return r;
}
be(ic, "getPaddedExitPoints");
function lc(e) {
  const { top: t, right: n, bottom: r, left: o } = e;
  return [
    { x: o, y: t },
    { x: n, y: t },
    { x: n, y: r },
    { x: o, y: r }
  ];
}
be(lc, "getPointsFromRect");
function cc(e, t) {
  const { x: n, y: r } = e;
  let o = !1;
  for (let s = 0, a = t.length - 1; s < t.length; a = s++) {
    const i = t[s], d = t[a], c = i.x, m = i.y, l = d.x, p = d.y;
    m > r != p > r && n < (l - c) * (r - m) / (p - m) + c && (o = !o);
  }
  return o;
}
be(cc, "isPointInPolygon");
function dc(e) {
  const t = e.slice();
  return t.sort((n, r) => n.x < r.x ? -1 : n.x > r.x ? 1 : n.y < r.y ? -1 : n.y > r.y ? 1 : 0), uc(t);
}
be(dc, "getHull");
function uc(e) {
  if (e.length <= 1) return e.slice();
  const t = [];
  for (let r = 0; r < e.length; r++) {
    const o = e[r];
    for (; t.length >= 2; ) {
      const s = t[t.length - 1], a = t[t.length - 2];
      if ((s.x - a.x) * (o.y - a.y) >= (s.y - a.y) * (o.x - a.x)) t.pop();
      else break;
    }
    t.push(o);
  }
  t.pop();
  const n = [];
  for (let r = e.length - 1; r >= 0; r--) {
    const o = e[r];
    for (; n.length >= 2; ) {
      const s = n[n.length - 1], a = n[n.length - 2];
      if ((s.x - a.x) * (o.y - a.y) >= (s.y - a.y) * (o.x - a.x)) n.pop();
      else break;
    }
    n.push(o);
  }
  return n.pop(), t.length === 1 && n.length === 1 && t[0].x === n[0].x && t[0].y === n[0].y ? t : t.concat(n);
}
be(uc, "getHullPresorted");
var $b = Pb, Fb = _b, zb = Ib, fc = Db;
const Bb = $b, Vb = Fb, jb = zb, mc = u.memo(
  u.forwardRef(({ className: e, sideOffset: t = 4, side: n = "bottom", ...r }, o) => /* @__PURE__ */ f(
    fc,
    {
      ref: o,
      sideOffset: t,
      side: n,
      className: I(
        "z-50 overflow-hidden rounded-md border border-white bg-black text-white px-3 py-1.5 text-xs shadow-md animate-in fade-in-0 zoom-in-95",
        e
      ),
      ...r
    }
  ))
);
mc.displayName = fc.displayName;
const Hb = typeof document < "u", Wb = () => Hb ? document.documentElement.dir === "rtl" || document.documentElement.getAttribute("data-rtl") === "true" : !1, Ub = (e) => new Set(e ?? []), Ky = ({
  title: e = "Menu",
  items: t,
  selectedId: n,
  onSelect: r,
  defaultExpandedIds: o,
  expandedIds: s,
  onExpandedChange: a,
  // dense = false, // Removed unused prop
  className: i,
  // Restoration props
  showCloseButton: d = !1,
  onCloseMenu: c,
  hideControlBar: m = !1
}) => {
  const l = Wb(), p = R.useMemo(() => {
    const _ = [], M = (A) => {
      A.forEach((T) => {
        T.children && T.children.length > 0 && (_.push(T.id), M(T.children));
      });
    };
    return t && M(t), _;
  }, [t]), [h, b] = R.useState(o ?? []), v = s !== void 0, g = v ? s : h, y = R.useMemo(() => Ub(g), [g]), C = R.useCallback(
    (_) => {
      v || b(_), a?.(_);
    },
    [v, a]
  ), w = R.useCallback(
    (_) => {
      const M = new Set(y);
      M.has(_) ? M.delete(_) : M.add(_), C(Array.from(M));
    },
    [y, C]
  ), x = () => C(p), E = () => C([]), N = "px-ui py-ui", k = (_, M) => /* @__PURE__ */ f("ul", { role: M === 0 ? "tree" : "group", className: "space-y-0.5", children: _.map((A) => {
    const T = (A.children?.length ?? 0) > 0, D = T && y.has(A.id), W = n === A.id, $ = 8 + M * 16;
    return /* @__PURE__ */ O(
      "li",
      {
        role: "treeitem",
        "aria-expanded": T ? D : void 0,
        "aria-selected": W || void 0,
        tabIndex: A.disabled ? -1 : 0,
        children: [
          /* @__PURE__ */ O(
            "div",
            {
              className: I(
                "w-full flex items-center gap-2 rounded-md transition-colors duration-150",
                N,
                "text-foreground",
                A.disabled && "opacity-50 pointer-events-none",
                W ? "bg-primary text-primary-foreground font-semibold" : "hover:bg-primary/20 hover:text-foreground"
              ),
              style: {
                paddingInlineStart: $
              },
              children: [
                T ? /* @__PURE__ */ O(
                  "button",
                  {
                    type: "button",
                    className: "flex-1 flex items-center min-w-0 text-start cursor-pointer focus:outline-none",
                    onClick: () => w(A.id),
                    children: [
                      A.icon && /* @__PURE__ */ f(
                        "span",
                        {
                          className: I(
                            "me-2",
                            W ? "text-primary-foreground" : "text-muted-foreground"
                          ),
                          children: A.icon
                        }
                      ),
                      /* @__PURE__ */ f("span", { className: I("truncate flex-grow", "text-ui"), children: A.label })
                    ]
                  }
                ) : /* @__PURE__ */ O(
                  "button",
                  {
                    type: "button",
                    className: "flex-1 flex items-center min-w-0 text-start cursor-pointer focus:outline-none",
                    onClick: () => r?.(A.id, A),
                    children: [
                      A.icon && /* @__PURE__ */ f(
                        "span",
                        {
                          className: I(
                            "me-2",
                            W ? "text-primary-foreground" : "text-muted-foreground"
                          ),
                          children: A.icon
                        }
                      ),
                      /* @__PURE__ */ f("span", { className: I("truncate flex-grow", "text-ui"), children: A.label })
                    ]
                  }
                ),
                A.badge !== void 0 && /* @__PURE__ */ f(
                  "span",
                  {
                    className: I(
                      "ms-2 text-xs px-2 py-0.5 rounded",
                      W ? "bg-primary-foreground/20 text-primary-foreground" : "bg-muted text-muted-foreground"
                    ),
                    children: A.badge
                  }
                ),
                T && /* @__PURE__ */ f(
                  "button",
                  {
                    type: "button",
                    onClick: (z) => {
                      z.stopPropagation(), w(A.id);
                    },
                    className: I(
                      "w-7 aspect-square flex items-center justify-center rounded focus:outline-none",
                      W ? "text-primary-foreground hover:text-primary-foreground/80" : "text-foreground hover:text-accent-foreground"
                    ),
                    "aria-label": D ? "Collapse" : "Expand",
                    children: D ? /* @__PURE__ */ f(Zn, { size: 16 }) : l ? /* @__PURE__ */ f($r, { size: 16 }) : /* @__PURE__ */ f(Fr, { size: 16 })
                  }
                )
              ]
            }
          ),
          T && D && A.children ? /* @__PURE__ */ f("div", { className: "mt-0.5", children: k(A.children, M + 1) }) : null
        ]
      },
      A.id
    );
  }) }), S = "text-primary-foreground", P = "hover:text-primary-foreground/80";
  return /* @__PURE__ */ O(
    "div",
    {
      className: I("w-full relative h-full min-h-0 flex flex-col", i),
      children: [
        !m && /* @__PURE__ */ O("div", { className: "flex items-center bg-primary px-ui py-ui w-full mb-2", children: [
          d && c && /* @__PURE__ */ f(
            "button",
            {
              type: "button",
              "aria-label": "Close menu",
              className: I(
                "min-w-[32px] focus:outline-none",
                S,
                P
              ),
              onClick: c,
              children: l ? /* @__PURE__ */ f(Fr, { size: 20 }) : /* @__PURE__ */ f($r, { size: 20 })
            }
          ),
          /* @__PURE__ */ f(
            "div",
            {
              className: I(
                "flex items-center font-bold flex-grow ps-2",
                S
              ),
              children: e
            }
          ),
          /* @__PURE__ */ O("div", { className: "flex items-center space-x-2", children: [
            /* @__PURE__ */ f(
              "button",
              {
                type: "button",
                onClick: x,
                className: I(
                  "focus:outline-none",
                  S,
                  P
                ),
                "aria-label": "Expand all",
                children: /* @__PURE__ */ f(Oa, { size: "0.8rem" })
              }
            ),
            /* @__PURE__ */ f(
              "button",
              {
                type: "button",
                onClick: E,
                className: I(
                  "focus:outline-none",
                  S,
                  P
                ),
                "aria-label": "Collapse all",
                children: /* @__PURE__ */ f(Wd, { size: "0.8rem" })
              }
            )
          ] })
        ] }),
        /* @__PURE__ */ f("div", { className: "bg-background w-full flex-1 min-h-0 overflow-y-auto", children: t && t.length > 0 ? k(t, 0) : /* @__PURE__ */ f("div", { className: "text-xs text-muted-foreground px-ui py-ui", children: "TreeMenu items not provided." }) })
      ]
    }
  );
}, Yy = R.memo(
  ({ options: e, value: t, onChange: n, className: r }) => /* @__PURE__ */ f(Bb, { children: /* @__PURE__ */ f(
    "div",
    {
      className: I(
        "inline-flex rounded-lg border border-border bg-background p-1",
        r
      ),
      children: e.map((o) => {
        const s = o.icon, a = t === o.value;
        return /* @__PURE__ */ O(Vb, { children: [
          /* @__PURE__ */ f(jb, { asChild: !0, children: /* @__PURE__ */ f(
            "button",
            {
              type: "button",
              onClick: () => n(o.value),
              className: I(
                "flex items-center justify-center p-2 rounded transition-colors",
                a ? "bg-accent text-white" : "text-muted-foreground hover:bg-card hover:text-foreground"
              ),
              "aria-label": o.tooltip,
              children: /* @__PURE__ */ f(s, { className: "text-lg" })
            }
          ) }),
          /* @__PURE__ */ f(mc, { children: /* @__PURE__ */ f("p", { children: o.tooltip }) })
        ] }, o.value);
      })
    }
  ) })
), Xy = {
  LIGHT: "light",
  DARK: "dark"
}, qy = {
  dark: { tone: "dark" },
  tokyonight: { tone: "dark" },
  eclipse: { tone: "light" },
  macosclassic: { tone: "light" },
  fire: { tone: "dark" },
  classicterminal: { tone: "dark" },
  sakurabloom: { tone: "light" },
  leafmint: { tone: "light" },
  lattecream: { tone: "light" },
  sunshineOrange: { tone: "light" },
  light: { tone: "light" }
}, Zy = "light";
export {
  qt as ActionButton,
  Wn as AdaptiveText,
  ey as AsyncDataWrapper,
  lf as Avatar,
  ty as Badge,
  ye as Button,
  ry as Calculator,
  py as CalendarProvider,
  Qu as CancelButton,
  Mm as Card,
  zm as CardContent,
  Fm as CardDescription,
  Bm as CardFooter,
  Lm as CardHeader,
  $m as CardTitle,
  oy as ChatDock,
  Vm as Checkbox,
  ay as Collapsible,
  ly as CollapsibleContent,
  iy as CollapsibleTrigger,
  cy as ConfirmModal,
  dy as ContentHeader,
  uy as CopyClipButton,
  Ju as CreateButton,
  Oy as CurrencyFormat,
  Zy as DEFAULT_THEME,
  fy as DateDisplay,
  hy as DateFormat,
  ef as DeleteButton,
  my as DigitalClock,
  Zb as DirectionProvider,
  gy as Drawer,
  vy as DropdownMenu,
  tf as EditButton,
  np as EditableSelect,
  rf as ErrorState,
  by as Form,
  Np as FormControl,
  Pp as FormDescription,
  yy as FormField,
  Cp as FormItem,
  kp as FormLabel,
  _p as FormMessage,
  Ip as ImageViewer,
  wy as ImageWithPreview,
  Cy as InfiniteListMenu,
  Un as Input,
  zn as KeypadModal,
  Fp as Label,
  Ny as LanguageSelector,
  Ry as MenuButtonGroup,
  Py as MiniTable,
  vn as Modal,
  Dm as ModalFooter,
  Ty as NavigationStepper,
  _y as NotificationCard,
  nv as NotificationToast,
  Iy as NumberFormat,
  Ay as OptionButtonGroup,
  Dy as Pagination,
  ov as PercentFormat,
  Ly as Popover,
  xv as PopoverContent,
  $y as PopoverTrigger,
  Tv as ProgressBar,
  zy as RadioButtonGroup,
  nf as SaveButton,
  _v as ScaleInput,
  Iv as ScrollArea,
  Ov as SearchableSelect,
  Ug as Select,
  Pl as SelectContent,
  Ey as SelectGroup,
  Tl as SelectItem,
  Kg as SelectLabel,
  Yg as SelectSeparator,
  Rl as SelectTrigger,
  Gg as SelectValue,
  By as SelectableTextInput,
  Lv as Separator,
  $v as SimpleSearchInput,
  Ka as Skeleton,
  St as Spinner,
  Kv as Switch,
  qy as THEME_COLORS,
  Xy as THEME_CONSTANTS,
  Hy as Tabs,
  Cb as TabsContent,
  xb as TabsList,
  wb as TabsTrigger,
  Wy as TextInput,
  Sb as Textarea,
  Jb as Toaster,
  Vb as Tooltip,
  mc as TooltipContent,
  Bb as TooltipProvider,
  jb as TooltipTrigger,
  Ky as TreeMenu,
  Yy as ViewSwitcher,
  qu as buttonVariants,
  Zg as calculateLastRowInfo,
  qg as calculateOptimalColumnCount,
  I as cn,
  Qb as toast,
  Jm as useCalendarSettings,
  rr as useFormField,
  xy as useImageViewer
};
