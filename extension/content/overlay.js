/* Caption overlay: a shadow-DOM panel pinned over the page, styled after the
 * Chrome Live Caption bubble. Only ever created in the top frame. */
"use strict";

(function (LC) {
  const CSS = `
:host { all: initial; }
.box {
  position: fixed; z-index: 2147483647;
  left: var(--lc-left, 50%); top: var(--lc-top, auto); bottom: var(--lc-bottom, 8%);
  transform: var(--lc-transform, translateX(-50%));
  width: var(--lc-width, min(720px, 80vw));
  box-sizing: border-box;
  padding: 10px 14px 12px;
  border-radius: 14px;
  background: rgba(20, 20, 22, var(--lc-opacity, 0.88));
  color: #fff;
  font: 500 var(--lc-font-size, 20px)/1.42 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(6px);
  cursor: default;
  user-select: none;
  transition: opacity .18s ease;
}
.box.light { background: rgba(248, 248, 250, var(--lc-opacity, 0.94)); color: #16181d; box-shadow: 0 8px 28px rgba(0,0,0,.22); }
.box.hidden { display: none; }
.box.dragging { cursor: grabbing; }

.bar { display: flex; align-items: center; gap: 6px; height: 20px; margin: -4px -4px 4px; opacity: 0; transition: opacity .15s ease; }
.box:hover .bar, .box.pinnedbar .bar { opacity: 1; }
.grip { flex: 1; height: 16px; cursor: grab; display: flex; align-items: center; gap: 6px; font: 600 11px/1 system-ui, sans-serif; letter-spacing: .06em; text-transform: uppercase; opacity: .6; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: #37d67a; box-shadow: 0 0 0 3px rgba(55,214,122,.2); flex: none; }
.dot.busy { background: #f2c744; box-shadow: 0 0 0 3px rgba(242,199,68,.2); }
.dot.error { background: #ff5c5c; box-shadow: 0 0 0 3px rgba(255,92,92,.2); }
button {
  all: unset; flex: none; width: 22px; height: 20px; border-radius: 6px; text-align: center;
  font: 600 13px/20px system-ui, sans-serif; opacity: .65; cursor: pointer;
}
button:hover { opacity: 1; background: rgba(255,255,255,.16); }
.box.light button:hover { background: rgba(0,0,0,.1); }

.lines { max-height: calc(var(--lc-lines, 3) * 1.42em); overflow: hidden; display: flex; flex-direction: column; justify-content: flex-end; }
.line { overflow-wrap: anywhere; }
.line.old { opacity: .55; }
.line.interim { opacity: .92; }
.caret { display: inline-block; width: .5em; }
.status { font: 500 12px/1.4 system-ui, sans-serif; opacity: .62; margin-top: 4px; }
.status:empty { display: none; }
`;

  LC.Overlay = class Overlay {
    constructor({ onClose, onGeometry } = {}) {
      this.onClose = onClose || (() => {});
      this.onGeometry = onGeometry || (() => {});
      this.finals = [];
      this.interim = "";
      this.host = null;
      this.opts = {};
    }

    mount() {
      if (this.host && this.host.isConnected) return;
      this.host = document.createElement("div");
      this.host.setAttribute("data-live-caption", "");
      // Zero-sized and out of flow: the panel itself is position:fixed inside
      // the shadow root, so the host must not affect the page's layout.
      this.host.style.cssText = "all:initial;position:fixed;top:0;left:0;width:0;height:0";
      const root = this.host.attachShadow({ mode: "closed" });
      const style = document.createElement("style");
      style.textContent = CSS;

      this.box = document.createElement("div");
      this.box.className = "box hidden";
      this.box.innerHTML = `
        <div class="bar">
          <div class="grip"><span class="dot"></span><span class="title">Live Caption</span></div>
          <button data-act="smaller" title="Smaller text">A-</button>
          <button data-act="bigger" title="Larger text">A+</button>
          <button data-act="close" title="Hide captions">✕</button>
        </div>
        <div class="lines"></div>
        <div class="status"></div>`;

      root.append(style, this.box);
      (document.body || document.documentElement).appendChild(this.host);

      this.linesEl = this.box.querySelector(".lines");
      this.statusEl = this.box.querySelector(".status");
      this.dotEl = this.box.querySelector(".dot");

      this.box.addEventListener("click", (e) => {
        const act = e.target && e.target.getAttribute && e.target.getAttribute("data-act");
        if (!act) return;
        e.stopPropagation();
        if (act === "close") this.onClose();
        if (act === "bigger") this.bumpFont(2);
        if (act === "smaller") this.bumpFont(-2);
      });
      this.initDrag();
      this.initFullscreen();
      this.applyOptions(this.opts);
    }

    initDrag() {
      const grip = this.box.querySelector(".grip");
      let startX = 0, startY = 0, originLeft = 0, originTop = 0;
      const move = (e) => {
        const left = originLeft + (e.clientX - startX);
        const top = originTop + (e.clientY - startY);
        const maxLeft = window.innerWidth - this.box.offsetWidth;
        const maxTop = window.innerHeight - this.box.offsetHeight;
        this.setPosition(Math.max(0, Math.min(maxLeft, left)), Math.max(0, Math.min(maxTop, top)));
      };
      const up = () => {
        this.box.classList.remove("dragging");
        window.removeEventListener("pointermove", move, true);
        window.removeEventListener("pointerup", up, true);
        this.onGeometry({ left: this.pos.left, top: this.pos.top });
      };
      grip.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        const rect = this.box.getBoundingClientRect();
        startX = e.clientX; startY = e.clientY;
        originLeft = rect.left; originTop = rect.top;
        this.box.classList.add("dragging");
        window.addEventListener("pointermove", move, true);
        window.addEventListener("pointerup", up, true);
      });
    }

    /* Keep captions visible when a video goes fullscreen. */
    initFullscreen() {
      this.fsHandler = () => {
        const fs = document.fullscreenElement;
        const parent = fs || document.body || document.documentElement;
        if (this.host && this.host.parentElement !== parent) parent.appendChild(this.host);
      };
      document.addEventListener("fullscreenchange", this.fsHandler, true);
    }

    setPosition(left, top) {
      this.pos = { left, top };
      this.box.style.setProperty("--lc-left", left + "px");
      this.box.style.setProperty("--lc-top", top + "px");
      this.box.style.setProperty("--lc-bottom", "auto");
      this.box.style.setProperty("--lc-transform", "none");
    }

    applyOptions(opts = {}) {
      this.opts = { ...this.opts, ...opts };
      if (!this.box) return;
      const o = this.opts;
      if (o.fontSize) this.box.style.setProperty("--lc-font-size", o.fontSize + "px");
      if (o.maxLines) this.box.style.setProperty("--lc-lines", String(o.maxLines));
      if (o.opacity != null) this.box.style.setProperty("--lc-opacity", String(o.opacity));
      if (o.width) this.box.style.setProperty("--lc-width", o.width);
      this.box.classList.toggle("light", o.theme === "light");
      if (o.position && o.position.left != null) this.setPosition(o.position.left, o.position.top);
    }

    bumpFont(delta) {
      const size = Math.max(12, Math.min(48, (this.opts.fontSize || 20) + delta));
      this.applyOptions({ fontSize: size });
      this.onGeometry({ fontSize: size });
    }

    show() { this.mount(); this.box.classList.remove("hidden"); }
    hide() { if (this.box) this.box.classList.add("hidden"); }
    destroy() {
      document.removeEventListener("fullscreenchange", this.fsHandler, true);
      if (this.host) this.host.remove();
      this.host = null;
    }

    setStatus(text, kind = "ok") {
      this.mount();
      this.statusEl.textContent = text || "";
      this.dotEl.className = "dot" + (kind === "ok" ? "" : " " + kind);
    }

    pushFinal(text) {
      if (!text) return;
      this.finals.push(text);
      if (this.finals.length > 8) this.finals.shift();
      this.interim = "";
      this.render();
    }

    setInterim(text) {
      this.interim = text || "";
      this.render();
    }

    clear() { this.finals = []; this.interim = ""; this.render(); }

    render() {
      this.mount();
      const maxLines = this.opts.maxLines || 3;
      const parts = [...this.finals.map((t) => ({ t, cls: "old" }))];
      if (this.interim) parts.push({ t: this.interim, cls: "interim" });
      else if (parts.length) parts[parts.length - 1].cls = "";

      // Only the tail is visible; the container clips to `maxLines` rows.
      const visible = parts.slice(-Math.max(2, maxLines));
      this.linesEl.textContent = "";
      for (const p of visible) {
        const div = document.createElement("div");
        div.className = "line " + p.cls;
        div.textContent = p.t;
        this.linesEl.appendChild(div);
      }
    }
  };
})(globalThis.LiveCaption);
