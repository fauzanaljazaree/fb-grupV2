/* =========================================================
   FB Auto Poster - Content: Stealth / Humanizer
   Membuat interaksi (scroll, ketik, klik) menyerupai manusia.
   ========================================================= */

(function (root) {
  "use strict";

  const FBAP = (root.FBAP = root.FBAP || {});
  const content = (FBAP.content = FBAP.content || {});
  const { randInt, gauss } = FBAP.random;
  const { sleep } = FBAP.time;

  /** Smooth human-like scroll pada element (default window) */
  async function humanScroll(element = window, duration = null, targetY = null) {
    const scroller = element === window ? document.scrollingElement : element;
    if (!scroller) return;
    const max = scroller.scrollHeight - scroller.clientHeight;
    const target = targetY == null ? max : Math.min(targetY, max);
    const startY = scroller.scrollTop;
    const dist = target - startY;
    if (dist === 0) return;
    const dur = duration || Math.min(2200, 600 + Math.round(gauss(700, 180)));
    const start = performance.now();
    return new Promise((resolve) => {
      const step = (now) => {
        const p = Math.min(1, (now - start) / dur);
        const ease = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
        scroller.scrollTop = startY + dist * ease;
        if (p < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
  }

  /* Geser pendek & acak untuk simulasi membaca (bukan scroll penuh instan) */
  async function humanScrollSidebar(scroller) {
    if (!scroller) return;
    const spans = randInt(1, 2);
    for (let i = 0; i < spans; i++) {
      await sleep(randInt(500, 1200));
      const step = randInt(120, 380);
      scroller.scrollTop += (i % 2 === 0 ? 1 : -1) * step;
      await sleep(randInt(500, 1100));
    }
  }

  /** Scroll elemen ke tengah layar dengan jeda kecil. */
  async function humanScrollToEl(el) {
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    await sleep(randInt(400, 900));
  }

  /** Ketik teks karakter-per-karakter lengkap dengan event keydown/input/keyup. */
  async function typeLikeHuman(element, text) {
    if (!element) return false;
    element.focus();
    try { element.click(); } catch (e) {}
    await selectAllAndClear(element);
    const chars = Array.from(text);
    for (const ch of chars) {
      const baseDelay = Math.min(180, Math.max(50, gauss(105, 28)));
      await sleep(baseDelay);
      if (" .,!?;:()".includes(ch)) {
        await sleep(Math.floor(Math.random() * 350) + Math.floor(gauss(120, 30)) + 40);
      }
      if (!element.isConnected) return false;

      const keydown = new KeyboardEvent("keydown", {
        key: ch, code: ch.length === 1 ? `Key${ch.toUpperCase()}` : "Unidentified",
        bubbles: true, cancelable: true
      });
      element.dispatchEvent(keydown);

      let inserted = false;
      try {
        element.focus();
        const sel = window.getSelection();
        sel.selectAllChildren(element);
        sel.collapseToEnd();
        inserted = document.execCommand("insertText", false, ch);
      } catch (e) { inserted = false; }
      if (!inserted) {
        element.textContent = (element.textContent || "") + ch;
      }

      const inputEv = new InputEvent("input", {
        bubbles: true, cancelable: true, inputType: "insertText", data: ch
      });
      element.dispatchEvent(inputEv);

      const keyup = new KeyboardEvent("keyup", {
        key: ch, code: ch.length === 1 ? `Key${ch.toUpperCase()}` : "Unidentified",
        bubbles: true, cancelable: true
      });
      element.dispatchEvent(keyup);

      if (Math.random() < 0.05) await sleep(randInt(200, 600));
    }
    return true;
  }

  async function selectAllAndClear(element) {
    try {
      document.execCommand("selectAll", false, null);
      document.execCommand("delete", false, null);
    } catch (e) {}
    element.textContent = "";
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
  }

  content.stealth = {
    humanScroll,
    humanScrollSidebar,
    humanScrollToEl,
    typeLikeHuman,
    selectAllAndClear
  };
})(globalThis);
