var us = (e) => {
  throw TypeError(e);
};
var fs = (e, n, r) => n.has(e) || us("Cannot " + r);
var Ce = (e, n, r) => (fs(e, n, "read from private field"), r ? r.call(e) : n.get(e)), ms = (e, n, r) => n.has(e) ? us("Cannot add the same private member more than once") : n instanceof WeakSet ? n.add(e) : n.set(e, r), gr = (e, n, r, o) => (fs(e, n, "write to private field"), o ? o.call(e, r) : n.set(e, r), r);
import * as f from "react";
import P, { forwardRef as da, createElement as Or, useRef as an, useState as Ke, useLayoutEffect as ua, useMemo as ot, useContext as gc, createContext as vc, useEffect as kt, useCallback as zt } from "react";
import { jsx as m, jsxs as D, Fragment as Qe } from "react/jsx-runtime";
import * as hn from "react-dom";
import bc, { createPortal as yc } from "react-dom";
import { useTranslation as xc } from "react-i18next";
var wc = Object.defineProperty, fa = (e, n) => wc(e, "name", { value: n, configurable: !0 }), ma = f.createContext(void 0), jb = /* @__PURE__ */ fa((e) => {
  const { dir: n, children: r } = e;
  return /* @__PURE__ */ m(ma.Provider, { value: n, children: r });
}, "DirectionProvider");
function Yn(e) {
  const n = f.useContext(ma);
  return e || n || "ltr";
}
fa(Yn, "useDirection");
function Cc(e) {
  if (typeof document > "u") return;
  let n = document.head || document.getElementsByTagName("head")[0], r = document.createElement("style");
  r.type = "text/css", n.appendChild(r), r.styleSheet ? r.styleSheet.cssText = e : r.appendChild(document.createTextNode(e));
}
const Sc = (e) => {
  switch (e) {
    case "success":
      return Nc;
    case "info":
      return Pc;
    case "warning":
      return Rc;
    case "error":
      return Tc;
    default:
      return null;
  }
}, kc = Array(12).fill(0), Ec = ({ visible: e, className: n }) => /* @__PURE__ */ P.createElement("div", {
  className: [
    "sonner-loading-wrapper",
    n
  ].filter(Boolean).join(" "),
  "data-visible": e
}, /* @__PURE__ */ P.createElement("div", {
  className: "sonner-spinner"
}, kc.map((r, o) => /* @__PURE__ */ P.createElement("div", {
  className: "sonner-loading-bar",
  key: `spinner-bar-${o}`
})))), Nc = /* @__PURE__ */ P.createElement("svg", {
  xmlns: "http://www.w3.org/2000/svg",
  viewBox: "0 0 20 20",
  fill: "currentColor",
  height: "20",
  width: "20",
  "aria-hidden": "true"
}, /* @__PURE__ */ P.createElement("path", {
  fillRule: "evenodd",
  d: "M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z",
  clipRule: "evenodd"
})), Rc = /* @__PURE__ */ P.createElement("svg", {
  xmlns: "http://www.w3.org/2000/svg",
  viewBox: "0 0 24 24",
  fill: "currentColor",
  height: "20",
  width: "20",
  "aria-hidden": "true"
}, /* @__PURE__ */ P.createElement("path", {
  fillRule: "evenodd",
  d: "M9.401 3.003c1.155-2 4.043-2 5.197 0l7.355 12.748c1.154 2-.29 4.5-2.599 4.5H4.645c-2.309 0-3.752-2.5-2.598-4.5L9.4 3.003zM12 8.25a.75.75 0 01.75.75v3.75a.75.75 0 01-1.5 0V9a.75.75 0 01.75-.75zm0 8.25a.75.75 0 100-1.5.75.75 0 000 1.5z",
  clipRule: "evenodd"
})), Pc = /* @__PURE__ */ P.createElement("svg", {
  xmlns: "http://www.w3.org/2000/svg",
  viewBox: "0 0 20 20",
  fill: "currentColor",
  height: "20",
  width: "20",
  "aria-hidden": "true"
}, /* @__PURE__ */ P.createElement("path", {
  fillRule: "evenodd",
  d: "M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z",
  clipRule: "evenodd"
})), Tc = /* @__PURE__ */ P.createElement("svg", {
  xmlns: "http://www.w3.org/2000/svg",
  viewBox: "0 0 20 20",
  fill: "currentColor",
  height: "20",
  width: "20",
  "aria-hidden": "true"
}, /* @__PURE__ */ P.createElement("path", {
  fillRule: "evenodd",
  d: "M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-5a.75.75 0 01.75.75v4.5a.75.75 0 01-1.5 0v-4.5A.75.75 0 0110 5zm0 10a1 1 0 100-2 1 1 0 000 2z",
  clipRule: "evenodd"
})), _c = /* @__PURE__ */ P.createElement("svg", {
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
}, /* @__PURE__ */ P.createElement("line", {
  x1: "18",
  y1: "6",
  x2: "6",
  y2: "18"
}), /* @__PURE__ */ P.createElement("line", {
  x1: "6",
  y1: "6",
  x2: "18",
  y2: "18"
})), Ic = () => {
  const [e, n] = P.useState(document.hidden);
  return P.useEffect(() => {
    const r = () => {
      n(document.hidden);
    };
    return document.addEventListener("visibilitychange", r), () => document.removeEventListener("visibilitychange", r);
  }, []), e;
};
let Oc = 1;
const Ac = 100, ps = (e) => {
  var n;
  return typeof e?.id == "number" || (e == null || (n = e.id) == null ? void 0 : n.length) > 0 ? e.id : Oc++;
};
class Dc {
  constructor() {
    this.subscribe = (n) => (this.subscribers.push(n), this.getActiveToasts().forEach((r) => n(r)), () => {
      const r = this.subscribers.indexOf(n);
      this.subscribers.splice(r, 1);
    }), this.publish = (n) => {
      this.subscribers.forEach((r) => r(n));
    }, this.addToast = (n) => {
      this.publish(n), this.toasts = [
        ...this.toasts,
        n
      ], this.trimHistory();
    }, this.trimHistory = () => {
      let n = this.toasts.length - Ac;
      n <= 0 || (this.toasts = this.toasts.filter((r) => n > 0 && this.dismissedToasts.has(r.id) ? (this.dismissedToasts.delete(r.id), n--, !1) : !0));
    }, this.create = (n) => {
      const { message: r, ...o } = n, s = ps(n), a = this.pendingDismissals.get(s);
      a !== void 0 && (cancelAnimationFrame(a), this.pendingDismissals.delete(s), this.dismissedToasts.delete(s));
      const i = this.dismissedToasts.has(s), l = n.dismissible === void 0 ? !0 : n.dismissible;
      return i && (this.dismissedToasts.delete(s), this.toasts = this.toasts.filter((d) => d.id !== s)), (i ? void 0 : this.toasts.find((d) => d.id === s)) ? this.toasts = this.toasts.map((d) => d.id === s ? (this.publish({
        ...d,
        ...n,
        id: s,
        title: r
      }), {
        ...d,
        ...n,
        id: s,
        dismissible: l,
        title: r
      }) : d) : this.addToast({
        title: r,
        ...o,
        dismissible: l,
        id: s
      }), s;
    }, this.dismiss = (n) => {
      if (n == null)
        return this.getActiveToasts().forEach((o) => {
          this.dismissedToasts.add(o.id), this.subscribers.forEach((s) => s({
            id: o.id,
            dismiss: !0
          }));
        }), n;
      this.dismissedToasts.add(n);
      const r = this.pendingDismissals.get(n);
      return r !== void 0 && cancelAnimationFrame(r), this.pendingDismissals.set(n, requestAnimationFrame(() => {
        this.pendingDismissals.delete(n), this.subscribers.forEach((o) => o({
          id: n,
          dismiss: !0
        }));
      })), n;
    }, this.message = (n, r) => this.create({
      ...r,
      message: n,
      type: void 0
    }), this.error = (n, r) => this.create({
      ...r,
      message: n,
      type: "error"
    }), this.success = (n, r) => this.create({
      ...r,
      type: "success",
      message: n
    }), this.info = (n, r) => this.create({
      ...r,
      type: "info",
      message: n
    }), this.warning = (n, r) => this.create({
      ...r,
      type: "warning",
      message: n
    }), this.loading = (n, r) => this.create({
      ...r,
      type: "loading",
      message: n
    }), this.promise = (n, r) => {
      if (!r)
        return;
      let o;
      r.loading !== void 0 && (o = this.create({
        ...r,
        promise: n,
        type: "loading",
        message: r.loading,
        description: typeof r.description != "function" ? r.description : void 0
      }));
      const s = Promise.resolve(n instanceof Function ? n() : n);
      let a = o !== void 0, i;
      const l = s.then(async (d) => {
        if (i = [
          "resolve",
          d
        ], P.isValidElement(d))
          a = !1, this.create({
            id: o,
            type: "default",
            message: d
          });
        else if (Lc(d) && !d.ok) {
          a = !1;
          const c = typeof r.error == "function" ? await r.error(`HTTP error! status: ${d.status}`) : r.error, h = typeof r.description == "function" ? await r.description(`HTTP error! status: ${d.status}`) : r.description, y = typeof c == "object" && !P.isValidElement(c) ? c : {
            message: c
          };
          this.create({
            id: o,
            type: "error",
            description: h,
            ...y
          });
        } else if (d instanceof Error) {
          a = !1;
          const c = typeof r.error == "function" ? await r.error(d) : r.error, h = typeof r.description == "function" ? await r.description(d) : r.description, y = typeof c == "object" && !P.isValidElement(c) ? c : {
            message: c
          };
          this.create({
            id: o,
            type: "error",
            description: h,
            ...y
          });
        } else if (r.success !== void 0) {
          a = !1;
          const c = typeof r.success == "function" ? await r.success(d) : r.success, h = typeof r.description == "function" ? await r.description(d) : r.description, y = typeof c == "object" && !P.isValidElement(c) ? c : {
            message: c
          };
          this.create({
            id: o,
            type: "success",
            description: h,
            ...y
          });
        }
      }).catch(async (d) => {
        if (i = [
          "reject",
          d
        ], r.error !== void 0) {
          a = !1;
          const p = typeof r.error == "function" ? await r.error(d) : r.error, c = typeof r.description == "function" ? await r.description(d) : r.description, g = typeof p == "object" && !P.isValidElement(p) ? p : {
            message: p
          };
          this.create({
            id: o,
            type: "error",
            description: c,
            ...g
          });
        }
      }).finally(() => {
        a && (this.dismiss(o), o = void 0), r.finally == null || r.finally.call(r);
      }), u = () => new Promise((d, p) => l.then(() => i[0] === "reject" ? p(i[1]) : d(i[1])).catch(p));
      return typeof o != "string" && typeof o != "number" ? {
        unwrap: u
      } : Object.assign(o, {
        unwrap: u
      });
    }, this.custom = (n, r) => {
      const o = ps(r);
      return this.create({
        ...r,
        jsx: n(o),
        id: o,
        type: void 0
      }), o;
    }, this.getActiveToasts = () => this.toasts.filter((n) => !this.dismissedToasts.has(n.id)), this.subscribers = [], this.toasts = [], this.dismissedToasts = /* @__PURE__ */ new Set(), this.pendingDismissals = /* @__PURE__ */ new Map();
  }
}
const Pe = new Dc(), Mc = (e, n) => Pe.message(e, n), Lc = (e) => e && typeof e == "object" && "ok" in e && typeof e.ok == "boolean" && "status" in e && typeof e.status == "number", Fc = Mc, $c = () => Pe.toasts, zc = () => Pe.getActiveToasts(), Hb = Object.assign(Fc, {
  success: Pe.success,
  info: Pe.info,
  warning: Pe.warning,
  error: Pe.error,
  custom: Pe.custom,
  message: Pe.message,
  promise: Pe.promise,
  dismiss: Pe.dismiss,
  loading: Pe.loading
}, {
  getHistory: $c,
  getToasts: zc
});
Cc("[data-sonner-toaster][dir=ltr],html[dir=ltr]{--toast-icon-margin-start:-3px;--toast-icon-margin-end:4px;--toast-svg-margin-start:-1px;--toast-svg-margin-end:0px;--toast-button-margin-start:auto;--toast-button-margin-end:0;--toast-close-button-start:0;--toast-close-button-end:unset;--toast-close-button-transform:translate(-35%, -35%)}[data-sonner-toaster][dir=rtl],html[dir=rtl]{--toast-icon-margin-start:4px;--toast-icon-margin-end:-3px;--toast-svg-margin-start:0px;--toast-svg-margin-end:-1px;--toast-button-margin-start:0;--toast-button-margin-end:auto;--toast-close-button-start:unset;--toast-close-button-end:0;--toast-close-button-transform:translate(35%, -35%)}[data-sonner-toaster]{position:fixed;width:var(--width);font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,Noto Sans,sans-serif,Apple Color Emoji,Segoe UI Emoji,Segoe UI Symbol,Noto Color Emoji;--gray1:hsl(0, 0%, 99%);--gray2:hsl(0, 0%, 97.3%);--gray3:hsl(0, 0%, 95.1%);--gray4:hsl(0, 0%, 93%);--gray5:hsl(0, 0%, 90.9%);--gray6:hsl(0, 0%, 88.7%);--gray7:hsl(0, 0%, 85.8%);--gray8:hsl(0, 0%, 78%);--gray9:hsl(0, 0%, 56.1%);--gray10:hsl(0, 0%, 52.3%);--gray11:hsl(0, 0%, 43.5%);--gray12:hsl(0, 0%, 9%);--border-radius:8px;box-sizing:border-box;padding:0;margin:0;list-style:none;outline:0;z-index:999999999;transition:transform .4s ease}@media (hover:none) and (pointer:coarse){[data-sonner-toaster][data-lifted=true]{transform:none}}[data-sonner-toaster][data-x-position=right]{right:var(--offset-right)}[data-sonner-toaster][data-x-position=left]{left:var(--offset-left)}[data-sonner-toaster][data-x-position=center]{left:50%;transform:translateX(-50%)}[data-sonner-toaster][data-y-position=top]{top:var(--offset-top)}[data-sonner-toaster][data-y-position=bottom]{bottom:var(--offset-bottom)}[data-sonner-toast]{--y:translateY(100%);--lift-amount:calc(var(--lift) * var(--gap));z-index:var(--z-index);position:absolute;opacity:0;transform:var(--y);touch-action:none;transition:transform .4s,opacity .4s,height .4s,box-shadow .2s;box-sizing:border-box;outline:0;overflow-wrap:anywhere}[data-sonner-toast][data-styled=true]{padding:16px;background:var(--normal-bg);border:1px solid var(--normal-border);color:var(--normal-text);border-radius:var(--border-radius);box-shadow:0 4px 12px rgba(0,0,0,.1);width:var(--width);font-size:13px;display:flex;align-items:center;gap:6px}[data-sonner-toast]:focus-visible{box-shadow:0 4px 12px rgba(0,0,0,.1),0 0 0 2px rgba(0,0,0,.2)}[data-sonner-toast][data-y-position=top]{top:0;--y:translateY(-100%);--lift:1;--lift-amount:calc(1 * var(--gap))}[data-sonner-toast][data-y-position=bottom]{bottom:0;--y:translateY(100%);--lift:-1;--lift-amount:calc(var(--lift) * var(--gap))}[data-sonner-toast][data-styled=true] [data-description]{font-weight:400;line-height:1.4;color:#3f3f3f}[data-rich-colors=true][data-sonner-toast][data-styled=true] [data-description]{color:inherit}[data-sonner-toaster][data-sonner-theme=dark] [data-description]{color:#e8e8e8}[data-sonner-toast][data-styled=true] [data-title]{font-weight:500;line-height:1.5;color:inherit}[data-sonner-toast][data-styled=true] [data-icon]{display:flex;height:16px;width:16px;position:relative;justify-content:flex-start;align-items:center;flex-shrink:0;margin-left:var(--toast-icon-margin-start);margin-right:var(--toast-icon-margin-end)}[data-sonner-toast][data-promise=true] [data-icon]>svg{opacity:0;transform:scale(.8);transform-origin:center;animation:sonner-fade-in .3s ease forwards}[data-sonner-toast][data-styled=true] [data-icon]>*{flex-shrink:0}[data-sonner-toast][data-styled=true] [data-icon] svg{margin-left:var(--toast-svg-margin-start);margin-right:var(--toast-svg-margin-end)}[data-sonner-toast][data-styled=true] [data-content]{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}[data-sonner-toast][data-styled=true] [data-button]{border-radius:4px;padding-left:8px;padding-right:8px;height:24px;font-size:12px;color:var(--normal-bg);background:var(--normal-text);margin-left:var(--toast-button-margin-start);margin-right:var(--toast-button-margin-end);border:none;font-weight:500;cursor:pointer;outline:0;display:flex;align-items:center;flex-shrink:0;transition:opacity .4s,box-shadow .2s}[data-sonner-toast][data-styled=true] [data-button]:focus-visible{box-shadow:0 0 0 2px rgba(0,0,0,.4)}[data-sonner-toast][data-styled=true] [data-button]:first-of-type{margin-left:var(--toast-button-margin-start);margin-right:var(--toast-button-margin-end)}[data-sonner-toast][data-styled=true] [data-cancel]{color:var(--normal-text);background:rgba(0,0,0,.08)}[data-sonner-toaster][data-sonner-theme=dark] [data-sonner-toast][data-styled=true] [data-cancel]{background:rgba(255,255,255,.3)}[data-sonner-toast][data-styled=true] [data-close-button]{position:absolute;left:var(--toast-close-button-start);right:var(--toast-close-button-end);top:0;height:20px;width:20px;display:flex;justify-content:center;align-items:center;padding:0;color:var(--normal-text);background:var(--normal-bg);border:1px solid var(--normal-border);transform:var(--toast-close-button-transform);border-radius:50%;cursor:pointer;z-index:1;transition:opacity .1s,background .2s,border-color .2s}[data-sonner-toast][data-styled=true] [data-close-button]:focus-visible{box-shadow:0 4px 12px rgba(0,0,0,.1),0 0 0 2px rgba(0,0,0,.2)}[data-sonner-toast][data-styled=true] [data-disabled=true]{cursor:not-allowed}[data-sonner-toast][data-styled=true]:hover [data-close-button]:hover{background:var(--gray2);border-color:var(--gray5)}[data-sonner-toast][data-swiping=true]::before{content:'';position:absolute;left:-100%;right:-100%;height:100%;z-index:-1}[data-sonner-toast][data-y-position=top][data-swiping=true]::before{bottom:50%;transform:scaleY(3) translateY(50%)}[data-sonner-toast][data-y-position=bottom][data-swiping=true]::before{top:50%;transform:scaleY(3) translateY(-50%)}[data-sonner-toast][data-swiping=false][data-removed=true]::before{content:'';position:absolute;inset:0;transform:scaleY(2)}[data-sonner-toast][data-expanded=true]::after{content:'';position:absolute;left:0;height:calc(var(--gap) + 1px);bottom:100%;width:100%}[data-sonner-toast][data-mounted=true]{--y:translateY(0);opacity:1}[data-sonner-toast][data-expanded=false][data-front=false]{--scale:var(--toasts-before) * 0.05 + 1;--y:translateY(calc(var(--lift-amount) * var(--toasts-before))) scale(calc(-1 * var(--scale)));height:var(--front-toast-height)}[data-sonner-toast]>*{transition:opacity .4s}[data-sonner-toast][data-x-position=right]{right:0}[data-sonner-toast][data-x-position=left]{left:0}[data-sonner-toast][data-expanded=false][data-front=false][data-styled=true]>*{opacity:0}[data-sonner-toast][data-visible=false]{opacity:0;pointer-events:none}[data-sonner-toast][data-mounted=true][data-expanded=true]{--y:translateY(calc(var(--lift) * var(--offset)));height:var(--initial-height)}[data-sonner-toast][data-removed=true][data-front=true][data-swipe-out=false]{--y:translateY(calc(var(--lift) * -100%));opacity:0}[data-sonner-toast][data-removed=true][data-front=false][data-swipe-out=false][data-expanded=true]{--y:translateY(calc(var(--lift) * var(--offset) + var(--lift) * -100%));opacity:0}[data-sonner-toast][data-removed=true][data-front=false][data-swipe-out=false][data-expanded=false]{--y:translateY(40%);opacity:0;transition:transform .5s,opacity .2s}[data-sonner-toast][data-removed=true][data-front=false]::before{height:calc(var(--initial-height) + 20%)}[data-sonner-toast][data-swiping=true]{transform:var(--y) translateY(var(--swipe-amount-y,0)) translateX(var(--swipe-amount-x,0));transition:none}[data-sonner-toast][data-swiped=true]{-webkit-user-select:none;user-select:none}[data-sonner-toast][data-swipe-out=true][data-y-position=bottom],[data-sonner-toast][data-swipe-out=true][data-y-position=top]{animation-duration:.2s;animation-timing-function:ease-out;animation-fill-mode:forwards}[data-sonner-toast][data-swipe-out=true][data-swipe-direction=left]{animation-name:swipe-out-left}[data-sonner-toast][data-swipe-out=true][data-swipe-direction=right]{animation-name:swipe-out-right}[data-sonner-toast][data-swipe-out=true][data-swipe-direction=up]{animation-name:swipe-out-up}[data-sonner-toast][data-swipe-out=true][data-swipe-direction=down]{animation-name:swipe-out-down}@keyframes swipe-out-left{from{transform:var(--y) translateX(var(--swipe-amount-x));opacity:1}to{transform:var(--y) translateX(calc(var(--swipe-amount-x) - 100%));opacity:0}}@keyframes swipe-out-right{from{transform:var(--y) translateX(var(--swipe-amount-x));opacity:1}to{transform:var(--y) translateX(calc(var(--swipe-amount-x) + 100%));opacity:0}}@keyframes swipe-out-up{from{transform:var(--y) translateY(var(--swipe-amount-y));opacity:1}to{transform:var(--y) translateY(calc(var(--swipe-amount-y) - 100%));opacity:0}}@keyframes swipe-out-down{from{transform:var(--y) translateY(var(--swipe-amount-y));opacity:1}to{transform:var(--y) translateY(calc(var(--swipe-amount-y) + 100%));opacity:0}}@media (max-width:600px){[data-sonner-toaster]{position:fixed;right:var(--mobile-offset-right);left:var(--mobile-offset-left);width:100%}[data-sonner-toaster][dir=rtl]{left:calc(var(--mobile-offset-left) * -1)}[data-sonner-toaster] [data-sonner-toast]{left:0;right:0;width:calc(100% - var(--mobile-offset-left) * 2)}[data-sonner-toaster][data-x-position=left]{left:var(--mobile-offset-left)}[data-sonner-toaster][data-y-position=bottom]{bottom:var(--mobile-offset-bottom)}[data-sonner-toaster][data-y-position=top]{top:var(--mobile-offset-top)}[data-sonner-toaster][data-x-position=center]{left:var(--mobile-offset-left);right:var(--mobile-offset-right);transform:none}}[data-sonner-toaster][data-sonner-theme=light]{--normal-bg:#fff;--normal-border:var(--gray4);--normal-text:var(--gray12);--success-bg:hsl(143, 85%, 96%);--success-border:hsl(145, 92%, 87%);--success-text:hsl(140, 100%, 27%);--info-bg:hsl(208, 100%, 97%);--info-border:hsl(221, 91%, 93%);--info-text:hsl(210, 92%, 45%);--warning-bg:hsl(49, 100%, 97%);--warning-border:hsl(49, 91%, 84%);--warning-text:hsl(31, 92%, 45%);--error-bg:hsl(359, 100%, 97%);--error-border:hsl(359, 100%, 94%);--error-text:hsl(360, 100%, 45%)}[data-sonner-toaster][data-sonner-theme=light] [data-sonner-toast][data-invert=true]{--normal-bg:#000;--normal-border:hsl(0, 0%, 20%);--normal-text:var(--gray1)}[data-sonner-toaster][data-sonner-theme=dark] [data-sonner-toast][data-invert=true]{--normal-bg:#fff;--normal-border:var(--gray3);--normal-text:var(--gray12)}[data-sonner-toaster][data-sonner-theme=dark]{--normal-bg:#000;--normal-bg-hover:hsl(0, 0%, 12%);--normal-border:hsl(0, 0%, 20%);--normal-border-hover:hsl(0, 0%, 25%);--normal-text:var(--gray1);--success-bg:hsl(150, 100%, 6%);--success-border:hsl(147, 100%, 12%);--success-text:hsl(150, 86%, 65%);--info-bg:hsl(215, 100%, 6%);--info-border:hsl(223, 43%, 17%);--info-text:hsl(216, 87%, 65%);--warning-bg:hsl(64, 100%, 6%);--warning-border:hsl(60, 100%, 9%);--warning-text:hsl(46, 87%, 65%);--error-bg:hsl(358, 76%, 10%);--error-border:hsl(357, 89%, 16%);--error-text:hsl(358, 100%, 81%)}[data-sonner-toaster][data-sonner-theme=dark] [data-sonner-toast] [data-close-button]{background:var(--normal-bg);border-color:var(--normal-border);color:var(--normal-text)}[data-sonner-toaster][data-sonner-theme=dark] [data-sonner-toast] [data-close-button]:hover{background:var(--normal-bg-hover);border-color:var(--normal-border-hover)}[data-rich-colors=true][data-sonner-toast][data-type=success]{background:var(--success-bg);border-color:var(--success-border);color:var(--success-text)}[data-rich-colors=true][data-sonner-toast][data-type=success] [data-close-button]{background:var(--success-bg);border-color:var(--success-border);color:var(--success-text)}[data-rich-colors=true][data-sonner-toast][data-type=info]{background:var(--info-bg);border-color:var(--info-border);color:var(--info-text)}[data-rich-colors=true][data-sonner-toast][data-type=info] [data-close-button]{background:var(--info-bg);border-color:var(--info-border);color:var(--info-text)}[data-rich-colors=true][data-sonner-toast][data-type=warning]{background:var(--warning-bg);border-color:var(--warning-border);color:var(--warning-text)}[data-rich-colors=true][data-sonner-toast][data-type=warning] [data-close-button]{background:var(--warning-bg);border-color:var(--warning-border);color:var(--warning-text)}[data-rich-colors=true][data-sonner-toast][data-type=error]{background:var(--error-bg);border-color:var(--error-border);color:var(--error-text)}[data-rich-colors=true][data-sonner-toast][data-type=error] [data-close-button]{background:var(--error-bg);border-color:var(--error-border);color:var(--error-text)}.sonner-loading-wrapper{--size:16px;height:var(--size);width:var(--size);position:absolute;inset:0;z-index:10}.sonner-loading-wrapper[data-visible=false]{transform-origin:center;animation:sonner-fade-out .2s ease forwards}.sonner-spinner{position:relative;top:50%;left:50%;height:var(--size);width:var(--size)}.sonner-loading-bar{animation:sonner-spin 1.2s linear infinite;background:var(--gray11);border-radius:6px;height:8%;left:-10%;position:absolute;top:-3.9%;width:24%}.sonner-loading-bar:first-child{animation-delay:-1.2s;transform:rotate(.0001deg) translate(146%)}.sonner-loading-bar:nth-child(2){animation-delay:-1.1s;transform:rotate(30deg) translate(146%)}.sonner-loading-bar:nth-child(3){animation-delay:-1s;transform:rotate(60deg) translate(146%)}.sonner-loading-bar:nth-child(4){animation-delay:-.9s;transform:rotate(90deg) translate(146%)}.sonner-loading-bar:nth-child(5){animation-delay:-.8s;transform:rotate(120deg) translate(146%)}.sonner-loading-bar:nth-child(6){animation-delay:-.7s;transform:rotate(150deg) translate(146%)}.sonner-loading-bar:nth-child(7){animation-delay:-.6s;transform:rotate(180deg) translate(146%)}.sonner-loading-bar:nth-child(8){animation-delay:-.5s;transform:rotate(210deg) translate(146%)}.sonner-loading-bar:nth-child(9){animation-delay:-.4s;transform:rotate(240deg) translate(146%)}.sonner-loading-bar:nth-child(10){animation-delay:-.3s;transform:rotate(270deg) translate(146%)}.sonner-loading-bar:nth-child(11){animation-delay:-.2s;transform:rotate(300deg) translate(146%)}.sonner-loading-bar:nth-child(12){animation-delay:-.1s;transform:rotate(330deg) translate(146%)}@keyframes sonner-fade-in{0%{opacity:0;transform:scale(.8)}100%{opacity:1;transform:scale(1)}}@keyframes sonner-fade-out{0%{opacity:1;transform:scale(1)}100%{opacity:0;transform:scale(.8)}}@keyframes sonner-spin{0%{opacity:1}100%{opacity:.15}}@media (prefers-reduced-motion){.sonner-loading-bar,[data-sonner-toast],[data-sonner-toast]>*{transition:none!important;animation:none!important}}.sonner-loader{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);transform-origin:center;transition:opacity .2s,transform .2s}.sonner-loader[data-visible=false]{opacity:0;transform:scale(.8) translate(-50%,-50%)}");
function Cn(e) {
  return e.label !== void 0;
}
const Bc = 3, Vc = "24px", jc = "16px", hs = 4e3, Hc = 356, Wc = 14, Uc = 45, Gc = 200;
function He(...e) {
  return e.filter(Boolean).join(" ");
}
function Kc(e) {
  const [n, r] = e.split("-"), o = [];
  return n && o.push(n), r && o.push(r), o;
}
const Yc = (e) => {
  var n, r, o, s, a, i, l, u, d;
  const { invert: p, toast: c, unstyled: h, interacting: g, setHeights: y, visibleToasts: b, heights: v, index: x, toasts: S, expanded: w, removeToast: C, defaultRichColors: N, closeButton: R, style: E, cancelButtonStyle: k, actionButtonStyle: T, className: I = "", descriptionClassName: L = "", duration: A, position: _, gap: M, expandByDefault: U, classNames: $, icons: B, closeButtonAriaLabel: W = "Close toast" } = e, [z, F] = P.useState(null), [le, ee] = P.useState(null), [ae, q] = P.useState(!1), [Y, G] = P.useState(!1), [ie, K] = P.useState(!1), [V, de] = P.useState(!1), [ne, re] = P.useState(!1), [se, pe] = P.useState(0), [Ee, Dt] = P.useState(0), Je = P.useRef(c.duration || A || hs), Mt = P.useRef(null), et = P.useRef(null), ic = x === 0, lc = x + 1 <= b, Se = c.type, rs = Se ?? "default", Lt = c.dismissible !== !1, cc = c.className || "", dc = c.descriptionClassName || "", wn = P.useMemo(() => v.findIndex((Z) => Z.toastId === c.id) || 0, [
    v,
    c.id
  ]), uc = P.useMemo(() => {
    var Z;
    return (Z = c.closeButton) != null ? Z : R;
  }, [
    c.closeButton,
    R
  ]), os = P.useMemo(() => c.duration || A || hs, [
    c.duration,
    A
  ]), fr = P.useRef(0), Ft = P.useRef(0), ss = P.useRef(0), $t = P.useRef(null), [fc, mc] = _.split("-"), as = P.useMemo(() => v.reduce((Z, he, we) => we >= wn ? Z : Z + he.height, 0), [
    v,
    wn
  ]), is = Ic(), Be = P.useMemo(() => {
    var Z;
    return (Z = e.swipeDirections) != null ? Z : Kc(_);
  }, [
    e.swipeDirections,
    _
  ]), pc = c.invert || p, mr = Se === "loading";
  Ft.current = P.useMemo(() => wn * M + as, [
    wn,
    as
  ]), P.useEffect(() => {
    Je.current = os;
  }, [
    os
  ]), P.useEffect(() => {
    q(!0);
  }, []), P.useEffect(() => {
    const Z = et.current;
    if (Z) {
      const he = Z.getBoundingClientRect().height;
      return Dt(he), y((we) => [
        {
          toastId: c.id,
          height: he,
          position: c.position
        },
        ...we
      ]), () => y((we) => we.filter((Ne) => Ne.toastId !== c.id));
    }
  }, [
    y,
    c.id
  ]), P.useLayoutEffect(() => {
    if (!ae) return;
    const Z = et.current, he = Z.style.height;
    Z.style.height = "auto";
    const we = Z.getBoundingClientRect().height;
    Z.style.height = he, Dt(we), y((Ne) => Ne.find((be) => be.toastId === c.id) ? Ne.map((be) => be.toastId === c.id ? {
      ...be,
      height: we
    } : be) : [
      {
        toastId: c.id,
        height: we,
        position: c.position
      },
      ...Ne
    ]);
  }, [
    ae,
    c.title,
    c.description,
    y,
    c.id,
    c.jsx,
    c.action,
    c.cancel
  ]);
  const ft = P.useCallback(() => {
    G(!0), pe(Ft.current), y((Z) => Z.filter((he) => he.toastId !== c.id)), setTimeout(() => {
      C(c);
    }, Gc);
  }, [
    c,
    C,
    y,
    Ft
  ]);
  P.useEffect(() => {
    if (c.promise && Se === "loading" || c.duration === 1 / 0 || c.type === "loading") return;
    let Z;
    return w || g || is ? (() => {
      if (ss.current < fr.current) {
        const Ne = (/* @__PURE__ */ new Date()).getTime() - fr.current;
        Je.current = Je.current - Ne;
      }
      ss.current = (/* @__PURE__ */ new Date()).getTime();
    })() : Je.current !== 1 / 0 && (fr.current = (/* @__PURE__ */ new Date()).getTime(), Z = setTimeout(() => {
      c.onAutoClose == null || c.onAutoClose.call(c, c), ft();
    }, Je.current)), () => clearTimeout(Z);
  }, [
    w,
    g,
    c,
    Se,
    is,
    ft
  ]), P.useEffect(() => {
    c.delete && (ft(), c.onDismiss == null || c.onDismiss.call(c, c));
  }, [
    ft,
    c.delete
  ]);
  function ls() {
    var Z;
    if (B?.loading) {
      var he;
      return /* @__PURE__ */ P.createElement("div", {
        className: He($?.loader, c == null || (he = c.classNames) == null ? void 0 : he.loader, "sonner-loader"),
        "data-visible": Se === "loading"
      }, B.loading);
    }
    return /* @__PURE__ */ P.createElement(Ec, {
      className: He($?.loader, c == null || (Z = c.classNames) == null ? void 0 : Z.loader),
      visible: Se === "loading"
    });
  }
  const hc = c.icon || B?.[Se] || Sc(Se);
  var cs, ds;
  return /* @__PURE__ */ P.createElement("li", {
    tabIndex: 0,
    ref: et,
    className: He(I, cc, $?.toast, c == null || (n = c.classNames) == null ? void 0 : n.toast, $?.[rs], c == null || (r = c.classNames) == null ? void 0 : r[rs]),
    "data-sonner-toast": "",
    "data-rich-colors": (cs = c.richColors) != null ? cs : N,
    "data-styled": !(c.jsx || c.unstyled || h),
    "data-mounted": ae,
    "data-promise": !!c.promise,
    "data-swiped": ne,
    "data-removed": Y,
    "data-visible": lc,
    "data-y-position": fc,
    "data-x-position": mc,
    "data-index": x,
    "data-front": ic,
    "data-swiping": ie,
    "data-dismissible": Lt,
    "data-type": Se,
    "data-invert": pc,
    "data-swipe-out": V,
    "data-swipe-direction": le,
    "data-expanded": !!(w || U && ae),
    "data-testid": c.testId,
    style: {
      "--index": x,
      "--toasts-before": x,
      "--z-index": S.length - x,
      "--offset": `${Y ? se : Ft.current}px`,
      "--initial-height": U ? "auto" : `${Ee}px`,
      ...E,
      ...c.style
    },
    onDragEnd: () => {
      K(!1), F(null), $t.current = null;
    },
    onPointerDown: (Z) => {
      Z.button !== 2 && (mr || !Lt || (Mt.current = /* @__PURE__ */ new Date(), pe(Ft.current), Z.target.setPointerCapture(Z.pointerId), Z.target.tagName !== "BUTTON" && (K(!0), $t.current = {
        x: Z.clientX,
        y: Z.clientY
      })));
    },
    onPointerUp: () => {
      var Z, he, we;
      if (V || !Lt) return;
      $t.current = null;
      const Ne = Number(((Z = et.current) == null ? void 0 : Z.style.getPropertyValue("--swipe-amount-x").replace("px", "")) || 0), rn = Number(((he = et.current) == null ? void 0 : he.style.getPropertyValue("--swipe-amount-y").replace("px", "")) || 0), be = (/* @__PURE__ */ new Date()).getTime() - ((we = Mt.current) == null ? void 0 : we.getTime()), Ae = z === "x" ? Ne : rn, Ve = Math.abs(Ae) / be;
      if ((z === "x" ? Be.includes(Ne > 0 ? "right" : "left") : Be.includes(rn > 0 ? "bottom" : "top")) && (Math.abs(Ae) >= Uc || Ve > 0.11)) {
        pe(Ft.current), c.onDismiss == null || c.onDismiss.call(c, c), ee(z === "x" ? Ne > 0 ? "right" : "left" : rn > 0 ? "down" : "up"), ft(), de(!0);
        return;
      } else {
        var je, hr;
        (je = et.current) == null || je.style.setProperty("--swipe-amount-x", "0px"), (hr = et.current) == null || hr.style.setProperty("--swipe-amount-y", "0px");
      }
      re(!1), K(!1), F(null);
    },
    onPointerMove: (Z) => {
      var he, we, Ne;
      if (!$t.current || !Lt || ((he = window.getSelection()) == null ? void 0 : he.toString().length) > 0) return;
      const be = Z.clientY - $t.current.y, Ae = Z.clientX - $t.current.x;
      !z && (Math.abs(Ae) > 1 || Math.abs(be) > 1) && F(Math.abs(Ae) > Math.abs(be) ? "x" : "y");
      let Ve = {
        x: 0,
        y: 0
      };
      const pr = (je) => 1 / (1.5 + Math.abs(je) / 20);
      if (z === "y") {
        if (Be.includes("top") || Be.includes("bottom"))
          if (Be.includes("top") && be < 0 || Be.includes("bottom") && be > 0)
            Ve.y = be;
          else {
            const je = be * pr(be);
            Ve.y = Math.abs(je) < Math.abs(be) ? je : be;
          }
      } else if (z === "x" && (Be.includes("left") || Be.includes("right")))
        if (Be.includes("left") && Ae < 0 || Be.includes("right") && Ae > 0)
          Ve.x = Ae;
        else {
          const je = Ae * pr(Ae);
          Ve.x = Math.abs(je) < Math.abs(Ae) ? je : Ae;
        }
      (Math.abs(Ve.x) > 0 || Math.abs(Ve.y) > 0) && re(!0), (we = et.current) == null || we.style.setProperty("--swipe-amount-x", `${Ve.x}px`), (Ne = et.current) == null || Ne.style.setProperty("--swipe-amount-y", `${Ve.y}px`);
    }
  }, uc && !c.jsx && Se !== "loading" ? /* @__PURE__ */ P.createElement("button", {
    "aria-label": W,
    "data-disabled": mr,
    "data-close-button": !0,
    onClick: mr || !Lt ? () => {
    } : () => {
      ft(), c.onDismiss == null || c.onDismiss.call(c, c);
    },
    className: He($?.closeButton, c == null || (o = c.classNames) == null ? void 0 : o.closeButton)
  }, (ds = B?.close) != null ? ds : _c) : null, (Se || c.icon || c.promise) && c.icon !== null && (B?.[Se] !== null || c.icon) ? /* @__PURE__ */ P.createElement("div", {
    "data-icon": "",
    className: He($?.icon, c == null || (s = c.classNames) == null ? void 0 : s.icon)
  }, Se === "loading" ? c.icon || ls() : c.promise ? ls() : null, Se !== "loading" ? hc : null) : null, /* @__PURE__ */ P.createElement("div", {
    "data-content": "",
    className: He($?.content, c == null || (a = c.classNames) == null ? void 0 : a.content)
  }, /* @__PURE__ */ P.createElement("div", {
    "data-title": "",
    className: He($?.title, c == null || (i = c.classNames) == null ? void 0 : i.title)
  }, c.jsx ? c.jsx : typeof c.title == "function" ? c.title() : c.title), c.description ? /* @__PURE__ */ P.createElement("div", {
    "data-description": "",
    className: He(L, dc, $?.description, c == null || (l = c.classNames) == null ? void 0 : l.description)
  }, typeof c.description == "function" ? c.description() : c.description) : null), /* @__PURE__ */ P.isValidElement(c.cancel) ? c.cancel : c.cancel && Cn(c.cancel) ? /* @__PURE__ */ P.createElement("button", {
    "data-button": !0,
    "data-cancel": !0,
    style: c.cancelButtonStyle || k,
    onClick: (Z) => {
      Cn(c.cancel) && Lt && (c.cancel.onClick == null || c.cancel.onClick.call(c.cancel, Z), ft());
    },
    className: He($?.cancelButton, c == null || (u = c.classNames) == null ? void 0 : u.cancelButton)
  }, c.cancel.label) : null, /* @__PURE__ */ P.isValidElement(c.action) ? c.action : c.action && Cn(c.action) ? /* @__PURE__ */ P.createElement("button", {
    "data-button": !0,
    "data-action": !0,
    style: c.actionButtonStyle || T,
    onClick: (Z) => {
      Cn(c.action) && (c.action.onClick == null || c.action.onClick.call(c.action, Z), !Z.defaultPrevented && ft());
    },
    className: He($?.actionButton, c == null || (d = c.classNames) == null ? void 0 : d.actionButton)
  }, c.action.label) : null);
};
function gs() {
  if (typeof window > "u" || typeof document > "u") return "ltr";
  const e = document.documentElement.getAttribute("dir");
  return e === "auto" || !e ? window.getComputedStyle(document.documentElement).direction : e;
}
function Xc(e, n) {
  const r = {};
  return [
    e,
    n
  ].forEach((o, s) => {
    const a = s === 1, i = a ? "--mobile-offset" : "--offset", l = a ? jc : Vc;
    function u(d) {
      [
        "top",
        "right",
        "bottom",
        "left"
      ].forEach((p) => {
        r[`${i}-${p}`] = typeof d == "number" ? `${d}px` : d;
      });
    }
    typeof o == "number" || typeof o == "string" ? u(o) : typeof o == "object" ? [
      "top",
      "right",
      "bottom",
      "left"
    ].forEach((d) => {
      o[d] === void 0 ? r[`${i}-${d}`] = l : r[`${i}-${d}`] = typeof o[d] == "number" ? `${o[d]}px` : o[d];
    }) : u(l);
  }), r;
}
const Wb = /* @__PURE__ */ P.forwardRef(function(n, r) {
  const { id: o, invert: s, position: a = "bottom-right", hotkey: i = [
    "altKey",
    "KeyT"
  ], expand: l, closeButton: u, className: d, offset: p, mobileOffset: c, theme: h = "light", richColors: g, duration: y, style: b, visibleToasts: v = Bc, toastOptions: x, dir: S = gs(), gap: w = Wc, icons: C, customAriaLabel: N, containerAriaLabel: R = "Notifications" } = n, [E, k] = P.useState([]), T = P.useMemo(() => o ? E.filter((q) => q.toasterId === o) : E.filter((q) => !q.toasterId), [
    E,
    o
  ]), I = P.useMemo(() => Array.from(new Set([
    a
  ].concat(T.filter((q) => q.position).map((q) => q.position)))), [
    T,
    a
  ]), [L, A] = P.useState([]), [_, M] = P.useState(!1), [U, $] = P.useState(!1), [B, W] = P.useState(h !== "system" ? h : typeof window < "u" && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"), z = P.useRef(null), F = i.join("+").replace(/Key/g, "").replace(/Digit/g, ""), le = P.useRef(null), ee = P.useRef(!1), ae = P.useCallback((q) => {
    k((Y) => {
      var G;
      return (G = Y.find((ie) => ie.id === q.id)) != null && G.delete || Pe.dismiss(q.id), Y.filter(({ id: ie }) => ie !== q.id);
    });
  }, []);
  return P.useEffect(() => Pe.subscribe((q) => {
    if (q.dismiss) {
      requestAnimationFrame(() => {
        k((Y) => Y.map((G) => G.id === q.id ? {
          ...G,
          delete: !0
        } : G));
      });
      return;
    }
    setTimeout(() => {
      bc.flushSync(() => {
        k((Y) => {
          const G = Y.findIndex((ie) => ie.id === q.id);
          return G !== -1 ? [
            ...Y.slice(0, G),
            {
              ...Y[G],
              ...q
            },
            ...Y.slice(G + 1)
          ] : [
            q,
            ...Y
          ];
        });
      });
    });
  }), []), P.useEffect(() => {
    if (h !== "system") {
      W(h);
      return;
    }
    if (h === "system" && (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? W("dark") : W("light")), typeof window > "u") return;
    const q = window.matchMedia("(prefers-color-scheme: dark)");
    try {
      q.addEventListener("change", ({ matches: Y }) => {
        W(Y ? "dark" : "light");
      });
    } catch {
      q.addListener(({ matches: G }) => {
        try {
          W(G ? "dark" : "light");
        } catch (ie) {
          console.error(ie);
        }
      });
    }
  }, [
    h
  ]), P.useEffect(() => {
    E.length <= 1 && M(!1);
  }, [
    E
  ]), P.useEffect(() => {
    const q = (Y) => {
      var G;
      if (i.length > 0 && i.every((V) => Y[V] || Y.code === V)) {
        var K;
        M(!0), (K = z.current) == null || K.focus();
      }
      Y.code === "Escape" && (document.activeElement === z.current || (G = z.current) != null && G.contains(document.activeElement)) && M(!1);
    };
    return document.addEventListener("keydown", q), () => document.removeEventListener("keydown", q);
  }, [
    i
  ]), P.useEffect(() => {
    if (z.current)
      return () => {
        le.current && (le.current.focus({
          preventScroll: !0
        }), le.current = null, ee.current = !1);
      };
  }, [
    z.current
  ]), // Remove item from normal navigation flow, only available via hotkey
  /* @__PURE__ */ P.createElement("section", {
    ref: r,
    "aria-label": N ?? `${R} ${F}`,
    tabIndex: -1,
    "aria-live": "polite",
    "aria-relevant": "additions text",
    "aria-atomic": "false",
    suppressHydrationWarning: !0,
    "data-react-aria-top-layer": !0
  }, I.map((q, Y) => {
    var G;
    const [ie, K] = q.split("-");
    return T.length ? /* @__PURE__ */ P.createElement("ol", {
      key: q,
      dir: S === "auto" ? gs() : S,
      tabIndex: -1,
      ref: z,
      className: d,
      "data-sonner-toaster": !0,
      "data-sonner-theme": B,
      "data-y-position": ie,
      "data-x-position": K,
      style: {
        "--front-toast-height": `${((G = L[0]) == null ? void 0 : G.height) || 0}px`,
        "--width": `${Hc}px`,
        "--gap": `${w}px`,
        ...b,
        ...Xc(p, c)
      },
      onBlur: (V) => {
        ee.current && !V.currentTarget.contains(V.relatedTarget) && (ee.current = !1, le.current && (le.current.focus({
          preventScroll: !0
        }), le.current = null));
      },
      onFocus: (V) => {
        V.target instanceof HTMLElement && V.target.dataset.dismissible === "false" || ee.current || (ee.current = !0, le.current = V.relatedTarget);
      },
      onMouseEnter: () => M(!0),
      onMouseMove: () => M(!0),
      onMouseLeave: () => {
        U || M(!1);
      },
      onDragEnd: () => M(!1),
      onPointerDown: (V) => {
        V.target instanceof HTMLElement && V.target.dataset.dismissible === "false" || $(!0);
      },
      onPointerUp: () => $(!1)
    }, T.filter((V) => !V.position && Y === 0 || V.position === q).map((V, de) => {
      var ne, re;
      return /* @__PURE__ */ P.createElement(Yc, {
        key: V.id,
        icons: C,
        index: de,
        toast: V,
        defaultRichColors: g,
        duration: (ne = x?.duration) != null ? ne : y,
        className: x?.className,
        descriptionClassName: x?.descriptionClassName,
        invert: s,
        visibleToasts: v,
        closeButton: (re = x?.closeButton) != null ? re : u,
        interacting: U,
        position: q,
        style: x?.style,
        unstyled: x?.unstyled,
        classNames: x?.classNames,
        cancelButtonStyle: x?.cancelButtonStyle,
        actionButtonStyle: x?.actionButtonStyle,
        closeButtonAriaLabel: x?.closeButtonAriaLabel,
        removeToast: ae,
        toasts: T.filter((se) => se.position == V.position),
        heights: L.filter((se) => se.position == V.position),
        setHeights: A,
        expandByDefault: l,
        gap: w,
        expanded: _,
        swipeDirections: n.swipeDirections
      });
    })) : null;
  }));
});
var qc = Object.defineProperty, oo = (e, n) => qc(e, "name", { value: n, configurable: !0 });
function Ar(e, n) {
  if (typeof e == "function")
    return e(n);
  e != null && (e.current = n);
}
oo(Ar, "setRef");
function pa(...e) {
  return (n) => {
    let r = !1;
    const o = e.map((s) => {
      const a = Ar(s, n);
      return !r && typeof a == "function" && (r = !0), a;
    });
    if (r)
      return () => {
        for (let s = 0; s < o.length; s++) {
          const a = o[s];
          typeof a == "function" ? a() : Ar(e[s], null);
        }
      };
  };
}
oo(pa, "composeRefs");
function oe(...e) {
  return f.useCallback(pa(...e), e);
}
oo(oe, "useComposedRefs");
var Zc = Object.defineProperty, $e = (e, n) => Zc(e, "name", { value: n, configurable: !0 });
// @__NO_SIDE_EFFECTS__
function Ye(e) {
  const n = f.forwardRef((r, o) => {
    let { children: s, ...a } = r, i = null, l = !1;
    const u = [];
    Dr(s) && typeof Sn == "function" && (s = Sn(s._payload)), f.Children.forEach(s, (h) => {
      if (xa(h)) {
        l = !0;
        const g = h;
        let y = "child" in g.props ? g.props.child : g.props.children;
        Dr(y) && typeof Sn == "function" && (y = Sn(y._payload)), i = Qc(g, y), u.push(i?.props?.children);
      } else
        u.push(h);
    }), i ? i = f.cloneElement(i, void 0, u) : (
      // A `Slottable` was found but it didn't resolve to a single element (e.g.
      // it wrapped multiple elements, text, or a render-prop `child` that
      // wasn't an element). Don't fall back to treating the `Slottable` wrapper
      // itself as the slot target — throw a descriptive error below instead.
      !l && f.Children.count(s) === 1 && f.isValidElement(s) && (i = s)
    );
    const d = i ? ya(i) : void 0, p = oe(o, d);
    if (!i) {
      if (s || s === 0)
        throw new Error(
          l ? td(e) : ed(e)
        );
      return s;
    }
    const c = ba(a, i.props ?? {});
    return i.type !== f.Fragment && (c.ref = o ? p : d), f.cloneElement(i, c);
  });
  return n.displayName = `${e}.Slot`, n;
}
$e(Ye, "createSlot");
var ha = /* @__PURE__ */ Ye("Slot"), ga = /* @__PURE__ */ Symbol.for("radix.slottable");
// @__NO_SIDE_EFFECTS__
function va(e) {
  const n = /* @__PURE__ */ $e((r) => "child" in r ? r.children(r.child) : r.children, "Slottable");
  return n.displayName = `${e}.Slottable`, n.__radixId = ga, n;
}
$e(va, "createSlottable");
var Qc = /* @__PURE__ */ $e((e, n) => {
  if ("child" in e.props) {
    const r = e.props.child;
    return f.isValidElement(r) ? f.cloneElement(r, void 0, e.props.children(r.props.children)) : null;
  }
  return f.isValidElement(n) ? n : null;
}, "getSlottableElementFromSlottable");
function ba(e, n) {
  const r = { ...n };
  for (const o in n) {
    const s = e[o], a = n[o];
    /^on[A-Z]/.test(o) ? s && a ? r[o] = (...l) => {
      const u = a(...l);
      return s(...l), u;
    } : s && (r[o] = s) : o === "style" ? r[o] = { ...s, ...a } : o === "className" && (r[o] = [s, a].filter(Boolean).join(" "));
  }
  return { ...e, ...r };
}
$e(ba, "mergeProps");
function ya(e) {
  let n = Object.getOwnPropertyDescriptor(e.props, "ref")?.get, r = n && "isReactWarning" in n && n.isReactWarning;
  return r ? e.ref : (n = Object.getOwnPropertyDescriptor(e, "ref")?.get, r = n && "isReactWarning" in n && n.isReactWarning, r ? e.props.ref : e.props.ref || e.ref);
}
$e(ya, "getElementRef");
function xa(e) {
  return f.isValidElement(e) && typeof e.type == "function" && "__radixId" in e.type && e.type.__radixId === ga;
}
$e(xa, "isSlottable");
var Jc = /* @__PURE__ */ Symbol.for("react.lazy");
function Dr(e) {
  return e != null && typeof e == "object" && "$$typeof" in e && e.$$typeof === Jc && "_payload" in e && wa(e._payload);
}
$e(Dr, "isLazyComponent");
function wa(e) {
  return typeof e == "object" && e !== null && "then" in e;
}
$e(wa, "isPromiseLike");
var ed = /* @__PURE__ */ $e((e) => `${e} failed to slot onto its children. Expected a single React element child or \`Slottable\`.`, "createSlotError"), td = /* @__PURE__ */ $e((e) => `${e} failed to slot onto its \`Slottable\`. Expected \`Slottable\` to receive a single React element child.`, "createSlottableError"), Sn = f[" use ".trim().toString()];
function Ca(e) {
  var n, r, o = "";
  if (typeof e == "string" || typeof e == "number") o += e;
  else if (typeof e == "object") if (Array.isArray(e)) {
    var s = e.length;
    for (n = 0; n < s; n++) e[n] && (r = Ca(e[n])) && (o && (o += " "), o += r);
  } else for (r in e) e[r] && (o && (o += " "), o += r);
  return o;
}
function Sa() {
  for (var e, n, r = 0, o = "", s = arguments.length; r < s; r++) (e = arguments[r]) && (n = Ca(e)) && (o && (o += " "), o += n);
  return o;
}
const vs = (e) => typeof e == "boolean" ? `${e}` : e === 0 ? "0" : e, bs = Sa, Yt = (e, n) => (r) => {
  var o;
  if (n?.variants == null) return bs(e, r?.class, r?.className);
  const { variants: s, defaultVariants: a } = n, i = Object.keys(s).map((d) => {
    const p = r?.[d], c = a?.[d];
    if (p === null) return null;
    const h = vs(p) || vs(c);
    return s[d][h];
  }), l = r && Object.entries(r).reduce((d, p) => {
    let [c, h] = p;
    return h === void 0 || (d[c] = h), d;
  }, {}), u = n == null || (o = n.compoundVariants) === null || o === void 0 ? void 0 : o.reduce((d, p) => {
    let { class: c, className: h, ...g } = p;
    return Object.entries(g).every((y) => {
      let [b, v] = y;
      return Array.isArray(v) ? v.includes({
        ...a,
        ...l
      }[b]) : {
        ...a,
        ...l
      }[b] === v;
    }) ? [
      ...d,
      c,
      h
    ] : d;
  }, []);
  return bs(e, i, u, r?.class, r?.className);
};
const nd = (e) => e.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase(), rd = (e) => e.replace(
  /^([A-Z])|[\s-_]+(\w)/g,
  (n, r, o) => o ? o.toUpperCase() : r.toLowerCase()
), ys = (e) => {
  const n = rd(e);
  return n.charAt(0).toUpperCase() + n.slice(1);
}, ka = (...e) => e.filter((n, r, o) => !!n && n.trim() !== "" && o.indexOf(n) === r).join(" ").trim(), od = (e) => {
  for (const n in e)
    if (n.startsWith("aria-") || n === "role" || n === "title")
      return !0;
};
var sd = {
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
const ad = da(
  ({
    color: e = "currentColor",
    size: n = 24,
    strokeWidth: r = 2,
    absoluteStrokeWidth: o,
    className: s = "",
    children: a,
    iconNode: i,
    ...l
  }, u) => Or(
    "svg",
    {
      ref: u,
      ...sd,
      width: n,
      height: n,
      stroke: e,
      strokeWidth: o ? Number(r) * 24 / Number(n) : r,
      className: ka("lucide", s),
      ...!a && !od(l) && { "aria-hidden": "true" },
      ...l
    },
    [
      ...i.map(([d, p]) => Or(d, p)),
      ...Array.isArray(a) ? a : [a]
    ]
  )
);
const ce = (e, n) => {
  const r = da(
    ({ className: o, ...s }, a) => Or(ad, {
      ref: a,
      iconNode: n,
      className: ka(
        `lucide-${nd(ys(e))}`,
        `lucide-${e}`,
        o
      ),
      ...s
    })
  );
  return r.displayName = ys(e), r;
};
const id = [
  ["path", { d: "m12 19-7-7 7-7", key: "1l729n" }],
  ["path", { d: "M19 12H5", key: "x3x0zl" }]
], Ea = ce("arrow-left", id);
const ld = [
  ["path", { d: "M5 12h14", key: "1ays0h" }],
  ["path", { d: "m12 5 7 7-7 7", key: "xquz4c" }]
], cd = ce("arrow-right", ld);
const dd = [
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
], ud = ce("calculator", dd);
const fd = [["path", { d: "M20 6 9 17l-5-5", key: "1gmf2c" }]], Vn = ce("check", fd);
const md = [["path", { d: "m6 9 6 6 6-6", key: "qrunsl" }]], Xn = ce("chevron-down", md);
const pd = [["path", { d: "m15 18-6-6 6-6", key: "1wnfg3" }]], Mr = ce("chevron-left", pd);
const hd = [["path", { d: "m9 18 6-6-6-6", key: "mthhwq" }]], Lr = ce("chevron-right", hd);
const gd = [["path", { d: "m18 15-6-6-6 6", key: "153udz" }]], vd = ce("chevron-up", gd);
const bd = [
  ["circle", { cx: "12", cy: "12", r: "10", key: "1mglay" }],
  ["line", { x1: "12", x2: "12", y1: "8", y2: "12", key: "1pkeuh" }],
  ["line", { x1: "12", x2: "12.01", y1: "16", y2: "16", key: "4dfq90" }]
], Na = ce("circle-alert", bd);
const yd = [
  ["path", { d: "M21.801 10A10 10 0 1 1 17 3.335", key: "yps3ct" }],
  ["path", { d: "m9 11 3 3L22 4", key: "1pflzl" }]
], xd = ce("circle-check-big", yd);
const wd = [
  ["circle", { cx: "12", cy: "12", r: "10", key: "1mglay" }],
  ["path", { d: "m9 12 2 2 4-4", key: "dzmm74" }]
], Cd = ce("circle-check", wd);
const Sd = [["circle", { cx: "12", cy: "12", r: "10", key: "1mglay" }]], kd = ce("circle", Sd);
const Ed = [
  ["rect", { width: "14", height: "14", x: "8", y: "8", rx: "2", ry: "2", key: "17jyea" }],
  ["path", { d: "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2", key: "zix9uf" }]
], Nd = ce("copy", Ed);
const Rd = [
  ["circle", { cx: "12", cy: "12", r: "10", key: "1mglay" }],
  ["path", { d: "M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20", key: "13o1zl" }],
  ["path", { d: "M2 12h20", key: "9i4pu4" }]
], Pd = ce("globe", Rd);
const Td = [
  ["circle", { cx: "12", cy: "12", r: "10", key: "1mglay" }],
  ["path", { d: "M12 16v-4", key: "1dtifu" }],
  ["path", { d: "M12 8h.01", key: "e9boi3" }]
], _d = ce("info", Td);
const Id = [["path", { d: "M21 12a9 9 0 1 1-6.219-8.56", key: "13zald" }]], Od = ce("loader-circle", Id);
const Ad = [
  [
    "path",
    {
      d: "M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719",
      key: "1sd12s"
    }
  ]
], Dd = ce("message-circle", Ad);
const Md = [["path", { d: "M5 12h14", key: "1ays0h" }]], Ld = ce("minus", Md);
const Fd = [
  [
    "path",
    {
      d: "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z",
      key: "1a8usu"
    }
  ],
  ["path", { d: "m15 5 4 4", key: "1mk7zo" }]
], $d = ce("pencil", Fd);
const zd = [
  ["path", { d: "M5 12h14", key: "1ays0h" }],
  ["path", { d: "M12 5v14", key: "s699le" }]
], Ra = ce("plus", zd);
const Bd = [
  ["path", { d: "M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8", key: "14sxne" }],
  ["path", { d: "M3 3v5h5", key: "1xhq8a" }],
  ["path", { d: "M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16", key: "1hlbsb" }],
  ["path", { d: "M16 16h5v5", key: "ccwih5" }]
], Vd = ce("refresh-ccw", Bd);
const jd = [
  [
    "path",
    {
      d: "M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z",
      key: "1c8476"
    }
  ],
  ["path", { d: "M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7", key: "1ydtos" }],
  ["path", { d: "M7 3v4a1 1 0 0 0 1 1h7", key: "t51u73" }]
], Hd = ce("save", jd);
const Wd = [
  ["path", { d: "m21 21-4.34-4.34", key: "14j7rj" }],
  ["circle", { cx: "11", cy: "11", r: "8", key: "4ej97u" }]
], Ud = ce("search", Wd);
const Gd = [
  ["path", { d: "M10 11v6", key: "nco0om" }],
  ["path", { d: "M14 11v6", key: "outv1u" }],
  ["path", { d: "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6", key: "miytrc" }],
  ["path", { d: "M3 6h18", key: "d0wm0j" }],
  ["path", { d: "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2", key: "e791ji" }]
], Kd = ce("trash-2", Gd);
const Yd = [
  [
    "path",
    {
      d: "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3",
      key: "wmoenq"
    }
  ],
  ["path", { d: "M12 9v4", key: "juzpu7" }],
  ["path", { d: "M12 17h.01", key: "p32p05" }]
], Xd = ce("triangle-alert", Yd);
const qd = [
  ["path", { d: "M18 6 6 18", key: "1bl5f8" }],
  ["path", { d: "m6 6 12 12", key: "d8bk6v" }]
], Xt = ce("x", qd), Zd = (e, n) => {
  const r = new Array(e.length + n.length);
  for (let o = 0; o < e.length; o++)
    r[o] = e[o];
  for (let o = 0; o < n.length; o++)
    r[e.length + o] = n[o];
  return r;
}, Qd = (e, n) => ({
  classGroupId: e,
  validator: n
}), Pa = (e = /* @__PURE__ */ new Map(), n = null, r) => ({
  nextPart: e,
  validators: n,
  classGroupId: r
}), jn = "-", xs = [], Jd = "arbitrary..", eu = (e) => {
  const n = nu(e), {
    conflictingClassGroups: r,
    conflictingClassGroupModifiers: o
  } = e;
  return {
    getClassGroupId: (i) => {
      if (i.startsWith("[") && i.endsWith("]"))
        return tu(i);
      const l = i.split(jn), u = l[0] === "" && l.length > 1 ? 1 : 0;
      return Ta(l, u, n);
    },
    getConflictingClassGroupIds: (i, l) => {
      if (l) {
        const u = o[i], d = r[i];
        return u ? d ? Zd(d, u) : u : d || xs;
      }
      return r[i] || xs;
    }
  };
}, Ta = (e, n, r) => {
  if (e.length - n === 0)
    return r.classGroupId;
  const s = e[n], a = r.nextPart.get(s);
  if (a) {
    const d = Ta(e, n + 1, a);
    if (d) return d;
  }
  const i = r.validators;
  if (i === null)
    return;
  const l = n === 0 ? e.join(jn) : e.slice(n).join(jn), u = i.length;
  for (let d = 0; d < u; d++) {
    const p = i[d];
    if (p.validator(l))
      return p.classGroupId;
  }
}, tu = (e) => e.slice(1, -1).indexOf(":") === -1 ? void 0 : (() => {
  const n = e.slice(1, -1), r = n.indexOf(":"), o = n.slice(0, r);
  return o ? Jd + o : void 0;
})(), nu = (e) => {
  const {
    theme: n,
    classGroups: r
  } = e;
  return ru(r, n);
}, ru = (e, n) => {
  const r = Pa();
  for (const o in e) {
    const s = e[o];
    so(s, r, o, n);
  }
  return r;
}, so = (e, n, r, o) => {
  const s = e.length;
  for (let a = 0; a < s; a++) {
    const i = e[a];
    ou(i, n, r, o);
  }
}, ou = (e, n, r, o) => {
  if (typeof e == "string") {
    su(e, n, r);
    return;
  }
  if (typeof e == "function") {
    au(e, n, r, o);
    return;
  }
  iu(e, n, r, o);
}, su = (e, n, r) => {
  const o = e === "" ? n : _a(n, e);
  o.classGroupId = r;
}, au = (e, n, r, o) => {
  if (lu(e)) {
    so(e(o), n, r, o);
    return;
  }
  n.validators === null && (n.validators = []), n.validators.push(Qd(r, e));
}, iu = (e, n, r, o) => {
  const s = Object.entries(e), a = s.length;
  for (let i = 0; i < a; i++) {
    const [l, u] = s[i];
    so(u, _a(n, l), r, o);
  }
}, _a = (e, n) => {
  let r = e;
  const o = n.split(jn), s = o.length;
  for (let a = 0; a < s; a++) {
    const i = o[a];
    let l = r.nextPart.get(i);
    l || (l = Pa(), r.nextPart.set(i, l)), r = l;
  }
  return r;
}, lu = (e) => "isThemeGetter" in e && e.isThemeGetter === !0, cu = (e) => {
  if (e < 1)
    return {
      get: () => {
      },
      set: () => {
      }
    };
  let n = 0, r = /* @__PURE__ */ Object.create(null), o = /* @__PURE__ */ Object.create(null);
  const s = (a, i) => {
    r[a] = i, n++, n > e && (n = 0, o = r, r = /* @__PURE__ */ Object.create(null));
  };
  return {
    get(a) {
      let i = r[a];
      if (i !== void 0)
        return i;
      if ((i = o[a]) !== void 0)
        return s(a, i), i;
    },
    set(a, i) {
      a in r ? r[a] = i : s(a, i);
    }
  };
}, Fr = "!", ws = ":", du = [], Cs = (e, n, r, o, s) => ({
  modifiers: e,
  hasImportantModifier: n,
  baseClassName: r,
  maybePostfixModifierPosition: o,
  isExternal: s
}), uu = (e) => {
  const {
    prefix: n,
    experimentalParseClassName: r
  } = e;
  let o = (s) => {
    const a = [];
    let i = 0, l = 0, u = 0, d;
    const p = s.length;
    for (let b = 0; b < p; b++) {
      const v = s[b];
      if (i === 0 && l === 0) {
        if (v === ws) {
          a.push(s.slice(u, b)), u = b + 1;
          continue;
        }
        if (v === "/") {
          d = b;
          continue;
        }
      }
      v === "[" ? i++ : v === "]" ? i-- : v === "(" ? l++ : v === ")" && l--;
    }
    const c = a.length === 0 ? s : s.slice(u);
    let h = c, g = !1;
    c.endsWith(Fr) ? (h = c.slice(0, -1), g = !0) : (
      /**
       * In Tailwind CSS v3 the important modifier was at the start of the base class name. This is still supported for legacy reasons.
       * @see https://github.com/dcastil/tailwind-merge/issues/513#issuecomment-2614029864
       */
      c.startsWith(Fr) && (h = c.slice(1), g = !0)
    );
    const y = d && d > u ? d - u : void 0;
    return Cs(a, g, h, y);
  };
  if (n) {
    const s = n + ws, a = o;
    o = (i) => i.startsWith(s) ? a(i.slice(s.length)) : Cs(du, !1, i, void 0, !0);
  }
  if (r) {
    const s = o;
    o = (a) => r({
      className: a,
      parseClassName: s
    });
  }
  return o;
}, fu = (e) => {
  const n = /* @__PURE__ */ new Map();
  return e.orderSensitiveModifiers.forEach((r, o) => {
    n.set(r, 1e6 + o);
  }), (r) => {
    const o = [];
    let s = [];
    for (let a = 0; a < r.length; a++) {
      const i = r[a], l = i[0] === "[", u = n.has(i);
      l || u ? (s.length > 0 && (s.sort(), o.push(...s), s = []), o.push(i)) : s.push(i);
    }
    return s.length > 0 && (s.sort(), o.push(...s)), o;
  };
}, mu = (e) => ({
  cache: cu(e.cacheSize),
  parseClassName: uu(e),
  sortModifiers: fu(e),
  postfixLookupClassGroupIds: pu(e),
  ...eu(e)
}), pu = (e) => {
  const n = /* @__PURE__ */ Object.create(null), r = e.postfixLookupClassGroups;
  if (r)
    for (let o = 0; o < r.length; o++)
      n[r[o]] = !0;
  return n;
}, hu = /\s+/, gu = (e, n) => {
  const {
    parseClassName: r,
    getClassGroupId: o,
    getConflictingClassGroupIds: s,
    sortModifiers: a,
    postfixLookupClassGroupIds: i
  } = n, l = [], u = e.trim().split(hu);
  let d = "";
  for (let p = u.length - 1; p >= 0; p -= 1) {
    const c = u[p], {
      isExternal: h,
      modifiers: g,
      hasImportantModifier: y,
      baseClassName: b,
      maybePostfixModifierPosition: v
    } = r(c);
    if (h) {
      d = c + (d.length > 0 ? " " + d : d);
      continue;
    }
    let x = !!v, S;
    if (x) {
      const E = b.substring(0, v);
      S = o(E);
      const k = S && i[S] ? o(b) : void 0;
      k && k !== S && (S = k, x = !1);
    } else
      S = o(b);
    if (!S) {
      if (!x) {
        d = c + (d.length > 0 ? " " + d : d);
        continue;
      }
      if (S = o(b), !S) {
        d = c + (d.length > 0 ? " " + d : d);
        continue;
      }
      x = !1;
    }
    const w = g.length === 0 ? "" : g.length === 1 ? g[0] : a(g).join(":"), C = y ? w + Fr : w, N = C + S;
    if (l.indexOf(N) > -1)
      continue;
    l.push(N);
    const R = s(S, x);
    for (let E = 0; E < R.length; ++E) {
      const k = R[E];
      l.push(C + k);
    }
    d = c + (d.length > 0 ? " " + d : d);
  }
  return d;
}, vu = (...e) => {
  let n = 0, r, o, s = "";
  for (; n < e.length; )
    (r = e[n++]) && (o = Ia(r)) && (s && (s += " "), s += o);
  return s;
}, Ia = (e) => {
  if (typeof e == "string")
    return e;
  let n, r = "";
  for (let o = 0; o < e.length; o++)
    e[o] && (n = Ia(e[o])) && (r && (r += " "), r += n);
  return r;
}, bu = (e, ...n) => {
  let r, o, s, a;
  const i = (u) => {
    const d = n.reduce((p, c) => c(p), e());
    return r = mu(d), o = r.cache.get, s = r.cache.set, a = l, l(u);
  }, l = (u) => {
    const d = o(u);
    if (d)
      return d;
    const p = gu(u, r);
    return s(u, p), p;
  };
  return a = i, (...u) => a(vu(...u));
}, yu = [], me = (e) => {
  const n = (r) => r[e] || yu;
  return n.isThemeGetter = !0, n.themeKey = e, n;
}, Oa = /^\[(?:(\w[\w-]*):)?(.+)\]$/i, Aa = /^\((?:(\w[\w-]*):)?(.+)\)$/i, xu = /^\d+(?:\.\d+)?\/\d+(?:\.\d+)?$/, wu = /^(\d+(\.\d+)?)?(xs|sm|md|lg|xl)$/, Cu = /\d+(%|px|r?em|[sdl]?v([hwib]|min|max)|pt|pc|in|cm|mm|cap|ch|ex|r?lh|cq(w|h|i|b|min|max))|\b(calc|min|max|clamp)\(.+\)|^0$/, Su = /^(rgba?|hsla?|hwb|(ok)?(lab|lch)|color-mix|color|light-dark)\(.+\)$/, ku = /^(inset_)?-?((\d+)?\.?(\d+)[a-z]+|0)_-?((\d+)?\.?(\d+)[a-z]+|0)/, Eu = /^(url|image|image-set|cross-fade|element|(repeating-)?(linear|radial|conic)-gradient)\(.+\)$/, mt = (e) => xu.test(e), J = (e) => !!e && !Number.isNaN(Number(e)), We = (e) => !!e && Number.isInteger(Number(e)), vr = (e) => e.endsWith("%") && J(e.slice(0, -1)), tt = (e) => wu.test(e), Da = () => !0, Nu = (e) => (
  // `colorFunctionRegex` check is necessary because color functions can have percentages in them which which would be incorrectly classified as lengths.
  // For example, `hsl(0 0% 0%)` would be classified as a length without this check.
  // I could also use lookbehind assertion in `lengthUnitRegex` but that isn't supported widely enough.
  Cu.test(e) && !Su.test(e)
), ao = () => !1, Ru = (e) => ku.test(e), Pu = (e) => Eu.test(e), Tu = (e) => !j(e) && !H(e), _u = (e) => e.startsWith("@container") && (e[10] === "/" && e[11] !== void 0 || e[11] === "s" && e[16] !== void 0 && e.startsWith("-size/", 10) || e[11] === "n" && e[18] !== void 0 && e.startsWith("-normal/", 10)), Iu = (e) => bt(e, Fa, ao), j = (e) => Oa.test(e), Ct = (e) => bt(e, $a, Nu), Ss = (e) => bt(e, zu, J), Ou = (e) => bt(e, Ba, Da), Au = (e) => bt(e, za, ao), ks = (e) => bt(e, Ma, ao), Du = (e) => bt(e, La, Pu), kn = (e) => bt(e, Va, Ru), H = (e) => Aa.test(e), on = (e) => _t(e, $a), Mu = (e) => _t(e, za), Es = (e) => _t(e, Ma), Lu = (e) => _t(e, Fa), Fu = (e) => _t(e, La), En = (e) => _t(e, Va, !0), $u = (e) => _t(e, Ba, !0), bt = (e, n, r) => {
  const o = Oa.exec(e);
  return o ? o[1] ? n(o[1]) : r(o[2]) : !1;
}, _t = (e, n, r = !1) => {
  const o = Aa.exec(e);
  return o ? o[1] ? n(o[1]) : r : !1;
}, Ma = (e) => e === "position" || e === "percentage", La = (e) => e === "image" || e === "url", Fa = (e) => e === "length" || e === "size" || e === "bg-size", $a = (e) => e === "length", zu = (e) => e === "number", za = (e) => e === "family-name", Ba = (e) => e === "number" || e === "weight", Va = (e) => e === "shadow", Bu = () => {
  const e = me("color"), n = me("font"), r = me("text"), o = me("font-weight"), s = me("tracking"), a = me("leading"), i = me("breakpoint"), l = me("container"), u = me("spacing"), d = me("radius"), p = me("shadow"), c = me("inset-shadow"), h = me("text-shadow"), g = me("drop-shadow"), y = me("blur"), b = me("perspective"), v = me("aspect"), x = me("ease"), S = me("animate"), w = () => ["auto", "avoid", "all", "avoid-page", "page", "left", "right", "column"], C = () => [
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
  ], N = () => [...C(), H, j], R = () => ["auto", "hidden", "clip", "visible", "scroll"], E = () => ["auto", "contain", "none"], k = () => [H, j, u], T = () => [mt, "full", "auto", ...k()], I = () => [We, "none", "subgrid", H, j], L = () => ["auto", {
    span: ["full", We, H, j]
  }, We, H, j], A = () => [We, "auto", H, j], _ = () => ["auto", "min", "max", "fr", H, j], M = () => ["start", "end", "center", "between", "around", "evenly", "stretch", "baseline", "center-safe", "end-safe"], U = () => ["start", "end", "center", "stretch", "center-safe", "end-safe"], $ = () => ["auto", ...k()], B = () => [mt, "auto", "full", "dvw", "dvh", "lvw", "lvh", "svw", "svh", "min", "max", "fit", ...k()], W = () => [l, mt, "screen", "full", "dvw", "lvw", "svw", "min", "max", "fit", ...k()], z = () => [mt, "screen", "full", "lh", "dvh", "lvh", "svh", "min", "max", "fit", ...k()], F = () => [e, H, j], le = () => [...C(), Es, ks, {
    position: [H, j]
  }], ee = () => ["no-repeat", {
    repeat: ["", "x", "y", "space", "round"]
  }], ae = () => ["auto", "cover", "contain", Lu, Iu, {
    size: [H, j]
  }], q = () => [vr, on, Ct], Y = () => [
    // Deprecated since Tailwind CSS v4.0.0
    "",
    "none",
    "full",
    d,
    H,
    j
  ], G = () => ["", J, on, Ct], ie = () => ["solid", "dashed", "dotted", "double"], K = () => ["normal", "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn", "hard-light", "soft-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity"], V = () => [J, vr, Es, ks], de = () => [
    // Deprecated since Tailwind CSS v4.0.0
    "",
    "none",
    y,
    H,
    j
  ], ne = () => ["none", J, H, j], re = () => ["none", J, H, j], se = () => [J, H, j], pe = () => [mt, "full", ...k()];
  return {
    cacheSize: 500,
    theme: {
      animate: ["spin", "ping", "pulse", "bounce"],
      aspect: ["video"],
      blur: [tt],
      breakpoint: [tt],
      color: [Da],
      container: [tt],
      "drop-shadow": [tt],
      ease: ["in", "out", "in-out"],
      font: [Tu],
      "font-weight": ["thin", "extralight", "light", "normal", "medium", "semibold", "bold", "extrabold", "black"],
      "inset-shadow": [tt],
      leading: ["none", "tight", "snug", "normal", "relaxed", "loose"],
      perspective: ["dramatic", "near", "normal", "midrange", "distant", "none"],
      radius: [tt],
      shadow: [tt],
      spacing: ["px", J],
      text: [tt],
      "text-shadow": [tt],
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
        aspect: ["auto", "square", mt, j, H, v]
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
        "@container": ["", "normal", "size", H, j]
      }],
      /**
       * Container Name
       * @see https://tailwindcss.com/docs/responsive-design#named-containers
       */
      "container-named": [_u],
      /**
       * Columns
       * @see https://tailwindcss.com/docs/columns
       */
      columns: [{
        columns: [J, "auto", j, H, l]
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
        object: N()
      }],
      /**
       * Overflow
       * @see https://tailwindcss.com/docs/overflow
       */
      overflow: [{
        overflow: R()
      }],
      /**
       * Overflow X
       * @see https://tailwindcss.com/docs/overflow
       */
      "overflow-x": [{
        "overflow-x": R()
      }],
      /**
       * Overflow Y
       * @see https://tailwindcss.com/docs/overflow
       */
      "overflow-y": [{
        "overflow-y": R()
      }],
      /**
       * Overscroll Behavior
       * @see https://tailwindcss.com/docs/overscroll-behavior
       */
      overscroll: [{
        overscroll: E()
      }],
      /**
       * Overscroll Behavior X
       * @see https://tailwindcss.com/docs/overscroll-behavior
       */
      "overscroll-x": [{
        "overscroll-x": E()
      }],
      /**
       * Overscroll Behavior Y
       * @see https://tailwindcss.com/docs/overscroll-behavior
       */
      "overscroll-y": [{
        "overscroll-y": E()
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
        inset: T()
      }],
      /**
       * Inset Inline
       * @see https://tailwindcss.com/docs/top-right-bottom-left
       */
      "inset-x": [{
        "inset-x": T()
      }],
      /**
       * Inset Block
       * @see https://tailwindcss.com/docs/top-right-bottom-left
       */
      "inset-y": [{
        "inset-y": T()
      }],
      /**
       * Inset Inline Start
       * @see https://tailwindcss.com/docs/top-right-bottom-left
       * @todo class group will be renamed to `inset-s` in next major release
       */
      start: [{
        "inset-s": T(),
        /**
         * @deprecated since Tailwind CSS v4.2.0 in favor of `inset-s-*` utilities.
         * @see https://github.com/tailwindlabs/tailwindcss/pull/19613
         */
        start: T()
      }],
      /**
       * Inset Inline End
       * @see https://tailwindcss.com/docs/top-right-bottom-left
       * @todo class group will be renamed to `inset-e` in next major release
       */
      end: [{
        "inset-e": T(),
        /**
         * @deprecated since Tailwind CSS v4.2.0 in favor of `inset-e-*` utilities.
         * @see https://github.com/tailwindlabs/tailwindcss/pull/19613
         */
        end: T()
      }],
      /**
       * Inset Block Start
       * @see https://tailwindcss.com/docs/top-right-bottom-left
       */
      "inset-bs": [{
        "inset-bs": T()
      }],
      /**
       * Inset Block End
       * @see https://tailwindcss.com/docs/top-right-bottom-left
       */
      "inset-be": [{
        "inset-be": T()
      }],
      /**
       * Top
       * @see https://tailwindcss.com/docs/top-right-bottom-left
       */
      top: [{
        top: T()
      }],
      /**
       * Right
       * @see https://tailwindcss.com/docs/top-right-bottom-left
       */
      right: [{
        right: T()
      }],
      /**
       * Bottom
       * @see https://tailwindcss.com/docs/top-right-bottom-left
       */
      bottom: [{
        bottom: T()
      }],
      /**
       * Left
       * @see https://tailwindcss.com/docs/top-right-bottom-left
       */
      left: [{
        left: T()
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
        z: [We, "auto", H, j]
      }],
      // ------------------------
      // --- Flexbox and Grid ---
      // ------------------------
      /**
       * Flex Basis
       * @see https://tailwindcss.com/docs/flex-basis
       */
      basis: [{
        basis: [mt, "full", "auto", l, ...k()]
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
        flex: [J, mt, "auto", "initial", "none", j]
      }],
      /**
       * Flex Grow
       * @see https://tailwindcss.com/docs/flex-grow
       */
      grow: [{
        grow: ["", J, H, j]
      }],
      /**
       * Flex Shrink
       * @see https://tailwindcss.com/docs/flex-shrink
       */
      shrink: [{
        shrink: ["", J, H, j]
      }],
      /**
       * Order
       * @see https://tailwindcss.com/docs/order
       */
      order: [{
        order: [We, "first", "last", "none", H, j]
      }],
      /**
       * Grid Template Columns
       * @see https://tailwindcss.com/docs/grid-template-columns
       */
      "grid-cols": [{
        "grid-cols": I()
      }],
      /**
       * Grid Column Start / End
       * @see https://tailwindcss.com/docs/grid-column
       */
      "col-start-end": [{
        col: L()
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
        "grid-rows": I()
      }],
      /**
       * Grid Row Start / End
       * @see https://tailwindcss.com/docs/grid-row
       */
      "row-start-end": [{
        row: L()
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
        "auto-cols": _()
      }],
      /**
       * Grid Auto Rows
       * @see https://tailwindcss.com/docs/grid-auto-rows
       */
      "auto-rows": [{
        "auto-rows": _()
      }],
      /**
       * Gap
       * @see https://tailwindcss.com/docs/gap
       */
      gap: [{
        gap: k()
      }],
      /**
       * Gap X
       * @see https://tailwindcss.com/docs/gap
       */
      "gap-x": [{
        "gap-x": k()
      }],
      /**
       * Gap Y
       * @see https://tailwindcss.com/docs/gap
       */
      "gap-y": [{
        "gap-y": k()
      }],
      /**
       * Justify Content
       * @see https://tailwindcss.com/docs/justify-content
       */
      "justify-content": [{
        justify: [...M(), "normal"]
      }],
      /**
       * Justify Items
       * @see https://tailwindcss.com/docs/justify-items
       */
      "justify-items": [{
        "justify-items": [...U(), "normal"]
      }],
      /**
       * Justify Self
       * @see https://tailwindcss.com/docs/justify-self
       */
      "justify-self": [{
        "justify-self": ["auto", ...U()]
      }],
      /**
       * Align Content
       * @see https://tailwindcss.com/docs/align-content
       */
      "align-content": [{
        content: ["normal", ...M()]
      }],
      /**
       * Align Items
       * @see https://tailwindcss.com/docs/align-items
       */
      "align-items": [{
        items: [...U(), {
          baseline: ["", "last"]
        }]
      }],
      /**
       * Align Self
       * @see https://tailwindcss.com/docs/align-self
       */
      "align-self": [{
        self: ["auto", ...U(), {
          baseline: ["", "last"]
        }]
      }],
      /**
       * Place Content
       * @see https://tailwindcss.com/docs/place-content
       */
      "place-content": [{
        "place-content": M()
      }],
      /**
       * Place Items
       * @see https://tailwindcss.com/docs/place-items
       */
      "place-items": [{
        "place-items": [...U(), "baseline"]
      }],
      /**
       * Place Self
       * @see https://tailwindcss.com/docs/place-self
       */
      "place-self": [{
        "place-self": ["auto", ...U()]
      }],
      // Spacing
      /**
       * Padding
       * @see https://tailwindcss.com/docs/padding
       */
      p: [{
        p: k()
      }],
      /**
       * Padding Inline
       * @see https://tailwindcss.com/docs/padding
       */
      px: [{
        px: k()
      }],
      /**
       * Padding Block
       * @see https://tailwindcss.com/docs/padding
       */
      py: [{
        py: k()
      }],
      /**
       * Padding Inline Start
       * @see https://tailwindcss.com/docs/padding
       */
      ps: [{
        ps: k()
      }],
      /**
       * Padding Inline End
       * @see https://tailwindcss.com/docs/padding
       */
      pe: [{
        pe: k()
      }],
      /**
       * Padding Block Start
       * @see https://tailwindcss.com/docs/padding
       */
      pbs: [{
        pbs: k()
      }],
      /**
       * Padding Block End
       * @see https://tailwindcss.com/docs/padding
       */
      pbe: [{
        pbe: k()
      }],
      /**
       * Padding Top
       * @see https://tailwindcss.com/docs/padding
       */
      pt: [{
        pt: k()
      }],
      /**
       * Padding Right
       * @see https://tailwindcss.com/docs/padding
       */
      pr: [{
        pr: k()
      }],
      /**
       * Padding Bottom
       * @see https://tailwindcss.com/docs/padding
       */
      pb: [{
        pb: k()
      }],
      /**
       * Padding Left
       * @see https://tailwindcss.com/docs/padding
       */
      pl: [{
        pl: k()
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
        "space-x": k()
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
        "space-y": k()
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
        size: B()
      }],
      /**
       * Inline Size
       * @see https://tailwindcss.com/docs/inline-size
       */
      "inline-size": [{
        inline: ["auto", ...W()]
      }],
      /**
       * Min-Inline Size
       * @see https://tailwindcss.com/docs/min-inline-size
       */
      "min-inline-size": [{
        "min-inline": ["auto", ...W()]
      }],
      /**
       * Max-Inline Size
       * @see https://tailwindcss.com/docs/max-inline-size
       */
      "max-inline-size": [{
        "max-inline": ["none", ...W()]
      }],
      /**
       * Block Size
       * @see https://tailwindcss.com/docs/block-size
       */
      "block-size": [{
        block: ["auto", ...z()]
      }],
      /**
       * Min-Block Size
       * @see https://tailwindcss.com/docs/min-block-size
       */
      "min-block-size": [{
        "min-block": ["auto", ...z()]
      }],
      /**
       * Max-Block Size
       * @see https://tailwindcss.com/docs/max-block-size
       */
      "max-block-size": [{
        "max-block": ["none", ...z()]
      }],
      /**
       * Width
       * @see https://tailwindcss.com/docs/width
       */
      w: [{
        w: [l, "screen", ...B()]
      }],
      /**
       * Min-Width
       * @see https://tailwindcss.com/docs/min-width
       */
      "min-w": [{
        "min-w": [
          l,
          "screen",
          /** Deprecated. @see https://github.com/tailwindlabs/tailwindcss.com/issues/2027#issuecomment-2620152757 */
          "none",
          ...B()
        ]
      }],
      /**
       * Max-Width
       * @see https://tailwindcss.com/docs/max-width
       */
      "max-w": [{
        "max-w": [
          l,
          "screen",
          "none",
          /** Deprecated since Tailwind CSS v4.0.0. @see https://github.com/tailwindlabs/tailwindcss.com/issues/2027#issuecomment-2620152757 */
          "prose",
          /** Deprecated since Tailwind CSS v4.0.0. @see https://github.com/tailwindlabs/tailwindcss.com/issues/2027#issuecomment-2620152757 */
          {
            screen: [i]
          },
          ...B()
        ]
      }],
      /**
       * Height
       * @see https://tailwindcss.com/docs/height
       */
      h: [{
        h: ["screen", "lh", ...B()]
      }],
      /**
       * Min-Height
       * @see https://tailwindcss.com/docs/min-height
       */
      "min-h": [{
        "min-h": ["screen", "lh", "none", ...B()]
      }],
      /**
       * Max-Height
       * @see https://tailwindcss.com/docs/max-height
       */
      "max-h": [{
        "max-h": ["screen", "lh", "none", ...B()]
      }],
      // ------------------
      // --- Typography ---
      // ------------------
      /**
       * Font Size
       * @see https://tailwindcss.com/docs/font-size
       */
      "font-size": [{
        text: ["base", r, on, Ct]
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
        font: [o, $u, Ou]
      }],
      /**
       * Font Stretch
       * @see https://tailwindcss.com/docs/font-stretch
       */
      "font-stretch": [{
        "font-stretch": ["ultra-condensed", "extra-condensed", "condensed", "semi-condensed", "normal", "semi-expanded", "expanded", "extra-expanded", "ultra-expanded", vr, j]
      }],
      /**
       * Font Family
       * @see https://tailwindcss.com/docs/font-family
       */
      "font-family": [{
        font: [Mu, Au, n]
      }],
      /**
       * Font Feature Settings
       * @see https://tailwindcss.com/docs/font-feature-settings
       */
      "font-features": [{
        "font-features": [j]
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
        tracking: [s, H, j]
      }],
      /**
       * Line Clamp
       * @see https://tailwindcss.com/docs/line-clamp
       */
      "line-clamp": [{
        "line-clamp": [J, "none", H, Ss]
      }],
      /**
       * Line Height
       * @see https://tailwindcss.com/docs/line-height
       */
      leading: [{
        leading: [
          "none",
          /** Deprecated since Tailwind CSS v4.0.0. @see https://github.com/tailwindlabs/tailwindcss.com/issues/2027#issuecomment-2620152757 */
          a,
          ...k()
        ]
      }],
      /**
       * List Style Image
       * @see https://tailwindcss.com/docs/list-style-image
       */
      "list-image": [{
        "list-image": ["none", H, j]
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
        list: ["disc", "decimal", "none", H, j]
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
        placeholder: F()
      }],
      /**
       * Text Color
       * @see https://tailwindcss.com/docs/text-color
       */
      "text-color": [{
        text: F()
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
        decoration: [...ie(), "wavy"]
      }],
      /**
       * Text Decoration Thickness
       * @see https://tailwindcss.com/docs/text-decoration-thickness
       */
      "text-decoration-thickness": [{
        decoration: [J, "from-font", "auto", H, Ct]
      }],
      /**
       * Text Decoration Color
       * @see https://tailwindcss.com/docs/text-decoration-color
       */
      "text-decoration-color": [{
        decoration: F()
      }],
      /**
       * Text Underline Offset
       * @see https://tailwindcss.com/docs/text-underline-offset
       */
      "underline-offset": [{
        "underline-offset": [J, "auto", H, j]
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
        indent: k()
      }],
      /**
       * Tab Size
       * @see https://tailwindcss.com/docs/tab-size
       */
      "tab-size": [{
        tab: [We, H, j]
      }],
      /**
       * Vertical Alignment
       * @see https://tailwindcss.com/docs/vertical-align
       */
      "vertical-align": [{
        align: ["baseline", "top", "middle", "bottom", "text-top", "text-bottom", "sub", "super", H, j]
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
        content: ["none", H, j]
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
        bg: le()
      }],
      /**
       * Background Repeat
       * @see https://tailwindcss.com/docs/background-repeat
       */
      "bg-repeat": [{
        bg: ee()
      }],
      /**
       * Background Size
       * @see https://tailwindcss.com/docs/background-size
       */
      "bg-size": [{
        bg: ae()
      }],
      /**
       * Background Image
       * @see https://tailwindcss.com/docs/background-image
       */
      "bg-image": [{
        bg: ["none", {
          linear: [{
            to: ["t", "tr", "r", "br", "b", "bl", "l", "tl"]
          }, We, H, j],
          radial: ["", H, j],
          conic: ["", We, H, j]
        }, Fu, Du]
      }],
      /**
       * Background Color
       * @see https://tailwindcss.com/docs/background-color
       */
      "bg-color": [{
        bg: F()
      }],
      /**
       * Gradient Color Stops From Position
       * @see https://tailwindcss.com/docs/gradient-color-stops
       */
      "gradient-from-pos": [{
        from: q()
      }],
      /**
       * Gradient Color Stops Via Position
       * @see https://tailwindcss.com/docs/gradient-color-stops
       */
      "gradient-via-pos": [{
        via: q()
      }],
      /**
       * Gradient Color Stops To Position
       * @see https://tailwindcss.com/docs/gradient-color-stops
       */
      "gradient-to-pos": [{
        to: q()
      }],
      /**
       * Gradient Color Stops From
       * @see https://tailwindcss.com/docs/gradient-color-stops
       */
      "gradient-from": [{
        from: F()
      }],
      /**
       * Gradient Color Stops Via
       * @see https://tailwindcss.com/docs/gradient-color-stops
       */
      "gradient-via": [{
        via: F()
      }],
      /**
       * Gradient Color Stops To
       * @see https://tailwindcss.com/docs/gradient-color-stops
       */
      "gradient-to": [{
        to: F()
      }],
      // ---------------
      // --- Borders ---
      // ---------------
      /**
       * Border Radius
       * @see https://tailwindcss.com/docs/border-radius
       */
      rounded: [{
        rounded: Y()
      }],
      /**
       * Border Radius Start
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-s": [{
        "rounded-s": Y()
      }],
      /**
       * Border Radius End
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-e": [{
        "rounded-e": Y()
      }],
      /**
       * Border Radius Top
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-t": [{
        "rounded-t": Y()
      }],
      /**
       * Border Radius Right
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-r": [{
        "rounded-r": Y()
      }],
      /**
       * Border Radius Bottom
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-b": [{
        "rounded-b": Y()
      }],
      /**
       * Border Radius Left
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-l": [{
        "rounded-l": Y()
      }],
      /**
       * Border Radius Start Start
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-ss": [{
        "rounded-ss": Y()
      }],
      /**
       * Border Radius Start End
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-se": [{
        "rounded-se": Y()
      }],
      /**
       * Border Radius End End
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-ee": [{
        "rounded-ee": Y()
      }],
      /**
       * Border Radius End Start
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-es": [{
        "rounded-es": Y()
      }],
      /**
       * Border Radius Top Left
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-tl": [{
        "rounded-tl": Y()
      }],
      /**
       * Border Radius Top Right
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-tr": [{
        "rounded-tr": Y()
      }],
      /**
       * Border Radius Bottom Right
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-br": [{
        "rounded-br": Y()
      }],
      /**
       * Border Radius Bottom Left
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-bl": [{
        "rounded-bl": Y()
      }],
      /**
       * Border Width
       * @see https://tailwindcss.com/docs/border-width
       */
      "border-w": [{
        border: G()
      }],
      /**
       * Border Width Inline
       * @see https://tailwindcss.com/docs/border-width
       */
      "border-w-x": [{
        "border-x": G()
      }],
      /**
       * Border Width Block
       * @see https://tailwindcss.com/docs/border-width
       */
      "border-w-y": [{
        "border-y": G()
      }],
      /**
       * Border Width Inline Start
       * @see https://tailwindcss.com/docs/border-width
       */
      "border-w-s": [{
        "border-s": G()
      }],
      /**
       * Border Width Inline End
       * @see https://tailwindcss.com/docs/border-width
       */
      "border-w-e": [{
        "border-e": G()
      }],
      /**
       * Border Width Block Start
       * @see https://tailwindcss.com/docs/border-width
       */
      "border-w-bs": [{
        "border-bs": G()
      }],
      /**
       * Border Width Block End
       * @see https://tailwindcss.com/docs/border-width
       */
      "border-w-be": [{
        "border-be": G()
      }],
      /**
       * Border Width Top
       * @see https://tailwindcss.com/docs/border-width
       */
      "border-w-t": [{
        "border-t": G()
      }],
      /**
       * Border Width Right
       * @see https://tailwindcss.com/docs/border-width
       */
      "border-w-r": [{
        "border-r": G()
      }],
      /**
       * Border Width Bottom
       * @see https://tailwindcss.com/docs/border-width
       */
      "border-w-b": [{
        "border-b": G()
      }],
      /**
       * Border Width Left
       * @see https://tailwindcss.com/docs/border-width
       */
      "border-w-l": [{
        "border-l": G()
      }],
      /**
       * Divide Width X
       * @see https://tailwindcss.com/docs/border-width#between-children
       */
      "divide-x": [{
        "divide-x": G()
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
        "divide-y": G()
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
        border: [...ie(), "hidden", "none"]
      }],
      /**
       * Divide Style
       * @see https://tailwindcss.com/docs/border-style#setting-the-divider-style
       */
      "divide-style": [{
        divide: [...ie(), "hidden", "none"]
      }],
      /**
       * Border Color
       * @see https://tailwindcss.com/docs/border-color
       */
      "border-color": [{
        border: F()
      }],
      /**
       * Border Color Inline
       * @see https://tailwindcss.com/docs/border-color
       */
      "border-color-x": [{
        "border-x": F()
      }],
      /**
       * Border Color Block
       * @see https://tailwindcss.com/docs/border-color
       */
      "border-color-y": [{
        "border-y": F()
      }],
      /**
       * Border Color Inline Start
       * @see https://tailwindcss.com/docs/border-color
       */
      "border-color-s": [{
        "border-s": F()
      }],
      /**
       * Border Color Inline End
       * @see https://tailwindcss.com/docs/border-color
       */
      "border-color-e": [{
        "border-e": F()
      }],
      /**
       * Border Color Block Start
       * @see https://tailwindcss.com/docs/border-color
       */
      "border-color-bs": [{
        "border-bs": F()
      }],
      /**
       * Border Color Block End
       * @see https://tailwindcss.com/docs/border-color
       */
      "border-color-be": [{
        "border-be": F()
      }],
      /**
       * Border Color Top
       * @see https://tailwindcss.com/docs/border-color
       */
      "border-color-t": [{
        "border-t": F()
      }],
      /**
       * Border Color Right
       * @see https://tailwindcss.com/docs/border-color
       */
      "border-color-r": [{
        "border-r": F()
      }],
      /**
       * Border Color Bottom
       * @see https://tailwindcss.com/docs/border-color
       */
      "border-color-b": [{
        "border-b": F()
      }],
      /**
       * Border Color Left
       * @see https://tailwindcss.com/docs/border-color
       */
      "border-color-l": [{
        "border-l": F()
      }],
      /**
       * Divide Color
       * @see https://tailwindcss.com/docs/divide-color
       */
      "divide-color": [{
        divide: F()
      }],
      /**
       * Outline Style
       * @see https://tailwindcss.com/docs/outline-style
       */
      "outline-style": [{
        outline: [...ie(), "none", "hidden"]
      }],
      /**
       * Outline Offset
       * @see https://tailwindcss.com/docs/outline-offset
       */
      "outline-offset": [{
        "outline-offset": [J, H, j]
      }],
      /**
       * Outline Width
       * @see https://tailwindcss.com/docs/outline-width
       */
      "outline-w": [{
        outline: ["", J, on, Ct]
      }],
      /**
       * Outline Color
       * @see https://tailwindcss.com/docs/outline-color
       */
      "outline-color": [{
        outline: F()
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
          p,
          En,
          kn
        ]
      }],
      /**
       * Box Shadow Color
       * @see https://tailwindcss.com/docs/box-shadow#setting-the-shadow-color
       */
      "shadow-color": [{
        shadow: F()
      }],
      /**
       * Inset Box Shadow
       * @see https://tailwindcss.com/docs/box-shadow#adding-an-inset-shadow
       */
      "inset-shadow": [{
        "inset-shadow": ["none", c, En, kn]
      }],
      /**
       * Inset Box Shadow Color
       * @see https://tailwindcss.com/docs/box-shadow#setting-the-inset-shadow-color
       */
      "inset-shadow-color": [{
        "inset-shadow": F()
      }],
      /**
       * Ring Width
       * @see https://tailwindcss.com/docs/box-shadow#adding-a-ring
       */
      "ring-w": [{
        ring: G()
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
        ring: F()
      }],
      /**
       * Ring Offset Width
       * @see https://v3.tailwindcss.com/docs/ring-offset-width
       * @deprecated since Tailwind CSS v4.0.0
       * @see https://github.com/tailwindlabs/tailwindcss/blob/v4.0.0/packages/tailwindcss/src/utilities.ts#L4158
       */
      "ring-offset-w": [{
        "ring-offset": [J, Ct]
      }],
      /**
       * Ring Offset Color
       * @see https://v3.tailwindcss.com/docs/ring-offset-color
       * @deprecated since Tailwind CSS v4.0.0
       * @see https://github.com/tailwindlabs/tailwindcss/blob/v4.0.0/packages/tailwindcss/src/utilities.ts#L4158
       */
      "ring-offset-color": [{
        "ring-offset": F()
      }],
      /**
       * Inset Ring Width
       * @see https://tailwindcss.com/docs/box-shadow#adding-an-inset-ring
       */
      "inset-ring-w": [{
        "inset-ring": G()
      }],
      /**
       * Inset Ring Color
       * @see https://tailwindcss.com/docs/box-shadow#setting-the-inset-ring-color
       */
      "inset-ring-color": [{
        "inset-ring": F()
      }],
      /**
       * Text Shadow
       * @see https://tailwindcss.com/docs/text-shadow
       */
      "text-shadow": [{
        "text-shadow": ["none", h, En, kn]
      }],
      /**
       * Text Shadow Color
       * @see https://tailwindcss.com/docs/text-shadow#setting-the-shadow-color
       */
      "text-shadow-color": [{
        "text-shadow": F()
      }],
      /**
       * Opacity
       * @see https://tailwindcss.com/docs/opacity
       */
      opacity: [{
        opacity: [J, H, j]
      }],
      /**
       * Mix Blend Mode
       * @see https://tailwindcss.com/docs/mix-blend-mode
       */
      "mix-blend": [{
        "mix-blend": [...K(), "plus-darker", "plus-lighter"]
      }],
      /**
       * Background Blend Mode
       * @see https://tailwindcss.com/docs/background-blend-mode
       */
      "bg-blend": [{
        "bg-blend": K()
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
        "mask-linear": [J]
      }],
      "mask-image-linear-from-pos": [{
        "mask-linear-from": V()
      }],
      "mask-image-linear-to-pos": [{
        "mask-linear-to": V()
      }],
      "mask-image-linear-from-color": [{
        "mask-linear-from": F()
      }],
      "mask-image-linear-to-color": [{
        "mask-linear-to": F()
      }],
      "mask-image-t-from-pos": [{
        "mask-t-from": V()
      }],
      "mask-image-t-to-pos": [{
        "mask-t-to": V()
      }],
      "mask-image-t-from-color": [{
        "mask-t-from": F()
      }],
      "mask-image-t-to-color": [{
        "mask-t-to": F()
      }],
      "mask-image-r-from-pos": [{
        "mask-r-from": V()
      }],
      "mask-image-r-to-pos": [{
        "mask-r-to": V()
      }],
      "mask-image-r-from-color": [{
        "mask-r-from": F()
      }],
      "mask-image-r-to-color": [{
        "mask-r-to": F()
      }],
      "mask-image-b-from-pos": [{
        "mask-b-from": V()
      }],
      "mask-image-b-to-pos": [{
        "mask-b-to": V()
      }],
      "mask-image-b-from-color": [{
        "mask-b-from": F()
      }],
      "mask-image-b-to-color": [{
        "mask-b-to": F()
      }],
      "mask-image-l-from-pos": [{
        "mask-l-from": V()
      }],
      "mask-image-l-to-pos": [{
        "mask-l-to": V()
      }],
      "mask-image-l-from-color": [{
        "mask-l-from": F()
      }],
      "mask-image-l-to-color": [{
        "mask-l-to": F()
      }],
      "mask-image-x-from-pos": [{
        "mask-x-from": V()
      }],
      "mask-image-x-to-pos": [{
        "mask-x-to": V()
      }],
      "mask-image-x-from-color": [{
        "mask-x-from": F()
      }],
      "mask-image-x-to-color": [{
        "mask-x-to": F()
      }],
      "mask-image-y-from-pos": [{
        "mask-y-from": V()
      }],
      "mask-image-y-to-pos": [{
        "mask-y-to": V()
      }],
      "mask-image-y-from-color": [{
        "mask-y-from": F()
      }],
      "mask-image-y-to-color": [{
        "mask-y-to": F()
      }],
      "mask-image-radial": [{
        "mask-radial": [H, j]
      }],
      "mask-image-radial-from-pos": [{
        "mask-radial-from": V()
      }],
      "mask-image-radial-to-pos": [{
        "mask-radial-to": V()
      }],
      "mask-image-radial-from-color": [{
        "mask-radial-from": F()
      }],
      "mask-image-radial-to-color": [{
        "mask-radial-to": F()
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
        "mask-radial-at": C()
      }],
      "mask-image-conic-pos": [{
        "mask-conic": [J]
      }],
      "mask-image-conic-from-pos": [{
        "mask-conic-from": V()
      }],
      "mask-image-conic-to-pos": [{
        "mask-conic-to": V()
      }],
      "mask-image-conic-from-color": [{
        "mask-conic-from": F()
      }],
      "mask-image-conic-to-color": [{
        "mask-conic-to": F()
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
        mask: le()
      }],
      /**
       * Mask Repeat
       * @see https://tailwindcss.com/docs/mask-repeat
       */
      "mask-repeat": [{
        mask: ee()
      }],
      /**
       * Mask Size
       * @see https://tailwindcss.com/docs/mask-size
       */
      "mask-size": [{
        mask: ae()
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
        mask: ["none", H, j]
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
          H,
          j
        ]
      }],
      /**
       * Blur
       * @see https://tailwindcss.com/docs/blur
       */
      blur: [{
        blur: de()
      }],
      /**
       * Brightness
       * @see https://tailwindcss.com/docs/brightness
       */
      brightness: [{
        brightness: [J, H, j]
      }],
      /**
       * Contrast
       * @see https://tailwindcss.com/docs/contrast
       */
      contrast: [{
        contrast: [J, H, j]
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
          g,
          En,
          kn
        ]
      }],
      /**
       * Drop Shadow Color
       * @see https://tailwindcss.com/docs/filter-drop-shadow#setting-the-shadow-color
       */
      "drop-shadow-color": [{
        "drop-shadow": F()
      }],
      /**
       * Grayscale
       * @see https://tailwindcss.com/docs/grayscale
       */
      grayscale: [{
        grayscale: ["", J, H, j]
      }],
      /**
       * Hue Rotate
       * @see https://tailwindcss.com/docs/hue-rotate
       */
      "hue-rotate": [{
        "hue-rotate": [J, H, j]
      }],
      /**
       * Invert
       * @see https://tailwindcss.com/docs/invert
       */
      invert: [{
        invert: ["", J, H, j]
      }],
      /**
       * Saturate
       * @see https://tailwindcss.com/docs/saturate
       */
      saturate: [{
        saturate: [J, H, j]
      }],
      /**
       * Sepia
       * @see https://tailwindcss.com/docs/sepia
       */
      sepia: [{
        sepia: ["", J, H, j]
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
          H,
          j
        ]
      }],
      /**
       * Backdrop Blur
       * @see https://tailwindcss.com/docs/backdrop-blur
       */
      "backdrop-blur": [{
        "backdrop-blur": de()
      }],
      /**
       * Backdrop Brightness
       * @see https://tailwindcss.com/docs/backdrop-brightness
       */
      "backdrop-brightness": [{
        "backdrop-brightness": [J, H, j]
      }],
      /**
       * Backdrop Contrast
       * @see https://tailwindcss.com/docs/backdrop-contrast
       */
      "backdrop-contrast": [{
        "backdrop-contrast": [J, H, j]
      }],
      /**
       * Backdrop Grayscale
       * @see https://tailwindcss.com/docs/backdrop-grayscale
       */
      "backdrop-grayscale": [{
        "backdrop-grayscale": ["", J, H, j]
      }],
      /**
       * Backdrop Hue Rotate
       * @see https://tailwindcss.com/docs/backdrop-hue-rotate
       */
      "backdrop-hue-rotate": [{
        "backdrop-hue-rotate": [J, H, j]
      }],
      /**
       * Backdrop Invert
       * @see https://tailwindcss.com/docs/backdrop-invert
       */
      "backdrop-invert": [{
        "backdrop-invert": ["", J, H, j]
      }],
      /**
       * Backdrop Opacity
       * @see https://tailwindcss.com/docs/backdrop-opacity
       */
      "backdrop-opacity": [{
        "backdrop-opacity": [J, H, j]
      }],
      /**
       * Backdrop Saturate
       * @see https://tailwindcss.com/docs/backdrop-saturate
       */
      "backdrop-saturate": [{
        "backdrop-saturate": [J, H, j]
      }],
      /**
       * Backdrop Sepia
       * @see https://tailwindcss.com/docs/backdrop-sepia
       */
      "backdrop-sepia": [{
        "backdrop-sepia": ["", J, H, j]
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
        "border-spacing": k()
      }],
      /**
       * Border Spacing X
       * @see https://tailwindcss.com/docs/border-spacing
       */
      "border-spacing-x": [{
        "border-spacing-x": k()
      }],
      /**
       * Border Spacing Y
       * @see https://tailwindcss.com/docs/border-spacing
       */
      "border-spacing-y": [{
        "border-spacing-y": k()
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
        transition: ["", "all", "colors", "opacity", "shadow", "transform", "none", H, j]
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
        duration: [J, "initial", H, j]
      }],
      /**
       * Transition Timing Function
       * @see https://tailwindcss.com/docs/transition-timing-function
       */
      ease: [{
        ease: ["linear", "initial", x, H, j]
      }],
      /**
       * Transition Delay
       * @see https://tailwindcss.com/docs/transition-delay
       */
      delay: [{
        delay: [J, H, j]
      }],
      /**
       * Animation
       * @see https://tailwindcss.com/docs/animation
       */
      animate: [{
        animate: ["none", S, H, j]
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
        perspective: [b, H, j]
      }],
      /**
       * Perspective Origin
       * @see https://tailwindcss.com/docs/perspective-origin
       */
      "perspective-origin": [{
        "perspective-origin": N()
      }],
      /**
       * Rotate
       * @see https://tailwindcss.com/docs/rotate
       */
      rotate: [{
        rotate: ne()
      }],
      /**
       * Rotate X
       * @see https://tailwindcss.com/docs/rotate
       */
      "rotate-x": [{
        "rotate-x": ne()
      }],
      /**
       * Rotate Y
       * @see https://tailwindcss.com/docs/rotate
       */
      "rotate-y": [{
        "rotate-y": ne()
      }],
      /**
       * Rotate Z
       * @see https://tailwindcss.com/docs/rotate
       */
      "rotate-z": [{
        "rotate-z": ne()
      }],
      /**
       * Scale
       * @see https://tailwindcss.com/docs/scale
       */
      scale: [{
        scale: re()
      }],
      /**
       * Scale X
       * @see https://tailwindcss.com/docs/scale
       */
      "scale-x": [{
        "scale-x": re()
      }],
      /**
       * Scale Y
       * @see https://tailwindcss.com/docs/scale
       */
      "scale-y": [{
        "scale-y": re()
      }],
      /**
       * Scale Z
       * @see https://tailwindcss.com/docs/scale
       */
      "scale-z": [{
        "scale-z": re()
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
        skew: se()
      }],
      /**
       * Skew X
       * @see https://tailwindcss.com/docs/skew
       */
      "skew-x": [{
        "skew-x": se()
      }],
      /**
       * Skew Y
       * @see https://tailwindcss.com/docs/skew
       */
      "skew-y": [{
        "skew-y": se()
      }],
      /**
       * Transform
       * @see https://tailwindcss.com/docs/transform
       */
      transform: [{
        transform: [H, j, "", "none", "gpu", "cpu"]
      }],
      /**
       * Transform Origin
       * @see https://tailwindcss.com/docs/transform-origin
       */
      "transform-origin": [{
        origin: N()
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
        translate: pe()
      }],
      /**
       * Translate X
       * @see https://tailwindcss.com/docs/translate
       */
      "translate-x": [{
        "translate-x": pe()
      }],
      /**
       * Translate Y
       * @see https://tailwindcss.com/docs/translate
       */
      "translate-y": [{
        "translate-y": pe()
      }],
      /**
       * Translate Z
       * @see https://tailwindcss.com/docs/translate
       */
      "translate-z": [{
        "translate-z": pe()
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
        zoom: [We, H, j]
      }],
      // ---------------------
      // --- Interactivity ---
      // ---------------------
      /**
       * Accent Color
       * @see https://tailwindcss.com/docs/accent-color
       */
      accent: [{
        accent: F()
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
        caret: F()
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
        cursor: ["auto", "default", "pointer", "wait", "text", "move", "help", "not-allowed", "none", "context-menu", "progress", "cell", "crosshair", "vertical-text", "alias", "copy", "no-drop", "grab", "grabbing", "all-scroll", "col-resize", "row-resize", "n-resize", "e-resize", "s-resize", "w-resize", "ne-resize", "nw-resize", "se-resize", "sw-resize", "ew-resize", "ns-resize", "nesw-resize", "nwse-resize", "zoom-in", "zoom-out", H, j]
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
        "scrollbar-thumb": F()
      }],
      /**
       * Scrollbar Track Color
       * @see https://tailwindcss.com/docs/scrollbar-color
       */
      "scrollbar-track-color": [{
        "scrollbar-track": F()
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
        "scroll-m": k()
      }],
      /**
       * Scroll Margin Inline
       * @see https://tailwindcss.com/docs/scroll-margin
       */
      "scroll-mx": [{
        "scroll-mx": k()
      }],
      /**
       * Scroll Margin Block
       * @see https://tailwindcss.com/docs/scroll-margin
       */
      "scroll-my": [{
        "scroll-my": k()
      }],
      /**
       * Scroll Margin Inline Start
       * @see https://tailwindcss.com/docs/scroll-margin
       */
      "scroll-ms": [{
        "scroll-ms": k()
      }],
      /**
       * Scroll Margin Inline End
       * @see https://tailwindcss.com/docs/scroll-margin
       */
      "scroll-me": [{
        "scroll-me": k()
      }],
      /**
       * Scroll Margin Block Start
       * @see https://tailwindcss.com/docs/scroll-margin
       */
      "scroll-mbs": [{
        "scroll-mbs": k()
      }],
      /**
       * Scroll Margin Block End
       * @see https://tailwindcss.com/docs/scroll-margin
       */
      "scroll-mbe": [{
        "scroll-mbe": k()
      }],
      /**
       * Scroll Margin Top
       * @see https://tailwindcss.com/docs/scroll-margin
       */
      "scroll-mt": [{
        "scroll-mt": k()
      }],
      /**
       * Scroll Margin Right
       * @see https://tailwindcss.com/docs/scroll-margin
       */
      "scroll-mr": [{
        "scroll-mr": k()
      }],
      /**
       * Scroll Margin Bottom
       * @see https://tailwindcss.com/docs/scroll-margin
       */
      "scroll-mb": [{
        "scroll-mb": k()
      }],
      /**
       * Scroll Margin Left
       * @see https://tailwindcss.com/docs/scroll-margin
       */
      "scroll-ml": [{
        "scroll-ml": k()
      }],
      /**
       * Scroll Padding
       * @see https://tailwindcss.com/docs/scroll-padding
       */
      "scroll-p": [{
        "scroll-p": k()
      }],
      /**
       * Scroll Padding Inline
       * @see https://tailwindcss.com/docs/scroll-padding
       */
      "scroll-px": [{
        "scroll-px": k()
      }],
      /**
       * Scroll Padding Block
       * @see https://tailwindcss.com/docs/scroll-padding
       */
      "scroll-py": [{
        "scroll-py": k()
      }],
      /**
       * Scroll Padding Inline Start
       * @see https://tailwindcss.com/docs/scroll-padding
       */
      "scroll-ps": [{
        "scroll-ps": k()
      }],
      /**
       * Scroll Padding Inline End
       * @see https://tailwindcss.com/docs/scroll-padding
       */
      "scroll-pe": [{
        "scroll-pe": k()
      }],
      /**
       * Scroll Padding Block Start
       * @see https://tailwindcss.com/docs/scroll-padding
       */
      "scroll-pbs": [{
        "scroll-pbs": k()
      }],
      /**
       * Scroll Padding Block End
       * @see https://tailwindcss.com/docs/scroll-padding
       */
      "scroll-pbe": [{
        "scroll-pbe": k()
      }],
      /**
       * Scroll Padding Top
       * @see https://tailwindcss.com/docs/scroll-padding
       */
      "scroll-pt": [{
        "scroll-pt": k()
      }],
      /**
       * Scroll Padding Right
       * @see https://tailwindcss.com/docs/scroll-padding
       */
      "scroll-pr": [{
        "scroll-pr": k()
      }],
      /**
       * Scroll Padding Bottom
       * @see https://tailwindcss.com/docs/scroll-padding
       */
      "scroll-pb": [{
        "scroll-pb": k()
      }],
      /**
       * Scroll Padding Left
       * @see https://tailwindcss.com/docs/scroll-padding
       */
      "scroll-pl": [{
        "scroll-pl": k()
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
        "will-change": ["auto", "scroll", "contents", "transform", H, j]
      }],
      // -----------
      // --- SVG ---
      // -----------
      /**
       * Fill
       * @see https://tailwindcss.com/docs/fill
       */
      fill: [{
        fill: ["none", ...F()]
      }],
      /**
       * Stroke Width
       * @see https://tailwindcss.com/docs/stroke-width
       */
      "stroke-w": [{
        stroke: [J, on, Ct, Ss]
      }],
      /**
       * Stroke
       * @see https://tailwindcss.com/docs/stroke
       */
      stroke: [{
        stroke: ["none", ...F()]
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
}, Vu = /* @__PURE__ */ bu(Bu);
function O(...e) {
  return Vu(Sa(e));
}
const ju = Yt(
  "inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 min-w-0 overflow-hidden",
  {
    variants: {
      variant: {
        // Standard Variants
        default: "bg-primary text-primary-foreground shadow hover:bg-primary/90",
        destructive: "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90",
        outline: "border border-input bg-transparent text-foreground dark:text-foreground shadow-sm hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80",
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
), xe = f.forwardRef(
  ({
    className: e,
    variant: n = "default",
    size: r,
    children: o,
    loading: s = !1,
    success: a = !1,
    error: i = !1,
    icon: l,
    asChild: u = !1,
    disabled: d,
    maxLabelLength: p = 14,
    ...c
  }, h) => {
    const g = u ? ha : "button", y = a ? "success" : i ? "destructive" : n, b = () => {
      if (s) return /* @__PURE__ */ m(Od, { className: "h-4 w-4 animate-spin" });
      if (a) return /* @__PURE__ */ m(Vn, { className: "h-4 w-4" });
      if (i) return /* @__PURE__ */ m(Xt, { className: "h-4 w-4" });
      const v = typeof o == "string" && o.length > p ? `${o.slice(0, Math.max(0, p - 1))}…` : o, S = typeof o == "string" ? /* @__PURE__ */ m(
        "span",
        {
          className: "min-w-0 flex-1 whitespace-nowrap",
          title: typeof o == "string" && typeof v == "string" && v !== o ? o : void 0,
          children: v
        }
      ) : o;
      return /* @__PURE__ */ D("span", { className: "flex min-w-0 items-center", children: [
        l && /* @__PURE__ */ m(l, { className: O("mr-2 h-4 w-4", !o && "mr-0") }),
        S
      ] });
    };
    return /* @__PURE__ */ m(
      g,
      {
        className: O(
          ju({ variant: y, size: r }),
          e
        ),
        ref: h,
        disabled: d || s || a || i,
        ...c,
        children: b()
      }
    );
  }
);
xe.displayName = "Button";
const Ns = 768;
function Hu() {
  const [e, n] = f.useState(() => typeof window < "u" && window.matchMedia ? window.matchMedia(`(max-width: ${Ns - 1}px)`).matches : !1);
  return f.useEffect(() => {
    if (typeof window > "u" || !window.matchMedia) return;
    const r = window.matchMedia(`(max-width: ${Ns - 1}px)`), o = (s) => {
      n(s.matches);
    };
    return r.addEventListener ? r.addEventListener("change", o) : r.addListener(o), n(r.matches), () => {
      r.removeEventListener ? r.removeEventListener("change", o) : r.removeListener(o);
    };
  }, []), e;
}
const qt = P.forwardRef(
  ({
    variant: e = "default",
    mobileVariant: n,
    label: r,
    icon: o,
    mobileIcon: s,
    iconOnly: a = !1,
    alwaysFull: i = !1,
    isFab: l = !1,
    className: u,
    children: d,
    size: p,
    ...c
  }, h) => {
    const g = Hu(), y = g && n ? n : e, b = g && s ? s : o, v = a || g && !i;
    return g && l ? /* @__PURE__ */ m(
      xe,
      {
        ref: h,
        variant: "fab",
        size: "icon",
        className: O("fixed bottom-6 right-6 z-50", u),
        icon: b,
        "aria-label": r,
        ...c
      }
    ) : /* @__PURE__ */ m(
      xe,
      {
        ref: h,
        variant: y,
        size: v ? "icon" : p || "default",
        className: u,
        icon: b,
        "aria-label": v ? r : void 0,
        ...c,
        children: v ? void 0 : r ?? d
      }
    );
  }
);
qt.displayName = "ActionButton";
const Wu = ({
  label: e = "Cancel",
  icon: n = Xt,
  variant: r = "secondary",
  ...o
}) => /* @__PURE__ */ m(qt, { label: e, icon: n, variant: r, ...o });
Wu.displayName = "CancelButton";
const Uu = ({
  label: e = "Create New",
  position: n = "inline",
  icon: r = Ra,
  variant: o = "default",
  ...s
}) => /* @__PURE__ */ m(
  qt,
  {
    label: e,
    icon: r,
    variant: o,
    isFab: n === "fab",
    ...s
  }
);
Uu.displayName = "CreateButton";
const Gu = ({
  label: e = "Delete",
  icon: n = Kd,
  variant: r = "destructive",
  ...o
}) => /* @__PURE__ */ m(qt, { label: e, icon: n, variant: r, ...o });
Gu.displayName = "DeleteButton";
const Ku = ({
  label: e = "Edit",
  icon: n = $d,
  variant: r = "secondary",
  ...o
}) => /* @__PURE__ */ m(qt, { label: e, icon: n, variant: r, ...o });
Ku.displayName = "EditButton";
const Yu = ({
  label: e = "Save",
  icon: n = Hd,
  variant: r = "default",
  ...o
}) => /* @__PURE__ */ m(qt, { label: e, icon: n, variant: r, ...o });
Yu.displayName = "SaveButton";
const ln = ({
  text: e,
  width: n,
  className: r = "",
  style: o = {},
  as: s = "div"
}) => {
  const a = an(null), i = an(null), [l, u] = Ke(1), [d, p] = Ke(!1);
  ua(() => {
    const g = a.current, y = i.current;
    if (!g || !y) return;
    const b = () => {
      u(1), p(!1);
      let v = 0;
      if (typeof n == "number" ? v = n : typeof n == "string" && n.endsWith("px") ? v = Number.parseFloat(n) : v = g.clientWidth, v <= 0) return;
      const S = y.scrollWidth / v;
      S <= 1 ? (u(1), p(!1)) : S <= 1.3 ? (u(1 / S), p(!1)) : (u(1), p(!0));
    };
    if (b(), !n) {
      const v = new ResizeObserver(() => {
        b();
      });
      return v.observe(g), () => v.disconnect();
    }
  }, [e, n]);
  const c = {
    ...o,
    width: n,
    whiteSpace: "nowrap",
    overflow: d ? "hidden" : "visible",
    textOverflow: d ? "ellipsis" : "clip",
    display: "block"
    // Ensure block/inline-block for width to apply
  }, h = {
    display: "inline-block",
    transform: l < 1 ? `scale(${l})` : "none",
    transformOrigin: "left center",
    width: l < 1 ? `${1 / l * 100}%` : "auto"
    // Compensate width when scaled
  };
  return /* @__PURE__ */ m(
    s,
    {
      ref: a,
      className: `adaptive-text-container ${r}`,
      style: c,
      title: d ? e : void 0,
      children: /* @__PURE__ */ m("span", { ref: i, style: h, children: e })
    }
  );
}, Xu = ({
  error: e,
  onRetry: n,
  className: r = "",
  title: o,
  message: s,
  retryText: a = "再読み込み"
}) => {
  const i = (c) => ({
    title: "Error",
    message: c?.message ?? "Something went wrong."
  }), { title: l, message: u } = i(e), d = o || l, p = s || u;
  return /* @__PURE__ */ D(
    "div",
    {
      className: O(
        "flex flex-col items-center justify-center p-8 text-center bg-card rounded-lg border border-border/50",
        r
      ),
      children: [
        /* @__PURE__ */ m("div", { className: "bg-destructive/10 p-4 rounded-full mb-4", children: /* @__PURE__ */ m(Na, { className: "h-8 w-8 text-destructive" }) }),
        /* @__PURE__ */ m("h3", { className: "text-lg font-semibold text-foreground mb-2", children: d }),
        /* @__PURE__ */ m("p", { className: "text-sm text-muted-foreground mb-6 max-w-sm", children: p }),
        n && /* @__PURE__ */ D(xe, { onClick: n, variant: "outline", className: "gap-2", children: [
          /* @__PURE__ */ m(Vd, { className: "h-4 w-4" }),
          a
        ] })
      ]
    }
  );
}, qu = {
  xs: "h-4 w-4 border-2",
  sm: "h-6 w-6 border-2",
  md: "h-8 w-8 border-[3px]",
  lg: "h-12 w-12 border-[3px]",
  xl: "h-16 w-16 border-4"
}, Zu = {
  primary: "border-theme-object-primary border-t-transparent",
  secondary: "border-theme-text-secondary border-t-transparent",
  accent: "border-theme-accent border-t-transparent"
}, Et = f.memo(
  ({ size: e = "md", variant: n = "primary", className: r, ...o }) => {
    const s = (a, i) => i ?? a;
    return /* @__PURE__ */ D(
      "output",
      {
        "aria-live": "polite",
        "aria-label": "Loading",
        className: O("inline-block", r),
        ...o,
        children: [
          /* @__PURE__ */ m(
            "div",
            {
              className: O(
                "animate-spin rounded-full",
                qu[e],
                Zu[n]
              )
            }
          ),
          /* @__PURE__ */ m("span", { className: "sr-only", children: s("loading") })
        ]
      }
    );
  }
);
Et.displayName = "Spinner";
const ja = f.memo(
  ({
    className: e,
    showSpinner: n = !1,
    spinnerSize: r = "md",
    spinnerVariant: o = "primary",
    ...s
  }) => /* @__PURE__ */ m(
    "div",
    {
      className: O(
        "animate-pulse rounded-md bg-card opacity-50",
        n && "relative flex items-center justify-center",
        e
      ),
      ...s,
      children: n && /* @__PURE__ */ m("div", { className: "absolute inset-0 flex items-center justify-center", children: /* @__PURE__ */ m(Et, { size: r, variant: o }) })
    }
  )
);
ja.displayName = "Skeleton";
const Ub = ({
  isLoading: e,
  isError: n,
  refetch: r,
  children: o,
  isFetching: s,
  className: a,
  isEmpty: i,
  emptyMessage: l,
  useSkeletonLoading: u = !0,
  loadingText: d = "Loading...",
  noDataText: p = "No data available",
  refreshText: c = "Refresh data"
}) => {
  if (n)
    return /* @__PURE__ */ m(
      "div",
      {
        className: O("h-full flex items-center justify-center p-8", a),
        children: /* @__PURE__ */ m(Xu, { error: n, onRetry: () => r() })
      }
    );
  if (e) {
    if (u) {
      const h = [
        "skeleton-1",
        "skeleton-2",
        "skeleton-3",
        "skeleton-4",
        "skeleton-5"
      ];
      return /* @__PURE__ */ D(
        "div",
        {
          className: O(
            "relative h-full w-full overflow-hidden p-4 space-y-4",
            a
          ),
          children: [
            /* @__PURE__ */ m("div", { className: "space-y-4 opacity-50", children: h.map((g) => /* @__PURE__ */ m(ja, { className: "h-16 w-full rounded-lg" }, g)) }),
            /* @__PURE__ */ D("div", { className: "absolute inset-0 flex flex-col items-center justify-center gap-2 z-10", children: [
              /* @__PURE__ */ m(Et, { size: "lg" }),
              /* @__PURE__ */ m("div", { className: "text-muted-foreground font-medium", children: d })
            ] })
          ]
        }
      );
    }
    return /* @__PURE__ */ D(
      "div",
      {
        className: O(
          "flex flex-col h-64 items-center justify-center gap-2",
          a
        ),
        children: [
          /* @__PURE__ */ m(Et, { size: "lg" }),
          /* @__PURE__ */ m("div", { className: "text-muted-foreground", children: d })
        ]
      }
    );
  }
  return i ? /* @__PURE__ */ D(
    "div",
    {
      className: O(
        "flex flex-col h-64 items-center justify-center gap-4 text-center p-8 border-2 border-dashed rounded-lg bg-muted/20",
        a
      ),
      children: [
        /* @__PURE__ */ m("div", { className: "text-muted-foreground", children: l || p }),
        /* @__PURE__ */ m(
          "button",
          {
            type: "button",
            onClick: () => r(),
            className: "text-sm text-primary hover:underline hover:text-primary/80 transition-colors",
            children: c
          }
        )
      ]
    }
  ) : /* @__PURE__ */ D("div", { className: O("relative", a), children: [
    s && !e && /* @__PURE__ */ D("div", { className: "absolute right-4 top-3 flex items-center gap-2 text-xs text-muted-foreground z-20 pointer-events-none", children: [
      /* @__PURE__ */ m(Et, { size: "sm", variant: "secondary" }),
      /* @__PURE__ */ m("span", { children: d })
    ] }),
    o
  ] });
}, Qu = {
  xs: "h-7 w-7 text-xs",
  sm: "h-8 w-8 text-xs",
  md: "h-11 w-11 text-sm",
  lg: "h-16 w-16 text-lg",
  xl: "h-20 w-20 text-xl"
}, Ju = f.memo(
  f.forwardRef(
    ({ src: e, alt: n, fallback: r, size: o = "md", className: s, ...a }, i) => {
      const [l, u] = f.useState(!1), d = () => !r && !n ? "?" : typeof r == "string" ? r.split(" ").map((p) => p[0]).join("").toUpperCase().slice(0, 2) : n ? n.split(" ").map((p) => p[0]).join("").toUpperCase().slice(0, 2) : "?";
      return /* @__PURE__ */ m(
        "div",
        {
          ref: i,
          className: O(
            "relative flex shrink-0 overflow-hidden rounded-full",
            Qu[o],
            s
          ),
          ...a,
          children: e && !l ? /* @__PURE__ */ m(
            "img",
            {
              src: e,
              alt: n || "Avatar",
              className: "h-full w-full object-cover",
              onError: () => u(!0)
            }
          ) : /* @__PURE__ */ m("div", { className: "flex h-full w-full items-center justify-center bg-muted text-muted-foreground", children: f.isValidElement(r) ? r : d() })
        }
      );
    }
  )
);
Ju.displayName = "Avatar";
const ef = Yt(
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
), Gb = f.memo(
  ({ className: e, variant: n, label: r, pill: o, children: s, ...a }) => /* @__PURE__ */ m("div", { className: O(ef({ variant: n }), e), ...a, children: r ?? s })
);
var tf = Object.defineProperty, Zt = (e, n) => tf(e, "name", { value: n, configurable: !0 }), Ha = !!(typeof window < "u" && window.document && window.document.createElement);
function X(e, n, { checkForDefaultPrevented: r = !0 } = {}) {
  return /* @__PURE__ */ Zt(function(s) {
    if (e?.(s), r === !1 || !s || !s.defaultPrevented)
      return n?.(s);
  }, "handleEvent");
}
Zt(X, "composeEventHandlers");
function nf(e) {
  if (!Ha)
    throw new Error("Cannot access window outside of the DOM");
  return e?.ownerDocument?.defaultView ?? window;
}
Zt(nf, "getOwnerWindow");
function $r(e) {
  if (!Ha)
    throw new Error("Cannot access document outside of the DOM");
  return e?.ownerDocument ?? document;
}
Zt($r, "getOwnerDocument");
function Wa(e, n = !1) {
  const { activeElement: r } = $r(e);
  if (!r?.nodeName)
    return null;
  if (Ua(r) && r.contentDocument)
    return Wa(r.contentDocument.body, n);
  if (n) {
    const o = r.getAttribute("aria-activedescendant");
    if (o) {
      const s = $r(r).getElementById(o);
      if (s)
        return s;
    }
  }
  return r;
}
Zt(Wa, "getActiveElement");
function Ua(e) {
  return e.tagName === "IFRAME";
}
Zt(Ua, "isFrame");
var rf = Object.defineProperty, De = (e, n) => rf(e, "name", { value: n, configurable: !0 });
// @__NO_SIDE_EFFECTS__
function of(e, n) {
  const r = f.createContext(n);
  r.displayName = e + "Context";
  const o = /* @__PURE__ */ De((a) => {
    const { children: i, ...l } = a, u = f.useMemo(() => l, Object.values(l));
    return /* @__PURE__ */ m(r.Provider, { value: u, children: i });
  }, "Provider");
  o.displayName = e + "Provider";
  function s(a, i = {}) {
    const { optional: l = !1 } = i, u = f.useContext(r);
    if (u) return u;
    if (n !== void 0) return n;
    if (!l)
      throw new Error(`\`${a}\` must be used within \`${e}\``);
  }
  return De(s, "useContext"), [o, s];
}
De(of, "createContext");
// @__NO_SIDE_EFFECTS__
function Ie(e, n = []) {
  let r = [];
  function o(a, i) {
    const l = f.createContext(i);
    l.displayName = a + "Context";
    const u = r.length;
    r = [...r, i];
    const d = /* @__PURE__ */ De((c) => {
      const { scope: h, children: g, ...y } = c, b = h?.[e]?.[u] || l, v = f.useMemo(() => y, Object.values(y));
      return /* @__PURE__ */ m(b.Provider, { value: v, children: g });
    }, "Provider");
    d.displayName = a + "Provider";
    function p(c, h, g = {}) {
      const { optional: y = !1 } = g, b = h?.[e]?.[u] || l, v = f.useContext(b);
      if (v) return v;
      if (i !== void 0) return i;
      if (!y)
        throw new Error(`\`${c}\` must be used within \`${a}\``);
    }
    return De(p, "useContext"), [d, p];
  }
  De(o, "createContext");
  const s = /* @__PURE__ */ De(() => {
    const a = r.map((i) => f.createContext(i));
    return /* @__PURE__ */ De(function(l) {
      const u = l?.[e] || a;
      return f.useMemo(
        () => ({ [`__scope${e}`]: { ...l, [e]: u } }),
        [l, u]
      );
    }, "useScope");
  }, "createScope");
  return s.scopeName = e, [o, Ga(s, ...n)];
}
De(Ie, "createContextScope");
function Ga(...e) {
  const n = e[0];
  if (e.length === 1) return n;
  const r = /* @__PURE__ */ De(() => {
    const o = e.map((s) => ({
      useScope: s(),
      scopeName: s.scopeName
    }));
    return /* @__PURE__ */ De(function(a) {
      const i = o.reduce((l, { useScope: u, scopeName: d }) => {
        const c = u(a)[`__scope${d}`];
        return { ...l, ...c };
      }, {});
      return f.useMemo(() => ({ [`__scope${n.scopeName}`]: i }), [i]);
    }, "useComposedScopes");
  }, "createScope");
  return r.scopeName = n.scopeName, r;
}
De(Ga, "composeContextScopes");
var ue = globalThis?.document ? f.useLayoutEffect : () => {
}, sf = Object.defineProperty, af = (e, n) => sf(e, "name", { value: n, configurable: !0 }), lf = f[" useId ".trim().toString()] || (() => {
}), cf = 0;
function Me(e) {
  const [n, r] = f.useState(lf());
  return ue(() => {
    e || r((o) => o ?? String(cf++));
  }, [e]), e || (n ? `radix-${n}` : "");
}
af(Me, "useId");
var df = Object.defineProperty, uf = (e, n) => df(e, "name", { value: n, configurable: !0 }), Rs = f[" useEffectEvent ".trim().toString()], Ps = f[" useInsertionEffect ".trim().toString()];
function Ka(e) {
  if (typeof Rs == "function")
    return Rs(e);
  const n = f.useRef(() => {
    throw new Error("Cannot call an event handler while rendering.");
  });
  return typeof Ps == "function" ? Ps(() => {
    n.current = e;
  }) : ue(() => {
    n.current = e;
  }), f.useMemo(() => ((...r) => n.current?.(...r)), []);
}
uf(Ka, "useEffectEvent");
var ff = Object.defineProperty, gn = (e, n) => ff(e, "name", { value: n, configurable: !0 }), mf = f[" useInsertionEffect ".trim().toString()] || ue;
function Xe({
  prop: e,
  defaultProp: n,
  onChange: r = /* @__PURE__ */ gn(() => {
  }, "onChange"),
  caller: o
}) {
  const [s, a, i] = Ya({
    defaultProp: n,
    onChange: r
  }), l = e !== void 0, u = l ? e : s, d = f.useCallback(
    (p) => {
      if (l) {
        const c = Xa(p) ? p(e) : p;
        c !== e && i.current?.(c);
      } else
        a(p);
    },
    [l, e, a, i]
  );
  return [u, d];
}
gn(Xe, "useControllableState");
function Ya({
  defaultProp: e,
  onChange: n
}) {
  const [r, o] = f.useState(e), s = f.useRef(r), a = f.useRef(n);
  return mf(() => {
    a.current = n;
  }, [n]), f.useEffect(() => {
    s.current !== r && (a.current?.(r), s.current = r);
  }, [r, s]), [r, o, a];
}
gn(Ya, "useUncontrolledState");
function Xa(e) {
  return typeof e == "function";
}
gn(Xa, "isFunction");
var Ts = /* @__PURE__ */ Symbol("RADIX:SYNC_STATE");
function pf(e, n, r, o) {
  const { prop: s, defaultProp: a, onChange: i, caller: l } = n, u = s !== void 0, d = Ka(i), p = [{ ...r, state: a }];
  o && p.push(o);
  const [c, h] = f.useReducer(
    (v, x) => {
      if (x.type === Ts)
        return { ...v, state: x.state };
      const S = e(v, x);
      return u && !Object.is(S.state, v.state) && d(S.state), S;
    },
    ...p
  ), g = c.state, y = f.useRef(g);
  f.useEffect(() => {
    y.current !== g && (y.current = g, u || d(g));
  }, [g, y, u]);
  const b = f.useMemo(() => s !== void 0 ? { ...c, state: s } : c, [c, s]);
  return f.useEffect(() => {
    u && !Object.is(s, c.state) && h({ type: Ts, state: s });
  }, [s, c.state, u]), [b, h];
}
gn(pf, "useControllableStateReducer");
var hf = Object.defineProperty, gf = (e, n) => hf(e, "name", { value: n, configurable: !0 }), vf = [
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
], Q = vf.reduce((e, n) => {
  const r = /* @__PURE__ */ Ye(`Primitive.${n}`), o = f.forwardRef((s, a) => {
    const { asChild: i, ...l } = s, u = i ? r : n;
    return typeof window < "u" && (window[/* @__PURE__ */ Symbol.for("radix-ui")] = !0), /* @__PURE__ */ m(u, { ...l, ref: a });
  });
  return o.displayName = `Primitive.${n}`, { ...e, [n]: o };
}, {});
function qa(e, n) {
  e && hn.flushSync(() => e.dispatchEvent(n));
}
gf(qa, "dispatchDiscreteCustomEvent");
var bf = Object.defineProperty, yf = (e, n) => bf(e, "name", { value: n, configurable: !0 });
function Fe(e) {
  const n = f.useRef(e);
  return f.useEffect(() => {
    n.current = e;
  }), f.useMemo(() => ((...r) => n.current?.(...r)), []);
}
yf(Fe, "useCallbackRef");
var xf = Object.defineProperty, ge = (e, n) => xf(e, "name", { value: n, configurable: !0 }), zr = "dismissableLayer.update", wf = "dismissableLayer.pointerDownOutside", Cf = "dismissableLayer.focusOutside", _s, Za = f.createContext({
  layers: /* @__PURE__ */ new Set(),
  layersWithOutsidePointerEventsDisabled: /* @__PURE__ */ new Set(),
  branches: /* @__PURE__ */ new Set(),
  // Outside elements that belong to a layer's own dismiss affordance (eg, a
  // dialog overlay). Pressing them should dismiss the layer regardless of
  // whether or not they stop propagation.
  //
  // See https://github.com/radix-ui/primitives/issues/3346
  dismissableSurfaces: /* @__PURE__ */ new Set()
}), qn = /* @__PURE__ */ f.forwardRef(
  // blank line to reduce diff noise
  /* @__PURE__ */ ge(function(n, r) {
    const {
      disableOutsidePointerEvents: o = !1,
      deferPointerDownOutside: s = !1,
      onEscapeKeyDown: a,
      onPointerDownOutside: i,
      onFocusOutside: l,
      onInteractOutside: u,
      onDismiss: d,
      ...p
    } = n, c = f.useContext(Za), [h, g] = f.useState(null), y = h?.ownerDocument ?? globalThis?.document, [, b] = f.useState({}), v = oe(r, g), x = Array.from(c.layers), [S] = [
      ...c.layersWithOutsidePointerEventsDisabled
    ].slice(-1), w = S ? x.indexOf(S) : -1, C = h ? x.indexOf(h) : -1, N = c.layersWithOutsidePointerEventsDisabled.size > 0, R = C >= w, E = f.useRef(!1), k = Ja(
      (A) => {
        i?.(A), u?.(A), A.defaultPrevented || d?.();
      },
      {
        ownerDocument: y,
        deferPointerDownOutside: s,
        isDeferredPointerDownOutsideRef: E,
        dismissableSurfaces: c.dismissableSurfaces,
        shouldHandlePointerDownOutside: f.useCallback(
          (A) => {
            if (!(A instanceof Node))
              return !1;
            const _ = [...c.branches].some(
              (M) => M.contains(A)
            );
            return R && !_;
          },
          [c.branches, R]
        )
      }
    ), T = ei((A) => {
      if (s && E.current)
        return;
      const _ = A.target;
      [...c.branches].some((U) => U.contains(_)) || (l?.(A), u?.(A), A.defaultPrevented || d?.());
    }, y), I = h ? C === x.length - 1 : !1, L = Fe((A) => {
      A.key === "Escape" && (a?.(A), !A.defaultPrevented && d && (A.preventDefault(), d()));
    });
    return f.useEffect(() => {
      if (I)
        return y.addEventListener("keydown", L, { capture: !0 }), () => y.removeEventListener("keydown", L, { capture: !0 });
    }, [y, I, L]), f.useEffect(() => {
      if (h)
        return o && (c.layersWithOutsidePointerEventsDisabled.size === 0 && (_s = y.body.style.pointerEvents, y.body.style.pointerEvents = "none"), c.layersWithOutsidePointerEventsDisabled.add(h)), c.layers.add(h), Br(), () => {
          o && (c.layersWithOutsidePointerEventsDisabled.delete(h), c.layersWithOutsidePointerEventsDisabled.size === 0 && (y.body.style.pointerEvents = _s));
        };
    }, [h, y, o, c]), f.useEffect(() => () => {
      h && (c.layers.delete(h), c.layersWithOutsidePointerEventsDisabled.delete(h), Br());
    }, [h, c]), f.useEffect(() => {
      const A = /* @__PURE__ */ ge(() => b({}), "handleUpdate");
      return document.addEventListener(zr, A), () => document.removeEventListener(zr, A);
    }, []), /* @__PURE__ */ m(
      Q.div,
      {
        ...p,
        ref: v,
        style: {
          pointerEvents: N ? R ? "auto" : "none" : void 0,
          ...n.style
        },
        onFocusCapture: X(n.onFocusCapture, T.onFocusCapture),
        onBlurCapture: X(n.onBlurCapture, T.onBlurCapture),
        onPointerDownCapture: X(
          n.onPointerDownCapture,
          k.onPointerDownCapture
        )
      }
    );
  }, "DismissableLayer")
);
function Qa() {
  const e = f.useContext(Za), [n, r] = f.useState(null);
  return f.useEffect(() => {
    if (n)
      return e.dismissableSurfaces.add(n), () => {
        e.dismissableSurfaces.delete(n);
      };
  }, [n, e.dismissableSurfaces]), r;
}
ge(Qa, "useDismissableLayerSurface");
var Sf = /* @__PURE__ */ ge(() => !0, "IS_TRUE");
function Ja(e, n) {
  const {
    ownerDocument: r = globalThis?.document,
    deferPointerDownOutside: o = !1,
    isDeferredPointerDownOutsideRef: s,
    dismissableSurfaces: a,
    shouldHandlePointerDownOutside: i = Sf
  } = n, l = Fe(e), u = f.useRef(!1), d = f.useRef(!1), p = f.useRef(/* @__PURE__ */ new Map()), c = f.useRef(() => {
  });
  return f.useEffect(() => {
    function h() {
      d.current = !1, s.current = !1, p.current.clear();
    }
    ge(h, "resetOutsideInteraction");
    function g() {
      return Array.from(p.current.values()).some(Boolean);
    }
    ge(g, "isOutsideInteractionIntercepted");
    function y(w) {
      if (!d.current)
        return;
      const C = w.target;
      C instanceof Node && [...a].some((R) => R.contains(C)) || p.current.set(w.type, !0), w.type === "click" && window.setTimeout(() => {
        d.current && c.current();
      }, 0);
    }
    ge(y, "handleInteractionCapture");
    function b(w) {
      d.current && p.current.set(w.type, !1);
    }
    ge(b, "handleInteractionBubble");
    const v = /* @__PURE__ */ ge((w) => {
      if (w.target && !u.current) {
        let C = function() {
          r.removeEventListener("click", c.current);
          const R = g();
          h(), R || io(
            wf,
            l,
            N,
            { discrete: !0 }
          );
        };
        if (ge(C, "handleAndDispatchPointerDownOutsideEvent"), !i(w.target)) {
          r.removeEventListener("click", c.current), h(), u.current = !1;
          return;
        }
        const N = { originalEvent: w };
        d.current = !0, s.current = o && w.button === 0, p.current.clear(), !o || w.button !== 0 ? C() : (r.removeEventListener("click", c.current), c.current = C, r.addEventListener("click", c.current, { once: !0 }));
      } else
        r.removeEventListener("click", c.current), h();
      u.current = !1;
    }, "handlePointerDown"), x = [
      "pointerup",
      "mousedown",
      "mouseup",
      "touchstart",
      "touchend",
      "click"
    ];
    for (const w of x)
      r.addEventListener(w, y, !0), r.addEventListener(w, b);
    const S = window.setTimeout(() => {
      r.addEventListener("pointerdown", v);
    }, 0);
    return () => {
      window.clearTimeout(S), r.removeEventListener("pointerdown", v), r.removeEventListener("click", c.current);
      for (const w of x)
        r.removeEventListener(w, y, !0), r.removeEventListener(w, b);
    };
  }, [
    r,
    l,
    o,
    s,
    a,
    i
  ]), {
    // ensures we check React component tree (not just DOM tree)
    onPointerDownCapture: /* @__PURE__ */ ge(() => u.current = !0, "onPointerDownCapture")
  };
}
ge(Ja, "usePointerDownOutside");
function ei(e, n = globalThis?.document) {
  const r = Fe(e), o = f.useRef(!1);
  return f.useEffect(() => {
    const s = /* @__PURE__ */ ge((a) => {
      a.target && !o.current && io(Cf, r, { originalEvent: a }, {
        discrete: !1
      });
    }, "handleFocus");
    return n.addEventListener("focusin", s), () => n.removeEventListener("focusin", s);
  }, [n, r]), {
    onFocusCapture: /* @__PURE__ */ ge(() => o.current = !0, "onFocusCapture"),
    onBlurCapture: /* @__PURE__ */ ge(() => o.current = !1, "onBlurCapture")
  };
}
ge(ei, "useFocusOutside");
function Br() {
  const e = new CustomEvent(zr);
  document.dispatchEvent(e);
}
ge(Br, "dispatchUpdate");
function io(e, n, r, { discrete: o }) {
  const s = r.originalEvent.target, a = new CustomEvent(e, { bubbles: !1, cancelable: !0, detail: r });
  n && s.addEventListener(e, n, { once: !0 }), o ? qa(s, a) : s.dispatchEvent(a);
}
ge(io, "handleAndDispatchCustomEvent");
var kf = Object.defineProperty, ke = (e, n) => kf(e, "name", { value: n, configurable: !0 }), br = "focusScope.autoFocusOnMount", yr = "focusScope.autoFocusOnUnmount", Is = { bubbles: !1, cancelable: !0 }, lo = /* @__PURE__ */ f.forwardRef(
  /* @__PURE__ */ ke(function(n, r) {
    const {
      loop: o = !1,
      trapped: s = !1,
      onMountAutoFocus: a,
      onUnmountAutoFocus: i,
      ...l
    } = n, [u, d] = f.useState(null), p = Fe(a), c = Fe(i), h = f.useRef(null), g = oe(r, d), y = f.useRef({
      paused: !1,
      pause() {
        this.paused = !0;
      },
      resume() {
        this.paused = !1;
      }
    }).current;
    f.useEffect(() => {
      if (s) {
        let v = function(C) {
          if (y.paused || !u) return;
          const N = C.target;
          u.contains(N) ? h.current = N : nt(h.current, { select: !0 });
        }, x = function(C) {
          if (y.paused || !u) return;
          const N = C.relatedTarget;
          N !== null && (u.contains(N) || nt(h.current, { select: !0 }));
        }, S = function(C) {
          if (document.activeElement === document.body)
            for (const R of C)
              R.removedNodes.length > 0 && nt(u);
        };
        ke(v, "handleFocusIn"), ke(x, "handleFocusOut"), ke(S, "handleMutations"), document.addEventListener("focusin", v), document.addEventListener("focusout", x);
        const w = new MutationObserver(S);
        return u && w.observe(u, { childList: !0, subtree: !0 }), () => {
          document.removeEventListener("focusin", v), document.removeEventListener("focusout", x), w.disconnect();
        };
      }
    }, [s, u, y.paused]), f.useEffect(() => {
      if (u) {
        Os.add(y);
        const v = document.activeElement;
        if (!u.contains(v)) {
          const S = new CustomEvent(br, Is);
          u.addEventListener(br, p), u.dispatchEvent(S), S.defaultPrevented || (ti(ai(co(u)), { select: !0 }), document.activeElement === v && nt(u));
        }
        return () => {
          u.removeEventListener(br, p), setTimeout(() => {
            const S = new CustomEvent(yr, Is);
            u.addEventListener(yr, c), u.dispatchEvent(S), S.defaultPrevented || nt(v ?? document.body, { select: !0 }), u.removeEventListener(yr, c), Os.remove(y);
          }, 0);
        };
      }
    }, [u, p, c, y]);
    const b = f.useCallback(
      (v) => {
        if (!o && !s || y.paused) return;
        const x = v.key === "Tab" && !v.altKey && !v.ctrlKey && !v.metaKey, S = document.activeElement;
        if (x && S) {
          const w = v.currentTarget, [C, N] = ni(w);
          C && N ? !v.shiftKey && S === N ? (v.preventDefault(), o && nt(C, { select: !0 })) : v.shiftKey && S === C && (v.preventDefault(), o && nt(N, { select: !0 })) : S === w && v.preventDefault();
        }
      },
      [o, s, y.paused]
    );
    return /* @__PURE__ */ m(Q.div, { tabIndex: -1, ...l, ref: g, onKeyDown: b });
  }, "FocusScope")
);
function ti(e, { select: n = !1 } = {}) {
  const r = document.activeElement;
  for (const o of e)
    if (nt(o, { select: n }), document.activeElement !== r) return;
}
ke(ti, "focusFirst");
function ni(e) {
  const n = co(e), r = Vr(n, e), o = Vr(n.reverse(), e);
  return [r, o];
}
ke(ni, "getTabbableEdges");
function co(e) {
  const n = [], r = document.createTreeWalker(e, NodeFilter.SHOW_ELEMENT, {
    acceptNode: /* @__PURE__ */ ke((o) => {
      const s = o.tagName === "INPUT" && o.type === "hidden";
      return o.disabled || o.hidden || s ? NodeFilter.FILTER_SKIP : o.tabIndex >= 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    }, "acceptNode")
  });
  for (; r.nextNode(); ) n.push(r.currentNode);
  return n;
}
ke(co, "getTabbableCandidates");
function Vr(e, n) {
  const r = typeof n.checkVisibility == "function" && n.checkVisibility({ checkVisibilityCSS: !0 });
  for (const o of e)
    if (!(r ? !o.checkVisibility({ checkVisibilityCSS: !0 }) : ri(o, { upTo: n })))
      return o;
}
ke(Vr, "findVisible");
function ri(e, { upTo: n }) {
  if (getComputedStyle(e).visibility === "hidden") return !0;
  for (; e; ) {
    if (n !== void 0 && e === n) return !1;
    if (getComputedStyle(e).display === "none") return !0;
    e = e.parentElement;
  }
  return !1;
}
ke(ri, "isHidden");
function oi(e) {
  return e instanceof HTMLInputElement && "select" in e;
}
ke(oi, "isSelectableInput");
function nt(e, { select: n = !1 } = {}) {
  if (e && e.focus) {
    const r = document.activeElement;
    e.focus({ preventScroll: !0 }), e !== r && oi(e) && n && e.select();
  }
}
ke(nt, "focus");
var Os = si();
function si() {
  let e = [];
  return {
    add(n) {
      const r = e[0];
      n !== r && r?.pause(), e = jr(e, n), e.unshift(n);
    },
    remove(n) {
      e = jr(e, n), e[0]?.resume();
    }
  };
}
ke(si, "createFocusScopesStack");
function jr(e, n) {
  const r = [...e], o = r.indexOf(n);
  return o !== -1 && r.splice(o, 1), r;
}
ke(jr, "arrayRemove");
function ai(e) {
  return e.filter((n) => n.tagName !== "A");
}
ke(ai, "removeLinks");
var Ef = Object.defineProperty, Nf = (e, n) => Ef(e, "name", { value: n, configurable: !0 }), uo = /* @__PURE__ */ f.forwardRef(
  /* @__PURE__ */ Nf(function(n, r) {
    const { container: o, ...s } = n, [a, i] = f.useState(!1);
    ue(() => i(!0), []);
    const l = o || a && globalThis?.document?.body;
    return l ? hn.createPortal(/* @__PURE__ */ m(Q.div, { ...s, ref: r }), l) : null;
  }, "Portal")
), Rf = Object.defineProperty, it = (e, n) => Rf(e, "name", { value: n, configurable: !0 });
function ii(e, n) {
  return f.useReducer((r, o) => n[r][o] ?? r, e);
}
it(ii, "useStateMachine");
var ct = /* @__PURE__ */ it((e) => {
  const { present: n, children: r } = e, o = li(n), s = typeof r == "function" ? r({ present: o.isPresent }) : f.Children.only(r), a = ci(o.ref, di(s));
  return typeof r == "function" || o.isPresent ? f.cloneElement(s, { ref: a }) : null;
}, "Presence");
function li(e) {
  const [n, r] = f.useState(), o = f.useRef(null), s = f.useRef(e), a = f.useRef("none"), i = f.useRef(void 0), l = e ? "mounted" : "unmounted", [u, d] = ii(l, {
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
  return f.useEffect(() => {
    u === "mounted" ? (a.current = i.current ?? Wt(o.current), i.current = void 0) : a.current = "none";
  }, [u]), ue(() => {
    const p = o.current, c = s.current;
    if (c !== e) {
      const g = a.current, y = Wt(p);
      e ? (i.current = y, d("MOUNT")) : y === "none" || p?.display === "none" ? d("UNMOUNT") : d(c && g !== y ? "ANIMATION_OUT" : "UNMOUNT"), s.current = e;
    }
  }, [e, d]), ue(() => {
    if (n) {
      let p;
      const c = n.ownerDocument.defaultView ?? window, h = /* @__PURE__ */ it((y) => {
        const v = Wt(o.current).includes(CSS.escape(y.animationName));
        if (y.target === n && v && (d("ANIMATION_END"), !s.current)) {
          const x = n.style.animationFillMode;
          n.style.animationFillMode = "forwards", p = c.setTimeout(() => {
            n.style.animationFillMode === "forwards" && (n.style.animationFillMode = x);
          });
        }
      }, "handleAnimationEnd"), g = /* @__PURE__ */ it((y) => {
        y.target === n && (a.current = Wt(o.current));
      }, "handleAnimationStart");
      return n.addEventListener("animationstart", g), n.addEventListener("animationcancel", h), n.addEventListener("animationend", h), () => {
        c.clearTimeout(p), n.removeEventListener("animationstart", g), n.removeEventListener("animationcancel", h), n.removeEventListener("animationend", h);
      };
    } else
      d("ANIMATION_END");
  }, [n, d]), {
    isPresent: ["mounted", "unmountSuspended"].includes(u),
    ref: f.useCallback((p) => {
      if (p) {
        const c = getComputedStyle(p);
        o.current = c, i.current = Wt(c);
      } else
        o.current = null;
      r(p);
    }, [])
  };
}
it(li, "usePresence");
function Hr(e, n) {
  if (typeof e == "function")
    return e(n);
  e != null && (e.current = n);
}
it(Hr, "setRef");
function ci(...e) {
  const n = f.useRef(e);
  return n.current = e, f.useCallback((r) => {
    const o = n.current;
    let s = !1;
    const a = o.map((i) => {
      const l = Hr(i, r);
      return !s && typeof l == "function" && (s = !0), l;
    });
    if (s)
      return () => {
        for (let i = 0; i < a.length; i++) {
          const l = a[i];
          typeof l == "function" ? l() : Hr(o[i], null);
        }
      };
  }, []);
}
it(ci, "useStableComposedRefs");
function Wt(e) {
  return e?.animationName || "none";
}
it(Wt, "getAnimationName");
function di(e) {
  let n = Object.getOwnPropertyDescriptor(e.props, "ref")?.get, r = n && "isReactWarning" in n && n.isReactWarning;
  return r ? e.ref : (n = Object.getOwnPropertyDescriptor(e, "ref")?.get, r = n && "isReactWarning" in n && n.isReactWarning, r ? e.props.ref : e.props.ref || e.ref);
}
it(di, "getElementRef");
var Pf = Object.defineProperty, fo = (e, n) => Pf(e, "name", { value: n, configurable: !0 }), Nn = 0, Bt = null;
function Tf(e) {
  return vn(), e.children;
}
fo(Tf, "FocusGuards");
function vn() {
  f.useEffect(() => {
    Bt || (Bt = { start: Wr(), end: Wr() });
    const { start: e, end: n } = Bt;
    return document.body.firstElementChild !== e && document.body.insertAdjacentElement("afterbegin", e), document.body.lastElementChild !== n && document.body.insertAdjacentElement("beforeend", n), Nn++, () => {
      Nn === 1 && (Bt?.start.remove(), Bt?.end.remove(), Bt = null), Nn = Math.max(0, Nn - 1);
    };
  }, []);
}
fo(vn, "useFocusGuards");
function Wr() {
  const e = document.createElement("span");
  return e.setAttribute("data-radix-focus-guard", ""), e.tabIndex = 0, e.style.outline = "none", e.style.opacity = "0", e.style.position = "fixed", e.style.pointerEvents = "none", e;
}
fo(Wr, "createFocusGuard");
var Ue = function() {
  return Ue = Object.assign || function(n) {
    for (var r, o = 1, s = arguments.length; o < s; o++) {
      r = arguments[o];
      for (var a in r) Object.prototype.hasOwnProperty.call(r, a) && (n[a] = r[a]);
    }
    return n;
  }, Ue.apply(this, arguments);
};
function ui(e, n) {
  var r = {};
  for (var o in e) Object.prototype.hasOwnProperty.call(e, o) && n.indexOf(o) < 0 && (r[o] = e[o]);
  if (e != null && typeof Object.getOwnPropertySymbols == "function")
    for (var s = 0, o = Object.getOwnPropertySymbols(e); s < o.length; s++)
      n.indexOf(o[s]) < 0 && Object.prototype.propertyIsEnumerable.call(e, o[s]) && (r[o[s]] = e[o[s]]);
  return r;
}
function _f(e, n, r) {
  if (r || arguments.length === 2) for (var o = 0, s = n.length, a; o < s; o++)
    (a || !(o in n)) && (a || (a = Array.prototype.slice.call(n, 0, o)), a[o] = n[o]);
  return e.concat(a || Array.prototype.slice.call(n));
}
var Dn = "right-scroll-bar-position", Mn = "width-before-scroll-bar", If = "with-scroll-bars-hidden", Of = "--removed-body-scroll-bar-size";
function xr(e, n) {
  return typeof e == "function" ? e(n) : e && (e.current = n), e;
}
function Af(e, n) {
  var r = Ke(function() {
    return {
      // value
      value: e,
      // last callback
      callback: n,
      // "memoized" public interface
      facade: {
        get current() {
          return r.value;
        },
        set current(o) {
          var s = r.value;
          s !== o && (r.value = o, r.callback(o, s));
        }
      }
    };
  })[0];
  return r.callback = n, r.facade;
}
var Df = typeof window < "u" ? f.useLayoutEffect : f.useEffect, As = /* @__PURE__ */ new WeakMap();
function Mf(e, n) {
  var r = Af(null, function(o) {
    return e.forEach(function(s) {
      return xr(s, o);
    });
  });
  return Df(function() {
    var o = As.get(r);
    if (o) {
      var s = new Set(o), a = new Set(e), i = r.current;
      s.forEach(function(l) {
        a.has(l) || xr(l, null);
      }), a.forEach(function(l) {
        s.has(l) || xr(l, i);
      });
    }
    As.set(r, e);
  }, [e]), r;
}
function Lf(e) {
  return e;
}
function Ff(e, n) {
  n === void 0 && (n = Lf);
  var r = [], o = !1, s = {
    read: function() {
      if (o)
        throw new Error("Sidecar: could not `read` from an `assigned` medium. `read` could be used only with `useMedium`.");
      return r.length ? r[r.length - 1] : e;
    },
    useMedium: function(a) {
      var i = n(a, o);
      return r.push(i), function() {
        r = r.filter(function(l) {
          return l !== i;
        });
      };
    },
    assignSyncMedium: function(a) {
      for (o = !0; r.length; ) {
        var i = r;
        r = [], i.forEach(a);
      }
      r = {
        push: function(l) {
          return a(l);
        },
        filter: function() {
          return r;
        }
      };
    },
    assignMedium: function(a) {
      o = !0;
      var i = [];
      if (r.length) {
        var l = r;
        r = [], l.forEach(a), i = r;
      }
      var u = function() {
        var p = i;
        i = [], p.forEach(a);
      }, d = function() {
        return Promise.resolve().then(u);
      };
      d(), r = {
        push: function(p) {
          i.push(p), d();
        },
        filter: function(p) {
          return i = i.filter(p), r;
        }
      };
    }
  };
  return s;
}
function $f(e) {
  e === void 0 && (e = {});
  var n = Ff(null);
  return n.options = Ue({ async: !0, ssr: !1 }, e), n;
}
var fi = function(e) {
  var n = e.sideCar, r = ui(e, ["sideCar"]);
  if (!n)
    throw new Error("Sidecar: please provide `sideCar` property to import the right car");
  var o = n.read();
  if (!o)
    throw new Error("Sidecar medium not found");
  return f.createElement(o, Ue({}, r));
};
fi.isSideCarExport = !0;
function zf(e, n) {
  return e.useMedium(n), fi;
}
var mi = $f(), wr = function() {
}, Zn = f.forwardRef(function(e, n) {
  var r = f.useRef(null), o = f.useState({
    onScrollCapture: wr,
    onWheelCapture: wr,
    onTouchMoveCapture: wr
  }), s = o[0], a = o[1], i = e.forwardProps, l = e.children, u = e.className, d = e.removeScrollBar, p = e.enabled, c = e.shards, h = e.sideCar, g = e.noRelative, y = e.noIsolation, b = e.inert, v = e.allowPinchZoom, x = e.as, S = x === void 0 ? "div" : x, w = e.gapMode, C = ui(e, ["forwardProps", "children", "className", "removeScrollBar", "enabled", "shards", "sideCar", "noRelative", "noIsolation", "inert", "allowPinchZoom", "as", "gapMode"]), N = h, R = Mf([r, n]), E = Ue(Ue({}, C), s);
  return f.createElement(
    f.Fragment,
    null,
    p && f.createElement(N, { sideCar: mi, removeScrollBar: d, shards: c, noRelative: g, noIsolation: y, inert: b, setCallbacks: a, allowPinchZoom: !!v, lockRef: r, gapMode: w }),
    i ? f.cloneElement(f.Children.only(l), Ue(Ue({}, E), { ref: R })) : f.createElement(S, Ue({}, E, { className: u, ref: R }), l)
  );
});
Zn.defaultProps = {
  enabled: !0,
  removeScrollBar: !0,
  inert: !1
};
Zn.classNames = {
  fullWidth: Mn,
  zeroRight: Dn
};
var Bf = function() {
  if (typeof __webpack_nonce__ < "u")
    return __webpack_nonce__;
};
function Vf() {
  if (!document)
    return null;
  var e = document.createElement("style");
  e.type = "text/css";
  var n = Bf();
  return n && e.setAttribute("nonce", n), e;
}
function jf(e, n) {
  e.styleSheet ? e.styleSheet.cssText = n : e.appendChild(document.createTextNode(n));
}
function Hf(e) {
  var n = document.head || document.getElementsByTagName("head")[0];
  n.appendChild(e);
}
var Wf = function() {
  var e = 0, n = null;
  return {
    add: function(r) {
      e == 0 && (n = Vf()) && (jf(n, r), Hf(n)), e++;
    },
    remove: function() {
      e--, !e && n && (n.parentNode && n.parentNode.removeChild(n), n = null);
    }
  };
}, Uf = function() {
  var e = Wf();
  return function(n, r) {
    f.useEffect(function() {
      return e.add(n), function() {
        e.remove();
      };
    }, [n && r]);
  };
}, pi = function() {
  var e = Uf(), n = function(r) {
    var o = r.styles, s = r.dynamic;
    return e(o, s), null;
  };
  return n;
}, Gf = {
  left: 0,
  top: 0,
  right: 0,
  gap: 0
}, Cr = function(e) {
  return parseInt(e || "", 10) || 0;
}, Kf = function(e) {
  var n = window.getComputedStyle(document.body), r = n[e === "padding" ? "paddingLeft" : "marginLeft"], o = n[e === "padding" ? "paddingTop" : "marginTop"], s = n[e === "padding" ? "paddingRight" : "marginRight"];
  return [Cr(r), Cr(o), Cr(s)];
}, Yf = function(e) {
  if (e === void 0 && (e = "margin"), typeof window > "u")
    return Gf;
  var n = Kf(e), r = document.documentElement.clientWidth, o = window.innerWidth;
  return {
    left: n[0],
    top: n[1],
    right: n[2],
    gap: Math.max(0, o - r + n[2] - n[0])
  };
}, Xf = pi(), Ut = "data-scroll-locked", qf = function(e, n, r, o) {
  var s = e.left, a = e.top, i = e.right, l = e.gap;
  return r === void 0 && (r = "margin"), `
  .`.concat(If, ` {
   overflow: hidden `).concat(o, `;
   padding-right: `).concat(l, "px ").concat(o, `;
  }
  body[`).concat(Ut, `] {
    overflow: hidden `).concat(o, `;
    overscroll-behavior: contain;
    `).concat([
    n && "position: relative ".concat(o, ";"),
    r === "margin" && `
    padding-left: `.concat(s, `px;
    padding-top: `).concat(a, `px;
    padding-right: `).concat(i, `px;
    margin-left:0;
    margin-top:0;
    margin-right: `).concat(l, "px ").concat(o, `;
    `),
    r === "padding" && "padding-right: ".concat(l, "px ").concat(o, ";")
  ].filter(Boolean).join(""), `
  }
  
  .`).concat(Dn, ` {
    right: `).concat(l, "px ").concat(o, `;
  }
  
  .`).concat(Mn, ` {
    margin-right: `).concat(l, "px ").concat(o, `;
  }
  
  .`).concat(Dn, " .").concat(Dn, ` {
    right: 0 `).concat(o, `;
  }
  
  .`).concat(Mn, " .").concat(Mn, ` {
    margin-right: 0 `).concat(o, `;
  }
  
  body[`).concat(Ut, `] {
    `).concat(Of, ": ").concat(l, `px;
  }
`);
}, Ds = function() {
  var e = parseInt(document.body.getAttribute(Ut) || "0", 10);
  return isFinite(e) ? e : 0;
}, Zf = function() {
  f.useEffect(function() {
    return document.body.setAttribute(Ut, (Ds() + 1).toString()), function() {
      var e = Ds() - 1;
      e <= 0 ? document.body.removeAttribute(Ut) : document.body.setAttribute(Ut, e.toString());
    };
  }, []);
}, Qf = function(e) {
  var n = e.noRelative, r = e.noImportant, o = e.gapMode, s = o === void 0 ? "margin" : o;
  Zf();
  var a = f.useMemo(function() {
    return Yf(s);
  }, [s]);
  return f.createElement(Xf, { styles: qf(a, !n, s, r ? "" : "!important") });
}, Ur = !1;
if (typeof window < "u")
  try {
    var Rn = Object.defineProperty({}, "passive", {
      get: function() {
        return Ur = !0, !0;
      }
    });
    window.addEventListener("test", Rn, Rn), window.removeEventListener("test", Rn, Rn);
  } catch {
    Ur = !1;
  }
var Vt = Ur ? { passive: !1 } : !1, Jf = function(e) {
  return e.tagName === "TEXTAREA";
}, hi = function(e, n) {
  if (!(e instanceof Element))
    return !1;
  var r = window.getComputedStyle(e);
  return (
    // not-not-scrollable
    r[n] !== "hidden" && // contains scroll inside self
    !(r.overflowY === r.overflowX && !Jf(e) && r[n] === "visible")
  );
}, em = function(e) {
  return hi(e, "overflowY");
}, tm = function(e) {
  return hi(e, "overflowX");
}, Ms = function(e, n) {
  var r = n.ownerDocument, o = n;
  do {
    typeof ShadowRoot < "u" && o instanceof ShadowRoot && (o = o.host);
    var s = gi(e, o);
    if (s) {
      var a = vi(e, o), i = a[1], l = a[2];
      if (i > l)
        return !0;
    }
    o = o.parentNode;
  } while (o && o !== r.body);
  return !1;
}, nm = function(e) {
  var n = e.scrollTop, r = e.scrollHeight, o = e.clientHeight;
  return [
    n,
    r,
    o
  ];
}, rm = function(e) {
  var n = e.scrollLeft, r = e.scrollWidth, o = e.clientWidth;
  return [
    n,
    r,
    o
  ];
}, gi = function(e, n) {
  return e === "v" ? em(n) : tm(n);
}, vi = function(e, n) {
  return e === "v" ? nm(n) : rm(n);
}, om = function(e, n) {
  return e === "h" && n === "rtl" ? -1 : 1;
}, sm = function(e, n, r, o, s) {
  var a = om(e, window.getComputedStyle(n).direction), i = a * o, l = r.target, u = n.contains(l), d = !1, p = i > 0, c = 0, h = 0;
  do {
    if (!l)
      break;
    var g = vi(e, l), y = g[0], b = g[1], v = g[2], x = b - v - a * y;
    (y || x) && gi(e, l) && (c += x, h += y);
    var S = l.parentNode;
    l = S && S.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? S.host : S;
  } while (
    // portaled content
    !u && l !== document.body || // self content
    u && (n.contains(l) || n === l)
  );
  return (p && Math.abs(c) < 1 || !p && Math.abs(h) < 1) && (d = !0), d;
}, Pn = function(e) {
  return "changedTouches" in e ? [e.changedTouches[0].clientX, e.changedTouches[0].clientY] : [0, 0];
}, Ls = function(e) {
  return [e.deltaX, e.deltaY];
}, Fs = function(e) {
  return e && "current" in e ? e.current : e;
}, am = function(e, n) {
  return e[0] === n[0] && e[1] === n[1];
}, im = function(e) {
  return `
  .block-interactivity-`.concat(e, ` {pointer-events: none;}
  .allow-interactivity-`).concat(e, ` {pointer-events: all;}
`);
}, lm = 0, jt = [];
function cm(e) {
  var n = f.useRef([]), r = f.useRef([0, 0]), o = f.useRef(), s = f.useState(lm++)[0], a = f.useState(pi)[0], i = f.useRef(e);
  f.useEffect(function() {
    i.current = e;
  }, [e]), f.useEffect(function() {
    if (e.inert) {
      document.body.classList.add("block-interactivity-".concat(s));
      var b = _f([e.lockRef.current], (e.shards || []).map(Fs), !0).filter(Boolean);
      return b.forEach(function(v) {
        return v.classList.add("allow-interactivity-".concat(s));
      }), function() {
        document.body.classList.remove("block-interactivity-".concat(s)), b.forEach(function(v) {
          return v.classList.remove("allow-interactivity-".concat(s));
        });
      };
    }
  }, [e.inert, e.lockRef.current, e.shards]);
  var l = f.useCallback(function(b, v) {
    if ("touches" in b && b.touches.length === 2 || b.type === "wheel" && b.ctrlKey)
      return !i.current.allowPinchZoom;
    var x = Pn(b), S = r.current, w = "deltaX" in b ? b.deltaX : S[0] - x[0], C = "deltaY" in b ? b.deltaY : S[1] - x[1], N, R = b.target, E = Math.abs(w) > Math.abs(C) ? "h" : "v";
    if ("touches" in b && E === "h" && R.type === "range")
      return !1;
    var k = window.getSelection(), T = k && k.anchorNode, I = T ? T === R || T.contains(R) : !1;
    if (I)
      return !1;
    var L = Ms(E, R);
    if (!L)
      return !0;
    if (L ? N = E : (N = E === "v" ? "h" : "v", L = Ms(E, R)), !L)
      return !1;
    if (!o.current && "changedTouches" in b && (w || C) && (o.current = N), !N)
      return !0;
    var A = o.current || N;
    return sm(A, v, b, A === "h" ? w : C);
  }, []), u = f.useCallback(function(b) {
    var v = b;
    if (!(!jt.length || jt[jt.length - 1] !== a)) {
      var x = "deltaY" in v ? Ls(v) : Pn(v), S = n.current.filter(function(N) {
        return N.name === v.type && (N.target === v.target || v.target === N.shadowParent) && am(N.delta, x);
      })[0];
      if (S && S.should) {
        v.cancelable && v.preventDefault();
        return;
      }
      if (!S) {
        var w = (i.current.shards || []).map(Fs).filter(Boolean).filter(function(N) {
          return N.contains(v.target);
        }), C = w.length > 0 ? l(v, w[0]) : !i.current.noIsolation;
        C && v.cancelable && v.preventDefault();
      }
    }
  }, []), d = f.useCallback(function(b, v, x, S) {
    var w = { name: b, delta: v, target: x, should: S, shadowParent: dm(x) };
    n.current.push(w), setTimeout(function() {
      n.current = n.current.filter(function(C) {
        return C !== w;
      });
    }, 1);
  }, []), p = f.useCallback(function(b) {
    r.current = Pn(b), o.current = void 0;
  }, []), c = f.useCallback(function(b) {
    d(b.type, Ls(b), b.target, l(b, e.lockRef.current));
  }, []), h = f.useCallback(function(b) {
    d(b.type, Pn(b), b.target, l(b, e.lockRef.current));
  }, []);
  f.useEffect(function() {
    return jt.push(a), e.setCallbacks({
      onScrollCapture: c,
      onWheelCapture: c,
      onTouchMoveCapture: h
    }), document.addEventListener("wheel", u, Vt), document.addEventListener("touchmove", u, Vt), document.addEventListener("touchstart", p, Vt), function() {
      jt = jt.filter(function(b) {
        return b !== a;
      }), document.removeEventListener("wheel", u, Vt), document.removeEventListener("touchmove", u, Vt), document.removeEventListener("touchstart", p, Vt);
    };
  }, []);
  var g = e.removeScrollBar, y = e.inert;
  return f.createElement(
    f.Fragment,
    null,
    y ? f.createElement(a, { styles: im(s) }) : null,
    g ? f.createElement(Qf, { noRelative: e.noRelative, gapMode: e.gapMode }) : null
  );
}
function dm(e) {
  for (var n = null; e !== null; )
    e instanceof ShadowRoot && (n = e.host, e = e.host), e = e.parentNode;
  return n;
}
const um = zf(mi, cm);
var Qn = f.forwardRef(function(e, n) {
  return f.createElement(Zn, Ue({}, e, { ref: n, sideCar: um }));
});
Qn.classNames = Zn.classNames;
var fm = function(e) {
  if (typeof document > "u")
    return null;
  var n = Array.isArray(e) ? e[0] : e;
  return n.ownerDocument.body;
}, Ht = /* @__PURE__ */ new WeakMap(), Tn = /* @__PURE__ */ new WeakMap(), _n = {}, Sr = 0, bi = function(e) {
  return e && (e.host || bi(e.parentNode));
}, mm = function(e, n) {
  return n.map(function(r) {
    if (e.contains(r))
      return r;
    var o = bi(r);
    return o && e.contains(o) ? o : (console.error("aria-hidden", r, "in not contained inside", e, ". Doing nothing"), null);
  }).filter(function(r) {
    return !!r;
  });
}, pm = function(e, n, r, o) {
  var s = mm(n, Array.isArray(e) ? e : [e]);
  _n[r] || (_n[r] = /* @__PURE__ */ new WeakMap());
  var a = _n[r], i = [], l = /* @__PURE__ */ new Set(), u = new Set(s), d = function(c) {
    !c || l.has(c) || (l.add(c), d(c.parentNode));
  };
  s.forEach(d);
  var p = function(c) {
    !c || u.has(c) || Array.prototype.forEach.call(c.children, function(h) {
      if (l.has(h))
        p(h);
      else
        try {
          var g = h.getAttribute(o), y = g !== null && g !== "false", b = (Ht.get(h) || 0) + 1, v = (a.get(h) || 0) + 1;
          Ht.set(h, b), a.set(h, v), i.push(h), b === 1 && y && Tn.set(h, !0), v === 1 && h.setAttribute(r, "true"), y || h.setAttribute(o, "true");
        } catch (x) {
          console.error("aria-hidden: cannot operate on ", h, x);
        }
    });
  };
  return p(n), l.clear(), Sr++, function() {
    i.forEach(function(c) {
      var h = Ht.get(c) - 1, g = a.get(c) - 1;
      Ht.set(c, h), a.set(c, g), h || (Tn.has(c) || c.removeAttribute(o), Tn.delete(c)), g || c.removeAttribute(r);
    }), Sr--, Sr || (Ht = /* @__PURE__ */ new WeakMap(), Ht = /* @__PURE__ */ new WeakMap(), Tn = /* @__PURE__ */ new WeakMap(), _n = {});
  };
}, mo = function(e, n, r) {
  r === void 0 && (r = "data-aria-hidden");
  var o = Array.from(Array.isArray(e) ? e : [e]), s = fm(e);
  return s ? (o.push.apply(o, Array.from(s.querySelectorAll("[aria-live], script"))), pm(o, s, r, "aria-hidden")) : function() {
    return null;
  };
}, hm = Object.defineProperty, Oe = (e, n) => hm(e, "name", { value: n, configurable: !0 }), po = "Dialog", [yi, Kb] = /* @__PURE__ */ Ie(po), [gm, ze] = yi(po), xi = /* @__PURE__ */ Oe((e) => {
  const {
    __scopeDialog: n,
    children: r,
    open: o,
    defaultOpen: s,
    onOpenChange: a,
    modal: i = !0
  } = e, l = f.useRef(null), u = f.useRef(null), [d, p] = Xe({
    prop: o,
    defaultProp: s ?? !1,
    onChange: a,
    caller: po
  }), [c, h] = f.useState(0), [g, y] = f.useState(0);
  return /* @__PURE__ */ m(
    gm,
    {
      scope: n,
      triggerRef: l,
      contentRef: u,
      contentId: Me(),
      titleId: Me(),
      descriptionId: Me(),
      titlePresent: c > 0,
      descriptionPresent: g > 0,
      setTitleCount: h,
      setDescriptionCount: y,
      open: d,
      onOpenChange: p,
      onOpenToggle: f.useCallback(() => p((b) => !b), [p]),
      modal: i,
      children: r
    }
  );
}, "Dialog"), vm = "DialogTrigger", bm = /* @__PURE__ */ f.forwardRef(
  /* @__PURE__ */ Oe(function(n, r) {
    const { __scopeDialog: o, ...s } = n, a = ze(vm, o), i = oe(r, a.triggerRef);
    return /* @__PURE__ */ m(
      Q.button,
      {
        type: "button",
        "aria-haspopup": "dialog",
        "aria-expanded": a.open,
        "aria-controls": a.open ? a.contentId : void 0,
        "data-state": Jn(a.open),
        ...s,
        ref: i,
        onClick: X(n.onClick, a.onOpenToggle)
      }
    );
  }, "DialogTrigger")
), wi = "DialogPortal", [ym, Ci] = yi(wi, {
  forceMount: void 0
}), Si = /* @__PURE__ */ Oe((e) => {
  const { __scopeDialog: n, forceMount: r, children: o, container: s } = e, a = ze(wi, n);
  return /* @__PURE__ */ m(ym, { scope: n, forceMount: r, children: f.Children.map(o, (i) => /* @__PURE__ */ m(ct, { present: r || a.open, children: /* @__PURE__ */ m(uo, { asChild: !0, container: s, children: i }) })) });
}, "DialogPortal"), Gr = "DialogOverlay", ki = /* @__PURE__ */ f.forwardRef(
  /* @__PURE__ */ Oe(function(n, r) {
    const o = Ci(Gr, n.__scopeDialog), { forceMount: s = o.forceMount, ...a } = n, i = ze(Gr, n.__scopeDialog);
    return i.modal ? /* @__PURE__ */ m(ct, { present: s || i.open, children: /* @__PURE__ */ m(wm, { ...a, ref: r }) }) : null;
  }, "DialogOverlay")
), xm = /* @__PURE__ */ Ye("DialogOverlay.RemoveScroll"), wm = /* @__PURE__ */ f.forwardRef(
  // blank line to reduce diff noise
  /* @__PURE__ */ Oe(function(n, r) {
    const { __scopeDialog: o, ...s } = n, a = ze(Gr, o), i = Qa(), l = oe(r, i);
    return (
      // Make sure `Content` is scrollable even when it doesn't live inside `RemoveScroll`
      // ie. when `Overlay` and `Content` are siblings
      /* @__PURE__ */ m(Qn, { as: xm, allowPinchZoom: !0, shards: [a.contentRef], children: /* @__PURE__ */ m(
        Q.div,
        {
          "data-state": Jn(a.open),
          ...s,
          ref: l,
          style: { pointerEvents: "auto", ...s.style }
        }
      ) })
    );
  }, "DialogOverlayImpl")
), cn = "DialogContent", Ei = /* @__PURE__ */ f.forwardRef(
  /* @__PURE__ */ Oe(function(n, r) {
    const o = Ci(cn, n.__scopeDialog), { forceMount: s = o.forceMount, ...a } = n, i = ze(cn, n.__scopeDialog);
    return /* @__PURE__ */ m(ct, { present: s || i.open, children: i.modal ? /* @__PURE__ */ m(Cm, { ...a, ref: r }) : /* @__PURE__ */ m(Sm, { ...a, ref: r }) });
  }, "DialogContent")
), Cm = /* @__PURE__ */ f.forwardRef(
  // blank line to reduce diff noise
  /* @__PURE__ */ Oe(function(n, r) {
    const o = ze(cn, n.__scopeDialog), s = f.useRef(null), a = oe(r, o.contentRef, s);
    return f.useEffect(() => {
      const i = s.current;
      if (i) return mo(i);
    }, []), /* @__PURE__ */ m(
      Ni,
      {
        ...n,
        ref: a,
        trapFocus: o.open,
        disableOutsidePointerEvents: o.open,
        onCloseAutoFocus: X(n.onCloseAutoFocus, (i) => {
          i.preventDefault(), o.triggerRef.current?.focus();
        }),
        onPointerDownOutside: X(n.onPointerDownOutside, (i) => {
          const l = i.detail.originalEvent, u = l.button === 0 && l.ctrlKey === !0;
          (l.button === 2 || u) && i.preventDefault();
        }),
        onFocusOutside: X(
          n.onFocusOutside,
          (i) => i.preventDefault()
        )
      }
    );
  }, "DialogContentModal")
), Sm = /* @__PURE__ */ f.forwardRef(
  // blank line to reduce diff noise
  /* @__PURE__ */ Oe(function(n, r) {
    const o = ze(cn, n.__scopeDialog), s = f.useRef(!1), a = f.useRef(!1);
    return /* @__PURE__ */ m(
      Ni,
      {
        ...n,
        ref: r,
        trapFocus: !1,
        disableOutsidePointerEvents: !1,
        onCloseAutoFocus: (i) => {
          n.onCloseAutoFocus?.(i), i.defaultPrevented || (s.current || o.triggerRef.current?.focus(), i.preventDefault()), s.current = !1, a.current = !1;
        },
        onInteractOutside: (i) => {
          n.onInteractOutside?.(i), i.defaultPrevented || (s.current = !0, i.detail.originalEvent.type === "pointerdown" && (a.current = !0));
          const l = i.target;
          o.triggerRef.current?.contains(l) && i.preventDefault(), i.detail.originalEvent.type === "focusin" && a.current && i.preventDefault();
        }
      }
    );
  }, "DialogContentNonModal")
), Ni = /* @__PURE__ */ f.forwardRef(
  // blank line to reduce diff noise
  /* @__PURE__ */ Oe(function(n, r) {
    const { __scopeDialog: o, trapFocus: s, onOpenAutoFocus: a, onCloseAutoFocus: i, ...l } = n, u = ze(cn, o);
    return vn(), /* @__PURE__ */ m(Qe, { children: /* @__PURE__ */ m(
      lo,
      {
        asChild: !0,
        loop: !0,
        trapped: s,
        onMountAutoFocus: a,
        onUnmountAutoFocus: i,
        children: /* @__PURE__ */ m(
          qn,
          {
            role: "dialog",
            id: u.contentId,
            "aria-describedby": u.descriptionPresent ? u.descriptionId : void 0,
            "aria-labelledby": u.titlePresent ? u.titleId : void 0,
            "data-state": Jn(u.open),
            ...l,
            ref: r,
            deferPointerDownOutside: !0,
            onDismiss: () => u.onOpenChange(!1)
          }
        )
      }
    ) });
  }, "DialogContentImpl")
), km = "DialogTitle", Ri = /* @__PURE__ */ f.forwardRef(
  /* @__PURE__ */ Oe(function(n, r) {
    const { __scopeDialog: o, ...s } = n, a = ze(km, o), { setTitleCount: i } = a;
    return ue(() => (i((l) => l + 1), () => i((l) => l - 1)), [i]), /* @__PURE__ */ m(Q.h2, { id: a.titleId, ...s, ref: r });
  }, "DialogTitle")
), Em = "DialogDescription", Ln = /* @__PURE__ */ f.forwardRef(
  // blank line to reduce diff noise
  /* @__PURE__ */ Oe(function(n, r) {
    const { __scopeDialog: o, ...s } = n, a = ze(Em, o), { setDescriptionCount: i } = a;
    return ue(() => (i((l) => l + 1), () => i((l) => l - 1)), [i]), /* @__PURE__ */ m(Q.p, { id: a.descriptionId, ...s, ref: r });
  }, "DialogDescription")
), Nm = "DialogClose", Pi = /* @__PURE__ */ f.forwardRef(
  /* @__PURE__ */ Oe(function(n, r) {
    const { __scopeDialog: o, ...s } = n, a = ze(Nm, o);
    return /* @__PURE__ */ m(
      Q.button,
      {
        type: "button",
        ...s,
        ref: r,
        onClick: X(n.onClick, () => a.onOpenChange(!1))
      }
    );
  }, "DialogClose")
);
function Jn(e) {
  return e ? "open" : "closed";
}
Oe(Jn, "getState");
const bn = f.memo(
  f.forwardRef(
    ({
      children: e,
      trigger: n,
      title: r,
      description: o,
      footer: s,
      footerClassName: a,
      className: i,
      contentClassName: l,
      open: u,
      onOpenChange: d,
      onClose: p,
      defaultOpen: c,
      draggable: h = !0,
      ...g
    }, y) => {
      const [b, v] = f.useState({ x: 0, y: 0 }), [x, S] = f.useState(!1), w = f.useRef({ x: 0, y: 0 }), [C, N] = f.useState(
        c || !1
      ), R = u !== void 0, E = R ? u : C;
      f.useEffect(() => {
        E || (v({ x: 0, y: 0 }), S(!1));
      }, [E]);
      const k = (_) => {
        R || N(_), d?.(_), !_ && p && p();
      }, T = (_) => {
        h && (S(!0), w.current = {
          x: _.clientX - b.x,
          y: _.clientY - b.y
        });
      };
      f.useEffect(() => {
        if (!x) return;
        let _;
        const M = ($) => {
          _ = requestAnimationFrame(() => {
            v({
              x: $.clientX - w.current.x,
              y: $.clientY - w.current.y
            });
          });
        }, U = () => {
          S(!1);
        };
        return document.addEventListener("mousemove", M), document.addEventListener("mouseup", U), () => {
          cancelAnimationFrame(_), document.removeEventListener("mousemove", M), document.removeEventListener("mouseup", U);
        };
      }, [x]);
      const L = f.useId(), A = /* @__PURE__ */ D(Qe, { children: [
        !g.noHeader && /* @__PURE__ */ D(
          "div",
          {
            "data-testid": "modal-header",
            className: O(
              "relative flex flex-col space-y-1.5 border-b border-border bg-card/50 flex-shrink-0",
              h && "cursor-move",
              g.noPadding ? "p-1" : "p-[var(--ui-component-padding-y)]"
            ),
            children: [
              h && /* @__PURE__ */ m(
                "button",
                {
                  type: "button",
                  "aria-label": "Drag modal",
                  className: "absolute inset-0 cursor-move",
                  onMouseDown: T
                }
              ),
              /* @__PURE__ */ D("div", { className: "relative z-10 w-full", children: [
                /* @__PURE__ */ D("div", { className: "flex items-center justify-between", children: [
                  /* @__PURE__ */ m(
                    Ri,
                    {
                      className: O(
                        "text-lg font-semibold leading-none tracking-tight text-foreground",
                        !r && "sr-only"
                      ),
                      children: r || "Dialog"
                    }
                  ),
                  /* @__PURE__ */ D(Pi, { className: "rounded-full p-1 opacity-70 ring-offset-background transition-all hover:opacity-100 hover:bg-accent focus:outline-none disabled:pointer-events-none cursor-pointer", children: [
                    /* @__PURE__ */ m(Xt, { className: "h-5 w-5 text-foreground" }),
                    /* @__PURE__ */ m("span", { className: "sr-only", children: "Close" })
                  ] })
                ] }),
                o ? /* @__PURE__ */ m(
                  Ln,
                  {
                    id: L,
                    className: "text-sm text-muted-foreground mt-1.5",
                    children: o
                  }
                ) : /* @__PURE__ */ m(
                  Ln,
                  {
                    id: L,
                    className: "sr-only",
                    children: "Dialog Content"
                  }
                )
              ] })
            ]
          }
        ),
        g.noHeader && /* @__PURE__ */ m(Ln, { id: L, className: "sr-only", children: "Dialog Content" }),
        /* @__PURE__ */ m(
          "div",
          {
            className: O(
              "flex-1 overflow-y-auto",
              g.noPadding ? "p-0" : "p-[var(--ui-modal-padding)]",
              l
            ),
            children: e
          }
        ),
        s && /* @__PURE__ */ m(
          "div",
          {
            className: O(
              "flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2 bg-background flex-shrink-0",
              "p-[var(--ui-component-padding-y)]",
              a
            ),
            children: s
          }
        )
      ] });
      return /* @__PURE__ */ D(
        xi,
        {
          open: E,
          onOpenChange: k,
          ...g,
          children: [
            n && /* @__PURE__ */ m(bm, { asChild: !0, children: n }),
            /* @__PURE__ */ D(Si, { children: [
              /* @__PURE__ */ m(ki, { className: "fixed inset-0 z-50 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" }),
              /* @__PURE__ */ m(
                Ei,
                {
                  ref: y,
                  "aria-describedby": L,
                  className: O(
                    "fixed z-50 flex flex-col gap-0 bg-background",
                    !h && "duration-200",
                    !h && "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
                    !h && "bottom-0 left-0 right-0 w-full h-[90vh] rounded-t-xl border-t border-border",
                    !h && "data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom",
                    h && "left-[50%] top-[50%] h-auto max-h-[90vh] w-[90vw] max-w-lg rounded-md border border-border",
                    !h && "sm:left-[50%] sm:top-[50%] sm:bottom-auto sm:right-auto sm:h-auto sm:max-h-[90vh] sm:max-w-lg sm:rounded-md sm:border sm:border-border",
                    !h && "sm:data-[state=closed]:zoom-out-95 sm:data-[state=open]:zoom-in-95",
                    !h && "sm:data-[state=closed]:slide-out-to-left-1/2 sm:data-[state=closed]:slide-out-to-top-[48%]",
                    !h && "sm:data-[state=open]:slide-in-from-left-1/2 sm:data-[state=open]:slide-in-from-top-[48%]",
                    i
                  ),
                  style: h ? {
                    transform: `translate(calc(-50% + ${b.x}px), calc(-50% + ${b.y}px))`,
                    cursor: x ? "grabbing" : void 0
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
bn.displayName = "Modal";
const Rm = ({ children: e, className: n }) => /* @__PURE__ */ m(
  "div",
  {
    className: O(
      "flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2 gap-2 bg-background flex-shrink-0 p-[var(--ui-component-padding-y)]",
      n
    ),
    children: e
  }
);
Rm.displayName = "ModalFooter";
const Yb = ({
  onResult: e,
  className: n,
  buttonLabel: r = "Calculator"
}) => {
  const [o, s] = Ke(!1), [a, i] = Ke("0"), l = (h) => ["+", "-", "*", "/"].includes(h), u = (h) => {
    const g = h.replace(/\s+/g, "");
    if (!/^[0-9.+\-*/]+$/.test(g))
      throw new Error("invalid");
    const y = [], b = [], v = {
      "+": 1,
      "-": 1,
      "*": 2,
      "/": 2
    }, x = () => {
      const C = b.pop();
      if (!C) return;
      const N = y.pop(), R = y.pop();
      if (R === void 0 || N === void 0)
        throw new Error("invalid");
      switch (C) {
        case "+":
          y.push(R + N);
          break;
        case "-":
          y.push(R - N);
          break;
        case "*":
          y.push(R * N);
          break;
        case "/":
          if (N === 0) throw new Error("div0");
          y.push(R / N);
          break;
        default:
          throw new Error("invalid");
      }
    }, S = g.match(/(\d+(?:\.\d+)?|[+\-*/])/g);
    if (!S)
      throw new Error("invalid");
    for (const C of S)
      if (l(C)) {
        for (; b.length > 0 && (() => {
          const N = b[b.length - 1];
          if (!N)
            return !1;
          const R = v[N], E = v[C];
          return R !== void 0 && E !== void 0 && R >= E;
        })(); )
          x();
        b.push(C);
      } else
        y.push(Number(C));
    for (; b.length > 0; )
      x();
    if (y.length !== 1 || Number.isNaN(y[0]))
      throw new Error("invalid");
    const [w] = y;
    if (w === void 0)
      throw new Error("invalid");
    return w;
  }, d = (h) => {
    if (h === "=")
      try {
        const g = u(a);
        i(g.toString()), e && e(g);
      } catch {
        i("Error");
      }
    else if (h === "C")
      i("0");
    else {
      if (a === "Error") {
        i(h);
        return;
      }
      const g = a === "0" && !l(h) ? h : `${a}${h}`;
      i(g);
    }
  }, p = ot(
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
  ), c = /* @__PURE__ */ D("div", { className: `space-y-4 ${n || ""}`, children: [
    /* @__PURE__ */ m("div", { className: "bg-muted p-4 rounded text-right text-2xl font-mono text-foreground", children: a }),
    /* @__PURE__ */ m("div", { className: "grid grid-cols-4 gap-2", children: p.map((h) => /* @__PURE__ */ m(
      xe,
      {
        onClick: () => d(h),
        variant: h === "=" ? "default" : "outline",
        className: h === "C" ? "col-span-4" : "h-auto aspect-[5/4]",
        children: h
      },
      h
    )) })
  ] });
  return e ? c : /* @__PURE__ */ D("div", { className: "space-y-4", children: [
    /* @__PURE__ */ D(xe, { variant: "outline", size: "lg", onClick: () => s(!0), children: [
      /* @__PURE__ */ m(ud, { className: "me-2 h-4 w-4" }),
      r
    ] }),
    /* @__PURE__ */ m(bn, { open: o, onOpenChange: s, title: r, children: c })
  ] });
}, Ti = Yt("rounded-lg border shadow-sm", {
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
}), Pm = f.memo(
  f.forwardRef(
    ({ className: e, variant: n, ...r }, o) => /* @__PURE__ */ m(
      "div",
      {
        ref: o,
        className: O(Ti({ variant: n }), e),
        ...r
      }
    )
  )
);
Pm.displayName = "Card";
const Tm = f.memo(
  f.forwardRef(
    ({ className: e, ...n }, r) => /* @__PURE__ */ m(
      "div",
      {
        ref: r,
        className: O(
          "flex flex-col space-y-1.5 p-[var(--ui-card-padding)]",
          e
        ),
        ...n
      }
    )
  )
);
Tm.displayName = "CardHeader";
const _m = f.memo(
  f.forwardRef(
    ({ className: e, ...n }, r) => /* @__PURE__ */ m(
      "div",
      {
        ref: r,
        className: O(
          "text-2xl font-semibold leading-none tracking-tight text-foreground",
          e
        ),
        ...n
      }
    )
  )
);
_m.displayName = "CardTitle";
const Im = f.memo(
  f.forwardRef(
    ({ className: e, ...n }, r) => /* @__PURE__ */ m(
      "div",
      {
        ref: r,
        className: O("text-sm text-muted-foreground", e),
        ...n
      }
    )
  )
);
Im.displayName = "CardDescription";
const Om = f.memo(
  f.forwardRef(
    ({ className: e, ...n }, r) => /* @__PURE__ */ m(
      "div",
      {
        ref: r,
        className: O("p-[var(--ui-card-padding)] pt-0", e),
        ...n
      }
    )
  )
);
Om.displayName = "CardContent";
const Am = f.memo(
  f.forwardRef(
    ({ className: e, ...n }, r) => /* @__PURE__ */ m(
      "div",
      {
        ref: r,
        className: O(
          "flex items-center p-[var(--ui-card-padding)] pt-0",
          e
        ),
        ...n
      }
    )
  )
);
Am.displayName = "CardFooter";
const Xb = f.memo(
  ({
    isOpen: e,
    onOpen: n,
    onClose: r,
    title: o = "chatbot",
    buttonLabel: s = "Chatbot",
    children: a,
    className: i,
    panelClassName: l,
    bodyClassName: u,
    buttonClassName: d,
    footer: p,
    footerClassName: c,
    bodyRef: h
  }) => /* @__PURE__ */ D(
    "div",
    {
      className: O(
        "fixed bottom-4 right-4 z-50 flex flex-col items-end gap-3",
        i
      ),
      children: [
        e && /* @__PURE__ */ D(
          "div",
          {
            className: O(
              "flex w-[320px] max-w-[92vw] flex-col overflow-hidden rounded-2xl border border-border/70 bg-background shadow-[0_18px_40px_rgba(15,23,42,0.22)]",
              l
            ),
            children: [
              /* @__PURE__ */ D("div", { className: "flex items-center justify-between border-b border-border/60 bg-muted/40 px-4 py-3", children: [
                /* @__PURE__ */ m("div", { className: "text-sm font-semibold text-foreground", children: o }),
                /* @__PURE__ */ m(
                  "button",
                  {
                    type: "button",
                    onClick: r,
                    className: "rounded-full border border-border/70 bg-background/80 p-1 text-muted-foreground transition hover:text-foreground",
                    "aria-label": "チャットを閉じる",
                    children: /* @__PURE__ */ m(Xt, { className: "h-4 w-4" })
                  }
                )
              ] }),
              /* @__PURE__ */ D(
                "div",
                {
                  ref: h,
                  className: O("flex-1 overflow-y-auto px-4 py-3", u),
                  children: [
                    a,
                    p && /* @__PURE__ */ m(
                      "div",
                      {
                        className: O(
                          "mt-4 -mx-4 border-t border-border/60 bg-background/50 p-4 backdrop-blur supports-[backdrop-filter]:bg-background/50",
                          c
                        ),
                        children: p
                      }
                    )
                  ]
                }
              )
            ]
          }
        ),
        /* @__PURE__ */ D(
          "button",
          {
            type: "button",
            onClick: e ? r : n,
            className: O(
              "inline-flex items-center gap-2 rounded-full border border-border/70 bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-[0_12px_28px_rgba(15,23,42,0.25)] transition hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              d
            ),
            "aria-expanded": e,
            "aria-label": "チャットを開閉",
            children: [
              /* @__PURE__ */ m(Dd, { className: "h-4 w-4" }),
              s
            ]
          }
        )
      ]
    }
  )
), Dm = f.memo(
  f.forwardRef(
    ({
      id: e,
      checked: n,
      onChange: r,
      label: o,
      className: s,
      disabled: a = !1,
      variant: i = "default"
    }, l) => {
      const u = (d) => {
        r(d.target.checked);
      };
      return i === "card" ? /* @__PURE__ */ D(
        "label",
        {
          className: O(
            Ti({ variant: "default" }),
            "w-full flex items-center gap-3 p-[var(--ui-component-padding-x)] transition-all min-h-[var(--ui-component-height)] cursor-pointer",
            n ? "border-theme-success/50" : "hover:bg-muted",
            a && "opacity-50 cursor-not-allowed",
            s
          ),
          children: [
            /* @__PURE__ */ m(
              "input",
              {
                ref: l,
                id: e,
                type: "checkbox",
                checked: n,
                onChange: u,
                disabled: a,
                className: "sr-only"
              }
            ),
            /* @__PURE__ */ m(
              "div",
              {
                className: O(
                  "text-[length:calc(var(--ui-checkbox-size)*1.5)] flex-shrink-0 transition-colors",
                  n ? "text-success" : "text-theme-border"
                ),
                children: n ? /* @__PURE__ */ m(xd, { size: "1em" }) : /* @__PURE__ */ m(kd, { size: "1em" })
              }
            ),
            /* @__PURE__ */ m(
              "span",
              {
                className: O(
                  "text-ui font-medium",
                  n ? "text-foreground" : "text-muted-foreground"
                ),
                children: o
              }
            )
          ]
        }
      ) : /* @__PURE__ */ D(
        "label",
        {
          className: O(
            "flex items-center gap-2 min-h-[44px] cursor-pointer hover:bg-accent rounded px-2",
            a && "opacity-50 cursor-not-allowed",
            s
          ),
          children: [
            /* @__PURE__ */ m(
              "input",
              {
                ref: l,
                id: e,
                type: "checkbox",
                checked: n,
                onChange: u,
                disabled: a,
                className: "w-[var(--ui-checkbox-size)] h-[var(--ui-checkbox-size)] rounded border-2 border-border text-accent-foreground focus:ring-2 focus:ring-ring focus:ring-offset-2 cursor-pointer disabled:cursor-not-allowed"
              }
            ),
            /* @__PURE__ */ m("span", { className: "text-ui select-none text-foreground", children: o })
          ]
        }
      );
    }
  )
);
Dm.displayName = "Checkbox";
var Mm = Object.defineProperty, yn = (e, n) => Mm(e, "name", { value: n, configurable: !0 }), ho = "Collapsible", [Lm, qb] = /* @__PURE__ */ Ie(ho), [Fm, go] = Lm(ho), $m = /* @__PURE__ */ f.forwardRef(
  /* @__PURE__ */ yn(function(n, r) {
    const {
      __scopeCollapsible: o,
      open: s,
      defaultOpen: a,
      disabled: i,
      onOpenChange: l,
      ...u
    } = n, [d, p] = Xe({
      prop: s,
      defaultProp: a ?? !1,
      onChange: l,
      caller: ho
    });
    return /* @__PURE__ */ m(
      Fm,
      {
        scope: o,
        disabled: i,
        contentId: Me(),
        open: d,
        onOpenToggle: f.useCallback(() => p((c) => !c), [p]),
        children: /* @__PURE__ */ m(
          Q.div,
          {
            "data-state": er(d),
            "data-disabled": i ? "" : void 0,
            ...u,
            ref: r
          }
        )
      }
    );
  }, "Collapsible")
), zm = "CollapsibleTrigger", Bm = /* @__PURE__ */ f.forwardRef(
  // blank line to reduce diff noise
  /* @__PURE__ */ yn(function(n, r) {
    const { __scopeCollapsible: o, ...s } = n, a = go(zm, o);
    return /* @__PURE__ */ m(
      Q.button,
      {
        type: "button",
        "aria-controls": a.open ? a.contentId : void 0,
        "aria-expanded": a.open || !1,
        "data-state": er(a.open),
        "data-disabled": a.disabled ? "" : void 0,
        disabled: a.disabled,
        ...s,
        ref: r,
        onClick: X(n.onClick, a.onOpenToggle)
      }
    );
  }, "CollapsibleTrigger")
), _i = "CollapsibleContent", Vm = /* @__PURE__ */ f.forwardRef(
  // blank line to reduce diff noise
  /* @__PURE__ */ yn(function(n, r) {
    const { forceMount: o, ...s } = n, a = go(_i, n.__scopeCollapsible);
    return /* @__PURE__ */ m(ct, { present: o || a.open, children: ({ present: i }) => /* @__PURE__ */ m(jm, { ...s, ref: r, present: i }) });
  }, "CollapsibleContent")
), jm = /* @__PURE__ */ f.forwardRef(/* @__PURE__ */ yn(function(n, r) {
  const { __scopeCollapsible: o, present: s, children: a, ...i } = n, l = go(_i, o), [u, d] = f.useState(s), p = f.useRef(null), c = oe(r, p), h = f.useRef(0), g = h.current, y = f.useRef(0), b = y.current, v = l.open || u, x = f.useRef(v), S = f.useRef(void 0);
  return f.useEffect(() => {
    const w = requestAnimationFrame(() => x.current = !1);
    return () => cancelAnimationFrame(w);
  }, []), ue(() => {
    const w = p.current;
    if (w) {
      S.current = S.current || {
        transitionDuration: w.style.transitionDuration,
        animationName: w.style.animationName
      }, w.style.transitionDuration = "0s", w.style.animationName = "none";
      const C = w.getBoundingClientRect();
      h.current = C.height, y.current = C.width, x.current || (w.style.transitionDuration = S.current.transitionDuration, w.style.animationName = S.current.animationName), d(s);
    }
  }, [l.open, s]), /* @__PURE__ */ m(
    Q.div,
    {
      "data-state": er(l.open),
      "data-disabled": l.disabled ? "" : void 0,
      id: l.contentId,
      hidden: !v,
      ...i,
      ref: c,
      style: {
        "--radix-collapsible-content-height": g ? `${g}px` : void 0,
        "--radix-collapsible-content-width": b ? `${b}px` : void 0,
        ...n.style
      },
      children: v && a
    }
  );
}, "CollapsibleContentImpl"));
function er(e) {
  return e ? "open" : "closed";
}
yn(er, "getState");
var Hm = $m;
const Zb = Hm, Qb = Bm, Jb = Vm, ey = ({
  open: e,
  onOpenChange: n,
  title: r,
  description: o,
  onConfirm: s,
  onCancel: a,
  confirmText: i = "Confirm",
  cancelText: l = "Cancel",
  variant: u = "default",
  loading: d = !1,
  showCancel: p = !0
}) => /* @__PURE__ */ m(
  bn,
  {
    open: e,
    onOpenChange: n,
    title: r,
    description: o,
    footer: /* @__PURE__ */ D(Qe, { children: [
      p && /* @__PURE__ */ m(xe, { variant: "outline", onClick: () => {
        a?.(), n(!1);
      }, disabled: d, children: l }),
      /* @__PURE__ */ m(xe, { variant: u, onClick: () => {
        s();
      }, loading: d, children: i })
    ] })
  }
), ty = ({
  patientName: e,
  patientId: n,
  additionalInfo: r,
  className: o = "",
  navigationBack: s,
  onBack: a,
  backLabel: i
}) => /* @__PURE__ */ m(
  "header",
  {
    className: `w-full border-b border-border bg-background ${o}`,
    children: /* @__PURE__ */ m("div", { className: "flex items-center justify-between gap-4 px-ui py-ui", children: /* @__PURE__ */ D("div", { className: "flex items-center gap-3 min-w-0", children: [
      a ? /* @__PURE__ */ D(xe, { variant: "link", className: "px-2 -ml-2", onClick: a, children: [
        /* @__PURE__ */ m(Ea, { className: "h-4 w-4 mr-2" }),
        i || "戻る"
      ] }) : s,
      /* @__PURE__ */ D("div", { className: "min-w-0", children: [
        /* @__PURE__ */ D("div", { className: "flex items-center gap-2 min-w-0", children: [
          /* @__PURE__ */ m("h1", { className: "text-xl font-semibold text-foreground truncate", children: e }),
          n && /* @__PURE__ */ m("span", { className: "text-sm text-muted-foreground bg-card rounded px-2 py-1 flex items-center max-w-[120px]", children: /* @__PURE__ */ m(
            ln,
            {
              text: n.length > 8 ? `${n.slice(0, 8)}...` : n,
              className: "w-full"
            }
          ) })
        ] }),
        r && /* @__PURE__ */ m("div", { className: "text-sm text-muted-foreground truncate", children: r })
      ] })
    ] }) })
  }
), ny = ({
  text: e,
  copyValue: n,
  className: r,
  onCopied: o,
  onCopyError: s
}) => {
  const a = (l) => l, i = async (l) => {
    l.stopPropagation();
    const u = n || e;
    try {
      await navigator.clipboard.writeText(u), o?.(u);
    } catch (d) {
      s?.(d);
    }
  };
  return /* @__PURE__ */ D(
    xe,
    {
      variant: "link",
      className: `p-0 h-auto font-normal hover:no-underline hover:text-primary items-center gap-1 ${r || ""}`,
      onClick: i,
      title: a("click_to_copy"),
      children: [
        e,
        /* @__PURE__ */ m(Nd, { className: "h-3 w-3 opacity-50" })
      ]
    }
  );
}, ry = P.memo(
  ({ date: e, format: n = "full", className: r, locale: o }) => {
    const s = o || "en", a = s === "ja" ? "ja-JP" : "en-GB";
    return /* @__PURE__ */ m("span", { className: r, children: (() => {
      switch (n) {
        case "weekday":
          return e.toLocaleDateString(a, { weekday: "long" });
        case "weekdayShort":
          return e.toLocaleDateString(a, { weekday: "short" });
        case "yearMonth":
          return s === "ja" ? `${e.getFullYear()}年${e.getMonth() + 1}月` : e.toLocaleDateString(a, {
            year: "numeric",
            month: "long"
          });
        case "monthDay":
          return s === "ja" ? `${e.getMonth() + 1}月${e.getDate()}日` : e.toLocaleDateString(a, {
            day: "numeric",
            month: "long"
          });
        case "monthDayShort": {
          if (s === "ja") {
            const d = e.toLocaleDateString(a, {
              weekday: "short"
            });
            return `${e.getMonth() + 1}/${e.getDate()} (${d})`;
          }
          const l = e.toLocaleDateString(a, {
            month: "short"
          }), u = e.toLocaleDateString(a, {
            weekday: "short"
          });
          return `${e.getDate()} ${l} (${u})`;
        }
        case "compact": {
          if (s === "ja") {
            const u = e.toLocaleDateString(a, {
              weekday: "short"
            });
            return `${e.getMonth() + 1}/${e.getDate()}
(${u})`;
          }
          const l = e.toLocaleDateString(a, {
            weekday: "short"
          });
          return `${e.getDate()}
${l}`;
        }
        case "date":
          return s === "ja" ? e.toLocaleDateString(a, {
            year: "numeric",
            month: "long",
            day: "numeric"
          }) : e.toLocaleDateString(a, {
            day: "numeric",
            month: "long",
            year: "numeric"
          });
        default:
          if (s === "ja") {
            const l = e.toLocaleDateString(a, {
              year: "numeric",
              month: "long",
              day: "numeric"
            }), u = e.toLocaleDateString(a, {
              weekday: "long"
            });
            return `${l}（${u}）`;
          }
          return e.toLocaleDateString(a, {
            weekday: "long",
            day: "numeric",
            month: "long",
            year: "numeric"
          });
      }
    })() });
  }
), Ii = vc(
  void 0
), oy = ({
  children: e,
  defaultSecondaryCalendar: n = "none",
  defaultPreferLocalCalendar: r = !1
}) => {
  const [o, s] = P.useState(n), [a, i] = P.useState(
    r
  ), l = ot(
    () => ({
      secondaryCalendar: o,
      preferLocalCalendar: a,
      setSecondaryCalendar: s,
      setPreferLocalCalendar: i
    }),
    [o, a]
  );
  return /* @__PURE__ */ m(Ii.Provider, { value: l, children: e });
}, Wm = () => {
  const e = gc(Ii);
  return e || {
    secondaryCalendar: "none",
    preferLocalCalendar: !1,
    setSecondaryCalendar: () => {
    },
    setPreferLocalCalendar: () => {
    }
  };
}, Um = () => typeof navigator < "u" && navigator.language ? navigator.language : "en-US", $s = (e, n) => {
  const r = n.toLowerCase();
  switch (e) {
    case "japanese":
      return r.startsWith("ja") ? n : "ja-JP";
    case "buddhist":
      return r.startsWith("th") ? n : "th-TH";
    case "islamic":
      return r.startsWith("ar") ? n : "ar-SA";
    case "chinese":
      return r.startsWith("zh") ? n : "zh-CN";
    default:
      return n;
  }
}, zs = (e, n, r, o) => {
  const s = {
    year: "numeric",
    month: n.startsWith("ja") ? "2-digit" : "short",
    day: "2-digit"
  };
  return e === "japanese" && n.startsWith("ja") && (s.era = "long", s.month = "long", s.day = "numeric"), r && (s.hour = "2-digit", s.minute = "2-digit"), o && (s.weekday = "short"), s;
}, kr = /* @__PURE__ */ new Map(), Bs = (e, n) => {
  const r = `${e}-${JSON.stringify(n)}`;
  return kr.has(r) || kr.set(r, new Intl.DateTimeFormat(e, n)), kr.get(r);
}, Vs = (e, n, r, o, s) => {
  const a = (i) => s === "islamic" ? i.formatToParts(e).filter((d) => d.type !== "era").map((d) => d.value).join("").replace(/\s{2,}/g, " ").trim() : i.format(e);
  try {
    return a(Bs(n, o));
  } catch {
    return a(Bs(r, o));
  }
}, sy = ({
  date: e,
  showDayOfWeek: n = !1,
  showTime: r = !1,
  className: o,
  calendar: s,
  showSecondary: a = !1,
  locale: i
}) => {
  const { secondaryCalendar: l, preferLocalCalendar: u } = Wm(), d = i || Um(), p = ot(() => {
    if (!e) return null;
    if (e instanceof Date) return e;
    const y = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(e);
    if (y) {
      const b = Number(y[1]), v = Number(y[2]), x = Number(y[3]);
      return new Date(b, v - 1, x);
    }
    return new Date(e);
  }, [e]), c = ot(() => s || (u ? d.startsWith("ja") ? "japanese" : d.startsWith("ar") ? "islamic" : d.startsWith("th") ? "buddhist" : d.startsWith("zh") ? "chinese" : "gregorian" : "gregorian"), [s, u, d]), h = ot(() => {
    if (!p || Number.isNaN(p.getTime()))
      return "-";
    let y = d;
    c !== "gregorian" && (y = `${$s(c, d)}-u-ca-${{
      japanese: "japanese",
      buddhist: "buddhist",
      islamic: "islamic",
      chinese: "chinese"
    }[c]}`);
    const b = zs(
      c,
      d,
      r,
      n
    );
    return Vs(
      p,
      y,
      d,
      b,
      c
    );
  }, [c, d, r, n, p]), g = ot(() => {
    if (!p || Number.isNaN(p.getTime()))
      return null;
    if (a && !u && l !== "none" && l !== c) {
      const y = {
        japanese: "japanese",
        buddhist: "buddhist",
        islamic: "islamic",
        chinese: "chinese"
      }, v = `${$s(
        l,
        d
      )}-u-ca-${y[l]}`, x = zs(
        l,
        d,
        r,
        n
      );
      return Vs(
        p,
        v,
        d,
        x,
        l
      );
    }
    return null;
  }, [
    a,
    u,
    l,
    c,
    d,
    r,
    n,
    p
  ]);
  return h === "-" ? /* @__PURE__ */ m("span", { className: o, children: "-" }) : /* @__PURE__ */ D("span", { className: o, children: [
    h,
    g && /* @__PURE__ */ D("span", { className: "text-muted-foreground ms-2", children: [
      "(",
      g,
      ")"
    ] })
  ] });
}, Gm = Yt(
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
), ay = f.memo(
  ({
    isOpen: e,
    onClose: n,
    children: r,
    position: o = "right",
    noPadding: s = !1,
    title: a,
    description: i,
    className: l,
    width: u
  }) => /* @__PURE__ */ m(
    xi,
    {
      open: e,
      onOpenChange: (d) => !d && n(),
      children: /* @__PURE__ */ D(Si, { children: [
        /* @__PURE__ */ m(
          ki,
          {
            className: O(
              "fixed inset-0 z-50 bg-black/40 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
            )
          }
        ),
        /* @__PURE__ */ D(
          Ei,
          {
            className: O(
              Gm({ side: o }),
              s && "p-0",
              l
            ),
            style: u ? { width: u, maxWidth: "100vw" } : void 0,
            children: [
              /* @__PURE__ */ D(
                "div",
                {
                  className: O(
                    "flex flex-col space-y-2 text-center sm:text-left",
                    s ? "px-6 pt-6 mb-4" : "mb-4"
                  ),
                  children: [
                    /* @__PURE__ */ m(
                      Ri,
                      {
                        className: O(
                          "text-lg font-semibold text-foreground",
                          !a && "sr-only"
                        ),
                        children: a || "Drawer"
                      }
                    ),
                    i && /* @__PURE__ */ m(Ln, { className: "text-sm text-muted-foreground", children: i })
                  ]
                }
              ),
              /* @__PURE__ */ m("div", { className: "flex-1 overflow-y-auto -mx-[var(--ui-modal-padding)] px-[var(--ui-modal-padding)]", children: r }),
              /* @__PURE__ */ D(Pi, { className: "absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-secondary", children: [
                /* @__PURE__ */ m(Xt, { className: "h-4 w-4" }),
                /* @__PURE__ */ m("span", { className: "sr-only", children: "Close" })
              ] })
            ]
          }
        )
      ] })
    }
  )
), iy = f.memo(
  ({
    trigger: e,
    items: n,
    align: r = "left",
    side: o = "bottom",
    autoFlip: s = !0,
    autoSide: a = !0,
    offset: i = 8,
    minWidthPx: l = 160,
    className: u = ""
  }) => {
    const [d, p] = Ke(!1), c = an(null), h = an(null), [g, y] = Ke({
      position: "fixed",
      top: -9999,
      left: -9999,
      visibility: "hidden",
      zIndex: 50
    }), b = f.useCallback(() => {
      const k = c.current?.getBoundingClientRect(), T = k ? Math.max(l, k.width) : l;
      y({
        position: "fixed",
        top: -9999,
        left: -9999,
        minWidth: T,
        visibility: "hidden",
        zIndex: 50
      });
    }, [l]), v = f.useCallback(() => {
      const E = c.current, k = h.current;
      if (!E || !k) return;
      const T = E.getBoundingClientRect(), I = k.getBoundingClientRect(), L = window.innerWidth, A = window.innerHeight, _ = 8, M = A - T.bottom - _, U = T.top - _;
      let $ = o;
      a && (M >= I.height ? $ = "bottom" : U >= I.height ? $ = "top" : $ = M >= U ? "bottom" : "top");
      const B = Math.max(l, T.width);
      let W = $ === "bottom" ? T.bottom + i : T.top - I.height - i;
      const z = Math.max(I.width, B), F = T.left, le = T.right - z;
      let ee = r;
      if (s) {
        const G = r === "left" ? F : le, ie = G < _, K = G + z > L - _;
        r === "left" && K || r === "right" && ie ? ee = r === "left" ? "right" : "left" : (ie || K) && (ee = r);
      }
      const ae = ee === "left" ? F : le, q = Math.min(
        L - _ - z,
        Math.max(_, ae)
      );
      if (a) {
        if ($ === "bottom" && W + I.height > A - _) {
          const G = T.top - I.height - i;
          G >= _ && (W = G);
        } else if ($ === "top" && W < _) {
          const G = T.bottom + i;
          G + I.height <= A - _ && (W = G);
        }
      }
      const Y = $ === "bottom" ? Math.max(120, A - W - _) : Math.max(120, T.top - _);
      y({
        position: "fixed",
        top: W,
        left: q,
        minWidth: B,
        maxHeight: Y,
        overflowY: "auto",
        zIndex: 50,
        visibility: "visible"
      });
    }, [r, s, a, l, i, o]);
    kt(() => {
      const E = (k) => {
        const T = k.target;
        d && !c.current?.contains(T) && !h.current?.contains(T) && p(!1);
      };
      return d && document.addEventListener("mousedown", E), () => {
        document.removeEventListener("mousedown", E);
      };
    }, [d]), kt(() => {
      if (!d) return;
      let E = 0;
      const k = () => {
        E || (E = window.requestAnimationFrame(() => {
          E = 0, v();
        }));
      };
      b(), k(), window.addEventListener("resize", k), window.addEventListener("scroll", k, !0);
      const T = h.current, I = T ? new ResizeObserver(() => {
        k();
      }) : null;
      return T && I && I.observe(T), () => {
        E && window.cancelAnimationFrame(E), window.removeEventListener("resize", k), window.removeEventListener("scroll", k, !0), I?.disconnect();
      };
    }, [v, d, b]), kt(() => {
      if (!d) return;
      const E = (k) => {
        k.key === "Escape" && p(!1);
      };
      return window.addEventListener("keydown", E), () => window.removeEventListener("keydown", E);
    }, [d]);
    const x = (E) => {
      log.debug("Menu item clicked", { label: E.label }), E.onClick(), p(!1);
    }, S = () => {
      p((E) => (E || b(), !E));
    }, w = (E) => {
      E?.defaultPrevented || S();
    }, C = (E) => {
      E.defaultPrevented || (E.key === "Enter" || E.key === " ") && (E.preventDefault(), S());
    }, N = {
      "aria-haspopup": "menu",
      "aria-expanded": d,
      onClick: w,
      onKeyDown: C,
      ref: (E) => {
        c.current = E;
      }
    }, R = f.isValidElement(e) ? f.cloneElement(e, {
      ...N,
      onClick: (E) => {
        e.props?.onClick?.(E), w(E);
      },
      onKeyDown: (E) => {
        e.props?.onKeyDown?.(E), C(E);
      },
      ...e.type === "button" ? { type: "button" } : {}
    }) : /* @__PURE__ */ m("button", { type: "button", ...N, children: e });
    return /* @__PURE__ */ D("div", { className: u, children: [
      /* @__PURE__ */ m("div", { style: { display: "inline-block" }, children: R }),
      d && yc(
        /* @__PURE__ */ m(
          "div",
          {
            ref: h,
            role: "menu",
            style: g,
            className: "rounded-md border border-border bg-background shadow-lg",
            children: /* @__PURE__ */ m("div", { className: "py-[var(--ui-component-padding-y)]", children: n.map((E) => /* @__PURE__ */ D(
              "button",
              {
                type: "button",
                role: "menuitem",
                onClick: () => x(E),
                className: "flex w-full items-center gap-ui px-ui text-left text-ui text-foreground hover:bg-accent focus:bg-accent focus:outline-none min-h-[var(--ui-list-row-height)]",
                children: [
                  E.icon && /* @__PURE__ */ m("span", { className: "text-muted-foreground", children: E.icon }),
                  /* @__PURE__ */ m("span", { children: E.label })
                ]
              },
              E.label
            )) })
          }
        ),
        document.body
      )
    ] });
  }
), Oi = Yt(
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
), Ai = Yt(
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
), Km = f.forwardRef(
  ({
    value: e,
    onChange: n,
    options: r,
    className: o,
    placeholder: s,
    disabled: a = !1,
    variant: i = "default",
    size: l = "md"
  }, u) => {
    const [d, p] = f.useState(!1), c = f.useRef(null);
    f.useEffect(() => {
      const g = (y) => {
        c.current && !c.current.contains(y.target) && p(!1);
      };
      return document.addEventListener("mousedown", g), () => document.removeEventListener("mousedown", g);
    }, []);
    const h = (g) => {
      n(String(g)), p(!1);
    };
    return /* @__PURE__ */ D("div", { className: O("relative", o), ref: c, children: [
      /* @__PURE__ */ D(
        "div",
        {
          className: O(
            Oi({ variant: i, size: l }),
            "cursor-text",
            "focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2",
            a && "pointer-events-none"
          ),
          "aria-disabled": a,
          children: [
            /* @__PURE__ */ m(
              "input",
              {
                ref: u,
                type: "text",
                value: e,
                onChange: (g) => n(g.target.value),
                placeholder: s,
                disabled: a,
                className: O(
                  "w-full bg-transparent border-none text-foreground text-left appearance-none focus:outline-none p-0 m-0",
                  "placeholder:text-muted-foreground"
                ),
                onFocus: () => p(!0)
              }
            ),
            /* @__PURE__ */ m(
              "button",
              {
                type: "button",
                onClick: () => p((g) => !g),
                className: O(
                  "inline-flex items-center justify-center rounded",
                  "text-muted-foreground hover:bg-accent focus:outline-none"
                ),
                tabIndex: -1,
                "aria-label": "Toggle options",
                children: /* @__PURE__ */ m(
                  Xn,
                  {
                    className: O(l === "lg" ? "h-5 w-5" : "h-4 w-4")
                  }
                )
              }
            )
          ]
        }
      ),
      d && /* @__PURE__ */ m("div", { className: "absolute z-50 w-full mt-1 max-h-60 overflow-y-auto bg-background border border-border rounded-md shadow-lg scrollbar-thin", children: r.map((g) => /* @__PURE__ */ m(
        "button",
        {
          type: "button",
          onClick: () => h(g),
          className: O(
            Ai({
              size: l,
              indicator: "none",
              padding: "plain"
            }),
            "w-full text-left text-foreground hover:bg-accent hover:text-accent-foreground"
          ),
          children: g
        },
        g
      )) })
    ] });
  }
);
Km.displayName = "EditableSelect";
var Ym = Object.defineProperty, Xm = (e, n) => Ym(e, "name", { value: n, configurable: !0 }), qm = /* @__PURE__ */ f.forwardRef(
  /* @__PURE__ */ Xm(function(n, r) {
    return /* @__PURE__ */ m(
      Q.label,
      {
        ...n,
        ref: r,
        onMouseDown: (o) => {
          o.target.closest("button, input, select, textarea") || (n.onMouseDown?.(o), !o.defaultPrevented && o.detail > 1 && o.preventDefault());
        }
      }
    );
  }, "Label")
), Di = qm, Zm = (e) => e.type === "checkbox", sn = (e) => e instanceof Date, vo = (e) => e == null;
const Mi = (e) => typeof e == "object";
var Nt = (e) => !vo(e) && !Array.isArray(e) && Mi(e) && !sn(e), Qm = (e) => Nt(e) && e.target ? Zm(e.target) ? e.target.checked : e.target.value : e, Jm = (e) => e.substring(0, e.search(/\.\d+(\.|$)/)) || e, ep = (e, n) => e.has(Jm(n)), tp = (e) => {
  const n = e.constructor && e.constructor.prototype;
  return Nt(n) && n.hasOwnProperty("isPrototypeOf");
}, np = typeof window < "u" && typeof window.HTMLElement < "u" && typeof document < "u";
function Li(e) {
  if (e instanceof Date)
    return new Date(e);
  const n = typeof FileList < "u" && e instanceof FileList;
  if (np && (e instanceof Blob || n))
    return e;
  const r = Array.isArray(e);
  if (!r && !(Nt(e) && tp(e)))
    return e;
  const o = r ? [] : Object.create(Object.getPrototypeOf(e));
  for (const s in e)
    Object.prototype.hasOwnProperty.call(e, s) && (o[s] = Li(e[s]));
  return o;
}
var Fi = (e) => /^\w*$/.test(e), Kr = (e) => e === void 0, rp = (e) => Array.isArray(e) ? e.filter(Boolean) : [], $i = (e) => rp(e.replace(/["|']|\]/g, "").split(/\.|\[/)), Re = (e, n, r) => {
  if (!n || !Nt(e))
    return r;
  const o = (Fi(n) ? [n] : $i(n)).reduce((s, a) => vo(s) ? s : s[a], e);
  return Kr(o) || o === e ? Kr(e[n]) ? r : e[n] : o;
}, Er = (e) => typeof e == "boolean", In = (e) => typeof e == "function", js = (e, n, r) => {
  let o = -1;
  const s = Fi(n) ? [n] : $i(n), a = s.length, i = a - 1;
  for (; ++o < a; ) {
    const l = s[o];
    let u = r;
    if (o !== i) {
      const d = e[l];
      u = Nt(d) || Array.isArray(d) ? d : isNaN(+s[o + 1]) ? {} : [];
    }
    if (l === "__proto__" || l === "constructor" || l === "prototype")
      return;
    e[l] = u, e = e[l];
  }
};
const Hs = {
  BLUR: "blur",
  CHANGE: "change"
}, Ws = {
  all: "all"
}, bo = P.createContext(null);
bo.displayName = "HookFormControlContext";
const yo = () => P.useContext(bo);
var op = (e, n, r, o = !0) => {
  const s = {
    defaultValues: n._defaultValues
  };
  for (const a in e)
    Object.defineProperty(s, a, {
      get: () => {
        const i = a;
        return n._proxyFormState[i] !== Ws.all && (n._proxyFormState[i] = !o || Ws.all), r && (r[i] = !0), e[i];
      }
    });
  return s;
};
const zi = typeof window < "u" ? P.useLayoutEffect : P.useEffect;
function sp(e) {
  const n = yo(), { control: r = n, disabled: o, name: s, exact: a } = e || {}, [i, l] = P.useState(r._formState), u = P.useRef({
    isDirty: !1,
    isLoading: !1,
    dirtyFields: !1,
    touchedFields: !1,
    validatingFields: !1,
    isValidating: !1,
    isValid: !1,
    errors: !1
  });
  return zi(() => r._subscribe({
    name: s,
    formState: u.current,
    exact: a,
    callback: (d) => {
      !o && l({
        ...r._formState,
        ...d
      });
    }
  }), [s, o, a]), P.useEffect(() => {
    u.current.isValid && r._setValid(!0);
  }, [r]), P.useMemo(() => op(i, r, u.current, !1), [i, r]);
}
var ap = (e) => typeof e == "string", Us = (e, n, r, o, s) => ap(e) ? Re(r, e, s) : Array.isArray(e) ? e.map((a) => Re(r, a)) : r, Gs = (e) => vo(e) || !Mi(e);
function Fn(e, n, r = /* @__PURE__ */ new WeakSet()) {
  if (Gs(e) || Gs(n))
    return Object.is(e, n);
  if (sn(e) && sn(n))
    return Object.is(e.getTime(), n.getTime());
  const o = Object.keys(e), s = Object.keys(n);
  if (o.length !== s.length)
    return !1;
  if (r.has(e) || r.has(n))
    return !0;
  r.add(e), r.add(n);
  for (const a of o) {
    const i = e[a];
    if (!s.includes(a))
      return !1;
    if (a !== "ref") {
      const l = n[a];
      if (sn(i) && sn(l) || Nt(i) && Nt(l) || Array.isArray(i) && Array.isArray(l) ? !Fn(i, l, r) : !Object.is(i, l))
        return !1;
    }
  }
  return !0;
}
function ip(e) {
  const n = yo(), { control: r = n, name: o, defaultValue: s, disabled: a, exact: i, compute: l } = e || {}, u = P.useRef(s), d = P.useRef(l), p = P.useRef(void 0), c = P.useRef(r), h = P.useRef(o);
  d.current = l;
  const [g, y] = P.useState(() => {
    const C = r._getWatch(o, u.current);
    return d.current ? d.current(C) : C;
  }), b = P.useCallback((C) => {
    const N = Us(o, r._names, C || r._formValues, !1, u.current);
    return d.current ? d.current(N) : N;
  }, [r._formValues, r._names, o]), v = P.useCallback((C) => {
    if (!a) {
      const N = Us(o, r._names, C || r._formValues, !1, u.current);
      if (d.current) {
        const R = d.current(N);
        Fn(R, p.current) || (y(R), p.current = R);
      } else
        y(N);
    }
  }, [r._formValues, r._names, a, o]);
  zi(() => ((c.current !== r || !Fn(h.current, o)) && (c.current = r, h.current = o, v()), r._subscribe({
    name: o,
    formState: {
      values: !0
    },
    exact: i,
    callback: (C) => {
      v(C.values);
    }
  })), [r, i, o, v]), P.useEffect(() => r._removeUnmounted());
  const x = c.current !== r, S = h.current, w = P.useMemo(() => {
    if (a)
      return null;
    const C = !x && !Fn(S, o);
    return x || C ? b() : null;
  }, [a, x, o, S, b]);
  return w !== null ? w : g;
}
function lp(e) {
  const n = yo(), { name: r, disabled: o, control: s = n, shouldUnregister: a, defaultValue: i, exact: l = !0 } = e, u = ep(s._names.array, r), d = P.useMemo(() => Re(s._formValues, r, Re(s._defaultValues, r, i)), [s, r, i]), p = ip({
    control: s,
    name: r,
    defaultValue: d,
    exact: l
  }), c = sp({
    control: s,
    name: r,
    exact: l
  }), h = P.useRef(e), g = P.useRef(void 0), y = P.useRef(s.register(r, {
    ...e.rules,
    value: p,
    ...Er(e.disabled) ? { disabled: e.disabled } : {}
  }));
  h.current = e;
  const b = P.useMemo(() => Object.defineProperties({}, {
    invalid: {
      enumerable: !0,
      get: () => !!Re(c.errors, r)
    },
    isDirty: {
      enumerable: !0,
      get: () => !!Re(c.dirtyFields, r)
    },
    isTouched: {
      enumerable: !0,
      get: () => !!Re(c.touchedFields, r)
    },
    isValidating: {
      enumerable: !0,
      get: () => !!Re(c.validatingFields, r)
    },
    error: {
      enumerable: !0,
      get: () => Re(c.errors, r)
    }
  }), [c, r]), v = P.useCallback((C) => y.current.onChange({
    target: {
      value: Qm(C),
      name: r
    },
    type: Hs.CHANGE
  }), [r]), x = P.useCallback(() => y.current.onBlur({
    target: {
      value: Re(s._formValues, r),
      name: r
    },
    type: Hs.BLUR
  }), [r, s._formValues]), S = P.useCallback((C) => {
    const N = Re(s._fields, r);
    N && N._f && C && (N._f.ref = {
      focus: () => In(C.focus) && C.focus(),
      select: () => In(C.select) && C.select(),
      setCustomValidity: (R) => In(C.setCustomValidity) && C.setCustomValidity(R),
      reportValidity: () => In(C.reportValidity) && C.reportValidity()
    });
  }, [s._fields, r]), w = P.useMemo(() => ({
    name: r,
    value: p,
    ...Er(o) || c.disabled ? { disabled: c.disabled || o } : {},
    onChange: v,
    onBlur: x,
    ref: S
  }), [r, o, c.disabled, v, x, S, p]);
  return P.useEffect(() => {
    const C = s._options.shouldUnregister || a, N = g.current;
    N && N !== r && !u && s.unregister(N), s.register(r, {
      ...h.current.rules,
      ...Er(h.current.disabled) ? { disabled: h.current.disabled } : {}
    });
    const R = (E, k) => {
      const T = Re(s._fields, E);
      T && T._f && (T._f.mount = k);
    };
    if (R(r, !0), C) {
      const E = Li(Re(s._options.defaultValues, r, h.current.defaultValue));
      js(s._defaultValues, r, E), Kr(Re(s._formValues, r)) && js(s._formValues, r, E);
    }
    return !u && s.register(r), g.current = r, () => {
      (u ? C && !s._state.action : C) ? s.unregister(r) : R(r, !1);
    };
  }, [r, s, u, a]), P.useEffect(() => {
    s._setDisabledField({
      disabled: o,
      name: r
    });
  }, [o, r, s]), P.useMemo(() => ({
    field: w,
    formState: c,
    fieldState: b
  }), [w, c, b]);
}
const cp = (e) => e.render(lp(e)), xo = P.createContext(null);
xo.displayName = "HookFormContext";
const dp = () => P.useContext(xo), up = (e) => {
  const { children: n, watch: r, getValues: o, getFieldState: s, setError: a, clearErrors: i, setValue: l, trigger: u, formState: d, resetField: p, reset: c, handleSubmit: h, unregister: g, control: y, register: b, setFocus: v, subscribe: x } = e;
  return P.createElement(
    xo.Provider,
    { value: P.useMemo(() => ({
      watch: r,
      getValues: o,
      getFieldState: s,
      setError: a,
      clearErrors: i,
      setValue: l,
      trigger: u,
      formState: d,
      resetField: p,
      reset: c,
      handleSubmit: h,
      unregister: g,
      control: y,
      register: b,
      setFocus: v,
      subscribe: x
    }), [
      i,
      y,
      d,
      s,
      o,
      h,
      b,
      c,
      p,
      a,
      v,
      l,
      x,
      u,
      g,
      r
    ]) },
    P.createElement(bo.Provider, { value: y }, n)
  );
}, ly = up, Bi = f.createContext(
  void 0
);
function tr() {
  const e = f.useContext(Bi), n = f.useContext(Vi), { getFieldState: r, formState: o } = dp();
  if (!e)
    throw new Error("useFormField should be used within <FormField>");
  const s = r(e.name, o), a = n.id;
  return {
    id: a,
    name: e.name,
    formItemId: `${a}-form-item`,
    formDescriptionId: `${a}-form-item-description`,
    formMessageId: `${a}-form-item-message`,
    ...s
  };
}
const Vi = f.createContext(
  {}
);
function cy(e) {
  return /* @__PURE__ */ m(Bi.Provider, { value: { name: e.name }, children: /* @__PURE__ */ m(cp, { ...e }) });
}
const fp = f.forwardRef(({ className: e, ...n }, r) => {
  const o = f.useId();
  return /* @__PURE__ */ m(Vi.Provider, { value: { id: o }, children: /* @__PURE__ */ m("div", { ref: r, className: O("space-y-2", e), ...n }) });
}), mp = f.memo(fp);
mp.displayName = "FormItem";
const pp = f.forwardRef(({ className: e, ...n }, r) => {
  const { formItemId: o } = tr();
  return /* @__PURE__ */ m(
    Di,
    {
      ref: r,
      className: O(
        "text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
        e
      ),
      htmlFor: o,
      ...n
    }
  );
}), hp = f.memo(pp);
hp.displayName = "FormLabel";
const gp = f.forwardRef(({ ...e }, n) => {
  const { error: r, formItemId: o, formDescriptionId: s, formMessageId: a } = tr();
  return /* @__PURE__ */ m(
    ha,
    {
      ref: n,
      id: o,
      "aria-describedby": r ? `${s} ${a}` : s,
      "aria-invalid": !!r,
      "aria-errormessage": a,
      ...e
    }
  );
}), vp = f.memo(gp);
vp.displayName = "FormControl";
const bp = f.forwardRef(({ className: e, ...n }, r) => {
  const { formDescriptionId: o } = tr();
  return /* @__PURE__ */ m(
    "p",
    {
      ref: r,
      id: o,
      className: O("text-sm text-muted-foreground", e),
      ...n
    }
  );
}), yp = f.memo(bp);
yp.displayName = "FormDescription";
const xp = f.forwardRef(({ className: e, children: n, ...r }, o) => {
  const { error: s, formMessageId: a } = tr(), i = s ? String(s?.message) : n;
  return i ? /* @__PURE__ */ m(
    "p",
    {
      ref: o,
      id: a,
      className: O(
        "text-sm font-medium text-destructive-foreground",
        e
      ),
      ...r,
      children: i
    }
  ) : null;
}), wp = f.memo(xp);
wp.displayName = "FormMessage";
const Cp = P.memo(
  ({ src: e, alt: n, open: r, onOpenChange: o, maxWidthPx: s = 900 }) => {
    const a = an(null);
    return kt(() => {
      const i = (l) => {
        l.key === "Escape" && r && (log.debug("Escape pressed, closing viewer"), o(!1));
      };
      return window.addEventListener("keydown", i), () => window.removeEventListener("keydown", i);
    }, [r, o]), kt(() => {
      r && (e || log.warn("ImageViewer opened without src"));
    }, [r, e]), /* @__PURE__ */ m(
      bn,
      {
        open: r,
        onOpenChange: o,
        noHeader: !0,
        noPadding: !0,
        contentClassName: "bg-black/90 border border-black/40 shadow-xl focus:outline-none flex items-center justify-center max-h-[90vh]",
        className: "p-2 md:p-4 bg-transparent border-none shadow-none",
        children: /* @__PURE__ */ m("div", { className: "w-full h-full flex items-center justify-center", children: /* @__PURE__ */ m(
          "img",
          {
            ref: a,
            src: e,
            alt: n || t("image"),
            className: O(
              "rounded-md object-contain shadow-lg",
              "max-h-[80vh] w-auto",
              "transition-opacity duration-200"
            ),
            style: { maxWidth: `${s}px` }
          }
        ) })
      }
    );
  }
), dy = () => {
  const [e, n] = P.useState(!1), [r, o] = P.useState(null), [s, a] = P.useState(void 0);
  return { open: e, show: (u, d) => {
    o(u), a(d), n(!0);
  }, hide: () => n(!1), src: r, alt: s };
}, uy = ({
  src: e,
  alt: n,
  className: r,
  width: o,
  height: s,
  children: a
}) => {
  const [i, l] = P.useState(!1), u = n || t("image");
  return /* @__PURE__ */ D(Qe, { children: [
    /* @__PURE__ */ m(
      "button",
      {
        type: "button",
        className: O("cursor-pointer border-0 bg-transparent p-0", r),
        "aria-label": u,
        onClick: (d) => {
          d.stopPropagation(), l(!0);
        },
        onKeyDown: (d) => {
          (d.key === "Enter" || d.key === " ") && (d.preventDefault(), l(!0));
        },
        style: { width: o, height: s },
        children: a || /* @__PURE__ */ m(
          "img",
          {
            src: e,
            alt: n || "Image",
            className: "w-full h-full object-cover"
          }
        )
      }
    ),
    /* @__PURE__ */ m(Cp, { src: e, alt: n, open: i, onOpenChange: l })
  ] });
}, fy = ({
  title: e = "List",
  items: n,
  selectedId: r,
  onSelect: o,
  onLoadMore: s,
  hasMore: a = !1,
  isLoading: i = !1,
  loadMoreOffset: l = 120,
  emptyText: u = "No items available.",
  loadingText: d = "Loading more...",
  endText: p = "All items loaded.",
  headerMeta: c,
  hideHeader: h = !1,
  resizable: g = !1,
  resizeMinWidth: y = 240,
  resizeMaxWidth: b = "100%",
  className: v,
  listClassName: x,
  showDividers: S = !1,
  enableAdaptiveText: w = !1,
  width: C,
  onResize: N,
  selectedItem: R
}) => {
  const E = f.useRef(null), k = f.useRef(null), T = f.useRef(!1), I = n?.length ?? 0, L = I > 0, [A, _] = f.useState(
    void 0
  ), M = f.useRef(!1), U = C !== void 0 ? C : A, $ = f.useCallback(() => {
    if (!s || !a || i || T.current) return;
    const z = k.current;
    if (!z) return;
    z.scrollHeight - z.scrollTop - z.clientHeight <= l && (T.current = !0, s());
  }, [a, i, l, s]);
  f.useEffect(() => {
    i || (T.current = !1);
  }, [i]), f.useEffect(() => {
    T.current = !1;
  }, [I]), f.useEffect(() => {
    const z = k.current;
    if (!z) return;
    const F = () => $();
    return z.addEventListener("scroll", F, { passive: !0 }), $(), () => {
      z.removeEventListener("scroll", F);
    };
  }, [$]), f.useEffect(() => {
    (I > 0 || a) && $();
  }, [a, I, $]);
  const B = (z) => {
    if (!g) return;
    z.preventDefault(), M.current = !0;
    const F = z.clientX, le = E.current?.getBoundingClientRect().width || 0, ee = (q) => {
      if (!M.current) return;
      const Y = q.clientX - F;
      let G = le + Y;
      typeof y == "number" && (G = Math.max(G, y)), typeof b == "number" && (G = Math.min(G, b)), C !== void 0 ? N?.(G) : _(G);
    }, ae = () => {
      M.current = !1, document.removeEventListener("mousemove", ee), document.removeEventListener("mouseup", ae);
    };
    document.addEventListener("mousemove", ee), document.addEventListener("mouseup", ae);
  }, W = "px-ui py-ui";
  return /* @__PURE__ */ D(
    "div",
    {
      ref: E,
      className: O(
        "relative h-full min-h-0 flex flex-col transition-width duration-0",
        // duration-0 to avoid lag during drag
        g || U !== void 0 ? "flex-none" : "w-full",
        v
      ),
      style: g || U !== void 0 ? {
        width: U,
        minWidth: y,
        maxWidth: b
      } : void 0,
      children: [
        !h && /* @__PURE__ */ D("div", { className: "flex items-center bg-primary px-ui py-ui w-full mb-2 shrink-0 flex-nowrap", children: [
          /* @__PURE__ */ m("div", { className: "flex items-center font-bold flex-grow ps-2 text-primary-foreground min-w-0", children: /* @__PURE__ */ m("span", { className: "truncate", children: e }) }),
          c && /* @__PURE__ */ m("div", { className: "text-xs text-primary-foreground/80 shrink-0 ml-2", children: c })
        ] }),
        /* @__PURE__ */ D(
          "div",
          {
            ref: k,
            "data-testid": "infinite-list-menu-scroll",
            className: O(
              "bg-background w-full flex-1 min-h-0 overflow-y-auto",
              x
            ),
            children: [
              L ? /* @__PURE__ */ m(
                "div",
                {
                  role: "listbox",
                  className: O(
                    !S && "space-y-0.5",
                    S && "divide-y divide-border"
                  ),
                  children: (n ?? []).map((z) => {
                    const F = R ? R.id === z.id : r === z.id;
                    return /* @__PURE__ */ D(
                      "button",
                      {
                        type: "button",
                        role: "option",
                        "aria-selected": F,
                        disabled: z.disabled,
                        "aria-disabled": z.disabled || void 0,
                        onClick: () => o?.(z.id, z),
                        className: O(
                          "w-full flex items-center gap-3 transition-colors duration-150 text-start",
                          W,
                          "text-sm",
                          z.disabled && "opacity-50 pointer-events-none",
                          F ? "bg-primary text-primary-foreground font-semibold" : "hover:bg-primary/20 hover:text-foreground",
                          !S && "rounded-md"
                          // removing rounded-md if dividers are shown usually looks better, but let's keep it consistent or check user preference.
                          // If showing dividers, usually we don't have gaps. The original had space-y-0.5.
                          // If showDividers is true, we should probably remove space-y-0.5 or set it to 0.
                        ),
                        children: [
                          z.icon && /* @__PURE__ */ m(
                            "span",
                            {
                              className: O(
                                "shrink-0",
                                F ? "text-primary-foreground" : "text-muted-foreground"
                              ),
                              children: z.icon
                            }
                          ),
                          /* @__PURE__ */ D("span", { className: "min-w-0 flex-1", children: [
                            /* @__PURE__ */ m("span", { className: "block truncate", children: w && typeof z.label == "string" ? /* @__PURE__ */ m(ln, { text: z.label }) : z.label }),
                            z.description && /* @__PURE__ */ m("span", { className: "block truncate text-xs text-muted-foreground", children: z.description })
                          ] }),
                          z.meta !== void 0 && /* @__PURE__ */ m(
                            "span",
                            {
                              className: O(
                                "text-xs",
                                F ? "text-primary-foreground/80" : "text-muted-foreground"
                              ),
                              children: z.meta
                            }
                          ),
                          z.badge !== void 0 && /* @__PURE__ */ m(
                            "span",
                            {
                              className: O(
                                "ms-2 text-xs px-2 py-0.5 rounded",
                                F ? "bg-primary-foreground/20 text-primary-foreground" : "bg-muted text-muted-foreground"
                              ),
                              children: z.badge
                            }
                          )
                        ]
                      },
                      z.id
                    );
                  })
                }
              ) : /* @__PURE__ */ m("div", { className: "px-ui py-ui", children: i ? /* @__PURE__ */ D("div", { className: "flex items-center gap-2 text-xs text-muted-foreground", children: [
                /* @__PURE__ */ m(Et, { size: "xs", variant: "secondary" }),
                /* @__PURE__ */ m("span", { children: d })
              ] }) : /* @__PURE__ */ m("div", { className: "text-xs text-muted-foreground", children: u }) }),
              L && /* @__PURE__ */ m("div", { className: "px-ui py-ui", children: i ? /* @__PURE__ */ D("div", { className: "flex items-center gap-2 text-xs text-muted-foreground", children: [
                /* @__PURE__ */ m(Et, { size: "xs", variant: "secondary" }),
                /* @__PURE__ */ m("span", { children: d })
              ] }) : a ? null : /* @__PURE__ */ m("div", { className: "text-xs text-muted-foreground", children: p }) })
            ]
          }
        ),
        g && /* @__PURE__ */ m(
          "div",
          {
            "data-testid": "infinite-list-menu-resize-handle",
            className: "absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-primary/50 z-50 transition-colors",
            onMouseDown: B,
            "aria-hidden": "true"
          }
        )
      ]
    }
  );
}, Hn = f.forwardRef(
  ({ className: e, type: n, ...r }, o) => /* @__PURE__ */ m(
    "input",
    {
      type: n,
      className: O(
        "flex h-ui w-full rounded-md border border-input bg-background px-3 text-foreground text-ui ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 min-h-ui-touch",
        e
      ),
      ref: o,
      ...r
    }
  )
);
Hn.displayName = "Input";
const rt = 4, Sp = (e) => e ? e.replace(/[^0-9]/g, "").slice(0, rt) : "", kp = (e) => {
  const n = e.padEnd(rt, "_");
  return `${n.slice(0, 2)}:${n.slice(2, 4)}`;
}, Ep = (e) => {
  if (e.length !== rt) return !1;
  const n = Number.parseInt(e.slice(0, 2), 10), r = Number.parseInt(e.slice(2, 4), 10);
  return n >= 0 && n <= 23 && r >= 0 && r <= 59;
}, Np = (e) => `${e.slice(0, 2)}:${e.slice(2, 4)}`, Rp = P.memo(
  ({
    open: e,
    title: n,
    onClose: r,
    displayContent: o,
    errorMessage: s,
    onNumberClick: a,
    onBackspace: i,
    onClear: l,
    onConfirm: u,
    additionalButton: d
  }) => /* @__PURE__ */ m(
    bn,
    {
      open: e,
      onOpenChange: (p) => !p && r(),
      title: n,
      onClose: r,
      children: /* @__PURE__ */ D("div", { className: "flex flex-col gap-4", children: [
        /* @__PURE__ */ m("div", { className: "bg-card border-2 border-theme-text-primary rounded-lg p-[var(--ui-modal-padding)] min-h-[60px] flex items-center justify-center text-lg font-semibold text-foreground", children: o }),
        s && /* @__PURE__ */ m("div", { className: "text-destructive-foreground text-sm text-center p-2 bg-red-50 dark:bg-red-950 rounded-md border-l-[3px] border-theme-danger", children: s }),
        /* @__PURE__ */ D("div", { className: "grid grid-cols-3 gap-2", children: [
          [1, 2, 3, 4, 5, 6, 7, 8, 9].map((p) => /* @__PURE__ */ m(
            "button",
            {
              type: "button",
              onClick: () => a(p.toString()),
              className: "min-h-[var(--ui-keypad-button-height)] text-lg font-semibold bg-background text-foreground border-2 border-theme-text-primary rounded-lg cursor-pointer transition-all active:scale-95 active:brightness-90 hover:brightness-110",
              children: p
            },
            p
          )),
          d || /* @__PURE__ */ m("div", { className: "min-h-[var(--ui-keypad-button-height)] bg-card rounded-lg" }),
          /* @__PURE__ */ m(
            "button",
            {
              type: "button",
              onClick: () => a("0"),
              className: "min-h-[var(--ui-keypad-button-height)] text-lg font-semibold bg-background text-foreground border-2 border-theme-text-primary rounded-lg cursor-pointer transition-all active:scale-95 active:brightness-90 hover:brightness-110",
              children: "0"
            }
          ),
          /* @__PURE__ */ m(
            "button",
            {
              type: "button",
              onClick: i,
              className: "min-h-[var(--ui-keypad-button-height)] text-base font-semibold bg-background text-foreground border-2 border-theme-text-primary rounded-lg cursor-pointer transition-all active:scale-95 active:brightness-90 hover:brightness-110",
              children: "⌫"
            }
          )
        ] }),
        /* @__PURE__ */ D("div", { className: "grid grid-cols-2 gap-2 mt-2", children: [
          /* @__PURE__ */ m(
            "button",
            {
              type: "button",
              onClick: l,
              className: "min-h-[var(--ui-keypad-button-height)] text-base font-semibold bg-background text-foreground border-2 border-theme-text-primary rounded-lg cursor-pointer transition-all active:scale-95 active:bg-destructive active:text-white active:border-theme-danger hover:bg-destructive hover:text-white hover:border-theme-danger",
              children: "C"
            }
          ),
          /* @__PURE__ */ m(
            "button",
            {
              type: "button",
              onClick: u,
              className: "min-h-[var(--ui-keypad-button-height)] text-base font-semibold bg-background text-foreground border-2 border-theme-text-primary rounded-lg cursor-pointer transition-all active:scale-95 active:brightness-90 hover:brightness-110",
              children: "OK"
            }
          )
        ] })
      ] })
    }
  )
), Pp = {
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
    maxLength: rt
  }
}, $n = P.memo(
  ({
    open: e,
    onClose: n,
    onSubmit: r,
    variant: o = "number",
    initialValue: s = "",
    title: a,
    placeholder: i,
    maxLength: l,
    allowDecimal: u = !1
  }) => {
    const d = ot(
      () => o === "time" ? Sp(s) : s,
      [o, s]
    ), [p, c] = Ke(d), [h, g] = Ke(""), y = ot(() => Pp[o], [o]), b = a ?? y.title, v = i ?? y.placeholder, x = o === "time" ? rt : l ?? y.maxLength, S = o === "number" && u, w = o === "phone", C = o === "time";
    kt(() => {
      e && (c(d), g(""));
    }, [e, d]);
    const N = zt(
      (_) => {
        if (C) {
          c((M) => M.length >= rt ? (g(`最大${rt}文字まで入力できます`), M) : (g(""), M.length === 0 && Number.parseInt(_, 10) >= 3 ? `0${_}` : (M + _).slice(0, rt)));
          return;
        }
        c((M) => M.length >= x ? (g(`最大${x}文字まで入力できます`), M) : (g(""), `${M}${_}`));
      },
      [x, C]
    ), R = zt(() => {
      w && c((_) => _.length >= x ? (g(`最大${x}文字まで入力できます`), _) : _.endsWith("-") ? (g("ハイフンを連続して入力することはできません"), _) : (g(""), `${_}-`));
    }, [w, x]), E = zt(() => {
      S && c((_) => _.includes(".") ? (g("小数点は1つまでです"), _) : (g(""), `${_}.`));
    }, [S]), k = zt(() => {
      c((_) => _.slice(0, -1)), g("");
    }, []), T = zt(() => {
      c(""), g("");
    }, []), I = zt(() => {
      if (C) {
        c((_) => Ep(_) ? (r(Np(_)), _) : (g("有効な時刻を 4 桁で入力してください（例: 0930）"), _));
        return;
      }
      c((_) => _ === "" ? (g("値を入力してください"), _) : S && _.endsWith(".") ? (g("小数点で終わることはできません"), _) : w && _.endsWith("-") ? (g("ハイフンで終わることはできません"), _) : (r(_), _));
    }, [S, w, C, r]);
    kt(() => {
      if (!e) return;
      const _ = (M) => {
        M.key >= "0" && M.key <= "9" || M.code >= "Numpad0" && M.code <= "Numpad9" ? (M.preventDefault(), N(M.key)) : w && (M.key === "-" || M.code === "NumpadSubtract" || M.key === "Minus") ? (M.preventDefault(), R()) : S && (M.key === "." || M.code === "NumpadDecimal") ? (M.preventDefault(), E()) : M.key === "Backspace" ? (M.preventDefault(), k()) : M.key === "Enter" ? (M.preventDefault(), I()) : M.key === "Escape" && (M.preventDefault(), n());
      };
      return window.addEventListener("keydown", _), () => window.removeEventListener("keydown", _);
    }, [
      e,
      w,
      S,
      n,
      N,
      R,
      E,
      k,
      I
    ]);
    const L = C ? /* @__PURE__ */ D("div", { className: "flex flex-col items-center justify-center gap-2 w-full", children: [
      /* @__PURE__ */ m(
        "span",
        {
          style: {
            fontSize: "24px",
            fontFamily: "monospace",
            color: "hsl(var(--foreground))",
            letterSpacing: "2px",
            fontWeight: 600
          },
          children: kp(p)
        }
      ),
      /* @__PURE__ */ D(
        "span",
        {
          style: { fontSize: "12px", color: "var(--theme-text-secondary)" },
          children: [
            "入力: ",
            p.padEnd(rt, "・")
          ]
        }
      )
    ] }) : /* @__PURE__ */ m(
      "span",
      {
        style: {
          fontSize: "24px",
          fontFamily: "monospace",
          color: "hsl(var(--foreground))",
          fontWeight: 600
        },
        children: p || /* @__PURE__ */ m("span", { style: { color: "var(--theme-text-secondary)" }, children: v })
      }
    ), A = ot(() => {
      if (w || S)
        return /* @__PURE__ */ m(
          "button",
          {
            type: "button",
            onClick: w ? R : E,
            className: "min-h-[var(--ui-keypad-button-height)] text-lg font-semibold bg-background text-foreground border-2 border-theme-text-primary rounded-lg cursor-pointer transition-all active:scale-95 active:brightness-90 hover:brightness-110",
            children: w ? "-" : "."
          }
        );
    }, [w, S, R, E]);
    return /* @__PURE__ */ m(
      Rp,
      {
        open: e,
        title: b,
        onClose: n,
        displayContent: L,
        errorMessage: h,
        onNumberClick: N,
        onBackspace: k,
        onClear: T,
        onConfirm: I,
        additionalButton: A
      }
    );
  }
);
$n.displayName = "KeypadModal";
const Tp = f.memo(
  f.forwardRef(({ className: e, ...n }, r) => /* @__PURE__ */ m(
    Di,
    {
      ref: r,
      className: O(
        "text-ui font-medium leading-none text-foreground peer-disabled:cursor-not-allowed peer-disabled:opacity-70 peer-disabled:text-theme-disabled-text",
        e
      ),
      ...n
    }
  ))
);
Tp.displayName = "Label";
var _p = Object.defineProperty, Ip = (e, n) => _p(e, "name", { value: n, configurable: !0 });
function Yr(e, [n, r]) {
  return Math.min(r, Math.max(n, e));
}
Ip(Yr, "clamp");
var Op = Object.defineProperty, ve = (e, n) => Op(e, "name", { value: n, configurable: !0 });
// @__NO_SIDE_EFFECTS__
function wo(e) {
  const n = e + "CollectionProvider", [r, o] = /* @__PURE__ */ Ie(n), [s, a] = r(
    n,
    { collectionRef: { current: null }, itemMap: /* @__PURE__ */ new Map() }
  ), i = /* @__PURE__ */ ve((b) => {
    const { scope: v, children: x } = b, S = f.useRef(null), w = f.useRef(/* @__PURE__ */ new Map()).current;
    return /* @__PURE__ */ m(s, { scope: v, itemMap: w, collectionRef: S, children: x });
  }, "CollectionProvider");
  i.displayName = n;
  const l = e + "CollectionSlot", u = /* @__PURE__ */ Ye(l), d = f.forwardRef(
    (b, v) => {
      const { scope: x, children: S } = b, w = a(l, x), C = oe(v, w.collectionRef);
      return /* @__PURE__ */ m(u, { ref: C, children: S });
    }
  );
  d.displayName = l;
  const p = e + "CollectionItemSlot", c = "data-radix-collection-item", h = /* @__PURE__ */ Ye(p), g = f.forwardRef(
    (b, v) => {
      const { scope: x, children: S, ...w } = b, C = f.useRef(null), N = oe(v, C), R = a(p, x);
      return f.useEffect(() => (R.itemMap.set(C, { ref: C, ...w }), () => {
        R.itemMap.delete(C);
      })), /* @__PURE__ */ m(h, { [c]: "", ref: N, children: S });
    }
  );
  g.displayName = p;
  function y(b) {
    const v = a(e + "CollectionConsumer", b);
    return f.useCallback(() => {
      const S = v.collectionRef.current;
      if (!S) return [];
      const w = Array.from(S.querySelectorAll(`[${c}]`));
      return Array.from(v.itemMap.values()).sort(
        (R, E) => w.indexOf(R.ref.current) - w.indexOf(E.ref.current)
      );
    }, [v.collectionRef, v.itemMap]);
  }
  return ve(y, "useCollection"), [
    { Provider: i, Slot: d, ItemSlot: g },
    y,
    o
  ];
}
ve(wo, "createCollection");
var Ks = /* @__PURE__ */ new WeakMap(), fe, _e, Nr = (_e = class extends Map {
  constructor(r) {
    super(r);
    ms(this, fe);
    gr(this, fe, [...super.keys()]), Ks.set(this, !0);
  }
  set(r, o) {
    return Ks.get(this) && (this.has(r) ? Ce(this, fe)[Ce(this, fe).indexOf(r)] = r : Ce(this, fe).push(r)), super.set(r, o), this;
  }
  insert(r, o, s) {
    const a = this.has(o), i = Ce(this, fe).length, l = Co(r);
    let u = l >= 0 ? l : i + l;
    const d = u < 0 || u >= i ? -1 : u;
    if (d === this.size || a && d === this.size - 1 || d === -1)
      return this.set(o, s), this;
    const p = this.size + (a ? 0 : 1);
    l < 0 && u++;
    const c = [...Ce(this, fe)];
    let h, g = !1;
    for (let y = u; y < p; y++)
      if (u === y) {
        let b = c[y];
        c[y] === o && (b = c[y + 1]), a && this.delete(o), h = this.get(b), this.set(o, s);
      } else {
        !g && c[y - 1] === o && (g = !0);
        const b = c[g ? y : y - 1], v = h;
        h = this.get(b), this.delete(b), this.set(b, v);
      }
    return this;
  }
  with(r, o, s) {
    const a = new _e(this);
    return a.insert(r, o, s), a;
  }
  before(r) {
    const o = Ce(this, fe).indexOf(r) - 1;
    if (!(o < 0))
      return this.entryAt(o);
  }
  /**
   * Sets a new key-value pair at the position before the given key.
   */
  setBefore(r, o, s) {
    const a = Ce(this, fe).indexOf(r);
    return a === -1 ? this : this.insert(a, o, s);
  }
  after(r) {
    let o = Ce(this, fe).indexOf(r);
    if (o = o === -1 || o === this.size - 1 ? -1 : o + 1, o !== -1)
      return this.entryAt(o);
  }
  /**
   * Sets a new key-value pair at the position after the given key.
   */
  setAfter(r, o, s) {
    const a = Ce(this, fe).indexOf(r);
    return a === -1 ? this : this.insert(a + 1, o, s);
  }
  first() {
    return this.entryAt(0);
  }
  last() {
    return this.entryAt(-1);
  }
  clear() {
    return gr(this, fe, []), super.clear();
  }
  delete(r) {
    const o = super.delete(r);
    return o && Ce(this, fe).splice(Ce(this, fe).indexOf(r), 1), o;
  }
  deleteAt(r) {
    const o = this.keyAt(r);
    return o !== void 0 ? this.delete(o) : !1;
  }
  at(r) {
    const o = zn(Ce(this, fe), r);
    if (o !== void 0)
      return this.get(o);
  }
  entryAt(r) {
    const o = zn(Ce(this, fe), r);
    if (o !== void 0)
      return [o, this.get(o)];
  }
  indexOf(r) {
    return Ce(this, fe).indexOf(r);
  }
  keyAt(r) {
    return zn(Ce(this, fe), r);
  }
  from(r, o) {
    const s = this.indexOf(r);
    if (s === -1)
      return;
    let a = s + o;
    return a < 0 && (a = 0), a >= this.size && (a = this.size - 1), this.at(a);
  }
  keyFrom(r, o) {
    const s = this.indexOf(r);
    if (s === -1)
      return;
    let a = s + o;
    return a < 0 && (a = 0), a >= this.size && (a = this.size - 1), this.keyAt(a);
  }
  find(r, o) {
    let s = 0;
    for (const a of this) {
      if (Reflect.apply(r, o, [a, s, this]))
        return a;
      s++;
    }
  }
  findIndex(r, o) {
    let s = 0;
    for (const a of this) {
      if (Reflect.apply(r, o, [a, s, this]))
        return s;
      s++;
    }
    return -1;
  }
  filter(r, o) {
    const s = [];
    let a = 0;
    for (const i of this)
      Reflect.apply(r, o, [i, a, this]) && s.push(i), a++;
    return new _e(s);
  }
  map(r, o) {
    const s = [];
    let a = 0;
    for (const i of this)
      s.push([i[0], Reflect.apply(r, o, [i, a, this])]), a++;
    return new _e(s);
  }
  reduce(...r) {
    const [o, s] = r;
    let a = 0, i = s ?? this.at(0);
    for (const l of this)
      a === 0 && r.length === 1 ? i = l : i = Reflect.apply(o, this, [i, l, a, this]), a++;
    return i;
  }
  reduceRight(...r) {
    const [o, s] = r;
    let a = s ?? this.at(-1);
    for (let i = this.size - 1; i >= 0; i--) {
      const l = this.at(i);
      i === this.size - 1 && r.length === 1 ? a = l : a = Reflect.apply(o, this, [a, l, i, this]);
    }
    return a;
  }
  toSorted(r) {
    const o = [...this.entries()].sort(r);
    return new _e(o);
  }
  toReversed() {
    const r = new _e();
    for (let o = this.size - 1; o >= 0; o--) {
      const s = this.keyAt(o), a = this.get(s);
      r.set(s, a);
    }
    return r;
  }
  toSpliced(...r) {
    const o = [...this.entries()];
    return o.splice(...r), new _e(o);
  }
  slice(r, o) {
    const s = new _e();
    let a = this.size - 1;
    if (r === void 0)
      return s;
    r < 0 && (r = r + this.size), o !== void 0 && o > 0 && (a = o - 1);
    for (let i = r; i <= a; i++) {
      const l = this.keyAt(i), u = this.get(l);
      s.set(l, u);
    }
    return s;
  }
  every(r, o) {
    let s = 0;
    for (const a of this) {
      if (!Reflect.apply(r, o, [a, s, this]))
        return !1;
      s++;
    }
    return !0;
  }
  some(r, o) {
    let s = 0;
    for (const a of this) {
      if (Reflect.apply(r, o, [a, s, this]))
        return !0;
      s++;
    }
    return !1;
  }
}, fe = new WeakMap(), ve(_e, "OrderedDict"), _e);
function zn(e, n) {
  if ("at" in Array.prototype)
    return Array.prototype.at.call(e, n);
  const r = ji(e, n);
  return r === -1 ? void 0 : e[r];
}
ve(zn, "at");
function ji(e, n) {
  const r = e.length, o = Co(n), s = o >= 0 ? o : r + o;
  return s < 0 || s >= r ? -1 : s;
}
ve(ji, "toSafeIndex");
function Co(e) {
  return e !== e || e === 0 ? 0 : Math.trunc(e);
}
ve(Co, "toSafeInteger");
// @__NO_SIDE_EFFECTS__
function Ap(e) {
  const n = e + "CollectionProvider", [r, o] = /* @__PURE__ */ Ie(n), [s, a] = r(
    n,
    {
      collectionElement: null,
      collectionRef: { current: null },
      collectionRefObject: { current: null },
      itemMap: new Nr(),
      setItemMap: /* @__PURE__ */ ve(() => {
      }, "setItemMap")
    }
  ), i = /* @__PURE__ */ ve(({ state: w, ...C }) => w ? /* @__PURE__ */ m(u, { ...C, state: w }) : /* @__PURE__ */ m(l, { ...C }), "CollectionProvider");
  i.displayName = n;
  const l = /* @__PURE__ */ ve((w) => {
    const C = v();
    return /* @__PURE__ */ m(u, { ...w, state: C });
  }, "CollectionInit");
  l.displayName = n + "Init";
  const u = /* @__PURE__ */ ve((w) => {
    const { scope: C, children: N, state: R } = w, E = f.useRef(null), [k, T] = f.useState(
      null
    ), I = oe(E, T), [L, A] = R;
    return f.useEffect(() => {
      if (!k) return;
      const _ = Ui(() => {
      });
      return _.observe(k, {
        childList: !0,
        subtree: !0
      }), () => {
        _.disconnect();
      };
    }, [k]), /* @__PURE__ */ m(
      s,
      {
        scope: C,
        itemMap: L,
        setItemMap: A,
        collectionRef: I,
        collectionRefObject: E,
        collectionElement: k,
        children: N
      }
    );
  }, "CollectionProviderImpl");
  u.displayName = n + "Impl";
  const d = e + "CollectionSlot", p = /* @__PURE__ */ Ye(d), c = f.forwardRef(
    (w, C) => {
      const { scope: N, children: R } = w, E = a(d, N), k = oe(C, E.collectionRef);
      return /* @__PURE__ */ m(p, { ref: k, children: R });
    }
  );
  c.displayName = d;
  const h = e + "CollectionItemSlot", g = "data-radix-collection-item", y = /* @__PURE__ */ Ye(h), b = f.forwardRef(
    (w, C) => {
      const { scope: N, children: R, ...E } = w, k = f.useRef(null), [T, I] = f.useState(null), L = oe(C, k, I), A = a(h, N), { setItemMap: _ } = A, M = f.useRef(E);
      Hi(M.current, E) || (M.current = E);
      const U = M.current;
      return f.useEffect(() => {
        const $ = U;
        return _((B) => T ? B.has(T) ? B.set(T, { ...$, element: T }).toSorted(Xr) : (B.set(T, { ...$, element: T }), B.toSorted(Xr)) : B), () => {
          _((B) => !T || !B.has(T) ? B : (B.delete(T), new Nr(B)));
        };
      }, [T, U, _]), /* @__PURE__ */ m(y, { [g]: "", ref: L, children: R });
    }
  );
  b.displayName = h;
  function v() {
    return f.useState(new Nr());
  }
  ve(v, "useInitCollection");
  function x(w) {
    const { itemMap: C } = a(e + "CollectionConsumer", w);
    return C;
  }
  return ve(x, "useCollection"), [
    { Provider: i, Slot: c, ItemSlot: b },
    {
      createCollectionScope: o,
      useCollection: x,
      useInitCollection: v
    }
  ];
}
ve(Ap, "createCollection");
function Hi(e, n) {
  if (e === n) return !0;
  if (typeof e != "object" || typeof n != "object" || e == null || n == null) return !1;
  const r = Object.keys(e), o = Object.keys(n);
  if (r.length !== o.length) return !1;
  for (const s of r)
    if (!Object.prototype.hasOwnProperty.call(n, s) || e[s] !== n[s]) return !1;
  return !0;
}
ve(Hi, "shallowEqual");
function Wi(e, n) {
  return !!(n.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_PRECEDING);
}
ve(Wi, "isElementPreceding");
function Xr(e, n) {
  return !e[1].element || !n[1].element ? 0 : Wi(e[1].element, n[1].element) ? -1 : 1;
}
ve(Xr, "sortByDocumentPosition");
function Ui(e) {
  return new MutationObserver((r) => {
    for (const o of r)
      if (o.type === "childList") {
        e();
        return;
      }
  });
}
ve(Ui, "getChildListObserver");
const Dp = ["top", "right", "bottom", "left"], ht = Math.min, st = Math.max, Wn = Math.round, On = Math.floor, at = (e) => ({
  x: e,
  y: e
}), Mp = {
  left: "right",
  right: "left",
  bottom: "top",
  top: "bottom"
};
function Gi(e, n, r) {
  return st(e, ht(n, r));
}
function lt(e, n) {
  return typeof e == "function" ? e(n) : e;
}
function gt(e) {
  return e.split("-")[0];
}
function Qt(e) {
  return e.split("-")[1];
}
function So(e) {
  return e === "x" ? "y" : "x";
}
function ko(e) {
  return e === "y" ? "height" : "width";
}
function Ge(e) {
  const n = e[0];
  return n === "t" || n === "b" ? "y" : "x";
}
function Eo(e) {
  return So(Ge(e));
}
function Lp(e, n, r) {
  r === void 0 && (r = !1);
  const o = Qt(e), s = Eo(e), a = ko(s);
  let i = s === "x" ? o === (r ? "end" : "start") ? "right" : "left" : o === "start" ? "bottom" : "top";
  return n.reference[a] > n.floating[a] && (i = Un(i)), [i, Un(i)];
}
function Fp(e) {
  const n = Un(e);
  return [qr(e), n, qr(n)];
}
function qr(e) {
  return e.includes("start") ? e.replace("start", "end") : e.replace("end", "start");
}
const Ys = ["left", "right"], Xs = ["right", "left"], $p = ["top", "bottom"], zp = ["bottom", "top"];
function Bp(e, n, r) {
  switch (e) {
    case "top":
    case "bottom":
      return r ? n ? Xs : Ys : n ? Ys : Xs;
    case "left":
    case "right":
      return n ? $p : zp;
    default:
      return [];
  }
}
function Vp(e, n, r, o) {
  const s = Qt(e);
  let a = Bp(gt(e), r === "start", o);
  return s && (a = a.map((i) => i + "-" + s), n && (a = a.concat(a.map(qr)))), a;
}
function Un(e) {
  const n = gt(e);
  return Mp[n] + e.slice(n.length);
}
function jp(e) {
  var n, r, o, s;
  return {
    top: (n = e.top) != null ? n : 0,
    right: (r = e.right) != null ? r : 0,
    bottom: (o = e.bottom) != null ? o : 0,
    left: (s = e.left) != null ? s : 0
  };
}
function Ki(e) {
  return typeof e != "number" ? jp(e) : {
    top: e,
    right: e,
    bottom: e,
    left: e
  };
}
function Gn(e) {
  const {
    x: n,
    y: r,
    width: o,
    height: s
  } = e;
  return {
    width: o,
    height: s,
    top: r,
    left: n,
    right: n + o,
    bottom: r + s,
    x: n,
    y: r
  };
}
function qs(e, n, r) {
  let {
    reference: o,
    floating: s
  } = e;
  const a = Ge(n), i = Eo(n), l = ko(i), u = gt(n), d = a === "y", p = o.x + o.width / 2 - s.width / 2, c = o.y + o.height / 2 - s.height / 2, h = o[l] / 2 - s[l] / 2;
  let g;
  switch (u) {
    case "top":
      g = {
        x: p,
        y: o.y - s.height
      };
      break;
    case "bottom":
      g = {
        x: p,
        y: o.y + o.height
      };
      break;
    case "right":
      g = {
        x: o.x + o.width,
        y: c
      };
      break;
    case "left":
      g = {
        x: o.x - s.width,
        y: c
      };
      break;
    default:
      g = {
        x: o.x,
        y: o.y
      };
  }
  const y = Qt(n);
  return y && (g[i] += h * (y === "end" ? 1 : -1) * (r && d ? -1 : 1)), g;
}
async function Hp(e, n) {
  var r;
  n === void 0 && (n = {});
  const {
    x: o,
    y: s,
    platform: a,
    rects: i,
    elements: l,
    strategy: u
  } = e, {
    boundary: d = "clippingAncestors",
    rootBoundary: p = "viewport",
    elementContext: c = "floating",
    altBoundary: h = !1,
    padding: g = 0
  } = lt(n, e), y = Ki(g), v = l[h ? c === "floating" ? "reference" : "floating" : c], x = Gn(await a.getClippingRect({
    element: (r = await (a.isElement == null ? void 0 : a.isElement(v))) == null || r ? v : v.contextElement || await (a.getDocumentElement == null ? void 0 : a.getDocumentElement(l.floating)),
    boundary: d,
    rootBoundary: p,
    strategy: u
  })), S = c === "floating" ? {
    x: o,
    y: s,
    width: i.floating.width,
    height: i.floating.height
  } : i.reference, w = await (a.getOffsetParent == null ? void 0 : a.getOffsetParent(l.floating)), C = await (a.isElement == null ? void 0 : a.isElement(w)) && await (a.getScale == null ? void 0 : a.getScale(w)) || {
    x: 1,
    y: 1
  }, N = Gn(a.convertOffsetParentRelativeRectToViewportRelativeRect ? await a.convertOffsetParentRelativeRectToViewportRelativeRect({
    elements: l,
    rect: S,
    offsetParent: w,
    strategy: u
  }) : S);
  return {
    top: (x.top - N.top + y.top) / C.y,
    bottom: (N.bottom - x.bottom + y.bottom) / C.y,
    left: (x.left - N.left + y.left) / C.x,
    right: (N.right - x.right + y.right) / C.x
  };
}
const Wp = 50, Up = async (e, n, r) => {
  const {
    placement: o = "bottom",
    strategy: s = "absolute",
    middleware: a = [],
    platform: i
  } = r, l = i.detectOverflow ? i : {
    ...i,
    detectOverflow: Hp
  }, u = await (i.isRTL == null ? void 0 : i.isRTL(n));
  let d = await i.getElementRects({
    reference: e,
    floating: n,
    strategy: s
  }), {
    x: p,
    y: c
  } = qs(d, o, u), h = o, g = 0;
  const y = {};
  for (let b = 0; b < a.length; b++) {
    const v = a[b];
    if (!v)
      continue;
    const {
      name: x,
      fn: S
    } = v, {
      x: w,
      y: C,
      data: N,
      reset: R
    } = await S({
      x: p,
      y: c,
      initialPlacement: o,
      placement: h,
      strategy: s,
      middlewareData: y,
      rects: d,
      platform: l,
      elements: {
        reference: e,
        floating: n
      }
    });
    p = w ?? p, c = C ?? c, y[x] = {
      ...y[x],
      ...N
    }, R && g < Wp && (g++, typeof R == "object" && (R.placement && (h = R.placement), R.rects && (d = R.rects === !0 ? await i.getElementRects({
      reference: e,
      floating: n,
      strategy: s
    }) : R.rects), {
      x: p,
      y: c
    } = qs(d, h, u)), b = -1);
  }
  return {
    x: p,
    y: c,
    placement: h,
    strategy: s,
    middlewareData: y
  };
}, Gp = (e) => ({
  name: "arrow",
  options: e,
  async fn(n) {
    const {
      x: r,
      y: o,
      placement: s,
      rects: a,
      platform: i,
      elements: l,
      middlewareData: u
    } = n, {
      element: d,
      padding: p = 0
    } = lt(e, n) || {};
    if (d == null)
      return {};
    const c = Ki(p), h = {
      x: r,
      y: o
    }, g = Eo(s), y = ko(g), b = await i.getDimensions(d), v = g === "y", x = v ? "top" : "left", S = v ? "bottom" : "right", w = v ? "clientHeight" : "clientWidth", C = a.reference[y] + a.reference[g] - h[g] - a.floating[y], N = h[g] - a.reference[g], R = await (i.getOffsetParent == null ? void 0 : i.getOffsetParent(d));
    let E = R ? R[w] : 0;
    (!E || !await (i.isElement == null ? void 0 : i.isElement(R))) && (E = l.floating[w] || a.floating[y]);
    const k = C / 2 - N / 2, T = E / 2 - b[y] / 2 - 1, I = ht(c[x], T), L = ht(c[S], T), A = E - b[y] - L, _ = E / 2 - b[y] / 2 + k, M = Gi(I, _, A), U = !u.arrow && Qt(s) != null && _ !== M && a.reference[y] / 2 - (_ < I ? I : L) - b[y] / 2 < 0, $ = U ? _ < I ? _ - I : _ - A : 0;
    return {
      [g]: h[g] + $,
      data: {
        [g]: M,
        centerOffset: _ - M - $,
        ...U && {
          alignmentOffset: $
        }
      },
      reset: U
    };
  }
}), Kp = function(e) {
  return e === void 0 && (e = {}), {
    name: "flip",
    options: e,
    async fn(n) {
      var r, o;
      const {
        placement: s,
        middlewareData: a,
        rects: i,
        initialPlacement: l,
        platform: u,
        elements: d
      } = n, {
        mainAxis: p = !0,
        crossAxis: c = !0,
        fallbackPlacements: h,
        fallbackStrategy: g = "bestFit",
        fallbackAxisSideDirection: y = "none",
        flipAlignment: b = !0,
        ...v
      } = lt(e, n);
      if ((r = a.arrow) != null && r.alignmentOffset)
        return {};
      const x = gt(s), S = Ge(l), w = gt(l) === l, C = await (u.isRTL == null ? void 0 : u.isRTL(d.floating)), N = h || (w || !b ? [Un(l)] : Fp(l)), R = y !== "none";
      !h && R && N.push(...Vp(l, b, y, C));
      const E = [l, ...N], k = await u.detectOverflow(n, v), T = [];
      let I = ((o = a.flip) == null ? void 0 : o.overflows) || [];
      if (p && T.push(k[x]), c) {
        const M = Lp(s, i, C);
        T.push(k[M[0]], k[M[1]]);
      }
      if (I = [...I, {
        placement: s,
        overflows: T
      }], !T.every((M) => M <= 0)) {
        var L, A;
        const M = (((L = a.flip) == null ? void 0 : L.index) || 0) + 1, U = E[M];
        if (U && (!(c === "alignment" ? S !== Ge(U) : !1) || // We leave the current main axis only if every placement on that axis
        // overflows the main axis.
        I.every((W) => Ge(W.placement) === S ? W.overflows[0] > 0 : !0)))
          return {
            data: {
              index: M,
              overflows: I
            },
            reset: {
              placement: U
            }
          };
        let $ = (A = I.filter((B) => B.overflows[0] <= 0).sort((B, W) => B.overflows[1] - W.overflows[1])[0]) == null ? void 0 : A.placement;
        if (!$)
          switch (g) {
            case "bestFit": {
              var _;
              const B = (_ = I.filter((W) => {
                if (R) {
                  const z = Ge(W.placement);
                  return z === S || // Create a bias to the `y` side axis due to horizontal
                  // reading directions favoring greater width.
                  z === "y";
                }
                return !0;
              }).map((W) => [W.placement, W.overflows.filter((z) => z > 0).reduce((z, F) => z + F, 0)]).sort((W, z) => W[1] - z[1])[0]) == null ? void 0 : _[0];
              B && ($ = B);
              break;
            }
            case "initialPlacement":
              $ = l;
              break;
          }
        if (s !== $)
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
function Zs(e, n) {
  return {
    top: e.top - n.height,
    right: e.right - n.width,
    bottom: e.bottom - n.height,
    left: e.left - n.width
  };
}
function Qs(e) {
  return Dp.some((n) => e[n] >= 0);
}
const Yp = function(e) {
  return e === void 0 && (e = {}), {
    name: "hide",
    options: e,
    async fn(n) {
      const {
        rects: r,
        platform: o
      } = n, {
        strategy: s = "referenceHidden",
        ...a
      } = lt(e, n);
      switch (s) {
        case "referenceHidden": {
          const i = await o.detectOverflow(n, {
            ...a,
            elementContext: "reference"
          }), l = Zs(i, r.reference);
          return {
            data: {
              referenceHiddenOffsets: l,
              referenceHidden: Qs(l)
            }
          };
        }
        case "escaped": {
          const i = await o.detectOverflow(n, {
            ...a,
            altBoundary: !0
          }), l = Zs(i, r.floating);
          return {
            data: {
              escapedOffsets: l,
              escaped: Qs(l)
            }
          };
        }
        default:
          return {};
      }
    }
  };
}, Yi = /* @__PURE__ */ new Set(["left", "top"]);
async function Xp(e, n) {
  const {
    placement: r,
    platform: o,
    elements: s
  } = e, a = await (o.isRTL == null ? void 0 : o.isRTL(s.floating)), i = gt(r), l = Qt(r), u = Ge(r) === "y", d = Yi.has(i) ? -1 : 1, p = a && u ? -1 : 1, c = lt(n, e);
  let {
    mainAxis: h,
    crossAxis: g,
    alignmentAxis: y
  } = typeof c == "number" ? {
    mainAxis: c,
    crossAxis: 0,
    alignmentAxis: null
  } : {
    mainAxis: c.mainAxis || 0,
    crossAxis: c.crossAxis || 0,
    alignmentAxis: c.alignmentAxis
  };
  return l && typeof y == "number" && (g = l === "end" ? y * -1 : y), u ? {
    x: g * p,
    y: h * d
  } : {
    x: h * d,
    y: g * p
  };
}
const qp = function(e) {
  return e === void 0 && (e = 0), {
    name: "offset",
    options: e,
    async fn(n) {
      var r, o;
      const {
        x: s,
        y: a,
        placement: i,
        middlewareData: l
      } = n, u = await Xp(n, e);
      return i === ((r = l.offset) == null ? void 0 : r.placement) && (o = l.arrow) != null && o.alignmentOffset ? {} : {
        x: s + u.x,
        y: a + u.y,
        data: {
          ...u,
          placement: i
        }
      };
    }
  };
}, Zp = function(e) {
  return e === void 0 && (e = {}), {
    name: "shift",
    options: e,
    async fn(n) {
      const {
        x: r,
        y: o,
        placement: s,
        platform: a
      } = n, {
        mainAxis: i = !0,
        crossAxis: l = !1,
        limiter: u = {
          fn: (S) => {
            let {
              x: w,
              y: C
            } = S;
            return {
              x: w,
              y: C
            };
          }
        },
        ...d
      } = lt(e, n), p = {
        x: r,
        y: o
      }, c = await a.detectOverflow(n, d), h = Ge(s), g = So(h);
      let y = p[g], b = p[h];
      const v = (S, w) => Gi(w + c[S === "y" ? "top" : "left"], w, w - c[S === "y" ? "bottom" : "right"]);
      i && (y = v(g, y)), l && (b = v(h, b));
      const x = u.fn({
        ...n,
        [g]: y,
        [h]: b
      });
      return {
        ...x,
        data: {
          x: x.x - r,
          y: x.y - o,
          enabled: {
            [g]: i,
            [h]: l
          }
        }
      };
    }
  };
}, Qp = function(e) {
  return e === void 0 && (e = {}), {
    options: e,
    fn(n) {
      var r, o;
      const {
        x: s,
        y: a,
        placement: i,
        rects: l,
        middlewareData: u
      } = n, {
        offset: d = 0,
        mainAxis: p = !0,
        crossAxis: c = !0
      } = lt(e, n), h = {
        x: s,
        y: a
      }, g = Ge(i), y = So(g);
      let b = h[y], v = h[g];
      const x = lt(d, n), S = typeof x == "number" ? {
        mainAxis: x,
        crossAxis: 0
      } : {
        mainAxis: (r = x.mainAxis) != null ? r : 0,
        crossAxis: (o = x.crossAxis) != null ? o : 0
      };
      if (p) {
        const N = y === "y" ? "height" : "width", R = l.reference[y] - l.floating[N] + S.mainAxis, E = l.reference[y] + l.reference[N] - S.mainAxis;
        b < R ? b = R : b > E && (b = E);
      }
      if (c) {
        var w, C;
        const N = y === "y" ? "width" : "height", R = Yi.has(gt(i)), E = l.reference[g] - l.floating[N] + (R && ((w = u.offset) == null ? void 0 : w[g]) || 0) + (R ? 0 : S.crossAxis), k = l.reference[g] + l.reference[N] + (R ? 0 : ((C = u.offset) == null ? void 0 : C[g]) || 0) - (R ? S.crossAxis : 0);
        v < E ? v = E : v > k && (v = k);
      }
      return {
        [y]: b,
        [g]: v
      };
    }
  };
}, Jp = function(e) {
  return e === void 0 && (e = {}), {
    name: "size",
    options: e,
    async fn(n) {
      const {
        placement: r,
        rects: o,
        platform: s,
        elements: a
      } = n, {
        apply: i = () => {
        },
        ...l
      } = lt(e, n), u = await s.detectOverflow(n, l), d = gt(r), p = Qt(r), c = Ge(r) === "y", {
        width: h,
        height: g
      } = o.floating;
      let y, b;
      d === "top" || d === "bottom" ? (y = d, b = p === (await (s.isRTL == null ? void 0 : s.isRTL(a.floating)) ? "start" : "end") ? "left" : "right") : (b = d, y = p === "end" ? "top" : "bottom");
      const v = g - u.top - u.bottom, x = h - u.left - u.right, S = ht(g - u[y], v), w = ht(h - u[b], x), C = n.middlewareData.shift, N = !C;
      let R = S, E = w;
      C != null && C.enabled.x && (E = x), C != null && C.enabled.y && (R = v), N && !p && (c ? E = h - 2 * st(u.left, u.right) : R = g - 2 * st(u.top, u.bottom)), await i({
        ...n,
        availableWidth: E,
        availableHeight: R
      });
      const k = await s.getDimensions(a.floating);
      return h !== k.width || g !== k.height ? {
        reset: {
          rects: !0
        }
      } : {};
    }
  };
};
function nr() {
  return typeof window < "u";
}
function Jt(e) {
  return Xi(e) ? (e.nodeName || "").toLowerCase() : "#document";
}
function Te(e) {
  var n;
  return (e == null || (n = e.ownerDocument) == null ? void 0 : n.defaultView) || window;
}
function dt(e) {
  var n;
  return (n = (Xi(e) ? e.ownerDocument : e.document) || window.document) == null ? void 0 : n.documentElement;
}
function Xi(e) {
  return nr() ? e instanceof Node || e instanceof Te(e).Node : !1;
}
function qe(e) {
  return nr() ? e instanceof Element || e instanceof Te(e).Element : !1;
}
function yt(e) {
  return nr() ? e instanceof HTMLElement || e instanceof Te(e).HTMLElement : !1;
}
function Js(e) {
  return !nr() || typeof ShadowRoot > "u" ? !1 : e instanceof ShadowRoot || e instanceof Te(e).ShadowRoot;
}
function rr(e) {
  const {
    overflow: n,
    overflowX: r,
    overflowY: o,
    display: s
  } = Ze(e);
  return /auto|scroll|overlay|hidden|clip/.test(n + o + r) && s !== "inline" && s !== "contents";
}
function eh(e) {
  return /^(table|td|th)$/.test(Jt(e));
}
function or(e) {
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
const th = /transform|translate|scale|rotate|perspective|filter/, nh = /paint|layout|strict|content/, St = (e) => !!e && e !== "none";
let Rr;
function No(e) {
  const n = qe(e) ? Ze(e) : e;
  return St(n.transform) || St(n.translate) || St(n.scale) || St(n.rotate) || St(n.perspective) || !Ro() && (St(n.backdropFilter) || St(n.filter)) || th.test(n.willChange || "") || nh.test(n.contain || "");
}
function rh(e) {
  let n = Rt(e);
  for (; yt(n) && !dn(n); ) {
    if (No(n))
      return n;
    if (or(n))
      return null;
    n = Rt(n);
  }
  return null;
}
function Ro() {
  return Rr == null && (Rr = typeof CSS < "u" && CSS.supports && CSS.supports("-webkit-backdrop-filter", "none")), Rr;
}
function dn(e) {
  return /^(html|body|#document)$/.test(Jt(e));
}
function Ze(e) {
  return Te(e).getComputedStyle(e);
}
function sr(e) {
  return qe(e) ? {
    scrollLeft: e.scrollLeft,
    scrollTop: e.scrollTop
  } : {
    scrollLeft: e.scrollX,
    scrollTop: e.scrollY
  };
}
function Rt(e) {
  if (Jt(e) === "html")
    return e;
  const n = (
    // Step into the shadow DOM of the parent of a slotted node.
    e.assignedSlot || // DOM Element detected.
    e.parentNode || // ShadowRoot detected.
    Js(e) && e.host || // Fallback.
    dt(e)
  );
  return Js(n) ? n.host : n;
}
function qi(e) {
  const n = Rt(e);
  return dn(n) ? (e.ownerDocument || e).body : yt(n) && rr(n) ? n : qi(n);
}
function un(e, n, r) {
  var o;
  n === void 0 && (n = []), r === void 0 && (r = !0);
  const s = qi(e), a = s === ((o = e.ownerDocument) == null ? void 0 : o.body), i = Te(s);
  if (a) {
    const l = Zr(i);
    return n.concat(i, i.visualViewport || [], rr(s) ? s : [], l && r ? un(l) : []);
  } else
    return n.concat(s, un(s, [], r));
}
function Zr(e) {
  return e.parent && Object.getPrototypeOf(e.parent) ? e.frameElement : null;
}
function Zi(e) {
  const n = Ze(e);
  let r = parseFloat(n.width) || 0, o = parseFloat(n.height) || 0;
  const s = yt(e), a = s ? e.offsetWidth : r, i = s ? e.offsetHeight : o, l = Wn(r) !== a || Wn(o) !== i;
  return l && (r = a, o = i), {
    width: r,
    height: o,
    $: l
  };
}
function Po(e) {
  return qe(e) ? e : e.contextElement;
}
function Gt(e) {
  const n = Po(e);
  if (!yt(n))
    return at(1);
  const r = n.getBoundingClientRect(), {
    width: o,
    height: s,
    $: a
  } = Zi(n);
  let i = (a ? Wn(r.width) : r.width) / o, l = (a ? Wn(r.height) : r.height) / s;
  return (!i || !Number.isFinite(i)) && (i = 1), (!l || !Number.isFinite(l)) && (l = 1), {
    x: i,
    y: l
  };
}
const oh = /* @__PURE__ */ at(0);
function Qi(e) {
  const n = Te(e);
  return !Ro() || !n.visualViewport ? oh : {
    x: n.visualViewport.offsetLeft,
    y: n.visualViewport.offsetTop
  };
}
function sh(e, n, r) {
  return n === void 0 && (n = !1), !!r && n && r === Te(e);
}
function Pt(e, n, r, o) {
  n === void 0 && (n = !1), r === void 0 && (r = !1);
  const s = e.getBoundingClientRect(), a = Po(e);
  let i = at(1);
  n && (o ? qe(o) && (i = Gt(o)) : i = Gt(e));
  const l = sh(a, r, o) ? Qi(a) : at(0);
  let u = (s.left + l.x) / i.x, d = (s.top + l.y) / i.y, p = s.width / i.x, c = s.height / i.y;
  if (a && o) {
    const h = Te(a), g = qe(o) ? Te(o) : o;
    let y = h, b = Zr(y);
    for (; b && g !== y; ) {
      const v = Gt(b), x = b.getBoundingClientRect(), S = Ze(b), w = x.left + (b.clientLeft + parseFloat(S.paddingLeft)) * v.x, C = x.top + (b.clientTop + parseFloat(S.paddingTop)) * v.y;
      u *= v.x, d *= v.y, p *= v.x, c *= v.y, u += w, d += C, y = Te(b), b = Zr(y);
    }
  }
  return Gn({
    width: p,
    height: c,
    x: u,
    y: d
  });
}
function ar(e, n) {
  const r = sr(e).scrollLeft;
  return n ? n.left + r : Pt(dt(e)).left + r;
}
function Ji(e, n) {
  const r = e.getBoundingClientRect(), o = r.left + n.scrollLeft - ar(e, r), s = r.top + n.scrollTop;
  return {
    x: o,
    y: s
  };
}
function ah(e) {
  let {
    elements: n,
    rect: r,
    offsetParent: o,
    strategy: s
  } = e;
  const a = s === "fixed", i = dt(o), l = n ? or(n.floating) : !1;
  if (o === i || l && a)
    return r;
  let u = {
    scrollLeft: 0,
    scrollTop: 0
  }, d = at(1);
  const p = at(0), c = yt(o);
  if ((c || !a) && ((Jt(o) !== "body" || rr(i)) && (u = sr(o)), c)) {
    const g = Pt(o);
    d = Gt(o), p.x = g.x + o.clientLeft, p.y = g.y + o.clientTop;
  }
  const h = i && !c && !a ? Ji(i, u) : at(0);
  return {
    width: r.width * d.x,
    height: r.height * d.y,
    x: r.x * d.x - u.scrollLeft * d.x + p.x + h.x,
    y: r.y * d.y - u.scrollTop * d.y + p.y + h.y
  };
}
function ih(e) {
  return e.getClientRects ? Array.from(e.getClientRects()) : [];
}
function lh(e) {
  const n = sr(e), r = e.ownerDocument.body, o = st(e.scrollWidth, e.clientWidth, r.scrollWidth, r.clientWidth), s = st(e.scrollHeight, e.clientHeight, r.scrollHeight, r.clientHeight);
  let a = -n.scrollLeft + ar(e);
  const i = -n.scrollTop;
  return Ze(r).direction === "rtl" && (a += st(e.clientWidth, r.clientWidth) - o), {
    width: o,
    height: s,
    x: a,
    y: i
  };
}
const ch = 25;
function dh(e, n, r) {
  r === void 0 && (r = "viewport");
  const o = r === "layoutViewport", s = Te(e), a = dt(e), i = s.visualViewport;
  let l = a.clientWidth, u = a.clientHeight, d = 0, p = 0;
  if (i) {
    const h = !Ro() || n === "fixed";
    o ? h || (d = -i.offsetLeft, p = -i.offsetTop) : (l = i.width, u = i.height, h && (d = i.offsetLeft, p = i.offsetTop));
  }
  if (ar(a) <= 0) {
    const h = a.ownerDocument, g = h.body, y = getComputedStyle(g), b = h.compatMode === "CSS1Compat" && parseFloat(y.marginLeft) + parseFloat(y.marginRight) || 0, v = Math.abs(a.clientWidth - g.clientWidth - b), x = getComputedStyle(a).scrollbarGutter === "stable both-edges" ? v / 2 : v;
    x <= ch && (l -= x);
  }
  return {
    width: l,
    height: u,
    x: d,
    y: p
  };
}
function uh(e, n) {
  const r = Pt(e, !0, n === "fixed"), o = r.top + e.clientTop, s = r.left + e.clientLeft, a = Gt(e), i = e.clientWidth * a.x, l = e.clientHeight * a.y, u = s * a.x, d = o * a.y;
  return {
    width: i,
    height: l,
    x: u,
    y: d
  };
}
function ea(e, n, r) {
  let o;
  if (n === "viewport" || n === "layoutViewport")
    o = dh(e, r, n);
  else if (n === "document")
    o = lh(dt(e));
  else if (qe(n))
    o = uh(n, r);
  else {
    const s = Qi(e);
    o = {
      x: n.x - s.x,
      y: n.y - s.y,
      width: n.width,
      height: n.height
    };
  }
  return Gn(o);
}
function fh(e, n) {
  const r = n.get(e);
  if (r)
    return r;
  let o = un(e, [], !1).filter((l) => qe(l) && Jt(l) !== "body"), s = null;
  const a = Ze(e).position === "fixed";
  let i = a ? Rt(e) : e;
  for (; qe(i) && !dn(i); ) {
    const l = Ze(i), u = No(i), d = s ? s.position : a ? "fixed" : "";
    !u && (d === "fixed" || d === "absolute" && l.position === "static") ? o = o.filter((c) => c !== i) : s = l, i = Rt(i);
  }
  return n.set(e, o), o;
}
function mh(e) {
  let {
    element: n,
    boundary: r,
    rootBoundary: o,
    strategy: s
  } = e;
  const i = [...r === "clippingAncestors" ? or(n) ? [] : fh(n, this._c) : [].concat(r), o], l = ea(n, i[0], s);
  let u = l.top, d = l.right, p = l.bottom, c = l.left;
  for (let h = 1; h < i.length; h++) {
    const g = ea(n, i[h], s);
    u = st(g.top, u), d = ht(g.right, d), p = ht(g.bottom, p), c = st(g.left, c);
  }
  return {
    width: d - c,
    height: p - u,
    x: c,
    y: u
  };
}
function ph(e) {
  const {
    width: n,
    height: r
  } = Zi(e);
  return {
    width: n,
    height: r
  };
}
function hh(e, n, r) {
  const o = yt(n), s = dt(n), a = r === "fixed", i = Pt(e, !0, a, n);
  let l = {
    scrollLeft: 0,
    scrollTop: 0
  };
  const u = at(0);
  if ((o || !a) && ((Jt(n) !== "body" || rr(s)) && (l = sr(n)), o)) {
    const h = Pt(n, !0, a, n);
    u.x = h.x + n.clientLeft, u.y = h.y + n.clientTop;
  }
  !o && s && (u.x = ar(s));
  const d = s && !o && !a ? Ji(s, l) : at(0), p = i.left + l.scrollLeft - u.x - d.x, c = i.top + l.scrollTop - u.y - d.y;
  return {
    x: p,
    y: c,
    width: i.width,
    height: i.height
  };
}
function Pr(e) {
  return Ze(e).position === "static";
}
function ta(e, n) {
  if (!yt(e) || Ze(e).position === "fixed")
    return null;
  if (n)
    return n(e);
  let r = e.offsetParent;
  return dt(e) === r && (r = r.ownerDocument.body), r;
}
function el(e, n) {
  const r = Te(e);
  if (or(e))
    return r;
  if (!yt(e)) {
    let s = Rt(e);
    for (; s && !dn(s); ) {
      if (qe(s) && !Pr(s))
        return s;
      s = Rt(s);
    }
    return r;
  }
  let o = ta(e, n);
  for (; o && eh(o) && Pr(o); )
    o = ta(o, n);
  return o && dn(o) && Pr(o) && !No(o) ? r : o || rh(e) || r;
}
const gh = async function(e) {
  const n = this.getOffsetParent || el, r = this.getDimensions, o = await r(e.floating);
  return {
    reference: hh(e.reference, await n(e.floating), e.strategy),
    floating: {
      x: 0,
      y: 0,
      width: o.width,
      height: o.height
    }
  };
};
function vh(e) {
  return Ze(e).direction === "rtl";
}
const bh = {
  convertOffsetParentRelativeRectToViewportRelativeRect: ah,
  getDocumentElement: dt,
  getClippingRect: mh,
  getOffsetParent: el,
  getElementRects: gh,
  getClientRects: ih,
  getDimensions: ph,
  getScale: Gt,
  isElement: qe,
  isRTL: vh
};
function tl(e, n) {
  return e.x === n.x && e.y === n.y && e.width === n.width && e.height === n.height;
}
function yh(e, n, r) {
  let o = null, s;
  const a = dt(e);
  function i() {
    var p;
    clearTimeout(s), (p = o) == null || p.disconnect(), o = null;
  }
  function l(p, c) {
    p === void 0 && (p = !1), c === void 0 && (c = 1), i();
    const h = e.getBoundingClientRect(), {
      left: g,
      top: y,
      width: b,
      height: v
    } = h;
    if (p || n(), !b || !v)
      return;
    const x = On(y), S = On(a.clientWidth - (g + b)), w = On(a.clientHeight - (y + v)), C = On(g), R = {
      rootMargin: -x + "px " + -S + "px " + -w + "px " + -C + "px",
      threshold: st(0, ht(1, c)) || 1
    };
    let E = !0;
    function k(T) {
      const I = T[0].intersectionRatio;
      if (!tl(h, e.getBoundingClientRect()))
        return l();
      if (I !== c) {
        if (!E)
          return l();
        I ? l(!1, I) : s = setTimeout(() => {
          l(!1, 1e-7);
        }, 1e3);
      }
      E = !1;
    }
    try {
      o = new IntersectionObserver(k, {
        ...R,
        // Handle <iframe>s
        root: a.ownerDocument
      });
    } catch {
      o = new IntersectionObserver(k, R);
    }
    o.observe(e);
  }
  const u = Te(e), d = () => l(r);
  return u.addEventListener("resize", d), l(!0), () => {
    u.removeEventListener("resize", d), i();
  };
}
function xh(e, n, r, o) {
  o === void 0 && (o = {});
  const {
    ancestorScroll: s = !0,
    ancestorResize: a = !0,
    elementResize: i = typeof ResizeObserver == "function",
    layoutShift: l = typeof IntersectionObserver == "function",
    animationFrame: u = !1
  } = o, d = Po(e), p = s || a ? [...d ? un(d) : [], ...n ? un(n) : []] : [];
  p.forEach((x) => {
    s && x.addEventListener("scroll", r), a && x.addEventListener("resize", r);
  });
  const c = d && l ? yh(d, r, a) : null;
  let h = -1, g = null;
  i && (g = new ResizeObserver((x) => {
    let [S] = x;
    S && S.target === d && g && n && (g.unobserve(n), cancelAnimationFrame(h), h = requestAnimationFrame(() => {
      var w;
      (w = g) == null || w.observe(n);
    })), r();
  }), d && !u && g.observe(d), n && g.observe(n));
  let y, b = u ? Pt(e) : null;
  u && v();
  function v() {
    const x = Pt(e);
    b && !tl(b, x) && r(), b = x, y = requestAnimationFrame(v);
  }
  return r(), () => {
    var x;
    p.forEach((S) => {
      s && S.removeEventListener("scroll", r), a && S.removeEventListener("resize", r);
    }), c?.(), (x = g) == null || x.disconnect(), g = null, u && cancelAnimationFrame(y);
  };
}
const wh = qp, Ch = Zp, Sh = Kp, kh = Jp, Eh = Yp, na = Gp, Nh = Qp, Rh = (e, n, r) => {
  const o = /* @__PURE__ */ new Map(), s = r ?? {}, a = {
    ...bh,
    ...s.platform,
    _c: o
  };
  return Up(e, n, {
    ...s,
    platform: a
  });
};
var Ph = typeof document < "u", Th = function() {
}, Bn = Ph ? ua : Th;
function Kn(e, n) {
  if (e === n)
    return !0;
  if (typeof e != typeof n)
    return !1;
  if (typeof e == "function" && e.toString() === n.toString())
    return !0;
  let r, o, s;
  if (e && n && typeof e == "object") {
    if (Array.isArray(e)) {
      if (r = e.length, r !== n.length) return !1;
      for (o = r; o-- !== 0; )
        if (!Kn(e[o], n[o]))
          return !1;
      return !0;
    }
    if (s = Object.keys(e), r = s.length, r !== Object.keys(n).length)
      return !1;
    for (o = r; o-- !== 0; )
      if (!{}.hasOwnProperty.call(n, s[o]))
        return !1;
    for (o = r; o-- !== 0; ) {
      const a = s[o];
      if (!(a === "_owner" && e.$$typeof) && !Kn(e[a], n[a]))
        return !1;
    }
    return !0;
  }
  return e !== e && n !== n;
}
function nl(e) {
  return typeof window > "u" ? 1 : (e.ownerDocument.defaultView || window).devicePixelRatio || 1;
}
function ra(e, n) {
  const r = nl(e);
  return Math.round(n * r) / r;
}
function Tr(e) {
  const n = f.useRef(e);
  return Bn(() => {
    n.current = e;
  }), n;
}
function _h(e) {
  e === void 0 && (e = {});
  const {
    placement: n = "bottom",
    strategy: r = "absolute",
    middleware: o = [],
    platform: s,
    elements: {
      reference: a,
      floating: i
    } = {},
    transform: l = !0,
    whileElementsMounted: u,
    open: d
  } = e, [p, c] = f.useState({
    x: 0,
    y: 0,
    strategy: r,
    placement: n,
    middlewareData: {},
    isPositioned: !1
  }), [h, g] = f.useState(o);
  Kn(h, o) || g(o);
  const [y, b] = f.useState(null), [v, x] = f.useState(null), S = f.useCallback((W) => {
    W !== R.current && (R.current = W, b(W));
  }, []), w = f.useCallback((W) => {
    W !== E.current && (E.current = W, x(W));
  }, []), C = a || y, N = i || v, R = f.useRef(null), E = f.useRef(null), k = f.useRef(p), T = u != null, I = Tr(u), L = Tr(s), A = Tr(d), _ = f.useCallback(() => {
    if (!R.current || !E.current)
      return;
    const W = {
      placement: n,
      strategy: r,
      middleware: h
    };
    L.current && (W.platform = L.current), Rh(R.current, E.current, W).then((z) => {
      const F = {
        ...z,
        // The floating element's position may be recomputed while it's closed
        // but still mounted (such as when transitioning out). To ensure
        // `isPositioned` will be `false` initially on the next open, avoid
        // setting it to `true` when `open === false` (must be specified).
        isPositioned: A.current !== !1
      };
      M.current && !Kn(k.current, F) && (k.current = F, hn.flushSync(() => {
        c(F);
      }));
    });
  }, [h, n, r, L, A]);
  Bn(() => {
    d === !1 && k.current.isPositioned && (k.current.isPositioned = !1, c((W) => ({
      ...W,
      isPositioned: !1
    })));
  }, [d]);
  const M = f.useRef(!1);
  Bn(() => (M.current = !0, () => {
    M.current = !1;
  }), []), Bn(() => {
    if (C && (R.current = C), N && (E.current = N), C && N) {
      if (I.current)
        return I.current(C, N, _);
      _();
    }
  }, [C, N, _, I, T]);
  const U = f.useMemo(() => ({
    reference: R,
    floating: E,
    setReference: S,
    setFloating: w
  }), [S, w]), $ = f.useMemo(() => ({
    reference: C,
    floating: N
  }), [C, N]), B = f.useMemo(() => {
    const W = {
      position: r,
      left: 0,
      top: 0
    };
    if (!$.floating)
      return W;
    const z = ra($.floating, p.x), F = ra($.floating, p.y);
    return l ? {
      ...W,
      transform: "translate(" + z + "px, " + F + "px)",
      ...nl($.floating) >= 1.5 && {
        willChange: "transform"
      }
    } : {
      position: r,
      left: z,
      top: F
    };
  }, [r, l, $.floating, p.x, p.y]);
  return f.useMemo(() => ({
    ...p,
    update: _,
    refs: U,
    elements: $,
    floatingStyles: B
  }), [p, _, U, $, B]);
}
const Ih = (e) => {
  function n(r) {
    return {}.hasOwnProperty.call(r, "current");
  }
  return {
    name: "arrow",
    options: e,
    fn(r) {
      const {
        element: o,
        padding: s
      } = typeof e == "function" ? e(r) : e;
      return o && n(o) ? o.current != null ? na({
        element: o.current,
        padding: s
      }).fn(r) : {} : o ? na({
        element: o,
        padding: s
      }).fn(r) : {};
    }
  };
}, Oh = (e, n) => {
  const r = wh(e);
  return {
    name: r.name,
    fn: r.fn,
    options: [e, n]
  };
}, Ah = (e, n) => {
  const r = Ch(e);
  return {
    name: r.name,
    fn: r.fn,
    options: [e, n]
  };
}, Dh = (e, n) => ({
  fn: Nh(e).fn,
  options: [e, n]
}), Mh = (e, n) => {
  const r = Sh(e);
  return {
    name: r.name,
    fn: r.fn,
    options: [e, n]
  };
}, Lh = (e, n) => {
  const r = kh(e);
  return {
    name: r.name,
    fn: r.fn,
    options: [e, n]
  };
}, Fh = (e, n) => {
  const r = Eh(e);
  return {
    name: r.name,
    fn: r.fn,
    options: [e, n]
  };
}, $h = (e, n) => {
  const r = Ih(e);
  return {
    name: r.name,
    fn: r.fn,
    options: [e, n]
  };
};
var zh = Object.defineProperty, Bh = (e, n) => zh(e, "name", { value: n, configurable: !0 });
function To(e) {
  const [n, r] = f.useState(void 0);
  return ue(() => {
    if (e) {
      r({ width: e.offsetWidth, height: e.offsetHeight });
      const o = new ResizeObserver((s) => {
        if (!Array.isArray(s) || !s.length)
          return;
        const a = s[0];
        let i, l;
        if ("borderBoxSize" in a) {
          const u = a.borderBoxSize, d = Array.isArray(u) ? u[0] : u;
          i = d.inlineSize, l = d.blockSize;
        } else
          i = e.offsetWidth, l = e.offsetHeight;
        r({ width: i, height: l });
      });
      return o.observe(e, { box: "border-box" }), () => o.unobserve(e);
    } else
      r(void 0);
  }, [e]), n;
}
Bh(To, "useSize");
var Vh = Object.defineProperty, pt = (e, n) => Vh(e, "name", { value: n, configurable: !0 }), rl = "Popper", [ol, en] = /* @__PURE__ */ Ie(rl), [jh, sl] = ol(rl), Hh = /* @__PURE__ */ pt((e) => {
  const { __scopePopper: n, children: r } = e, [o, s] = f.useState(null), [a, i] = f.useState(void 0);
  return /* @__PURE__ */ m(
    jh,
    {
      scope: n,
      anchor: o,
      onAnchorChange: s,
      placementState: a,
      setPlacementState: i,
      children: r
    }
  );
}, "Popper"), Wh = "PopperAnchor", Uh = /* @__PURE__ */ f.forwardRef(
  /* @__PURE__ */ pt(function(n, r) {
    const { __scopePopper: o, virtualRef: s, ...a } = n, i = sl(Wh, o), l = f.useRef(null), u = i.onAnchorChange, d = f.useCallback(
      (b) => {
        l.current = b, b && u(b);
      },
      [u]
    ), p = oe(r, d), c = f.useRef(null);
    f.useEffect(() => {
      if (!s)
        return;
      const b = c.current;
      c.current = s.current, b !== c.current && u(c.current);
    });
    const h = i.placementState && ir(i.placementState), g = h?.[0], y = h?.[1];
    return s ? null : /* @__PURE__ */ m(
      Q.div,
      {
        "data-radix-popper-side": g,
        "data-radix-popper-align": y,
        ...a,
        ref: p
      }
    );
  }, "PopperAnchor")
), al = "PopperContent", [Gh, my] = ol(al), Kh = /* @__PURE__ */ f.forwardRef(
  /* @__PURE__ */ pt(function(n, r) {
    const {
      __scopePopper: o,
      side: s = "bottom",
      sideOffset: a = 0,
      align: i = "center",
      alignOffset: l = 0,
      arrowPadding: u = 0,
      avoidCollisions: d = !0,
      collisionBoundary: p = [],
      collisionPadding: c = 0,
      sticky: h = "partial",
      hideWhenDetached: g = !1,
      updatePositionStrategy: y = "optimized",
      onPlaced: b,
      ...v
    } = n, x = sl(al, o), [S, w] = f.useState(null), C = oe(r, w), [N, R] = f.useState(null), E = To(N), k = E?.width ?? 0, T = E?.height ?? 0, I = s + (i !== "center" ? "-" + i : ""), L = typeof c == "number" ? c : { top: 0, right: 0, bottom: 0, left: 0, ...c }, A = Array.isArray(p) ? p : [p], _ = A.length > 0, M = {
      padding: L,
      boundary: A.filter(il),
      // with `strategy: 'fixed'`, this is the only way to get it to respect boundaries
      altBoundary: _
    }, { refs: U, floatingStyles: $, placement: B, isPositioned: W, middlewareData: z } = _h({
      // default to `fixed` strategy so users don't have to pick and we also avoid focus scroll issues
      strategy: "fixed",
      placement: I,
      whileElementsMounted: /* @__PURE__ */ pt((...V) => xh(...V, {
        animationFrame: y === "always"
      }), "whileElementsMounted"),
      elements: {
        reference: x.anchor
      },
      middleware: [
        Oh({ mainAxis: a + T, alignmentAxis: l }),
        d && Ah({
          mainAxis: !0,
          crossAxis: !1,
          limiter: h === "partial" ? Dh() : void 0,
          ...M
        }),
        d && Mh({ ...M }),
        Lh({
          ...M,
          apply: /* @__PURE__ */ pt(({ elements: V, rects: de, availableWidth: ne, availableHeight: re }) => {
            const { width: se, height: pe } = de.reference, Ee = V.floating.style;
            Ee.setProperty("--radix-popper-available-width", `${ne}px`), Ee.setProperty("--radix-popper-available-height", `${re}px`), Ee.setProperty("--radix-popper-anchor-width", `${se}px`), Ee.setProperty("--radix-popper-anchor-height", `${pe}px`);
          }, "apply")
        }),
        N && $h({ element: N, padding: u }),
        Yh({ arrowWidth: k, arrowHeight: T }),
        g && Fh({
          strategy: "referenceHidden",
          ...M,
          // `hide` detects whether the anchor (reference) is clipped, so when
          // no explicit `collisionBoundary` is set we fall back to Floating
          // UI's default clipping ancestors (e.g. a scrollable menu). This
          // lets an occluded submenu hide once its anchor scrolls out of view
          // (#3237). The collision/size middlewares deliberately keep the
          // viewport-based default to avoid clamping content rendered inside
          // transformed or overflow-clipping portal containers.
          boundary: _ ? M.boundary : void 0
        })
      ]
    }), F = x.setPlacementState;
    ue(() => (F(B), () => {
      F(void 0);
    }), [B, F]);
    const [le, ee] = ir(B), ae = Fe(b);
    ue(() => {
      W && ae?.();
    }, [W, ae]);
    const q = z.arrow?.x, Y = z.arrow?.y, G = z.arrow?.centerOffset !== 0, [ie, K] = f.useState();
    return ue(() => {
      S && K(window.getComputedStyle(S).zIndex);
    }, [S]), /* @__PURE__ */ m(
      "div",
      {
        ref: U.setFloating,
        "data-radix-popper-content-wrapper": "",
        style: {
          ...$,
          transform: W ? $.transform : "translate(0, -200%)",
          // keep off the page when measuring
          minWidth: "max-content",
          zIndex: ie,
          "--radix-popper-transform-origin": [
            z.transformOrigin?.x,
            z.transformOrigin?.y
          ].join(" "),
          // hide the content if using the hide middleware and should be hidden
          // set visibility to hidden and disable pointer events so the UI behaves
          // as if the PopperContent isn't there at all
          ...z.hide?.referenceHidden && {
            visibility: "hidden",
            pointerEvents: "none"
          }
        },
        dir: n.dir,
        children: /* @__PURE__ */ m(
          Gh,
          {
            scope: o,
            placedSide: le,
            placedAlign: ee,
            onArrowChange: R,
            arrowX: q,
            arrowY: Y,
            shouldHideArrow: G,
            children: /* @__PURE__ */ m(
              Q.div,
              {
                "data-side": le,
                "data-align": ee,
                ...v,
                ref: C,
                style: {
                  ...v.style,
                  // if the PopperContent hasn't been placed yet (not all
                  // measurements done) we prevent animations so that users'
                  // animations don't kick in too early from the wrong sides.
                  animation: W ? v.style?.animation : "none"
                }
              }
            )
          }
        )
      }
    );
  }, "PopperContent")
);
function il(e) {
  return e !== null;
}
pt(il, "isNotNull");
var Yh = /* @__PURE__ */ pt((e) => ({
  name: "transformOrigin",
  options: e,
  fn(n) {
    const { placement: r, rects: o, middlewareData: s } = n, i = s.arrow?.centerOffset !== 0, l = i ? 0 : e.arrowWidth, u = i ? 0 : e.arrowHeight, [d, p] = ir(r), c = { start: "0%", center: "50%", end: "100%" }[p], h = (s.arrow?.x ?? 0) + l / 2, g = (s.arrow?.y ?? 0) + u / 2;
    let y = "", b = "";
    return d === "bottom" ? (y = i ? c : `${h}px`, b = `${-u}px`) : d === "top" ? (y = i ? c : `${h}px`, b = `${o.floating.height + u}px`) : d === "right" ? (y = `${-u}px`, b = i ? c : `${g}px`) : d === "left" && (y = `${o.floating.width + u}px`, b = i ? c : `${g}px`), { data: { x: y, y: b } };
  }
}), "transformOrigin");
function ir(e) {
  const [n, r = "center"] = e.split("-");
  return [n, r];
}
pt(ir, "getSideAndAlignFromPlacement");
var _o = Hh, Io = Uh, Oo = Kh, Xh = Object.defineProperty, qh = (e, n) => Xh(e, "name", { value: n, configurable: !0 });
function ll(e) {
  const n = f.useRef({ value: e, previous: e });
  return f.useMemo(() => (n.current.value !== e && (n.current.previous = n.current.value, n.current.value = e), n.current.previous), [e]);
}
qh(ll, "usePrevious");
var Zh = Object.defineProperty, Qh = (e, n) => Zh(e, "name", { value: n, configurable: !0 }), cl = Object.freeze({
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
}), Jh = /* @__PURE__ */ f.forwardRef(
  /* @__PURE__ */ Qh(function(n, r) {
    return /* @__PURE__ */ m(
      Q.span,
      {
        ...n,
        ref: r,
        style: { ...cl, ...n.style }
      }
    );
  }, "VisuallyHidden")
), eg = Jh, tg = Object.defineProperty, te = (e, n) => tg(e, "name", { value: n, configurable: !0 }), ng = [" ", "Enter", "ArrowUp", "ArrowDown"], rg = [" ", "Enter"], Kt = "Select", [lr, cr, og] = /* @__PURE__ */ wo(Kt), [It, py] = /* @__PURE__ */ Ie(Kt, [
  og,
  en
]), Ao = en(), [sg, xt] = It(Kt), [ag, ig] = It(Kt);
function dl(e) {
  const {
    __scopeSelect: n,
    children: r,
    open: o,
    defaultOpen: s,
    onOpenChange: a,
    value: i,
    defaultValue: l,
    onValueChange: u,
    dir: d,
    name: p,
    autoComplete: c,
    disabled: h,
    required: g,
    form: y,
    // @ts-expect-error internal render prop used by `Select` to compose its default parts
    internal_do_not_use_render: b
  } = e, v = Ao(n), [x, S] = f.useState(null), [w, C] = f.useState(null), [N, R] = f.useState(!1), E = Yn(d), [k, T] = Xe({
    prop: o,
    defaultProp: s ?? !1,
    onChange: a,
    caller: Kt
  }), [I, L] = Xe({
    prop: i,
    defaultProp: l,
    onChange: u,
    caller: Kt
  }), A = f.useRef(null), _ = f.useRef(I);
  f.useEffect(() => {
    const ee = y ? x?.ownerDocument.getElementById(y) : x?.form;
    if (ee instanceof HTMLFormElement) {
      const ae = /* @__PURE__ */ te(() => L(_.current), "reset");
      return ee.addEventListener("reset", ae), () => ee.removeEventListener("reset", ae);
    }
  }, [y, x, L]);
  const M = x ? !!y || !!x.closest("form") : !0, [U, $] = f.useState(/* @__PURE__ */ new Set()), B = Me(), W = Array.from(U).map((ee) => ee.props.value).join(";"), z = f.useCallback((ee) => {
    $((ae) => new Set(ae).add(ee));
  }, []), F = f.useCallback((ee) => {
    $((ae) => {
      const q = new Set(ae);
      return q.delete(ee), q;
    });
  }, []), le = {
    required: g,
    trigger: x,
    onTriggerChange: S,
    valueNode: w,
    onValueNodeChange: C,
    valueNodeHasChildren: N,
    onValueNodeHasChildrenChange: R,
    contentId: B,
    value: I,
    onValueChange: L,
    open: k,
    onOpenChange: T,
    dir: E,
    triggerPointerDownPosRef: A,
    disabled: h,
    name: p,
    autoComplete: c,
    form: y,
    nativeOptions: U,
    nativeSelectKey: W,
    isFormControl: M
  };
  return /* @__PURE__ */ m(_o, { ...v, children: /* @__PURE__ */ m(sg, { scope: n, ...le, children: /* @__PURE__ */ m(lr.Provider, { scope: n, children: /* @__PURE__ */ m(
    ag,
    {
      scope: n,
      onNativeOptionAdd: z,
      onNativeOptionRemove: F,
      children: yl(b) ? b(le) : r
    }
  ) }) }) });
}
te(dl, "SelectProvider");
var lg = /* @__PURE__ */ te((e) => {
  const { __scopeSelect: n, children: r, ...o } = e;
  return /* @__PURE__ */ m(
    dl,
    {
      __scopeSelect: n,
      ...o,
      internal_do_not_use_render: ({ isFormControl: s }) => /* @__PURE__ */ D(Qe, { children: [
        r,
        s ? /* @__PURE__ */ m(
          Mg,
          {
            __scopeSelect: n
          }
        ) : null
      ] })
    }
  );
}, "Select"), cg = "SelectTrigger", ul = /* @__PURE__ */ f.forwardRef(
  /* @__PURE__ */ te(function(n, r) {
    const { __scopeSelect: o, disabled: s = !1, ...a } = n, i = Ao(o), l = xt(cg, o), u = l.disabled || s, d = oe(r, l.onTriggerChange), p = cr(o), c = f.useRef("touch"), [h, g, y] = Mo((v) => {
      const x = p().filter((C) => !C.disabled), S = x.find((C) => C.value === l.value), w = Lo(x, v, S);
      w !== void 0 && l.onValueChange(w.value);
    }), b = /* @__PURE__ */ te((v) => {
      u || (l.onOpenChange(!0), y()), v && (l.triggerPointerDownPosRef.current = {
        x: Math.round(v.pageX),
        y: Math.round(v.pageY)
      });
    }, "handleOpen");
    return /* @__PURE__ */ m(Io, { asChild: !0, ...i, children: /* @__PURE__ */ m(
      Q.button,
      {
        type: "button",
        role: "combobox",
        "aria-controls": l.open ? l.contentId : void 0,
        "aria-expanded": l.open,
        "aria-required": l.required,
        "aria-autocomplete": "none",
        dir: l.dir,
        "data-state": l.open ? "open" : "closed",
        disabled: u,
        "data-disabled": u ? "" : void 0,
        "data-placeholder": xn(l.value) ? "" : void 0,
        ...a,
        ref: d,
        onClick: X(a.onClick, (v) => {
          v.currentTarget.focus(), c.current !== "mouse" && b(v);
        }),
        onPointerDown: X(a.onPointerDown, (v) => {
          c.current = v.pointerType;
          const x = v.target;
          x.hasPointerCapture(v.pointerId) && x.releasePointerCapture(v.pointerId), v.button === 0 && v.ctrlKey === !1 && v.pointerType === "mouse" && (b(v), v.preventDefault());
        }),
        onKeyDown: X(a.onKeyDown, (v) => {
          const x = h.current !== "";
          !(v.ctrlKey || v.altKey || v.metaKey) && v.key.length === 1 && g(v.key), !(x && v.key === " ") && ng.includes(v.key) && (b(), v.preventDefault());
        })
      }
    ) });
  }, "SelectTrigger")
), dg = "SelectValue", ug = /* @__PURE__ */ f.forwardRef(
  /* @__PURE__ */ te(function(n, r) {
    const { __scopeSelect: o, className: s, style: a, children: i, placeholder: l = "", ...u } = n, d = xt(dg, o), { onValueNodeHasChildrenChange: p } = d, c = i !== void 0, h = oe(r, d.onValueNodeChange);
    ue(() => {
      p(c);
    }, [p, c]);
    const g = xn(d.value);
    return /* @__PURE__ */ m(
      Q.span,
      {
        ...u,
        asChild: g ? !1 : u.asChild,
        ref: h,
        style: { pointerEvents: "none" },
        children: /* @__PURE__ */ m(f.Fragment, { children: g ? l : i }, g ? "placeholder" : "value")
      }
    );
  }, "SelectValue")
), fg = /* @__PURE__ */ f.forwardRef(
  /* @__PURE__ */ te(function(n, r) {
    const { __scopeSelect: o, children: s, ...a } = n;
    return /* @__PURE__ */ m(Q.span, { "aria-hidden": !0, ...a, ref: r, children: s || "▼" });
  }, "SelectIcon")
), mg = "SelectPortal", [pg, hg] = It(mg, {
  forceMount: void 0
}), gg = /* @__PURE__ */ te((e) => {
  const { __scopeSelect: n, forceMount: r, ...o } = e;
  return /* @__PURE__ */ m(pg, { scope: e.__scopeSelect, forceMount: r, children: /* @__PURE__ */ m(uo, { asChild: !0, ...o }) });
}, "SelectPortal"), Tt = "SelectContent", fl = /* @__PURE__ */ f.forwardRef(
  /* @__PURE__ */ te(function(n, r) {
    const o = hg(Tt, n.__scopeSelect), { forceMount: s = o.forceMount, ...a } = n, i = xt(Tt, n.__scopeSelect), [l, u] = f.useState();
    return ue(() => {
      u(new DocumentFragment());
    }, []), /* @__PURE__ */ m(ct, { present: s || i.open, children: ({ present: d }) => d ? /* @__PURE__ */ m(yg, { ...a, ref: r }) : /* @__PURE__ */ m(vg, { ...a, fragment: l }) });
  }, "SelectContent")
), vg = /* @__PURE__ */ f.forwardRef(/* @__PURE__ */ te(function(n, r) {
  const { __scopeSelect: o, children: s, fragment: a } = n;
  return a ? hn.createPortal(
    /* @__PURE__ */ m(ml, { scope: o, children: /* @__PURE__ */ m(lr.Slot, { scope: o, children: /* @__PURE__ */ m("div", { ref: r, children: s }) }) }),
    a
  ) : null;
}, "SelectContentFragment")), Le = 10, [ml, Ot] = It(Tt), bg = /* @__PURE__ */ Ye("SelectContent.RemoveScroll"), yg = /* @__PURE__ */ f.forwardRef(
  // blank line to reduce diff noise
  /* @__PURE__ */ te(function(n, r) {
    const { __scopeSelect: o } = n, {
      position: s = "item-aligned",
      onCloseAutoFocus: a,
      onEscapeKeyDown: i,
      onPointerDownOutside: l,
      //
      // PopperContent props
      side: u,
      sideOffset: d,
      align: p,
      alignOffset: c,
      arrowPadding: h,
      collisionBoundary: g,
      collisionPadding: y,
      sticky: b,
      hideWhenDetached: v,
      avoidCollisions: x,
      //
      ...S
    } = n, w = xt(Tt, o), [C, N] = f.useState(null), [R, E] = f.useState(null), k = oe(r, N), [T, I] = f.useState(null), [L, A] = f.useState(
      null
    ), _ = cr(o), [M, U] = f.useState(!1), $ = f.useRef(!1);
    f.useEffect(() => {
      if (C) return mo(C);
    }, [C]), vn();
    const B = f.useCallback(
      (K) => {
        const [V, ...de] = _().map((se) => se.ref.current), [ne] = de.slice(-1), re = document.activeElement;
        for (const se of K)
          if (se === re || (se?.scrollIntoView({ block: "nearest" }), se === V && R && (R.scrollTop = 0), se === ne && R && (R.scrollTop = R.scrollHeight), se?.focus(), document.activeElement !== re)) return;
      },
      [_, R]
    ), W = f.useCallback(
      () => B([T, C]),
      [B, T, C]
    );
    f.useEffect(() => {
      M && W();
    }, [M, W]);
    const { onOpenChange: z, triggerPointerDownPosRef: F } = w;
    f.useEffect(() => {
      if (C) {
        let K = { x: 0, y: 0 };
        const V = /* @__PURE__ */ te((ne) => {
          K = {
            x: Math.abs(Math.round(ne.pageX) - (F.current?.x ?? 0)),
            y: Math.abs(Math.round(ne.pageY) - (F.current?.y ?? 0))
          };
        }, "handlePointerMove"), de = /* @__PURE__ */ te((ne) => {
          K.x <= 10 && K.y <= 10 ? ne.preventDefault() : ne.composedPath().includes(C) || z(!1), document.removeEventListener("pointermove", V), F.current = null;
        }, "handlePointerUp");
        return F.current !== null && (document.addEventListener("pointermove", V), document.addEventListener("pointerup", de, { capture: !0, once: !0 })), () => {
          document.removeEventListener("pointermove", V), document.removeEventListener("pointerup", de, { capture: !0 });
        };
      }
    }, [C, z, F]), f.useEffect(() => {
      const K = /* @__PURE__ */ te(() => z(!1), "close");
      return window.addEventListener("blur", K), window.addEventListener("resize", K), () => {
        window.removeEventListener("blur", K), window.removeEventListener("resize", K);
      };
    }, [z]);
    const [le, ee] = Mo((K) => {
      const V = _().filter((re) => !re.disabled), de = V.find((re) => re.ref.current === document.activeElement), ne = Lo(V, K, de);
      ne && setTimeout(() => ne.ref.current?.focus());
    }), ae = f.useCallback(
      (K, V, de) => {
        const ne = !$.current && !de;
        (w.value !== void 0 && w.value === V || ne) && (I(K), ne && ($.current = !0));
      },
      [w.value]
    ), q = f.useCallback(() => C?.focus(), [C]), Y = f.useCallback(
      (K, V, de) => {
        const ne = !$.current && !de;
        (w.value !== void 0 && w.value === V || ne) && A(K);
      },
      [w.value]
    ), G = s === "popper" ? oa : xg, ie = G === oa ? {
      side: u,
      sideOffset: d,
      align: p,
      alignOffset: c,
      arrowPadding: h,
      collisionBoundary: g,
      collisionPadding: y,
      sticky: b,
      hideWhenDetached: v,
      avoidCollisions: x
    } : {};
    return /* @__PURE__ */ m(
      ml,
      {
        scope: o,
        content: C,
        viewport: R,
        onViewportChange: E,
        itemRefCallback: ae,
        selectedItem: T,
        onItemLeave: q,
        itemTextRefCallback: Y,
        focusSelectedItem: W,
        selectedItemText: L,
        position: s,
        isPositioned: M,
        searchRef: le,
        children: /* @__PURE__ */ m(Qn, { as: bg, allowPinchZoom: !0, children: /* @__PURE__ */ m(
          lo,
          {
            asChild: !0,
            trapped: w.open,
            onMountAutoFocus: (K) => {
              K.preventDefault();
            },
            onUnmountAutoFocus: X(a, (K) => {
              w.trigger?.focus({ preventScroll: !0 }), K.preventDefault();
            }),
            children: /* @__PURE__ */ m(
              qn,
              {
                asChild: !0,
                disableOutsidePointerEvents: !0,
                onEscapeKeyDown: i,
                onPointerDownOutside: l,
                onFocusOutside: (K) => K.preventDefault(),
                onDismiss: () => w.onOpenChange(!1),
                children: /* @__PURE__ */ m(
                  G,
                  {
                    role: "listbox",
                    id: w.contentId,
                    "data-state": w.open ? "open" : "closed",
                    dir: w.dir,
                    onContextMenu: (K) => K.preventDefault(),
                    ...S,
                    ...ie,
                    onPlaced: () => U(!0),
                    ref: k,
                    style: {
                      // flex layout so we can place the scroll buttons properly
                      display: "flex",
                      flexDirection: "column",
                      // reset the outline by default as the content MAY get focused
                      outline: "none",
                      ...S.style
                    },
                    onKeyDown: X(S.onKeyDown, (K) => {
                      const V = K.ctrlKey || K.altKey || K.metaKey;
                      if (K.key === "Tab" && K.preventDefault(), !V && K.key.length === 1 && ee(K.key), ["ArrowUp", "ArrowDown", "Home", "End"].includes(K.key)) {
                        let ne = _().filter((re) => !re.disabled).map((re) => re.ref.current);
                        if (["ArrowUp", "End"].includes(K.key) && (ne = ne.slice().reverse()), ["ArrowUp", "ArrowDown"].includes(K.key)) {
                          const re = K.target, se = ne.indexOf(re);
                          ne = ne.slice(se + 1);
                        }
                        setTimeout(() => B(ne)), K.preventDefault();
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
), xg = /* @__PURE__ */ f.forwardRef(/* @__PURE__ */ te(function(n, r) {
  const { __scopeSelect: o, onPlaced: s, ...a } = n, i = xt(Tt, o), l = Ot(Tt, o), [u, d] = f.useState(null), [p, c] = f.useState(null), h = oe(r, c), g = cr(o), y = f.useRef(!1), b = f.useRef(!0), { viewport: v, selectedItem: x, selectedItemText: S, focusSelectedItem: w } = l, C = f.useCallback(() => {
    if (i.trigger && i.valueNode && u && p && v && x && S) {
      const k = i.trigger.getBoundingClientRect(), T = p.getBoundingClientRect(), I = i.valueNode.getBoundingClientRect(), L = S.getBoundingClientRect();
      if (i.dir !== "rtl") {
        const re = L.left - T.left, se = I.left - re, pe = k.left - se, Ee = k.width + pe, Dt = Math.max(Ee, T.width), Je = window.innerWidth - Le, Mt = Yr(se, [
          Le,
          // Prevents the content from going off the starting edge of the
          // viewport. It may still go off the ending edge, but this can be
          // controlled by the user since they may want to manage overflow in a
          // specific way.
          // https://github.com/radix-ui/primitives/issues/2049
          Math.max(Le, Je - Dt)
        ]);
        u.style.minWidth = Ee + "px", u.style.left = Mt + "px";
      } else {
        const re = T.right - L.right, se = window.innerWidth - I.right - re, pe = window.innerWidth - k.right - se, Ee = k.width + pe, Dt = Math.max(Ee, T.width), Je = window.innerWidth - Le, Mt = Yr(se, [
          Le,
          Math.max(Le, Je - Dt)
        ]);
        u.style.minWidth = Ee + "px", u.style.right = Mt + "px";
      }
      const A = g(), _ = window.innerHeight - Le * 2, M = v.scrollHeight, U = window.getComputedStyle(p), $ = parseInt(U.borderTopWidth, 10), B = parseInt(U.paddingTop, 10), W = parseInt(U.borderBottomWidth, 10), z = parseInt(U.paddingBottom, 10), F = $ + B + M + z + W, le = Math.min(x.offsetHeight * 5, F), ee = window.getComputedStyle(v), ae = parseInt(ee.paddingTop, 10), q = parseInt(ee.paddingBottom, 10), Y = k.top + k.height / 2 - Le, G = _ - Y, ie = x.offsetHeight / 2, K = x.offsetTop + ie, V = $ + B + K, de = F - V;
      if (V <= Y) {
        const re = A.length > 0 && x === A[A.length - 1].ref.current;
        u.style.bottom = "0px";
        const se = p.clientHeight - v.offsetTop - v.offsetHeight, pe = Math.max(
          G,
          ie + // viewport might have padding bottom, include it to avoid a scrollable viewport
          (re ? q : 0) + se + W
        ), Ee = V + pe;
        u.style.height = Ee + "px";
      } else {
        const re = A.length > 0 && x === A[0].ref.current;
        u.style.top = "0px";
        const pe = Math.max(
          Y,
          $ + v.offsetTop + // viewport might have padding top, include it to avoid a scrollable viewport
          (re ? ae : 0) + ie
        ) + de;
        u.style.height = pe + "px", v.scrollTop = V - Y + v.offsetTop;
      }
      u.style.margin = `${Le}px 0`, u.style.minHeight = le + "px", u.style.maxHeight = _ + "px", s?.(), requestAnimationFrame(() => y.current = !0);
    }
  }, [
    g,
    i.trigger,
    i.valueNode,
    u,
    p,
    v,
    x,
    S,
    i.dir,
    s
  ]);
  ue(() => C(), [C]);
  const [N, R] = f.useState();
  ue(() => {
    p && R(window.getComputedStyle(p).zIndex);
  }, [p]);
  const E = f.useCallback(
    (k) => {
      k && b.current === !0 && (C(), w?.(), b.current = !1);
    },
    [C, w]
  );
  return /* @__PURE__ */ m(
    wg,
    {
      scope: o,
      contentWrapper: u,
      shouldExpandOnScrollRef: y,
      onScrollButtonChange: E,
      children: /* @__PURE__ */ m(
        "div",
        {
          ref: d,
          style: {
            display: "flex",
            flexDirection: "column",
            position: "fixed",
            zIndex: N
          },
          children: /* @__PURE__ */ m(
            Q.div,
            {
              ...a,
              ref: h,
              style: {
                // When we get the height of the content, it includes borders. If we were to set
                // the height without having `boxSizing: 'border-box'` it would be too big.
                boxSizing: "border-box",
                // We need to ensure the content doesn't get taller than the wrapper
                maxHeight: "100%",
                ...a.style
              }
            }
          )
        }
      )
    }
  );
}, "SelectItemAlignedPosition")), oa = /* @__PURE__ */ f.forwardRef(/* @__PURE__ */ te(function(n, r) {
  const {
    __scopeSelect: o,
    align: s = "start",
    collisionPadding: a = Le,
    ...i
  } = n, l = Ao(o);
  return /* @__PURE__ */ m(
    Oo,
    {
      ...l,
      ...i,
      ref: r,
      align: s,
      collisionPadding: a,
      style: {
        // Ensure border-box for floating-ui calculations
        boxSizing: "border-box",
        ...i.style,
        "--radix-select-content-transform-origin": "var(--radix-popper-transform-origin)",
        "--radix-select-content-available-width": "var(--radix-popper-available-width)",
        "--radix-select-content-available-height": "var(--radix-popper-available-height)",
        "--radix-select-trigger-width": "var(--radix-popper-anchor-width)",
        "--radix-select-trigger-height": "var(--radix-popper-anchor-height)"
      }
    }
  );
}, "SelectPopperPosition")), [wg, Do] = It(Tt, {}), sa = "SelectViewport", Cg = /* @__PURE__ */ f.forwardRef(
  /* @__PURE__ */ te(function(n, r) {
    const { __scopeSelect: o, nonce: s, ...a } = n, i = Ot(sa, o), l = Do(sa, o), u = oe(r, i.onViewportChange), d = f.useRef(0);
    return /* @__PURE__ */ D(Qe, { children: [
      /* @__PURE__ */ m(
        "style",
        {
          dangerouslySetInnerHTML: {
            __html: "[data-radix-select-viewport]{scrollbar-width:none;-ms-overflow-style:none;-webkit-overflow-scrolling:touch;}[data-radix-select-viewport]::-webkit-scrollbar{display:none}"
          },
          nonce: s
        }
      ),
      /* @__PURE__ */ m(lr.Slot, { scope: o, children: /* @__PURE__ */ m(
        Q.div,
        {
          "data-radix-select-viewport": "",
          role: "presentation",
          ...a,
          ref: u,
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
            ...a.style
          },
          onScroll: X(a.onScroll, (p) => {
            const c = p.currentTarget, { contentWrapper: h, shouldExpandOnScrollRef: g } = l;
            if (g?.current && h) {
              const y = Math.abs(d.current - c.scrollTop);
              if (y > 0) {
                const b = window.innerHeight - Le * 2, v = parseFloat(h.style.minHeight), x = parseFloat(h.style.height), S = Math.max(v, x);
                if (S < b) {
                  const w = S + y, C = Math.min(b, w), N = w - C;
                  h.style.height = C + "px", h.style.bottom === "0px" && (c.scrollTop = N > 0 ? N : 0, h.style.justifyContent = "flex-end");
                }
              }
            }
            d.current = c.scrollTop;
          })
        }
      ) })
    ] });
  }, "SelectViewport")
), Sg = "SelectGroup", [kg, Eg] = It(Sg), Ng = /* @__PURE__ */ f.forwardRef(
  /* @__PURE__ */ te(function(n, r) {
    const { __scopeSelect: o, ...s } = n, a = Me();
    return /* @__PURE__ */ m(kg, { scope: o, id: a, children: /* @__PURE__ */ m(Q.div, { role: "group", "aria-labelledby": a, ...s, ref: r }) });
  }, "SelectGroup")
), Rg = "SelectLabel", pl = /* @__PURE__ */ f.forwardRef(
  /* @__PURE__ */ te(function(n, r) {
    const { __scopeSelect: o, ...s } = n, a = Eg(Rg, o);
    return /* @__PURE__ */ m(Q.div, { id: a.id, ...s, ref: r });
  }, "SelectLabel")
), Qr = "SelectItem", [Pg, hl] = It(Qr), gl = /* @__PURE__ */ f.forwardRef(
  /* @__PURE__ */ te(function(n, r) {
    const {
      __scopeSelect: o,
      value: s,
      disabled: a = !1,
      textValue: i,
      ...l
    } = n, u = xt(Qr, o), d = Ot(Qr, o), p = u.value === s, [c, h] = f.useState(i ?? ""), [g, y] = f.useState(!1), b = Fe(
      (C) => d.itemRefCallback?.(C, s, a)
    ), v = oe(r, b), x = Me(), S = f.useRef("touch"), w = /* @__PURE__ */ te(() => {
      a || (u.onValueChange(s), u.onOpenChange(!1));
    }, "handleSelect");
    return /* @__PURE__ */ m(
      Pg,
      {
        scope: o,
        value: s,
        disabled: a,
        textId: x,
        isSelected: p,
        onItemTextChange: f.useCallback((C) => {
          h((N) => N || (C?.textContent ?? "").trim());
        }, []),
        children: /* @__PURE__ */ m(
          lr.ItemSlot,
          {
            scope: o,
            value: s,
            disabled: a,
            textValue: c,
            children: /* @__PURE__ */ m(
              Q.div,
              {
                role: "option",
                "aria-labelledby": x,
                "data-highlighted": g ? "" : void 0,
                "aria-selected": p && g,
                "data-state": p ? "checked" : "unchecked",
                "aria-disabled": a || void 0,
                "data-disabled": a ? "" : void 0,
                tabIndex: a ? void 0 : -1,
                ...l,
                ref: v,
                onFocus: X(l.onFocus, () => y(!0)),
                onBlur: X(l.onBlur, () => y(!1)),
                onClick: X(l.onClick, () => {
                  S.current !== "mouse" && w();
                }),
                onPointerUp: X(l.onPointerUp, () => {
                  S.current === "mouse" && w();
                }),
                onPointerDown: X(l.onPointerDown, (C) => {
                  S.current = C.pointerType;
                }),
                onPointerMove: X(l.onPointerMove, (C) => {
                  S.current = C.pointerType, a ? d.onItemLeave?.() : S.current === "mouse" && C.currentTarget.focus({ preventScroll: !0 });
                }),
                onPointerLeave: X(l.onPointerLeave, (C) => {
                  C.currentTarget === document.activeElement && d.onItemLeave?.();
                }),
                onKeyDown: X(l.onKeyDown, (C) => {
                  a || C.target !== C.currentTarget || d.searchRef?.current !== "" && C.key === " " || (rg.includes(C.key) && w(), C.key === " " && C.preventDefault());
                })
              }
            )
          }
        )
      }
    );
  }, "SelectItem")
), An = "SelectItemText", Tg = /* @__PURE__ */ f.forwardRef(
  /* @__PURE__ */ te(function(n, r) {
    const { __scopeSelect: o, className: s, style: a, ...i } = n, l = xt(An, o), u = Ot(An, o), d = hl(An, o), p = ig(An, o), [c, h] = f.useState(null), g = Fe(
      (w) => u.itemTextRefCallback?.(w, d.value, d.disabled)
    ), y = oe(
      r,
      h,
      d.onItemTextChange,
      g
    ), b = c?.textContent, v = f.useMemo(
      () => /* @__PURE__ */ m("option", { value: d.value, disabled: d.disabled, children: b }, d.value),
      [d.disabled, d.value, b]
    ), { onNativeOptionAdd: x, onNativeOptionRemove: S } = p;
    return ue(() => (x(v), () => S(v)), [x, S, v]), /* @__PURE__ */ D(Qe, { children: [
      /* @__PURE__ */ m(Q.span, { id: d.textId, ...i, ref: y }),
      d.isSelected && l.valueNode && !l.valueNodeHasChildren && !xn(l.value) ? hn.createPortal(i.children, l.valueNode) : null
    ] });
  }, "SelectItemText")
), _g = "SelectItemIndicator", Ig = /* @__PURE__ */ f.forwardRef(
  // blank line to reduce diff noise
  /* @__PURE__ */ te(function(n, r) {
    const { __scopeSelect: o, ...s } = n;
    return hl(_g, o).isSelected ? /* @__PURE__ */ m(Q.span, { "aria-hidden": !0, ...s, ref: r }) : null;
  }, "SelectItemIndicator")
), aa = "SelectScrollUpButton", Og = /* @__PURE__ */ f.forwardRef(/* @__PURE__ */ te(function(n, r) {
  const o = Ot(aa, n.__scopeSelect), s = Do(aa, n.__scopeSelect), [a, i] = f.useState(!1), l = oe(r, s.onScrollButtonChange);
  return ue(() => {
    if (o.viewport && o.isPositioned) {
      let u = function() {
        const p = d.scrollTop > 0;
        i(p);
      };
      te(u, "handleScroll");
      const d = o.viewport;
      return u(), d.addEventListener("scroll", u), () => d.removeEventListener("scroll", u);
    }
  }, [o.viewport, o.isPositioned]), a ? /* @__PURE__ */ m(
    vl,
    {
      ...n,
      ref: l,
      onAutoScroll: () => {
        const { viewport: u, selectedItem: d } = o;
        u && d && (u.scrollTop = u.scrollTop - d.offsetHeight);
      }
    }
  ) : null;
}, "SelectScrollUpButton")), ia = "SelectScrollDownButton", Ag = /* @__PURE__ */ f.forwardRef(/* @__PURE__ */ te(function(n, r) {
  const o = Ot(ia, n.__scopeSelect), s = Do(ia, n.__scopeSelect), [a, i] = f.useState(!1), l = oe(r, s.onScrollButtonChange);
  return ue(() => {
    if (o.viewport && o.isPositioned) {
      let u = function() {
        const p = d.scrollHeight - d.clientHeight, c = Math.ceil(d.scrollTop) < p;
        i(c);
      };
      te(u, "handleScroll");
      const d = o.viewport;
      return u(), d.addEventListener("scroll", u), () => d.removeEventListener("scroll", u);
    }
  }, [o.viewport, o.isPositioned]), a ? /* @__PURE__ */ m(
    vl,
    {
      ...n,
      ref: l,
      onAutoScroll: () => {
        const { viewport: u, selectedItem: d } = o;
        u && d && (u.scrollTop = u.scrollTop + d.offsetHeight);
      }
    }
  ) : null;
}, "SelectScrollDownButton")), vl = /* @__PURE__ */ f.forwardRef(/* @__PURE__ */ te(function(n, r) {
  const { __scopeSelect: o, onAutoScroll: s, ...a } = n, i = Ot("SelectScrollButton", o), l = f.useRef(null), u = cr(o), d = f.useCallback(() => {
    l.current !== null && (window.clearInterval(l.current), l.current = null);
  }, []);
  return f.useEffect(() => () => d(), [d]), ue(() => {
    u().find((c) => c.ref.current === document.activeElement)?.ref.current?.scrollIntoView({ block: "nearest" });
  }, [u]), /* @__PURE__ */ m(
    Q.div,
    {
      "aria-hidden": !0,
      ...a,
      ref: r,
      style: { flexShrink: 0, ...a.style },
      onPointerDown: X(a.onPointerDown, () => {
        l.current === null && (l.current = window.setInterval(s, 50));
      }),
      onPointerMove: X(a.onPointerMove, () => {
        i.onItemLeave?.(), l.current === null && (l.current = window.setInterval(s, 50));
      }),
      onPointerLeave: X(a.onPointerLeave, () => {
        d();
      })
    }
  );
}, "SelectScrollButtonImpl")), bl = /* @__PURE__ */ f.forwardRef(
  // blank line to reduce diff noise
  /* @__PURE__ */ te(function(n, r) {
    const { __scopeSelect: o, ...s } = n;
    return /* @__PURE__ */ m(Q.div, { "aria-hidden": !0, ...s, ref: r });
  }, "SelectSeparator")
), Dg = "SelectBubbleInput", Mg = /* @__PURE__ */ f.forwardRef(
  // blank line to reduce diff noise
  /* @__PURE__ */ te(function({ __scopeSelect: n, ...r }, o) {
    const s = xt(Dg, n), { value: a, onValueChange: i, required: l, disabled: u, name: d, autoComplete: p, form: c } = s, { nativeOptions: h, nativeSelectKey: g } = s, y = f.useRef(null), b = oe(o, y), v = a ?? "", x = ll(v), S = Array.from(h).some(
      (w) => (w.props.value ?? "") === ""
    );
    return f.useEffect(() => {
      const w = y.current;
      if (!w) return;
      const C = window.HTMLSelectElement.prototype, R = Object.getOwnPropertyDescriptor(
        C,
        "value"
      ).set;
      if (x !== v && R) {
        const E = new Event("change", { bubbles: !0 });
        R.call(w, v), w.dispatchEvent(E);
      }
    }, [x, v]), /* @__PURE__ */ D(
      Q.select,
      {
        "aria-hidden": !0,
        required: l,
        tabIndex: -1,
        name: d,
        autoComplete: p,
        disabled: u,
        form: c,
        onChange: (w) => i(w.target.value),
        ...r,
        style: { ...cl, ...r.style },
        ref: b,
        defaultValue: v,
        children: [
          xn(a) && !S ? /* @__PURE__ */ m("option", { value: "" }) : null,
          Array.from(h)
        ]
      },
      g
    );
  }, "SelectBubbleInput")
);
function yl(e) {
  return typeof e == "function";
}
te(yl, "isFunction");
function xn(e) {
  return e === "" || e === void 0;
}
te(xn, "shouldShowPlaceholder");
function Mo(e) {
  const n = Fe(e), r = f.useRef(""), o = f.useRef(0), s = f.useCallback(
    (i) => {
      const l = r.current + i;
      n(l), (/* @__PURE__ */ te((function u(d) {
        r.current = d, window.clearTimeout(o.current), d !== "" && (o.current = window.setTimeout(() => u(""), 1e3));
      }), "updateSearch"))(l);
    },
    [n]
  ), a = f.useCallback(() => {
    r.current = "", window.clearTimeout(o.current);
  }, []);
  return f.useEffect(() => () => window.clearTimeout(o.current), []), [r, s, a];
}
te(Mo, "useTypeaheadSearch");
function Lo(e, n, r) {
  const s = n.length > 1 && Array.from(n).every((d) => d === n[0]) ? n[0] : n, a = r ? e.indexOf(r) : -1;
  let i = xl(e, Math.max(a, 0));
  s.length === 1 && (i = i.filter((d) => d !== r));
  const u = i.find(
    (d) => d.textValue.toLowerCase().startsWith(s.toLowerCase())
  );
  return u !== r ? u : void 0;
}
te(Lo, "findNextItem");
function xl(e, n) {
  return e.map((r, o) => e[(n + o) % e.length]);
}
te(xl, "wrapArray");
const Lg = lg, hy = Ng, Fg = ug, wl = f.memo(
  f.forwardRef(
    ({ className: e, children: n, disabled: r, style: o, variant: s, size: a, ...i }, l) => /* @__PURE__ */ D(
      ul,
      {
        ref: l,
        disabled: r,
        style: o,
        className: O(Oi({ variant: s, size: a }), e),
        ...i,
        children: [
          n,
          /* @__PURE__ */ m(fg, { asChild: !0, children: /* @__PURE__ */ m(
            Xn,
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
wl.displayName = ul.displayName;
const Cl = f.memo(
  f.forwardRef(
    ({ className: e, children: n, position: r = "popper", width: o = "content", ...s }, a) => /* @__PURE__ */ m(gg, { children: /* @__PURE__ */ D(
      fl,
      {
        ref: a,
        position: r,
        className: O(
          "relative z-50 min-w-[8rem] overflow-hidden rounded-[calc(var(--radius,0.5rem)-2px)] border border-border bg-background text-foreground shadow-md",
          "data-[state=open]:animate-in data-[state=closed]:animate-out",
          "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
          "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
          "data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2",
          "data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
          r === "popper" && "data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1",
          e
        ),
        ...s,
        children: [
          /* @__PURE__ */ m(
            Cg,
            {
              className: O(
                "p-1",
                "p-1",
                r === "popper" && (o === "stretch" ? "h-[var(--radix-select-trigger-height)] w-[var(--radix-select-trigger-width)]" : "h-[var(--radix-select-trigger-height)] min-w-[var(--radix-select-trigger-width)]")
              ),
              children: n
            }
          ),
          /* @__PURE__ */ m(Og, { className: "flex cursor-default items-center justify-center py-2 text-foreground", children: /* @__PURE__ */ m(vd, { className: "h-5 w-5" }) }),
          /* @__PURE__ */ m(Ag, { className: "flex cursor-default items-center justify-center py-2 text-foreground", children: /* @__PURE__ */ m(Xn, { className: "h-5 w-5" }) })
        ]
      }
    ) })
  )
);
Cl.displayName = fl.displayName;
const $g = f.forwardRef(({ className: e, ...n }, r) => /* @__PURE__ */ m(
  pl,
  {
    ref: r,
    className: O("px-2 py-2 text-ui font-semibold text-foreground", e),
    ...n
  }
));
$g.displayName = pl.displayName;
const Sl = f.memo(
  f.forwardRef(({ className: e, children: n, size: r, ...o }, s) => /* @__PURE__ */ D(
    gl,
    {
      ref: s,
      className: O(
        Ai({
          size: r,
          indicator: "check",
          padding: "withIndicator"
        }),
        "text-foreground transition-colors",
        e
      ),
      ...o,
      children: [
        /* @__PURE__ */ m("span", { className: "absolute left-4 flex h-5 w-5 items-center justify-center", children: /* @__PURE__ */ m(Ig, { children: /* @__PURE__ */ m(Vn, { className: "h-4 w-4" }) }) }),
        /* @__PURE__ */ m(Tg, { children: n })
      ]
    }
  ))
);
Sl.displayName = gl.displayName;
const zg = f.forwardRef(({ className: e, ...n }, r) => /* @__PURE__ */ m(
  bl,
  {
    ref: r,
    className: O("-mx-1 my-1 h-px bg-border", e),
    ...n
  }
));
zg.displayName = bl.displayName;
const Bg = [
  { value: "ja", label: "日本語" },
  { value: "en", label: "English" }
], gy = P.memo(
  ({
    className: e = "",
    buttonClassName: n = "",
    id: r,
    align: o = "right",
    value: s,
    onValueChange: a,
    languages: i = Bg
  }) => {
    const { i18n: l } = xc(), u = (p) => {
      a ? a(p) : l.changeLanguage(p);
      const c = globalThis.log;
      c && typeof c.info == "function" && c.info("Language changed", { language: p });
    }, d = s ?? l.language ?? "ja";
    return /* @__PURE__ */ m("div", { className: O("relative", e), id: r, children: /* @__PURE__ */ D(Lg, { value: d, onValueChange: u, children: [
      /* @__PURE__ */ m(
        wl,
        {
          className: O("w-auto min-w-[100px]", n),
          children: /* @__PURE__ */ D("div", { className: "flex items-center gap-2", children: [
            /* @__PURE__ */ m(Pd, { className: "w-[var(--ui-icon-size)] h-[var(--ui-icon-size)]" }),
            /* @__PURE__ */ m(Fg, {})
          ] })
        }
      ),
      /* @__PURE__ */ m(Cl, { align: o === "left" ? "start" : "end", children: i.map((p) => /* @__PURE__ */ m(Sl, { value: p.value, children: p.label }, p.value)) })
    ] }) });
  }
);
function Vg(e, n) {
  if (e.length === 0 || n <= 0)
    return e.length || 1;
  let r = e.length;
  for (; r > 1; ) {
    const o = [];
    for (let a = 0; a < r; a++) {
      let i = 0;
      for (let l = a; l < e.length; l += r) {
        const u = e[l];
        u !== void 0 && u > i && (i = u);
      }
      o.push(i);
    }
    if (o.reduce((a, i) => a + i, 0) <= n)
      break;
    r--;
  }
  return r;
}
function jg(e, n) {
  if (n <= 0)
    return {
      lastRowStartIndex: 0,
      lastRowItemCount: e,
      isLastRowFull: !0
    };
  const r = Math.floor(e / n) * n, o = e - r;
  return { lastRowStartIndex: r, lastRowItemCount: o, isLastRowFull: o === n || o === 0 };
}
const vy = ({
  items: e = [],
  selectedId: n,
  onAction: r,
  className: o,
  stretchLastRow: s = !1,
  _testColumnCount: a
}) => {
  const i = f.useRef(null), l = f.useRef(null), [u, d] = f.useState(
    a ?? 0
  ), [p, c] = f.useState([]), [h, g] = f.useState(
    a !== void 0
  ), y = e?.filter((k) => !k.separator) || [], b = y.map((k) => k.label).join(","), v = a ?? u;
  f.useEffect(() => {
    if (h || a !== void 0) return;
    const T = setTimeout(() => {
      if (!l.current) return;
      const I = l.current.querySelectorAll(
        '[data-measure="true"]'
      );
      if (I.length === 0) return;
      const L = [];
      I.forEach((A) => {
        L.push(A.offsetWidth);
      }), c(L), g(!0);
    }, 0);
    return () => clearTimeout(T);
  }, [h, a]), f.useEffect(() => {
    if (p.length === 0 || a !== void 0) return;
    const k = () => {
      if (!i.current) return;
      const I = i.current.offsetWidth;
      if (I === 0) return;
      const L = Vg(p, I);
      d(L);
    };
    k();
    const T = new ResizeObserver(k);
    return i.current && T.observe(i.current), () => T.disconnect();
  }, [p, a]), f.useEffect(() => {
    a === void 0 && (g(!1), c([]), d(0));
  }, [b, a]);
  const x = (k) => {
    k.disabled || (k.onClick?.(), k.action && r && r(k.action));
  }, { lastRowStartIndex: S, isLastRowFull: w } = jg(
    y.length,
    v
  ), C = (k, T, I) => {
    const L = n && k.action === n;
    let A = "gap-ui justify-start text-ui rounded-none border-b border-r border-border h-auto py-ui px-ui whitespace-nowrap";
    L ? A += " bg-accent text-accent-foreground font-bold" : A += " text-muted-foreground hover:text-foreground hover:bg-muted";
    const _ = k.label.length > 16 ? k.label.slice(0, 16) : k.label;
    return /* @__PURE__ */ D(
      xe,
      {
        variant: "ghost",
        disabled: k.disabled,
        onClick: I ? void 0 : () => x(k),
        className: O(A),
        "data-measure": I ? "true" : void 0,
        children: [
          k.icon,
          /* @__PURE__ */ m(ln, { text: _ })
        ]
      },
      `${I ? "measure-" : ""}${k.label}-${T}`
    );
  }, N = v > 0 ? {
    gridTemplateColumns: `repeat(${v}, minmax(max-content, 1fr))`
  } : {}, R = s && !w ? y.slice(0, S) : y, E = s && !w ? y.slice(S) : [];
  return /* @__PURE__ */ D(Qe, { children: [
    !h && /* @__PURE__ */ m(
      "div",
      {
        ref: l,
        className: "absolute invisible flex flex-wrap",
        "aria-hidden": "true",
        "data-testid": "measure-container",
        children: y.map((k, T) => C(k, T, !0))
      }
    ),
    /* @__PURE__ */ D(
      "div",
      {
        ref: i,
        className: O(
          "grid items-center gap-0 border border-border rounded-lg overflow-hidden",
          o
        ),
        style: N,
        children: [
          R.map((k, T) => C(k, T, !1)),
          E.length > 0 && E.map((k, T) => {
            const I = S + T, L = n && k.action === n;
            let A = "gap-ui justify-start text-ui rounded-none border-b border-r border-border h-auto py-ui px-ui whitespace-nowrap";
            L ? A += " bg-accent text-accent-foreground font-bold" : A += " text-muted-foreground hover:text-foreground hover:bg-muted";
            const M = {
              gridColumn: `span ${Math.ceil(
                v / E.length
              )}`
            }, U = k.label.length > 16 ? k.label.slice(0, 16) : k.label;
            return /* @__PURE__ */ D(
              xe,
              {
                variant: "ghost",
                disabled: k.disabled,
                onClick: () => x(k),
                className: O(A),
                style: M,
                children: [
                  k.icon,
                  /* @__PURE__ */ m(ln, { text: U })
                ]
              },
              `${k.label}-${I}`
            );
          })
        ]
      }
    )
  ] });
}, by = ({
  columns: e,
  rows: n,
  dense: r = !1,
  size: o = "sm",
  headerBg: s,
  hideHeader: a = !1
}) => {
  const i = "px-[var(--ui-component-padding-x)] py-[var(--ui-component-padding-y)]", l = "text-ui", u = "text-ui", d = i;
  return /* @__PURE__ */ m("div", { className: "overflow-hidden rounded border border-border bg-card m-0", children: /* @__PURE__ */ D(
    "div",
    {
      className: "grid",
      style: {
        gridTemplateColumns: e.map((p) => p.width || "1fr").join(" ")
      },
      children: [
        !a && e.map((p) => /* @__PURE__ */ m(
          "div",
          {
            className: `${l} font-semibold uppercase tracking-wide text-muted-foreground border-b border-border ${s || ""} ${i}`,
            style: { textAlign: p.align || "left" },
            children: p.label
          },
          p.key
        )),
        n.map(
          (p) => e.map((c) => /* @__PURE__ */ m(
            "div",
            {
              className: `${u} text-foreground border-b border-border/60 last:border-b-0 ${d}`,
              style: { textAlign: c.align || "left" },
              children: p.cells[c.key]
            },
            `${p.key}-${c.key}`
          ))
        )
      ]
    }
  ) });
}, Hg = (e, n, r) => Math.min(Math.max(e, n), r), yy = P.memo(
  ({
    steps: e,
    activeStep: n,
    onStepChange: r,
    renderStepContent: o,
    orientation: s = "horizontal",
    variant: a = "split",
    compactOnMobile: i = !0,
    inlineContentOnVerticalMobile: l = !0,
    className: u
  }) => {
    const d = Hg(n, 0, Math.max(e.length - 1, 0)), p = (b) => b < d ? "completed" : b === d ? "current" : "upcoming", c = (b, v) => O("h-[var(--ui-step-circle-size)] w-[var(--ui-step-circle-size)] rounded-full border-2 flex items-center justify-center text-xs font-semibold flex-shrink-0 transition-colors", b === "completed" ? "bg-success border-success text-primary-foreground" : b === "current" ? "bg-primary border-primary text-primary-foreground" : "bg-background border-border text-muted-foreground", r ? "cursor-pointer hover:brightness-110" : "", v ? "opacity-50 cursor-not-allowed hover:brightness-100" : ""), h = (b, v, x) => r ? /* @__PURE__ */ m(
      "button",
      {
        type: "button",
        onClick: () => {
          x || r(b);
        },
        disabled: x,
        "aria-current": b === d ? "step" : void 0,
        children: v
      }
    ) : /* @__PURE__ */ m("div", { className: O(x ? "pointer-events-none" : ""), children: v });
    if (e.length === 0)
      return null;
    if (s === "vertical") {
      const b = e[d], v = a === "accordion";
      return /* @__PURE__ */ m("nav", { "aria-label": "Progress", className: O("w-full", u), children: /* @__PURE__ */ D(
        "div",
        {
          className: O(
            "grid gap-3",
            v ? "grid-cols-1" : "grid-cols-1 sm:grid-cols-[192px_1fr]"
          ),
          children: [
            /* @__PURE__ */ m("ol", { className: "flex flex-col", children: e.map((x, S) => {
              const w = p(S), C = S === e.length - 1, N = S === d;
              return /* @__PURE__ */ D("li", { className: "flex flex-col", children: [
                /* @__PURE__ */ D("div", { className: "flex items-start gap-2", children: [
                  /* @__PURE__ */ D("div", { className: "flex flex-col items-center", children: [
                    h(
                      S,
                      /* @__PURE__ */ m("div", { className: c(w, x.disabled), children: w === "completed" ? /* @__PURE__ */ m(Vn, { className: "h-4 w-4" }) : S + 1 }),
                      x.disabled
                    ),
                    !C && /* @__PURE__ */ m(
                      "div",
                      {
                        className: O(
                          "w-0.5 flex-1 mt-2",
                          w === "completed" ? "bg-success" : "bg-border"
                        ),
                        style: {
                          minHeight: v && N ? 32 : 16
                        }
                      }
                    )
                  ] }),
                  /* @__PURE__ */ D("div", { className: "min-w-0 pb-3 flex-1", children: [
                    /* @__PURE__ */ D("div", { className: "flex items-center gap-2", children: [
                      /* @__PURE__ */ m(
                        "div",
                        {
                          className: O(
                            "text-sm font-semibold",
                            x.disabled ? "text-muted-foreground/50" : w === "current" ? "text-foreground" : "text-muted-foreground"
                          ),
                          children: x.title
                        }
                      ),
                      w === "current" && /* @__PURE__ */ m("span", { className: "text-xs px-2 py-0.5 rounded bg-card text-muted-foreground", children: "Current" })
                    ] }),
                    x.description && /* @__PURE__ */ m("div", { className: "text-xs text-muted-foreground mt-0.5", children: x.description })
                  ] })
                ] }),
                (l || v) && N && o && /* @__PURE__ */ m(
                  "div",
                  {
                    className: O(
                      "w-full pb-8 pl-9",
                      // Indent content in accordion
                      !v && "sm:hidden"
                    ),
                    children: /* @__PURE__ */ m("div", { className: "w-full", children: o(x, S) })
                  }
                )
              ] }, x.id);
            }) }),
            !v && o && b && /* @__PURE__ */ m("div", { className: "hidden sm:block", children: /* @__PURE__ */ m("div", { className: "rounded-lg border border-border bg-background p-1", children: o(b, d) }) })
          ]
        }
      ) });
    }
    const g = e[d], y = g?.title;
    return /* @__PURE__ */ m("nav", { "aria-label": "Progress", className: O("w-full", u), children: /* @__PURE__ */ D("div", { className: "flex flex-col gap-3", children: [
      i && /* @__PURE__ */ D(
        "div",
        {
          className: "text-sm text-muted-foreground sm:hidden",
          "aria-live": "polite",
          children: [
            d + 1,
            " / ",
            e.length,
            y ? ` - ${y}` : ""
          ]
        }
      ),
      /* @__PURE__ */ m(
        "ol",
        {
          className: O(
            "flex items-center gap-2 overflow-x-auto pb-1",
            i && "sm:overflow-visible"
          ),
          children: e.map((b, v) => {
            const x = p(v), S = v === e.length - 1, w = v === d;
            return /* @__PURE__ */ D(P.Fragment, { children: [
              /* @__PURE__ */ D(
                "li",
                {
                  className: O(
                    "flex flex-col items-center flex-shrink-0",
                    i ? "min-w-[40px] sm:min-w-[120px]" : "min-w-[120px]"
                  ),
                  children: [
                    h(
                      v,
                      /* @__PURE__ */ m("div", { className: c(x, b.disabled), children: x === "completed" ? /* @__PURE__ */ m(Vn, { className: "h-4 w-4" }) : v + 1 }),
                      b.disabled
                    ),
                    /* @__PURE__ */ D(
                      "div",
                      {
                        className: O(
                          "mt-2 text-center min-w-0",
                          i ? w ? "sm:block" : "hidden sm:block" : "block"
                        ),
                        children: [
                          /* @__PURE__ */ m(
                            "div",
                            {
                              className: O(
                                "text-xs font-semibold truncate",
                                b.disabled ? "text-muted-foreground/50" : x === "current" ? "text-foreground" : x === "completed" ? "text-muted-foreground" : "text-muted-foreground/50"
                              ),
                              title: b.title,
                              children: b.title
                            }
                          ),
                          b.description && /* @__PURE__ */ m(
                            "div",
                            {
                              className: "hidden sm:block text-xs text-muted-foreground truncate",
                              title: b.description,
                              children: b.description
                            }
                          )
                        ]
                      }
                    )
                  ]
                }
              ),
              !S && /* @__PURE__ */ m(
                "div",
                {
                  className: O(
                    "h-0.5 flex-shrink-0",
                    x === "completed" ? "bg-success" : "bg-border",
                    i ? "w-8 min-w-8 sm:w-16" : "w-16 min-w-16"
                  ),
                  "aria-hidden": "true"
                }
              )
            ] }, b.id);
          })
        }
      ),
      o && g && /* @__PURE__ */ m("div", { className: "rounded-lg border border-border bg-background p-1", children: o(g, d) })
    ] }) });
  }
), Wg = {
  info: "border-l-info",
  success: "border-l-success",
  warning: "border-l-warning",
  error: "border-l-destructive"
}, Ug = {
  info: _d,
  success: Cd,
  warning: Xd,
  error: Na
}, Gg = {
  info: "text-info",
  success: "text-success",
  warning: "text-warning",
  error: "text-destructive"
}, Kg = f.memo(
  ({
    type: e,
    title: n,
    message: r,
    linkLabel: o,
    onClickLink: s,
    onClose: a,
    showCloseButton: i = !0,
    className: l,
    ...u
  }) => {
    const d = (g, y) => y ?? g, p = Wg[e], c = typeof s == "function", h = Ug[e];
    return /* @__PURE__ */ D(
      "div",
      {
        className: O(
          "relative w-full max-w-sm bg-background shadow-md rounded-lg border border-border border-l-4",
          "pr-[calc(var(--ui-component-padding-x)+5px)] pl-1 py-[calc(var(--ui-component-padding-y)+5px)]",
          p,
          c ? "hover:shadow-lg" : void 0,
          l
        ),
        role: "alert",
        "aria-live": "polite",
        "aria-atomic": "true",
        ...u,
        children: [
          /* @__PURE__ */ D("div", { className: "flex items-start gap-[var(--ui-gap-base)]", children: [
            /* @__PURE__ */ m(
              "div",
              {
                className: O("shrink-0", Gg[e]),
                "aria-hidden": "true",
                children: /* @__PURE__ */ m(h, { className: "h-4 w-4" })
              }
            ),
            /* @__PURE__ */ m("div", { className: "flex-1 min-w-0", children: c ? /* @__PURE__ */ m(
              "button",
              {
                type: "button",
                className: "w-full text-left",
                onClick: s,
                "aria-label": o ? `${n}. ${o}` : n,
                children: /* @__PURE__ */ D("div", { className: "min-w-0", children: [
                  /* @__PURE__ */ m("h4", { className: "text-sm font-bold text-foreground truncate leading-tight", children: n }),
                  /* @__PURE__ */ m("p", { className: "text-xs text-muted-foreground break-words leading-tight", children: r }),
                  /* @__PURE__ */ D("div", { className: "text-xs text-accent-foreground flex items-center gap-1 leading-tight", children: [
                    /* @__PURE__ */ m(cd, { className: "h-3 w-3" }),
                    /* @__PURE__ */ m("span", { children: o || d("details", "詳細を見る") })
                  ] })
                ] })
              }
            ) : /* @__PURE__ */ D("div", { className: "min-w-0", children: [
              /* @__PURE__ */ m("h4", { className: "text-sm font-bold text-foreground truncate leading-tight", children: n }),
              /* @__PURE__ */ m("p", { className: "text-xs text-muted-foreground break-words leading-tight", children: r })
            ] }) })
          ] }),
          i && /* @__PURE__ */ m(
            "button",
            {
              type: "button",
              onClick: (g) => {
                g.stopPropagation(), a?.();
              },
              className: "absolute top-[5px] right-[5px] flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors p-1",
              "aria-label": d("close", "Close"),
              children: /* @__PURE__ */ m(Xt, { className: "h-3 w-3" })
            }
          )
        ]
      }
    );
  }
);
Kg.displayName = "NotificationToast";
const Fo = "-", Yg = () => {
  if (typeof document > "u") return;
  const e = document.documentElement.getAttribute(
    "data-number-format-locale"
  );
  return e?.trim() ? e : void 0;
}, $o = (e) => {
  if (e) return e;
  const n = Yg();
  return n || (typeof Intl < "u" && Intl.NumberFormat ? new Intl.NumberFormat().resolvedOptions().locale : "en-US");
}, zo = (e, n, r, o) => {
  try {
    return new Intl.NumberFormat(n, r).format(e);
  } catch {
    try {
      return new Intl.NumberFormat("en-US", r).format(e);
    } catch {
      return o ?? String(e);
    }
  }
}, xy = ({
  value: e,
  className: n,
  locale: r,
  options: o,
  fallback: s = Fo
}) => {
  if (e == null || !Number.isFinite(e))
    return /* @__PURE__ */ m("span", { className: n, children: s });
  const a = $o(r), i = zo(e, a, o, s);
  return /* @__PURE__ */ m("span", { className: n, children: i });
}, wy = ({
  value: e,
  className: n,
  locale: r,
  options: o,
  fallback: s = Fo,
  currency: a
}) => {
  if (e == null || !Number.isFinite(e))
    return /* @__PURE__ */ m("span", { className: n, children: s });
  const i = $o(r), l = {
    ...o,
    style: "currency",
    currency: a
  }, u = zo(
    e,
    i,
    l,
    s
  );
  return /* @__PURE__ */ m("span", { className: n, children: u });
}, Xg = ({
  value: e,
  className: n,
  locale: r,
  options: o,
  fallback: s = Fo,
  valueScale: a = "ratio"
}) => {
  if (e == null || !Number.isFinite(e))
    return /* @__PURE__ */ m("span", { className: n, children: s });
  const i = $o(r), l = a === "percent" ? e / 100 : e, d = {
    maximumFractionDigits: o?.maximumFractionDigits ?? o?.minimumFractionDigits ?? 1,
    ...o,
    style: "percent"
  }, p = zo(
    l,
    i,
    d,
    s
  );
  return /* @__PURE__ */ m("span", { className: n, children: p });
};
function Cy(e) {
  const { options: n, columns: r = 2, className: o = "" } = e, s = {
    1: "grid-cols-1",
    2: "grid-cols-2",
    3: "grid-cols-3",
    4: "grid-cols-4"
  }[r], a = (l) => {
    e.multiple || e.onChange(l);
  }, i = (l) => {
    if (!e.multiple) return;
    const u = e.value, d = u.includes(l) ? u.filter((p) => p !== l) : [...u, l];
    e.onChange(d);
  };
  return /* @__PURE__ */ D("div", { className: `grid ${s} gap-2 ${o}`, children: [
    !e.multiple && e.allowNull && /* @__PURE__ */ m(
      xe,
      {
        type: "button",
        variant: e.value === null ? "option-active" : "option",
        onClick: () => a(null),
        className: "justify-start min-h-[44px] text-left",
        children: /* @__PURE__ */ m("div", { className: "font-medium text-foreground", children: e.nullLabel || "自動" })
      }
    ),
    n.map((l) => {
      const u = e.multiple ? e.value.includes(l.value) : e.value === l.value;
      return /* @__PURE__ */ m(
        xe,
        {
          type: "button",
          variant: u ? "option-active" : "option",
          onClick: () => e.multiple ? i(l.value) : a(l.value),
          className: "justify-start min-h-[44px] text-left",
          children: l.description ? /* @__PURE__ */ D("div", { children: [
            /* @__PURE__ */ m("div", { className: "font-medium text-foreground", children: l.label }),
            /* @__PURE__ */ m("div", { className: "text-xs text-muted-foreground mt-1", children: l.description })
          ] }) : /* @__PURE__ */ m("div", { className: "font-medium text-foreground", children: l.label })
        },
        l.value
      );
    })
  ] });
}
const Sy = P.memo(
  ({
    currentPage: e,
    totalPages: n,
    onPrevPage: r,
    onNextPage: o,
    prevLabel: s = "Previous page",
    nextLabel: a = "Next page",
    prevContent: i = /* @__PURE__ */ m(Mr, { className: "h-4 w-4" }),
    nextContent: l = /* @__PURE__ */ m(Lr, { className: "h-4 w-4" }),
    pageInfoFormatter: u,
    className: d
  }) => {
    if (n <= 1)
      return null;
    const p = e <= 1, c = e >= n, h = u?.(e, n) ?? `${e} / ${n}`, g = () => {
      p || r();
    }, y = () => {
      c || o();
    };
    return /* @__PURE__ */ D("div", { className: O("flex flex-wrap items-center gap-2", d), children: [
      /* @__PURE__ */ m(
        xe,
        {
          type: "button",
          variant: "outline",
          size: "icon",
          onClick: g,
          disabled: p,
          "aria-label": s,
          children: i
        }
      ),
      /* @__PURE__ */ m(
        "span",
        {
          className: "text-ui text-foreground font-medium whitespace-nowrap",
          "aria-live": "polite",
          children: h
        }
      ),
      /* @__PURE__ */ m(
        xe,
        {
          type: "button",
          variant: "outline",
          size: "icon",
          onClick: y,
          disabled: c,
          "aria-label": a,
          children: l
        }
      )
    ] });
  }
);
var qg = Object.defineProperty, wt = (e, n) => qg(e, "name", { value: n, configurable: !0 }), Bo = "Popover", [kl, ky] = /* @__PURE__ */ Ie(Bo, [
  en
]), Vo = en(), [Zg, tn] = kl(Bo), Qg = /* @__PURE__ */ wt((e) => {
  const {
    __scopePopover: n,
    children: r,
    open: o,
    defaultOpen: s,
    onOpenChange: a,
    modal: i = !1
  } = e, l = Vo(n), u = f.useRef(null), [d, p] = f.useState(!1), [c, h] = Xe({
    prop: o,
    defaultProp: s ?? !1,
    onChange: a,
    caller: Bo
  });
  return /* @__PURE__ */ m(_o, { ...l, children: /* @__PURE__ */ m(
    Zg,
    {
      scope: n,
      contentId: Me(),
      triggerRef: u,
      open: c,
      onOpenChange: h,
      onOpenToggle: f.useCallback(() => h((g) => !g), [h]),
      hasCustomAnchor: d,
      onCustomAnchorAdd: f.useCallback(() => p(!0), []),
      onCustomAnchorRemove: f.useCallback(() => p(!1), []),
      modal: i,
      children: r
    }
  ) });
}, "Popover"), Jg = "PopoverTrigger", ev = /* @__PURE__ */ f.forwardRef(
  /* @__PURE__ */ wt(function(n, r) {
    const { __scopePopover: o, ...s } = n, a = tn(Jg, o), i = Vo(o), l = oe(r, a.triggerRef), u = /* @__PURE__ */ m(
      Q.button,
      {
        type: "button",
        "aria-haspopup": "dialog",
        "aria-expanded": a.open,
        "aria-controls": a.open ? a.contentId : void 0,
        "data-state": jo(a.open),
        ...s,
        ref: l,
        onClick: X(n.onClick, a.onOpenToggle)
      }
    );
    return a.hasCustomAnchor ? u : /* @__PURE__ */ m(Io, { asChild: !0, ...i, children: u });
  }, "PopoverTrigger")
), El = "PopoverPortal", [tv, nv] = kl(El, {
  forceMount: void 0
}), rv = /* @__PURE__ */ wt((e) => {
  const { __scopePopover: n, forceMount: r, children: o, container: s } = e, a = tn(El, n);
  return /* @__PURE__ */ m(tv, { scope: n, forceMount: r, children: /* @__PURE__ */ m(ct, { present: r || a.open, children: /* @__PURE__ */ m(uo, { asChild: !0, container: s, children: o }) }) });
}, "PopoverPortal"), fn = "PopoverContent", ov = /* @__PURE__ */ f.forwardRef(
  // blank line to reduce diff noise
  /* @__PURE__ */ wt(function(n, r) {
    const o = nv(fn, n.__scopePopover), { forceMount: s = o.forceMount, ...a } = n, i = tn(fn, n.__scopePopover);
    return /* @__PURE__ */ m(ct, { present: s || i.open, children: i.modal ? /* @__PURE__ */ m(av, { ...a, ref: r }) : /* @__PURE__ */ m(iv, { ...a, ref: r }) });
  }, "PopoverContent")
), sv = /* @__PURE__ */ Ye("PopoverContent.RemoveScroll"), av = /* @__PURE__ */ f.forwardRef(
  // blank line to reduce diff noise
  /* @__PURE__ */ wt(function(n, r) {
    const o = tn(fn, n.__scopePopover), s = f.useRef(null), a = oe(r, s), i = f.useRef(!1);
    return f.useEffect(() => {
      const l = s.current;
      if (l) return mo(l);
    }, []), /* @__PURE__ */ m(Qn, { as: sv, allowPinchZoom: !0, children: /* @__PURE__ */ m(
      Nl,
      {
        ...n,
        ref: a,
        trapFocus: o.open,
        disableOutsidePointerEvents: !0,
        onCloseAutoFocus: X(n.onCloseAutoFocus, (l) => {
          l.preventDefault(), i.current || o.triggerRef.current?.focus();
        }),
        onPointerDownOutside: X(
          n.onPointerDownOutside,
          (l) => {
            const u = l.detail.originalEvent, d = u.button === 0 && u.ctrlKey === !0, p = u.button === 2 || d;
            i.current = p;
          },
          { checkForDefaultPrevented: !1 }
        ),
        onFocusOutside: X(
          n.onFocusOutside,
          (l) => l.preventDefault(),
          { checkForDefaultPrevented: !1 }
        )
      }
    ) });
  }, "PopoverContentModal")
), iv = /* @__PURE__ */ f.forwardRef(
  // blank line to reduce diff noise
  /* @__PURE__ */ wt(function(n, r) {
    const o = tn(fn, n.__scopePopover), s = f.useRef(!1), a = f.useRef(!1);
    return /* @__PURE__ */ m(
      Nl,
      {
        ...n,
        ref: r,
        trapFocus: !1,
        disableOutsidePointerEvents: !1,
        onCloseAutoFocus: (i) => {
          n.onCloseAutoFocus?.(i), i.defaultPrevented || (s.current || o.triggerRef.current?.focus(), i.preventDefault()), s.current = !1, a.current = !1;
        },
        onInteractOutside: (i) => {
          n.onInteractOutside?.(i), i.defaultPrevented || (s.current = !0, i.detail.originalEvent.type === "pointerdown" && (a.current = !0));
          const l = i.target;
          o.triggerRef.current?.contains(l) && i.preventDefault(), i.detail.originalEvent.type === "focusin" && a.current && i.preventDefault();
        }
      }
    );
  }, "PopoverContentNonModal")
), Nl = /* @__PURE__ */ f.forwardRef(
  // blank line to reduce diff noise
  /* @__PURE__ */ wt(function(n, r) {
    const {
      __scopePopover: o,
      trapFocus: s,
      onOpenAutoFocus: a,
      onCloseAutoFocus: i,
      disableOutsidePointerEvents: l,
      onEscapeKeyDown: u,
      onPointerDownOutside: d,
      onFocusOutside: p,
      onInteractOutside: c,
      ...h
    } = n, g = tn(fn, o), y = Vo(o);
    return vn(), /* @__PURE__ */ m(
      lo,
      {
        asChild: !0,
        loop: !0,
        trapped: s,
        onMountAutoFocus: a,
        onUnmountAutoFocus: i,
        children: /* @__PURE__ */ m(
          qn,
          {
            asChild: !0,
            disableOutsidePointerEvents: l,
            onInteractOutside: c,
            onEscapeKeyDown: u,
            onPointerDownOutside: d,
            onFocusOutside: p,
            onDismiss: () => g.onOpenChange(!1),
            deferPointerDownOutside: !0,
            children: /* @__PURE__ */ m(
              Oo,
              {
                "data-state": jo(g.open),
                role: "dialog",
                id: g.contentId,
                ...y,
                ...h,
                ref: r,
                style: {
                  ...h.style,
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
function jo(e) {
  return e ? "open" : "closed";
}
wt(jo, "getState");
var lv = Qg, cv = ev, dv = rv, Rl = ov;
const Ey = lv, Ny = cv, uv = f.forwardRef(({ className: e, align: n = "center", sideOffset: r = 4, ...o }, s) => /* @__PURE__ */ m(dv, { children: /* @__PURE__ */ m(
  Rl,
  {
    ref: s,
    align: n,
    sideOffset: r,
    className: O(
      "z-50 rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
      e
    ),
    ...o
  }
) }));
uv.displayName = Rl.displayName;
var fv = Object.defineProperty, ut = (e, n) => fv(e, "name", { value: n, configurable: !0 }), Pl = "Progress", Ho = 100, [mv, Ry] = /* @__PURE__ */ Ie(Pl), [pv, hv] = mv(Pl), gv = /* @__PURE__ */ f.forwardRef(
  // blank line to reduce diff noise
  /* @__PURE__ */ ut(function(n, r) {
    const {
      __scopeProgress: o,
      value: s = null,
      max: a,
      getValueLabel: i = Tl,
      ...l
    } = n;
    (a || a === 0) && !Jr(a) && console.error(_l(`${a}`, "Progress"));
    const u = Jr(a) ? a : Ho;
    s !== null && !eo(s, u) && console.error(Il(`${s}`, "Progress"));
    const d = eo(s, u) ? s : null, p = mn(d) ? i(d, u) : void 0;
    return /* @__PURE__ */ m(pv, { scope: o, value: d, max: u, children: /* @__PURE__ */ m(
      Q.div,
      {
        "aria-valuemax": u,
        "aria-valuemin": 0,
        "aria-valuenow": mn(d) ? d : void 0,
        "aria-valuetext": p,
        role: "progressbar",
        "data-state": Wo(d, u),
        "data-value": d ?? void 0,
        "data-max": u,
        ...l,
        ref: r
      }
    ) });
  }, "Progress")
), vv = "ProgressIndicator", bv = /* @__PURE__ */ f.forwardRef(
  // blank line to reduce diff noise
  /* @__PURE__ */ ut(function(n, r) {
    const { __scopeProgress: o, ...s } = n, a = hv(vv, o);
    return /* @__PURE__ */ m(
      Q.div,
      {
        "data-state": Wo(a.value, a.max),
        "data-value": a.value ?? void 0,
        "data-max": a.max,
        ...s,
        ref: r
      }
    );
  }, "ProgressIndicator")
);
function Tl(e, n) {
  return `${Math.round(e / n * 100)}%`;
}
ut(Tl, "defaultGetValueLabel");
function Wo(e, n) {
  return e == null ? "indeterminate" : e === n ? "complete" : "loading";
}
ut(Wo, "getProgressState");
function mn(e) {
  return typeof e == "number";
}
ut(mn, "isNumber");
function Jr(e) {
  return mn(e) && !isNaN(e) && e > 0;
}
ut(Jr, "isValidMaxNumber");
function eo(e, n) {
  return mn(e) && !isNaN(e) && e <= n && e >= 0;
}
ut(eo, "isValidValueNumber");
function _l(e, n) {
  return `Invalid prop \`max\` of value \`${e}\` supplied to \`${n}\`. Only numbers greater than 0 are valid max values. Defaulting to \`${Ho}\`.`;
}
ut(_l, "getInvalidMaxError");
function Il(e, n) {
  return `Invalid prop \`value\` of value \`${e}\` supplied to \`${n}\`. The \`value\` prop must be:
  - a positive number
  - less than the value passed to \`max\` (or ${Ho} if no \`max\` prop is set)
  - \`null\` or \`undefined\` if the progress is indeterminate.

Defaulting to \`null\`.`;
}
ut(Il, "getInvalidValueError");
var Ol = gv, yv = bv;
const xv = f.forwardRef(
  ({
    className: e,
    value: n,
    label: r,
    subLabel: o,
    height: s = "h-[var(--ui-progress-height)]",
    color: a,
    striped: i = !0,
    animated: l = !0,
    status: u = "normal",
    ...d
  }, p) => {
    const c = Math.min(Math.max(n || 0, 0), 100), h = (v, x, S) => `rgb(${v.map((C, N) => {
      const R = x[N] || 0;
      return Math.round(C + (R - C) * S);
    }).join(",")})`, g = () => {
      if (a) return { className: a };
      if (u === "paused") return { className: "bg-yellow-500" };
      if (u === "error") return { className: "bg-red-800" };
      const v = [4, 120, 87], x = [37, 99, 235], S = [34, 211, 238];
      let w = "";
      return c <= 50 ? w = h(v, x, c / 50) : w = h(
        x,
        S,
        (c - 50) / 50
      ), { style: { backgroundColor: w } };
    }, { className: y, style: b } = g();
    return /* @__PURE__ */ D("div", { className: "w-full", children: [
      (r || o) && /* @__PURE__ */ D("div", { className: "flex justify-between mb-1 text-sm", children: [
        /* @__PURE__ */ m("div", { className: "font-medium text-foreground", children: r }),
        /* @__PURE__ */ m("div", { className: "text-muted-foreground", children: o })
      ] }),
      /* @__PURE__ */ m(
        Ol,
        {
          ref: p,
          className: O(
            "relative w-full overflow-hidden rounded-full bg-card",
            s,
            e
          ),
          value: n,
          ...d,
          children: /* @__PURE__ */ m(
            yv,
            {
              className: O(
                "h-full w-full flex-1 transition-all duration-500 ease-out flex items-center justify-end pr-2",
                y,
                i && "bg-[linear-gradient(45deg,rgba(255,255,255,0.15)_25%,transparent_25%,transparent_50%,rgba(255,255,255,0.15)_50%,rgba(255,255,255,0.15)_75%,transparent_75%,transparent)] bg-[length:1rem_1rem]",
                l && "animate-progress-stripes"
              ),
              style: {
                transform: `translateX(-${100 - c}%)`,
                ...b
              },
              children: s !== "h-1" && s !== "h-2" && /* @__PURE__ */ m(
                Xg,
                {
                  value: c,
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
xv.displayName = Ol.displayName;
const wv = f.memo(
  ({
    label: e,
    value: n,
    onChange: r,
    min: o = 0,
    max: s = 10,
    minLabel: a,
    maxLabel: i,
    className: l,
    disabled: u = !1
  }) => {
    const d = f.useMemo(() => {
      const p = [];
      for (let c = o; c <= s; c++)
        p.push(c);
      return p;
    }, [o, s]);
    return /* @__PURE__ */ D("div", { className: O("flex flex-col gap-2", l), children: [
      e && /* @__PURE__ */ m("span", { className: "text-sm font-medium text-muted-foreground", children: e }),
      /* @__PURE__ */ m("div", { className: "flex items-center gap-2 overflow-x-auto pb-2 scrollbar-thin scrollbar-thumb-theme-border scrollbar-track-transparent", children: d.map((p) => /* @__PURE__ */ m(
        "button",
        {
          onClick: () => !u && r(p),
          disabled: u,
          type: "button",
          className: O(
            "w-[var(--ui-component-height)] h-[var(--ui-component-height)] rounded-full flex-shrink-0 flex items-center justify-center font-bold transition-all border",
            n === p ? "bg-primary text-primary-foreground border-theme-object-primary shadow-md scale-110" : "bg-card text-muted-foreground border-border hover:bg-muted",
            u && "opacity-50 cursor-not-allowed hover:bg-card hover:scale-100"
          ),
          children: p
        },
        p
      )) }),
      (a || i) && /* @__PURE__ */ D("div", { className: "flex justify-between text-xs text-muted-foreground px-1 select-none", children: [
        /* @__PURE__ */ m("span", { children: a }),
        /* @__PURE__ */ m("span", { children: i })
      ] })
    ] });
  }
);
wv.displayName = "ScaleInput";
const Cv = f.memo(
  f.forwardRef(
    ({ className: e, children: n, ...r }, o) => /* @__PURE__ */ m(
      "div",
      {
        ref: o,
        className: O("relative overflow-auto", e),
        ...r,
        children: n
      }
    )
  )
);
Cv.displayName = "ScrollArea";
const Sv = f.forwardRef(
  ({
    options: e,
    value: n,
    onChange: r,
    placeholder: o,
    className: s,
    id: a,
    name: i,
    disabled: l = !1,
    required: u = !1,
    noResultsText: d = "No results"
  }, p) => {
    const c = f.useRef(null), h = f.useId(), g = f.useMemo(() => e.find((I) => I.value === n)?.label ?? "", [e, n]), [y, b] = f.useState(g), [v, x] = f.useState(!1), [S, w] = f.useState(-1), C = f.useRef(n), N = f.useRef(null);
    f.useEffect(() => {
      n !== C.current && (C.current = n, N.current = null, v || b(g));
    }, [v, g, n]), f.useEffect(() => {
      if (!v) {
        if (N.current) return;
        b(g);
      }
    }, [v, g]);
    const R = f.useMemo(() => {
      const I = y.trim().toLowerCase();
      return I ? e.filter((L) => {
        const A = L.label.toLowerCase(), _ = L.value.toLowerCase();
        return A.includes(I) || _.includes(I);
      }) : e;
    }, [e, y]);
    f.useEffect(() => {
      v && w(R.length ? 0 : -1);
    }, [v, R.length]), f.useEffect(() => {
      if (!v) return;
      const I = (L) => {
        const A = L.target;
        A && c.current && !c.current.contains(A) && x(!1);
      };
      return document.addEventListener("mousedown", I), () => document.removeEventListener("mousedown", I);
    }, [v]);
    const E = f.useCallback(
      (I) => {
        N.current = I.value, r?.(I.value), b(I.label), x(!1);
      },
      [r]
    ), k = () => {
      setTimeout(() => {
        c.current && (c.current.contains(document.activeElement) || x(!1));
      }, 0);
    }, T = (I) => {
      if (!l) {
        if (I.key === "ArrowDown") {
          I.preventDefault(), x(!0), w((L) => Math.min(L + 1, R.length - 1));
          return;
        }
        if (I.key === "ArrowUp") {
          I.preventDefault(), x(!0), w((L) => Math.max(L - 1, 0));
          return;
        }
        if (I.key === "Enter") {
          if (!v) return;
          I.preventDefault();
          const L = R[S];
          L && E(L);
          return;
        }
        if (I.key === "Escape") {
          if (!v) return;
          I.preventDefault(), x(!1);
          return;
        }
      }
    };
    return /* @__PURE__ */ D("div", { className: "relative", ref: c, children: [
      /* @__PURE__ */ m(
        Hn,
        {
          ref: p,
          id: a,
          name: i,
          disabled: l,
          required: u,
          value: y,
          placeholder: o,
          autoComplete: "off",
          "aria-label": o,
          role: "combobox",
          "aria-expanded": v,
          "aria-controls": h,
          "aria-autocomplete": "list",
          className: O(s),
          onFocus: () => !l && x(!0),
          onBlur: k,
          onKeyDown: T,
          onChange: (I) => {
            b(I.target.value), l || x(!0);
          }
        }
      ),
      v && /* @__PURE__ */ m(
        "div",
        {
          id: h,
          role: "listbox",
          className: O(
            "absolute z-50 mt-1 w-full overflow-auto rounded-md border border-border bg-background shadow-lg",
            "max-h-60"
          ),
          children: R.length === 0 ? /* @__PURE__ */ m("div", { className: "px-3 py-2 text-sm text-muted-foreground", children: d }) : R.map((I, L) => /* @__PURE__ */ m(
            "button",
            {
              type: "button",
              role: "option",
              "aria-selected": L === S,
              className: O(
                "w-full px-3 py-2 text-left text-sm text-foreground",
                "hover:bg-accent hover:text-accent-foreground focus:outline-none",
                L === S && "bg-accent text-accent-foreground"
              ),
              onMouseDown: (A) => A.preventDefault(),
              onMouseEnter: () => w(L),
              onClick: () => E(I),
              children: I.label
            },
            I.value
          ))
        }
      )
    ] });
  }
);
Sv.displayName = "SearchableSelect";
const Py = ({
  options: e,
  value: n,
  onChange: r,
  placeholder: o,
  className: s
}) => /* @__PURE__ */ D("div", { className: s, children: [
  /* @__PURE__ */ m(
    "select",
    {
      className: "mb-1 w-full rounded border border-border bg-background px-3 py-2 text-sm h-10 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
      value: n,
      onChange: (a) => r?.(a.target.value),
      children: e.map((a) => /* @__PURE__ */ m("option", { value: a.value, children: a.label }, a.value))
    }
  ),
  /* @__PURE__ */ m(
    "input",
    {
      type: "text",
      className: "w-full rounded border border-border bg-background px-3 py-2 text-sm h-10 placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
      placeholder: o
    }
  )
] });
var kv = Object.defineProperty, Al = (e, n) => kv(e, "name", { value: n, configurable: !0 }), la = "horizontal", Ev = ["horizontal", "vertical"], Nv = /* @__PURE__ */ f.forwardRef(
  /* @__PURE__ */ Al(function(n, r) {
    const { decorative: o, orientation: s = la, ...a } = n, i = Dl(s) ? s : la, u = o ? { role: "none" } : { "aria-orientation": i === "vertical" ? i : void 0, role: "separator" };
    return /* @__PURE__ */ m(
      Q.div,
      {
        "data-orientation": i,
        ...u,
        ...a,
        ref: r
      }
    );
  }, "Separator")
);
function Dl(e) {
  return Ev.includes(e);
}
Al(Dl, "isValidOrientation");
var Ml = Nv;
const Rv = f.forwardRef(
  ({ className: e, orientation: n = "horizontal", decorative: r = !0, ...o }, s) => /* @__PURE__ */ m(
    Ml,
    {
      ref: s,
      decorative: r,
      orientation: n,
      className: O(
        "shrink-0 bg-border",
        n === "horizontal" ? "h-[1px] w-full" : "h-full w-[1px]",
        e
      ),
      ...o
    }
  )
);
Rv.displayName = Ml.displayName;
const Pv = P.memo(
  P.forwardRef(
    ({ onSearch: e, className: n, ...r }, o) => /* @__PURE__ */ D("div", { className: "relative w-full", children: [
      /* @__PURE__ */ m(Ud, { className: "absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" }),
      /* @__PURE__ */ m(
        "input",
        {
          ref: o,
          type: "text",
          className: O(
            "flex h-11 w-full rounded-md border border-input bg-background pl-10 pr-3 py-2 text-base ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
            n
          ),
          placeholder: "Search...",
          onChange: (s) => e?.(s.target.value),
          ...r
        }
      )
    ] })
  )
);
Pv.displayName = "SimpleSearchInput";
var Tv = Object.defineProperty, vt = (e, n) => Tv(e, "name", { value: n, configurable: !0 }), Uo = "Switch", [_v, Ty] = /* @__PURE__ */ Ie(Uo), [Iv, Go] = _v(Uo);
function Ll(e) {
  const {
    __scopeSwitch: n,
    checked: r,
    children: o,
    defaultChecked: s,
    disabled: a,
    form: i,
    name: l,
    onCheckedChange: u,
    required: d,
    value: p = "on",
    // @ts-expect-error
    internal_do_not_use_render: c
  } = e, [h, g] = Xe({
    prop: r,
    defaultProp: s ?? !1,
    onChange: u,
    caller: Uo
  }), [y, b] = f.useState(null), [v, x] = f.useState(null), S = f.useRef(!1), [w, C] = f.useReducer(
    (E) => E + 1,
    0
  ), N = y ? !!i || !!y.closest("form") : (
    // We set this to true by default so that events bubble to forms without JS (SSR)
    !0
  ), R = {
    checked: h,
    setChecked: g,
    disabled: a,
    control: y,
    setControl: b,
    name: l,
    form: i,
    value: p,
    hasConsumerStoppedPropagationRef: S,
    userInteractionCount: w,
    onUserInteraction: C,
    required: d,
    defaultChecked: s,
    isFormControl: N,
    bubbleInput: v,
    setBubbleInput: x
  };
  return /* @__PURE__ */ m(Iv, { scope: n, ...R, children: $l(c) ? c(R) : o });
}
vt(Ll, "SwitchProvider");
var Ov = "SwitchTrigger", Av = /* @__PURE__ */ f.forwardRef(
  /* @__PURE__ */ vt(function({ __scopeSwitch: n, onClick: r, ...o }, s) {
    const {
      control: a,
      form: i,
      value: l,
      disabled: u,
      checked: d,
      required: p,
      setControl: c,
      setChecked: h,
      hasConsumerStoppedPropagationRef: g,
      onUserInteraction: y,
      isFormControl: b,
      bubbleInput: v
    } = Go(Ov, n), x = oe(s, c), S = f.useRef(d);
    return f.useEffect(() => {
      const w = i ? a?.ownerDocument.getElementById(i) : a?.form;
      if (w instanceof HTMLFormElement) {
        const C = /* @__PURE__ */ vt(() => h(S.current), "reset");
        return w.addEventListener("reset", C), () => w.removeEventListener("reset", C);
      }
    }, [a, i, h]), /* @__PURE__ */ m(
      Q.button,
      {
        type: "button",
        role: "switch",
        "aria-checked": d,
        "aria-required": p,
        "data-state": Ko(d),
        "data-disabled": u ? "" : void 0,
        disabled: u,
        value: l,
        ...o,
        ref: x,
        onClick: X(r, (w) => {
          y(), h((C) => !C), v && b && (g.current = w.isPropagationStopped(), g.current || w.stopPropagation());
        })
      }
    );
  }, "SwitchTrigger")
), Fl = /* @__PURE__ */ f.forwardRef(
  // blank line to reduce diff noise
  /* @__PURE__ */ vt(function(n, r) {
    const {
      __scopeSwitch: o,
      name: s,
      checked: a,
      defaultChecked: i,
      required: l,
      disabled: u,
      value: d,
      onCheckedChange: p,
      form: c,
      ...h
    } = n;
    return /* @__PURE__ */ m(
      Ll,
      {
        __scopeSwitch: o,
        checked: a,
        defaultChecked: i,
        disabled: u,
        required: l,
        onCheckedChange: p,
        name: s,
        form: c,
        value: d,
        internal_do_not_use_render: ({ isFormControl: g }) => /* @__PURE__ */ D(Qe, { children: [
          /* @__PURE__ */ m(
            Av,
            {
              ...h,
              ref: r,
              __scopeSwitch: o
            }
          ),
          g && /* @__PURE__ */ m(
            Fv,
            {
              __scopeSwitch: o
            }
          )
        ] })
      }
    );
  }, "Switch")
), Dv = "SwitchThumb", Mv = /* @__PURE__ */ f.forwardRef(
  /* @__PURE__ */ vt(function(n, r) {
    const { __scopeSwitch: o, ...s } = n, a = Go(Dv, o);
    return /* @__PURE__ */ m(
      Q.span,
      {
        "data-state": Ko(a.checked),
        "data-disabled": a.disabled ? "" : void 0,
        ...s,
        ref: r
      }
    );
  }, "SwitchThumb")
), Lv = "SwitchBubbleInput", Fv = /* @__PURE__ */ f.forwardRef(
  // blank line to reduce diff noise
  /* @__PURE__ */ vt(function({ __scopeSwitch: n, onClick: r, ...o }, s) {
    const {
      control: a,
      hasConsumerStoppedPropagationRef: i,
      userInteractionCount: l,
      checked: u,
      defaultChecked: d,
      required: p,
      disabled: c,
      name: h,
      value: g,
      form: y,
      bubbleInput: b,
      setBubbleInput: v
    } = Go(Lv, n), x = oe(s, v), S = To(a), w = f.useRef(!1), C = f.useRef(u), N = f.useRef(l);
    f.useEffect(() => {
      const E = b;
      if (!E) return;
      const k = window.HTMLInputElement.prototype, I = Object.getOwnPropertyDescriptor(
        k,
        "checked"
      ).set, L = l !== N.current;
      N.current = l;
      const A = C.current !== u;
      C.current = u;
      const _ = !(L && i.current);
      if (A && I) {
        w.current = !L;
        const M = new Event("click", { bubbles: _ });
        I.call(E, u), E.dispatchEvent(M), w.current = !1;
      }
    }, [b, u, i, l]);
    const R = f.useRef(u);
    return /* @__PURE__ */ m(
      Q.input,
      {
        type: "checkbox",
        "aria-hidden": !0,
        defaultChecked: d ?? R.current,
        required: p,
        disabled: c,
        name: h,
        value: g,
        form: y,
        ...o,
        tabIndex: -1,
        ref: x,
        onClick: X(r, (E) => {
          w.current && E.stopPropagation();
        }),
        style: {
          ...o.style,
          ...S,
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
function $l(e) {
  return typeof e == "function";
}
vt($l, "isFunction");
function Ko(e) {
  return e ? "checked" : "unchecked";
}
vt(Ko, "getState");
const $v = f.forwardRef(({ className: e, ...n }, r) => /* @__PURE__ */ m(
  Fl,
  {
    className: O(
      "peer inline-flex h-[var(--ui-switch-height)] w-[var(--ui-switch-width)] shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input",
      e
    ),
    ...n,
    ref: r,
    children: /* @__PURE__ */ m(
      Mv,
      {
        className: O(
          "pointer-events-none block h-[var(--ui-switch-thumb-size)] w-[var(--ui-switch-thumb-size)] rounded-full bg-background shadow-lg ring-0 transition-transform data-[state=checked]:translate-x-[var(--ui-switch-thumb-translate)] data-[state=unchecked]:translate-x-0"
        )
      }
    )
  }
));
$v.displayName = Fl.displayName;
var zv = Object.defineProperty, Yo = (e, n) => zv(e, "name", { value: n, configurable: !0 }), _r = !1;
function zl() {
  const [e, n] = f.useState(_r);
  return f.useEffect(() => {
    _r || (_r = !0, n(!0));
  }, []), e;
}
Yo(zl, "useIsHydrated");
var Bl = f[" useSyncExternalStore ".trim().toString()];
function Vl() {
  return () => {
  };
}
Yo(Vl, "subscribe");
function jl() {
  return Bl(
    Vl,
    () => !0,
    () => !1
  );
}
Yo(jl, "useIsHydratedModern");
var Bv = typeof Bl == "function" ? jl : zl, Vv = Object.defineProperty, At = (e, n) => Vv(e, "name", { value: n, configurable: !0 }), Ir = "rovingFocusGroup.onEntryFocus", jv = { bubbles: !1, cancelable: !0 }, dr = "RovingFocusGroup", [to, Hl, Hv] = /* @__PURE__ */ wo(dr), [Wv, Wl] = /* @__PURE__ */ Ie(
  dr,
  [Hv]
), [Uv, Gv] = Wv(dr), Kv = /* @__PURE__ */ f.forwardRef(
  // blank line to reduce diff noise
  /* @__PURE__ */ At(function(n, r) {
    return /* @__PURE__ */ m(to.Provider, { scope: n.__scopeRovingFocusGroup, children: /* @__PURE__ */ m(to.Slot, { scope: n.__scopeRovingFocusGroup, children: /* @__PURE__ */ m(Yv, { ...n, ref: r }) }) });
  }, "RovingFocusGroup")
), Yv = /* @__PURE__ */ f.forwardRef(/* @__PURE__ */ At(function(n, r) {
  const {
    __scopeRovingFocusGroup: o,
    orientation: s,
    loop: a = !1,
    dir: i,
    currentTabStopId: l,
    defaultCurrentTabStopId: u,
    onCurrentTabStopIdChange: d,
    onEntryFocus: p,
    preventScrollOnEntryFocus: c = !1,
    ...h
  } = n, g = f.useRef(null), y = oe(r, g), b = Yn(i), [v, x] = Xe({
    prop: l,
    defaultProp: u ?? null,
    onChange: d,
    caller: dr
  }), [S, w] = f.useState(!1), C = Fe(p), N = Hl(o), R = f.useRef(!1), [E, k] = f.useState(0);
  return f.useEffect(() => {
    const T = g.current;
    if (T)
      return T.addEventListener(Ir, C), () => T.removeEventListener(Ir, C);
  }, [C]), /* @__PURE__ */ m(
    Uv,
    {
      scope: o,
      orientation: s,
      dir: b,
      loop: a,
      currentTabStopId: v,
      onItemFocus: f.useCallback(
        (T) => x(T),
        [x]
      ),
      onItemShiftTab: f.useCallback(() => w(!0), []),
      onFocusableItemAdd: f.useCallback(
        () => k((T) => T + 1),
        []
      ),
      onFocusableItemRemove: f.useCallback(
        () => k((T) => T - 1),
        []
      ),
      children: /* @__PURE__ */ m(
        Q.div,
        {
          tabIndex: S || E === 0 ? -1 : 0,
          "data-orientation": s,
          ...h,
          ref: y,
          style: { outline: "none", ...n.style },
          onMouseDown: X(n.onMouseDown, () => {
            R.current = !0;
          }),
          onFocus: X(n.onFocus, (T) => {
            const I = !R.current;
            if (T.target === T.currentTarget && I && !S) {
              const L = new CustomEvent(Ir, jv);
              if (T.currentTarget.dispatchEvent(L), !L.defaultPrevented) {
                const A = N().filter((B) => B.focusable), _ = A.find((B) => B.active), M = A.find((B) => B.id === v), $ = [_, M, ...A].filter(
                  Boolean
                ).map((B) => B.ref.current);
                Xo($, c);
              }
            }
            R.current = !1;
          }),
          onBlur: X(n.onBlur, () => w(!1))
        }
      )
    }
  );
}, "RovingFocusGroupImpl")), Xv = "RovingFocusGroupItem", qv = /* @__PURE__ */ f.forwardRef(
  // blank line to reduce diff noise
  /* @__PURE__ */ At(function(n, r) {
    const {
      __scopeRovingFocusGroup: o,
      focusable: s = !0,
      active: a = !1,
      tabStopId: i,
      children: l,
      ...u
    } = n, d = Me(), p = i || d, c = Gv(Xv, o), h = c.currentTabStopId === p, g = Hl(o), { onFocusableItemAdd: y, onFocusableItemRemove: b, currentTabStopId: v } = c, x = Bv();
    return ue(() => {
      if (!(!x || !s))
        return y(), () => b();
    }, [x, s, y, b]), f.useEffect(() => {
      if (!(x || !s))
        return y(), () => b();
    }, [x, s, y, b]), /* @__PURE__ */ m(
      to.ItemSlot,
      {
        scope: o,
        id: p,
        focusable: s,
        active: a,
        children: /* @__PURE__ */ m(
          Q.span,
          {
            tabIndex: h ? 0 : -1,
            "data-orientation": c.orientation,
            ...u,
            ref: r,
            onMouseDown: X(n.onMouseDown, (S) => {
              s ? c.onItemFocus(p) : S.preventDefault();
            }),
            onFocus: X(n.onFocus, () => c.onItemFocus(p)),
            onKeyDown: X(n.onKeyDown, (S) => {
              if (S.key === "Tab" && S.shiftKey) {
                c.onItemShiftTab();
                return;
              }
              if (S.target !== S.currentTarget) return;
              const w = Gl(S, c.orientation, c.dir);
              if (w !== void 0) {
                if (S.metaKey || S.ctrlKey || S.altKey || S.shiftKey) return;
                S.preventDefault();
                let N = g().filter((R) => R.focusable).map((R) => R.ref.current);
                if (w === "last") N.reverse();
                else if (w === "prev" || w === "next") {
                  w === "prev" && N.reverse();
                  const R = N.indexOf(S.currentTarget);
                  N = c.loop ? Kl(N, R + 1) : N.slice(R + 1);
                }
                setTimeout(() => Xo(N));
              }
            }),
            children: typeof l == "function" ? l({ isCurrentTabStop: h, hasTabStop: v != null }) : l
          }
        )
      }
    );
  }, "RovingFocusGroupItem")
), Zv = {
  ArrowLeft: "prev",
  ArrowUp: "prev",
  ArrowRight: "next",
  ArrowDown: "next",
  PageUp: "first",
  Home: "first",
  PageDown: "last",
  End: "last"
};
function Ul(e, n) {
  return n !== "rtl" ? e : e === "ArrowLeft" ? "ArrowRight" : e === "ArrowRight" ? "ArrowLeft" : e;
}
At(Ul, "getDirectionAwareKey");
function Gl(e, n, r) {
  const o = Ul(e.key, r);
  if (!(n === "vertical" && ["ArrowLeft", "ArrowRight"].includes(o)) && !(n === "horizontal" && ["ArrowUp", "ArrowDown"].includes(o)))
    return Zv[o];
}
At(Gl, "getFocusIntent");
function Xo(e, n = !1) {
  const r = document.activeElement;
  for (const o of e)
    if (o === r || (o.focus({ preventScroll: n }), document.activeElement !== r)) return;
}
At(Xo, "focusFirst");
function Kl(e, n) {
  return e.map((r, o) => e[(n + o) % e.length]);
}
At(Kl, "wrapArray");
var Qv = Kv, Jv = qv, eb = Object.defineProperty, nn = (e, n) => eb(e, "name", { value: n, configurable: !0 }), qo = "Tabs", [tb, _y] = /* @__PURE__ */ Ie(qo, [
  Wl
]), Yl = Wl(), [nb, Zo] = tb(qo), rb = /* @__PURE__ */ f.forwardRef(
  // blank line to reduce diff noise
  /* @__PURE__ */ nn(function(n, r) {
    const {
      __scopeTabs: o,
      value: s,
      onValueChange: a,
      defaultValue: i,
      orientation: l = "horizontal",
      dir: u,
      activationMode: d = "automatic",
      ...p
    } = n, c = Yn(u), [h, g] = Xe({
      prop: s,
      onChange: a,
      defaultProp: i ?? "",
      caller: qo
    });
    return /* @__PURE__ */ m(
      nb,
      {
        scope: o,
        baseId: Me(),
        value: h,
        onValueChange: g,
        orientation: l,
        dir: c,
        activationMode: d,
        children: /* @__PURE__ */ m(
          Q.div,
          {
            dir: c,
            "data-orientation": l,
            ...p,
            ref: r
          }
        )
      }
    );
  }, "Tabs")
), ob = "TabsList", sb = /* @__PURE__ */ f.forwardRef(
  // blank line to reduce diff noise
  /* @__PURE__ */ nn(function(n, r) {
    const { __scopeTabs: o, loop: s = !0, ...a } = n, i = Zo(ob, o), l = Yl(o);
    return /* @__PURE__ */ m(
      Qv,
      {
        asChild: !0,
        ...l,
        orientation: i.orientation,
        dir: i.dir,
        loop: s,
        children: /* @__PURE__ */ m(
          Q.div,
          {
            role: "tablist",
            "aria-orientation": i.orientation,
            ...a,
            ref: r
          }
        )
      }
    );
  }, "TabsList")
), ab = "TabsTrigger", ib = /* @__PURE__ */ f.forwardRef(
  /* @__PURE__ */ nn(function(n, r) {
    const { __scopeTabs: o, value: s, disabled: a = !1, ...i } = n, l = Zo(ab, o), u = Yl(o), d = Qo(l.baseId, s), p = Jo(l.baseId, s), c = s === l.value;
    return /* @__PURE__ */ m(
      Jv,
      {
        asChild: !0,
        ...u,
        focusable: !a,
        active: c,
        children: /* @__PURE__ */ m(
          Q.button,
          {
            type: "button",
            role: "tab",
            "aria-selected": c,
            "aria-controls": p,
            "data-state": c ? "active" : "inactive",
            "data-disabled": a ? "" : void 0,
            disabled: a,
            id: d,
            ...i,
            ref: r,
            onMouseDown: X(n.onMouseDown, (h) => {
              !a && h.button === 0 && h.ctrlKey === !1 ? l.onValueChange(s) : h.preventDefault();
            }),
            onKeyDown: X(n.onKeyDown, (h) => {
              a || h.target !== h.currentTarget || [" ", "Enter"].includes(h.key) && l.onValueChange(s);
            }),
            onFocus: X(n.onFocus, () => {
              const h = l.activationMode !== "manual";
              !c && !a && h && l.onValueChange(s);
            })
          }
        )
      }
    );
  }, "TabsTrigger")
), lb = "TabsContent", cb = /* @__PURE__ */ f.forwardRef(
  /* @__PURE__ */ nn(function(n, r) {
    const { __scopeTabs: o, value: s, forceMount: a, children: i, ...l } = n, u = Zo(lb, o), d = Qo(u.baseId, s), p = Jo(u.baseId, s), c = s === u.value, h = f.useRef(c);
    return f.useEffect(() => {
      const g = requestAnimationFrame(() => h.current = !1);
      return () => cancelAnimationFrame(g);
    }, []), /* @__PURE__ */ m(ct, { present: a || c, children: ({ present: g }) => /* @__PURE__ */ m(
      Q.div,
      {
        "data-state": c ? "active" : "inactive",
        "data-orientation": u.orientation,
        role: "tabpanel",
        "aria-labelledby": d,
        hidden: !g,
        id: p,
        tabIndex: 0,
        ...l,
        ref: r,
        style: {
          ...n.style,
          animationDuration: h.current ? "0s" : void 0
        },
        children: g && i
      }
    ) });
  }, "TabsContent")
);
function Qo(e, n) {
  return `${e}-trigger-${n}`;
}
nn(Qo, "makeTriggerId");
function Jo(e, n) {
  return `${e}-content-${n}`;
}
nn(Jo, "makeContentId");
var db = rb, Xl = sb, ql = ib, Zl = cb;
const Iy = db, ub = f.forwardRef(({ className: e, children: n, onBack: r, backButtonLabel: o, ...s }, a) => /* @__PURE__ */ D(
  Xl,
  {
    ref: a,
    className: O(
      "inline-flex items-center justify-start rounded-md bg-card text-foreground",
      "w-full h-auto p-1 flex flex-wrap gap-1",
      e
    ),
    ...s,
    children: [
      r && /* @__PURE__ */ D(
        xe,
        {
          variant: "ghost",
          size: "sm",
          className: "mr-1 h-8 text-muted-foreground hover:text-foreground shrink-0",
          onClick: r,
          children: [
            /* @__PURE__ */ m(Ea, { className: "mr-1 h-4 w-4" }),
            o || "戻る"
          ]
        }
      ),
      n
    ]
  }
));
ub.displayName = Xl.displayName;
const fb = f.forwardRef(({ className: e, children: n, icon: r, ...o }, s) => /* @__PURE__ */ D(
  ql,
  {
    ref: s,
    className: O(
      "inline-flex items-center justify-center whitespace-nowrap rounded-sm px-ui-x py-ui text-ui font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
      "text-muted-foreground min-h-ui-touch border-b-2 border-transparent",
      "data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:font-bold data-[state=active]:shadow-sm data-[state=active]:border-theme-accent",
      "flex-1 md:flex-1 flex gap-2 min-w-[120px] max-w-full overflow-hidden",
      e
    ),
    ...o,
    children: [
      r && /* @__PURE__ */ m(r, { className: "h-4 w-4 flex-shrink-0" }),
      typeof n == "string" ? /* @__PURE__ */ m(
        ln,
        {
          text: n.length > 10 ? `${n.slice(0, 10)}...` : n,
          className: "flex-1 min-w-0 overflow-hidden",
          as: "span"
        }
      ) : n
    ]
  }
));
fb.displayName = ql.displayName;
const mb = f.forwardRef(({ className: e, ...n }, r) => /* @__PURE__ */ m(
  Zl,
  {
    ref: r,
    className: O(
      "mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      e
    ),
    ...n
  }
));
mb.displayName = Zl.displayName;
const pb = f.forwardRef(
  ({ className: e, ...n }, r) => /* @__PURE__ */ m(
    "textarea",
    {
      className: O(
        "flex min-h-[80px] w-full rounded-md border border-input bg-background px-ui py-ui text-ui text-foreground ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
        e
      ),
      ref: r,
      ...n
    }
  )
);
pb.displayName = "Textarea";
const Oy = P.memo(
  ({
    type: e = "text",
    value: n = "",
    onChange: r,
    modalTitle: o,
    className: s,
    disabled: a,
    readOnly: i,
    ...l
  }) => {
    const [u, d] = Ke(!1), p = () => {
      !a && !i && d(!0);
    }, c = () => {
      d(!1);
    }, h = (g) => {
      r?.(g), d(!1);
    };
    return e === "text" ? /* @__PURE__ */ m(
      Hn,
      {
        type: "text",
        value: n,
        onChange: (g) => r?.(g.target.value),
        className: s,
        disabled: a,
        readOnly: i,
        ...l
      }
    ) : /* @__PURE__ */ D(Qe, { children: [
      /* @__PURE__ */ m(
        Hn,
        {
          type: "text",
          value: n,
          readOnly: !0,
          onClick: p,
          className: `${s} cursor-pointer`,
          disabled: a,
          ...l
        }
      ),
      e === "numeric" && /* @__PURE__ */ m(
        $n,
        {
          open: u,
          onClose: c,
          onSubmit: h,
          initialValue: n,
          title: o,
          placeholder: l.placeholder
        }
      ),
      e === "time" && /* @__PURE__ */ m(
        $n,
        {
          open: u,
          onClose: c,
          onSubmit: h,
          initialValue: n,
          title: o,
          variant: "time"
        }
      ),
      e === "phone" && /* @__PURE__ */ m(
        $n,
        {
          open: u,
          onClose: c,
          onSubmit: h,
          initialValue: n,
          title: o,
          placeholder: l.placeholder,
          variant: "phone"
        }
      )
    ] });
  }
);
var hb = Object.defineProperty, ye = (e, n) => hb(e, "name", { value: n, configurable: !0 }), [es, Ay] = /* @__PURE__ */ Ie("Tooltip", [
  en
]), ts = en(), gb = "TooltipProvider", vb = 700, no = "tooltip.open", [bb, ns] = es(gb), yb = /* @__PURE__ */ ye((e) => {
  const {
    __scopeTooltip: n,
    delayDuration: r = vb,
    skipDelayDuration: o = 300,
    disableHoverableContent: s = !1,
    children: a
  } = e, i = f.useRef(!0), l = f.useRef(!1), u = f.useRef(0);
  return f.useEffect(() => {
    const d = u.current;
    return () => window.clearTimeout(d);
  }, []), /* @__PURE__ */ m(
    bb,
    {
      scope: n,
      isOpenDelayedRef: i,
      delayDuration: r,
      onOpen: f.useCallback(() => {
        o <= 0 || (window.clearTimeout(u.current), i.current = !1);
      }, [o]),
      onClose: f.useCallback(() => {
        o <= 0 || (window.clearTimeout(u.current), u.current = window.setTimeout(
          () => i.current = !0,
          o
        ));
      }, [o]),
      isPointerInTransitRef: l,
      onPointerInTransitChange: f.useCallback((d) => {
        l.current = d;
      }, []),
      disableHoverableContent: s,
      children: a
    }
  );
}, "TooltipProvider"), ro = "Tooltip", [xb, ur] = es(ro), wb = /* @__PURE__ */ ye((e) => {
  const {
    __scopeTooltip: n,
    children: r,
    open: o,
    defaultOpen: s,
    onOpenChange: a,
    disableHoverableContent: i,
    delayDuration: l
  } = e, u = ns(ro, e.__scopeTooltip), d = ts(n), [p, c] = f.useState(null), [h, g] = f.useState(void 0), y = Me(), b = f.useRef(0), v = i ?? u.disableHoverableContent, x = l ?? u.delayDuration, S = f.useRef(!1), [w, C] = Xe({
    prop: o,
    defaultProp: s ?? !1,
    onChange: /* @__PURE__ */ ye((I) => {
      I ? (u.onOpen(), document.dispatchEvent(new CustomEvent(no))) : u.onClose(), a?.(I);
    }, "onChange"),
    caller: ro
  }), N = f.useMemo(() => w ? S.current ? "delayed-open" : "instant-open" : "closed", [w]), R = f.useCallback(() => {
    window.clearTimeout(b.current), b.current = 0, S.current = !1, C(!0);
  }, [C]), E = f.useCallback(() => {
    window.clearTimeout(b.current), b.current = 0, C(!1);
  }, [C]), k = f.useCallback(() => {
    window.clearTimeout(b.current), b.current = window.setTimeout(() => {
      S.current = !0, C(!0), b.current = 0;
    }, x);
  }, [x, C]);
  return f.useEffect(() => () => {
    b.current && (window.clearTimeout(b.current), b.current = 0);
  }, []), /* @__PURE__ */ m(_o, { ...d, children: /* @__PURE__ */ m(
    xb,
    {
      scope: n,
      contentId: h ?? y,
      setContentId: g,
      open: w,
      stateAttribute: N,
      trigger: p,
      onTriggerChange: c,
      onTriggerEnter: f.useCallback(() => {
        u.isOpenDelayedRef.current ? k() : R();
      }, [u.isOpenDelayedRef, k, R]),
      onTriggerLeave: f.useCallback(() => {
        v ? E() : (window.clearTimeout(b.current), b.current = 0);
      }, [E, v]),
      onOpen: R,
      onClose: E,
      disableHoverableContent: v,
      children: r
    }
  ) });
}, "Tooltip"), ca = "TooltipTrigger", Cb = /* @__PURE__ */ f.forwardRef(
  /* @__PURE__ */ ye(function(n, r) {
    const { __scopeTooltip: o, ...s } = n, a = ur(ca, o), i = ns(ca, o), l = ts(o), u = f.useRef(null), d = oe(r, u, a.onTriggerChange), p = f.useRef(!1), c = f.useRef(!1), h = f.useCallback(() => p.current = !1, []);
    return f.useEffect(() => () => document.removeEventListener("pointerup", h), [h]), /* @__PURE__ */ m(Io, { asChild: !0, ...l, children: /* @__PURE__ */ m(
      Q.button,
      {
        "aria-describedby": a.open ? a.contentId : void 0,
        "data-state": a.stateAttribute,
        ...s,
        ref: d,
        onPointerMove: X(n.onPointerMove, (g) => {
          g.pointerType !== "touch" && !c.current && !i.isPointerInTransitRef.current && (a.onTriggerEnter(), c.current = !0);
        }),
        onPointerLeave: X(n.onPointerLeave, () => {
          a.onTriggerLeave(), c.current = !1;
        }),
        onPointerDown: X(n.onPointerDown, () => {
          a.open && a.onClose(), p.current = !0, document.addEventListener("pointerup", h, { once: !0 });
        }),
        onFocus: X(n.onFocus, () => {
          p.current || a.onOpen();
        }),
        onBlur: X(n.onBlur, a.onClose),
        onClick: X(n.onClick, a.onClose)
      }
    ) });
  }, "TooltipTrigger")
), Sb = "TooltipPortal", [Dy, kb] = es(Sb, {
  forceMount: void 0
}), pn = "TooltipContent", Eb = /* @__PURE__ */ f.forwardRef(
  /* @__PURE__ */ ye(function(n, r) {
    const o = kb(pn, n.__scopeTooltip), { forceMount: s = o.forceMount, side: a = "top", ...i } = n, l = ur(pn, n.__scopeTooltip);
    return /* @__PURE__ */ m(ct, { present: s || l.open, children: l.disableHoverableContent ? /* @__PURE__ */ m(Ql, { side: a, ...i, ref: r }) : /* @__PURE__ */ m(Nb, { side: a, ...i, ref: r }) });
  }, "TooltipContent")
), Nb = /* @__PURE__ */ f.forwardRef(/* @__PURE__ */ ye(function(n, r) {
  const o = ur(pn, n.__scopeTooltip), s = ns(pn, n.__scopeTooltip), a = f.useRef(null), i = oe(r, a), [l, u] = f.useState(null), { trigger: d, onClose: p } = o, c = a.current, { onPointerInTransitChange: h } = s, g = f.useCallback(() => {
    u(null), h(!1);
  }, [h]), y = f.useCallback(
    (b, v) => {
      const x = b.currentTarget, S = { x: b.clientX, y: b.clientY }, w = Jl(S, x.getBoundingClientRect()), C = ec(S, w), N = tc(v.getBoundingClientRect()), R = rc([...C, ...N]);
      u(R), h(!0);
    },
    [h]
  );
  return f.useEffect(() => () => g(), [g]), f.useEffect(() => {
    if (d && c) {
      const b = /* @__PURE__ */ ye((x) => y(x, c), "handleTriggerLeave"), v = /* @__PURE__ */ ye((x) => y(x, d), "handleContentLeave");
      return d.addEventListener("pointerleave", b), c.addEventListener("pointerleave", v), () => {
        d.removeEventListener("pointerleave", b), c.removeEventListener("pointerleave", v);
      };
    }
  }, [d, c, y, g]), f.useEffect(() => {
    if (l) {
      const b = /* @__PURE__ */ ye((v) => {
        const x = v.target, S = { x: v.clientX, y: v.clientY }, w = d?.contains(x) || c?.contains(x), C = !nc(S, l);
        w ? g() : C && (g(), p());
      }, "handleTrackPointerGrace");
      return document.addEventListener("pointermove", b), () => document.removeEventListener("pointermove", b);
    }
  }, [d, c, l, p, g]), /* @__PURE__ */ m(Ql, { ...n, ref: i });
}, "TooltipContentHoverable")), Rb = /* @__PURE__ */ va("TooltipContent"), Ql = /* @__PURE__ */ f.forwardRef(
  // blank line to reduce diff noise
  /* @__PURE__ */ ye(function(n, r) {
    const {
      __scopeTooltip: o,
      children: s,
      "aria-label": a,
      id: i,
      onEscapeKeyDown: l,
      onPointerDownOutside: u,
      ...d
    } = n, p = ur(pn, o), c = ts(o), { onClose: h } = p;
    f.useEffect(() => (document.addEventListener(no, h), () => document.removeEventListener(no, h)), [h]), f.useEffect(() => {
      if (p.trigger) {
        const y = /* @__PURE__ */ ye((b) => {
          b.target instanceof Node && b.target.contains(p.trigger) && h();
        }, "handleScroll");
        return window.addEventListener("scroll", y, { capture: !0 }), () => window.removeEventListener("scroll", y, { capture: !0 });
      }
    }, [p.trigger, h]);
    const { setContentId: g } = p;
    return ue(() => (g(i), () => {
      g(void 0);
    }), [i, g]), /* @__PURE__ */ m(
      qn,
      {
        asChild: !0,
        disableOutsidePointerEvents: !1,
        onEscapeKeyDown: l,
        onPointerDownOutside: u,
        onFocusOutside: (y) => y.preventDefault(),
        onDismiss: h,
        children: /* @__PURE__ */ D(
          Oo,
          {
            "data-state": p.stateAttribute,
            role: a ? void 0 : "tooltip",
            id: a ? void 0 : p.contentId,
            ...c,
            ...d,
            ref: r,
            style: {
              ...d.style,
              "--radix-tooltip-content-transform-origin": "var(--radix-popper-transform-origin)",
              "--radix-tooltip-content-available-width": "var(--radix-popper-available-width)",
              "--radix-tooltip-content-available-height": "var(--radix-popper-available-height)",
              "--radix-tooltip-trigger-width": "var(--radix-popper-anchor-width)",
              "--radix-tooltip-trigger-height": "var(--radix-popper-anchor-height)"
            },
            children: [
              /* @__PURE__ */ m(Rb, { children: s }),
              a ? /* @__PURE__ */ m(eg, { id: p.contentId, role: "tooltip", children: a }) : null
            ]
          }
        )
      }
    );
  }, "TooltipContentImpl")
);
function Jl(e, n) {
  const r = Math.abs(n.top - e.y), o = Math.abs(n.bottom - e.y), s = Math.abs(n.right - e.x), a = Math.abs(n.left - e.x);
  switch (Math.min(r, o, s, a)) {
    case a:
      return "left";
    case s:
      return "right";
    case r:
      return "top";
    case o:
      return "bottom";
    default:
      throw new Error("unreachable");
  }
}
ye(Jl, "getExitSideFromRect");
function ec(e, n, r = 5) {
  const o = [];
  switch (n) {
    case "top":
      o.push(
        { x: e.x - r, y: e.y + r },
        { x: e.x + r, y: e.y + r }
      );
      break;
    case "bottom":
      o.push(
        { x: e.x - r, y: e.y - r },
        { x: e.x + r, y: e.y - r }
      );
      break;
    case "left":
      o.push(
        { x: e.x + r, y: e.y - r },
        { x: e.x + r, y: e.y + r }
      );
      break;
    case "right":
      o.push(
        { x: e.x - r, y: e.y - r },
        { x: e.x - r, y: e.y + r }
      );
      break;
  }
  return o;
}
ye(ec, "getPaddedExitPoints");
function tc(e) {
  const { top: n, right: r, bottom: o, left: s } = e;
  return [
    { x: s, y: n },
    { x: r, y: n },
    { x: r, y: o },
    { x: s, y: o }
  ];
}
ye(tc, "getPointsFromRect");
function nc(e, n) {
  const { x: r, y: o } = e;
  let s = !1;
  for (let a = 0, i = n.length - 1; a < n.length; i = a++) {
    const l = n[a], u = n[i], d = l.x, p = l.y, c = u.x, h = u.y;
    p > o != h > o && r < (c - d) * (o - p) / (h - p) + d && (s = !s);
  }
  return s;
}
ye(nc, "isPointInPolygon");
function rc(e) {
  const n = e.slice();
  return n.sort((r, o) => r.x < o.x ? -1 : r.x > o.x ? 1 : r.y < o.y ? -1 : r.y > o.y ? 1 : 0), oc(n);
}
ye(rc, "getHull");
function oc(e) {
  if (e.length <= 1) return e.slice();
  const n = [];
  for (let o = 0; o < e.length; o++) {
    const s = e[o];
    for (; n.length >= 2; ) {
      const a = n[n.length - 1], i = n[n.length - 2];
      if ((a.x - i.x) * (s.y - i.y) >= (a.y - i.y) * (s.x - i.x)) n.pop();
      else break;
    }
    n.push(s);
  }
  n.pop();
  const r = [];
  for (let o = e.length - 1; o >= 0; o--) {
    const s = e[o];
    for (; r.length >= 2; ) {
      const a = r[r.length - 1], i = r[r.length - 2];
      if ((a.x - i.x) * (s.y - i.y) >= (a.y - i.y) * (s.x - i.x)) r.pop();
      else break;
    }
    r.push(s);
  }
  return r.pop(), n.length === 1 && r.length === 1 && n[0].x === r[0].x && n[0].y === r[0].y ? n : n.concat(r);
}
ye(oc, "getHullPresorted");
var Pb = yb, Tb = wb, _b = Cb, sc = Eb;
const Ib = Pb, Ob = Tb, Ab = _b, ac = f.memo(
  f.forwardRef(({ className: e, sideOffset: n = 4, side: r = "bottom", ...o }, s) => /* @__PURE__ */ m(
    sc,
    {
      ref: s,
      sideOffset: n,
      side: r,
      className: O(
        "z-50 overflow-hidden rounded-md border border-white bg-black text-white px-3 py-1.5 text-xs shadow-md animate-in fade-in-0 zoom-in-95",
        e
      ),
      ...o
    }
  ))
);
ac.displayName = sc.displayName;
const Db = typeof document < "u", Mb = () => Db ? document.documentElement.dir === "rtl" || document.documentElement.getAttribute("data-rtl") === "true" : !1, Lb = (e) => new Set(e ?? []), My = ({
  title: e = "Menu",
  items: n,
  selectedId: r,
  onSelect: o,
  defaultExpandedIds: s,
  expandedIds: a,
  onExpandedChange: i,
  // dense = false, // Removed unused prop
  className: l,
  // Restoration props
  showCloseButton: u = !1,
  onCloseMenu: d,
  hideControlBar: p = !1
}) => {
  const c = Mb(), h = P.useMemo(() => {
    const I = [], L = (A) => {
      A.forEach((_) => {
        _.children && _.children.length > 0 && (I.push(_.id), L(_.children));
      });
    };
    return n && L(n), I;
  }, [n]), [g, y] = P.useState(s ?? []), b = a !== void 0, v = b ? a : g, x = P.useMemo(() => Lb(v), [v]), S = P.useCallback(
    (I) => {
      b || y(I), i?.(I);
    },
    [b, i]
  ), w = P.useCallback(
    (I) => {
      const L = new Set(x);
      L.has(I) ? L.delete(I) : L.add(I), S(Array.from(L));
    },
    [x, S]
  ), C = () => S(h), N = () => S([]), R = "px-ui py-ui", E = (I, L) => /* @__PURE__ */ m("ul", { role: L === 0 ? "tree" : "group", className: "space-y-0.5", children: I.map((A) => {
    const _ = (A.children?.length ?? 0) > 0, M = _ && x.has(A.id), U = r === A.id, $ = 8 + L * 16;
    return /* @__PURE__ */ D(
      "li",
      {
        role: "treeitem",
        "aria-expanded": _ ? M : void 0,
        "aria-selected": U || void 0,
        tabIndex: A.disabled ? -1 : 0,
        children: [
          /* @__PURE__ */ D(
            "div",
            {
              className: O(
                "w-full flex items-center gap-2 rounded-md transition-colors duration-150",
                R,
                "text-foreground",
                A.disabled && "opacity-50 pointer-events-none",
                U ? "bg-primary text-primary-foreground font-semibold" : "hover:bg-primary/20 hover:text-foreground"
              ),
              style: {
                paddingInlineStart: $
              },
              children: [
                _ ? /* @__PURE__ */ D(
                  "button",
                  {
                    type: "button",
                    className: "flex-1 flex items-center min-w-0 text-start cursor-pointer focus:outline-none",
                    onClick: () => w(A.id),
                    children: [
                      A.icon && /* @__PURE__ */ m(
                        "span",
                        {
                          className: O(
                            "me-2",
                            U ? "text-primary-foreground" : "text-muted-foreground"
                          ),
                          children: A.icon
                        }
                      ),
                      /* @__PURE__ */ m("span", { className: O("truncate flex-grow", "text-ui"), children: A.label })
                    ]
                  }
                ) : /* @__PURE__ */ D(
                  "button",
                  {
                    type: "button",
                    className: "flex-1 flex items-center min-w-0 text-start cursor-pointer focus:outline-none",
                    onClick: () => o?.(A.id, A),
                    children: [
                      A.icon && /* @__PURE__ */ m(
                        "span",
                        {
                          className: O(
                            "me-2",
                            U ? "text-primary-foreground" : "text-muted-foreground"
                          ),
                          children: A.icon
                        }
                      ),
                      /* @__PURE__ */ m("span", { className: O("truncate flex-grow", "text-ui"), children: A.label })
                    ]
                  }
                ),
                A.badge !== void 0 && /* @__PURE__ */ m(
                  "span",
                  {
                    className: O(
                      "ms-2 text-xs px-2 py-0.5 rounded",
                      U ? "bg-primary-foreground/20 text-primary-foreground" : "bg-muted text-muted-foreground"
                    ),
                    children: A.badge
                  }
                ),
                _ && /* @__PURE__ */ m(
                  "button",
                  {
                    type: "button",
                    onClick: (B) => {
                      B.stopPropagation(), w(A.id);
                    },
                    className: O(
                      "w-7 aspect-square flex items-center justify-center rounded focus:outline-none",
                      U ? "text-primary-foreground hover:text-primary-foreground/80" : "text-foreground hover:text-accent-foreground"
                    ),
                    "aria-label": M ? "Collapse" : "Expand",
                    children: M ? /* @__PURE__ */ m(Xn, { size: 16 }) : c ? /* @__PURE__ */ m(Mr, { size: 16 }) : /* @__PURE__ */ m(Lr, { size: 16 })
                  }
                )
              ]
            }
          ),
          _ && M && A.children ? /* @__PURE__ */ m("div", { className: "mt-0.5", children: E(A.children, L + 1) }) : null
        ]
      },
      A.id
    );
  }) }), k = "text-primary-foreground", T = "hover:text-primary-foreground/80";
  return /* @__PURE__ */ D(
    "div",
    {
      className: O("w-full relative h-full min-h-0 flex flex-col", l),
      children: [
        !p && /* @__PURE__ */ D("div", { className: "flex items-center bg-primary px-ui py-ui w-full mb-2", children: [
          u && d && /* @__PURE__ */ m(
            "button",
            {
              type: "button",
              "aria-label": "Close menu",
              className: O(
                "min-w-[32px] focus:outline-none",
                k,
                T
              ),
              onClick: d,
              children: c ? /* @__PURE__ */ m(Lr, { size: 20 }) : /* @__PURE__ */ m(Mr, { size: 20 })
            }
          ),
          /* @__PURE__ */ m(
            "div",
            {
              className: O(
                "flex items-center font-bold flex-grow ps-2",
                k
              ),
              children: e
            }
          ),
          /* @__PURE__ */ D("div", { className: "flex items-center space-x-2", children: [
            /* @__PURE__ */ m(
              "button",
              {
                type: "button",
                onClick: C,
                className: O(
                  "focus:outline-none",
                  k,
                  T
                ),
                "aria-label": "Expand all",
                children: /* @__PURE__ */ m(Ra, { size: "0.8rem" })
              }
            ),
            /* @__PURE__ */ m(
              "button",
              {
                type: "button",
                onClick: N,
                className: O(
                  "focus:outline-none",
                  k,
                  T
                ),
                "aria-label": "Collapse all",
                children: /* @__PURE__ */ m(Ld, { size: "0.8rem" })
              }
            )
          ] })
        ] }),
        /* @__PURE__ */ m("div", { className: "bg-background w-full flex-1 min-h-0 overflow-y-auto", children: n && n.length > 0 ? E(n, 0) : /* @__PURE__ */ m("div", { className: "text-xs text-muted-foreground px-ui py-ui", children: "TreeMenu items not provided." }) })
      ]
    }
  );
}, Ly = P.memo(
  ({ options: e, value: n, onChange: r, className: o }) => /* @__PURE__ */ m(Ib, { children: /* @__PURE__ */ m(
    "div",
    {
      className: O(
        "inline-flex rounded-lg border border-border bg-background p-1",
        o
      ),
      children: e.map((s) => {
        const a = s.icon, i = n === s.value;
        return /* @__PURE__ */ D(Ob, { children: [
          /* @__PURE__ */ m(Ab, { asChild: !0, children: /* @__PURE__ */ m(
            "button",
            {
              type: "button",
              onClick: () => r(s.value),
              className: O(
                "flex items-center justify-center p-2 rounded transition-colors",
                i ? "bg-accent text-white" : "text-muted-foreground hover:bg-card hover:text-foreground"
              ),
              "aria-label": s.tooltip,
              children: /* @__PURE__ */ m(a, { className: "text-lg" })
            }
          ) }),
          /* @__PURE__ */ m(ac, { children: /* @__PURE__ */ m("p", { children: s.tooltip }) })
        ] }, s.value);
      })
    }
  ) })
), Fy = {
  LIGHT: "light",
  DARK: "dark"
}, $y = {
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
}, zy = "light";
export {
  qt as ActionButton,
  ln as AdaptiveText,
  Ub as AsyncDataWrapper,
  Ju as Avatar,
  Gb as Badge,
  xe as Button,
  Yb as Calculator,
  oy as CalendarProvider,
  Wu as CancelButton,
  Pm as Card,
  Om as CardContent,
  Im as CardDescription,
  Am as CardFooter,
  Tm as CardHeader,
  _m as CardTitle,
  Xb as ChatDock,
  Dm as Checkbox,
  Zb as Collapsible,
  Jb as CollapsibleContent,
  Qb as CollapsibleTrigger,
  ey as ConfirmModal,
  ty as ContentHeader,
  ny as CopyClipButton,
  Uu as CreateButton,
  wy as CurrencyFormat,
  zy as DEFAULT_THEME,
  ry as DateDisplay,
  sy as DateFormat,
  Gu as DeleteButton,
  jb as DirectionProvider,
  ay as Drawer,
  iy as DropdownMenu,
  Ku as EditButton,
  Km as EditableSelect,
  Xu as ErrorState,
  ly as Form,
  vp as FormControl,
  yp as FormDescription,
  cy as FormField,
  mp as FormItem,
  hp as FormLabel,
  wp as FormMessage,
  Cp as ImageViewer,
  uy as ImageWithPreview,
  fy as InfiniteListMenu,
  Hn as Input,
  $n as KeypadModal,
  Tp as Label,
  gy as LanguageSelector,
  vy as MenuButtonGroup,
  by as MiniTable,
  bn as Modal,
  Rm as ModalFooter,
  yy as NavigationStepper,
  Kg as NotificationToast,
  xy as NumberFormat,
  Cy as OptionButtonGroup,
  Sy as Pagination,
  Xg as PercentFormat,
  Ey as Popover,
  uv as PopoverContent,
  Ny as PopoverTrigger,
  xv as ProgressBar,
  Yu as SaveButton,
  wv as ScaleInput,
  Cv as ScrollArea,
  Sv as SearchableSelect,
  Lg as Select,
  Cl as SelectContent,
  hy as SelectGroup,
  Sl as SelectItem,
  $g as SelectLabel,
  zg as SelectSeparator,
  wl as SelectTrigger,
  Fg as SelectValue,
  Py as SelectableTextInput,
  Rv as Separator,
  Pv as SimpleSearchInput,
  ja as Skeleton,
  Et as Spinner,
  $v as Switch,
  $y as THEME_COLORS,
  Fy as THEME_CONSTANTS,
  Iy as Tabs,
  mb as TabsContent,
  ub as TabsList,
  fb as TabsTrigger,
  Oy as TextInput,
  pb as Textarea,
  Wb as Toaster,
  Ob as Tooltip,
  ac as TooltipContent,
  Ib as TooltipProvider,
  Ab as TooltipTrigger,
  My as TreeMenu,
  Ly as ViewSwitcher,
  ju as buttonVariants,
  jg as calculateLastRowInfo,
  Vg as calculateOptimalColumnCount,
  O as cn,
  Hb as toast,
  Wm as useCalendarSettings,
  tr as useFormField,
  dy as useImageViewer
};
