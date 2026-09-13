/*
 * Presenter View (F4) — Canva and Google Slides
 *
 * Neither app exposes a stable, documented URL for presenter view, so this
 * drives the real UI, exactly as a click-by-hand would.
 *
 * The two apps need different methods, because Google Slides can already put
 * the slideshow on a chosen monitor by itself:
 *
 *   Canva          "pop-and-move" — click Present > Presenter view, then let
 *                  the service worker pop the slides tab into its own window
 *                  and move that window to the other display.
 *
 *   Google Slides  "display-options" — pop the tab out first, then open
 *                  Slideshow > Presentation display options, tick Presenter
 *                  view / Present from beginning / Full screen, choose the
 *                  monitor that is not the current one, and hit Start
 *                  slideshow. Slides does the placing, so the worker never
 *                  touches the windows.
 *
 * If an app renames its controls (or your UI is not in English), add the
 * labels you see to the SITES table below.
 * Run  __canvaF4.debug()  in the DevTools console to list what it can see.
 */
(() => {
  "use strict";

  // ---------------------------------------------------------------- config --
  /**
   * Live copy of the user's settings, from the options page. Defaults are used
   * until storage answers, so an F4 in the first few milliseconds still works.
   *
   *   triggerKey            the key to press, on its own
   *   preferredDisplayName  pins the monitor for Google Slides, as a substring
   *                         of the name it shows (e.g. "LG ULTRAGEAR"). Empty
   *                         means "whichever screen is not the current one",
   *                         which needs no configuring on any machine.
   */
  /**
   * Defaults repeated here on purpose. settings.js is injected before this
   * file, but if it ever fails to load, reading through it at the top level
   * would throw and take the key listener down with it — the extension would
   * do nothing at all, with no clue why. The shortcut matters more than the
   * settings, so this file never depends on it being there.
   */
  const BUILT_IN = {
    triggerKey: "F4",
    preferredDisplayName: "",
  };

  const settingsApi = self.PresenterSettings || null;
  let settings = { ...BUILT_IN, ...(settingsApi ? settingsApi.DEFAULTS : null) };

  function refreshSettings() {
    if (!settingsApi) return;
    settingsApi.load().then(
      (loaded) => {
        settings = { ...BUILT_IN, ...loaded };
      },
      () => {}, // keep the defaults
    );
  }

  if (settingsApi) {
    refreshSettings();
    settingsApi.onChange(refreshSettings);
  } else {
    console.warn(
      "[presenter-f4] settings.js did not load; using built-in defaults.",
      "The shortcut still works, but the options page will not affect it.",
    );
  }

  /** How Slides labels the screen the browser is already on. */
  const CURRENT_SCREEN = /^\(?current\)?$/i;

  /**
   * Per-app labels. Pattern lists are tried in order, so put the most specific
   * first — the first pattern with a match on the page wins, regardless of
   * where the elements sit in the DOM.
   */
  const SITES = [
    {
      name: "Canva",
      host: /(^|\.)canva\.com$/,
      strategy: "pop-and-move",
      openPatterns: [/^present$/i, /^present\b/i],
      itemPatterns: [/presenter view/i, /presenter'?s view/i],
    },
    {
      name: "Google Slides",
      host: /(^|\.)docs\.google\.com$/,
      path: /\/presentation\//,
      strategy: "display-options",
      // The caret beside "Slideshow". Clicking "Slideshow" itself starts
      // presenting immediately with no menu, so that is deliberately NOT in
      // this list -- if none of these match, the caret is found by its
      // position instead (see findAdjacentControl).
      openPatterns: [
        /slideshow options/i,
        /presentation options/i,
        /more presentation options/i,
        /start slideshow options/i,
      ],
      // The menu entry that opens the dialog.
      itemPatterns: [/presentation display options/i, /display options/i],
      // Inside the dialog.
      togglePatterns: [/presenter view/i, /present from beginning/i, /full screen/i],
      startPatterns: [/^start slideshow$/i, /^start$/i, /^present$/i],
    },
  ];

  function siteFor(loc = location) {
    return (
      SITES.find(
        (site) =>
          site.host.test(loc.hostname) && (!site.path || site.path.test(loc.pathname)),
      ) || null
    );
  }

  const MENU_TIMEOUT_MS = 4000;
  const DIALOG_TIMEOUT_MS = 6000;
  const SETTLE_MS = 250; // after the tab is re-parented, before measuring anything
  const TICK_MS = 60; // between clicks inside the dialog
  const MAX_LABEL_LENGTH = 60; // ignore big containers that merely contain the text

  const CLICKABLE_SELECTOR = [
    "button",
    "a",
    '[role="button"]',
    '[role="menuitem"]',
    '[role="menuitemradio"]',
    '[role="option"]',
    '[role="tab"]',
  ].join(",");

  const DIALOG_SELECTOR = '[role="dialog"],[role="alertdialog"]';

  /**
   * Anything that might be a tick box or a radio, cast as widely as possible.
   * Requiring role="checkbox" is not safe: the real control is often a
   * zero-size or transparent <input> with the visual drawn by a sibling, and
   * some widgets expose only aria-checked with no role at all.
   */
  const TOGGLE_SELECTOR = [
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="switch"]',
    '[role="menuitemcheckbox"]',
    '[role="menuitemradio"]',
    "[aria-checked]",
    'input[type="checkbox"]',
    'input[type="radio"]',
  ].join(",");

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ------------------------------------------------------------- utilities --
  /** Collect elements matching `selector`, descending into open shadow roots. */
  function deepQueryAll(selector, root = document, out = []) {
    for (const el of root.querySelectorAll(selector)) out.push(el);
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) deepQueryAll(selector, el.shadowRoot, out);
    }
    return out;
  }

  function labelOf(el) {
    const aria = el.getAttribute("aria-label") || "";
    const title = el.getAttribute("title") || "";
    const text = (el.innerText || el.textContent || "").trim();
    return [aria, title, text.length <= MAX_LABEL_LENGTH ? text : ""]
      .filter(Boolean)
      .join(" | ");
  }

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
  }

  function isDisabled(el) {
    return el.getAttribute("aria-disabled") === "true" || el.disabled === true;
  }

  /** /presenter view/i -> "Presenter view", for toasts meant to be read. */
  function readableName(pattern) {
    const body = String(pattern).replace(/^\//, "").replace(/\/[a-z]*$/, "");
    const plain = body.replace(/[\\^$?]/g, "");
    return plain.charAt(0).toUpperCase() + plain.slice(1);
  }

  function matchIn(elements, pattern) {
    for (const el of elements) {
      if (isDisabled(el) || !isVisible(el)) continue;
      if (pattern.test(labelOf(el))) return el;
    }
    return null;
  }

  /**
   * First match for the highest-priority pattern, not the first element that
   * happens to match anything.
   */
  function findMatch(patterns, root = document) {
    const shallow = [...root.querySelectorAll(CLICKABLE_SELECTOR)];
    for (const pattern of patterns) {
      const hit = matchIn(shallow, pattern);
      if (hit) return hit;
    }
    // The deep scan walks every node looking for shadow roots, so it only runs
    // when the cheap pass found nothing.
    const deep = deepQueryAll(CLICKABLE_SELECTOR, root);
    for (const pattern of patterns) {
      const hit = matchIn(deep, pattern);
      if (hit) return hit;
    }
    return null;
  }

  function waitFor(produce, timeoutMs) {
    return new Promise((resolve) => {
      const immediate = produce();
      if (immediate) return resolve(immediate);

      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        observer.disconnect();
        clearInterval(poll);
        clearTimeout(timer);
        resolve(value);
      };
      const check = () => {
        const value = produce();
        if (value) finish(value);
      };

      // These apps re-render constantly; coalesce mutation bursts into one
      // scan per frame instead of one per mutation record.
      let scheduled = false;
      const schedule = () => {
        if (scheduled || done) return;
        scheduled = true;
        requestAnimationFrame(() => {
          scheduled = false;
          check();
        });
      };

      const observer = new MutationObserver(schedule);
      observer.observe(document.documentElement, { childList: true, subtree: true });
      const poll = setInterval(check, 150);
      const timer = setTimeout(() => finish(null), timeoutMs);
    });
  }

  const waitForMatch = (patterns, timeoutMs, root = document) =>
    waitFor(() => findMatch(patterns, root), timeoutMs);

  /**
   * The control immediately to the right of `anchor` — used for Google Slides'
   * dropdown caret, which sits beside the Slideshow button. Found by position
   * rather than by label, because it is an unlabelled icon and its
   * accessibility name is not something to rely on.
   */
  function findAdjacentControl(anchor, maxGapPx = 140) {
    const a = anchor.getBoundingClientRect();
    let best = null;
    let bestGap = Infinity;

    for (const el of document.querySelectorAll(CLICKABLE_SELECTOR)) {
      if (el === anchor || el.contains(anchor) || anchor.contains(el)) continue;
      if (isDisabled(el) || !isVisible(el)) continue;

      const r = el.getBoundingClientRect();
      const sameRow = r.top < a.bottom && r.bottom > a.top;
      if (!sameRow) continue;

      const gap = r.left - a.right;
      if (gap < -4 || gap > maxGapPx) continue;
      if (gap < bestGap) {
        bestGap = gap;
        best = el;
      }
    }
    return best;
  }

  /** Text of the row a control sits in — the control itself carries none. */
  function rowTextOf(el, root) {
    let node = el;
    for (let depth = 0; depth < 6 && node && node !== root; depth++) {
      const text = (node.innerText || "").trim();
      if (text) return text;
      node = node.parentElement;
    }
    return "";
  }

  /**
   * The label for a toggle. A tick box almost never carries its own text, so
   * fall back to the FIRST LINE of the row it sits in.
   *
   * First line only, and this matters: the "(current)" monitor row reads
   * "(current) / Presenter view will open on LG ULTRAGEAR", so matching whole
   * row text would make that radio answer to /presenter view/i as well as the
   * actual Presenter view checkbox.
   */
  function toggleLabel(el, root) {
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim();
    return (rowTextOf(el, root).split("\n")[0] || "").trim();
  }

  function toggleKind(el) {
    const role = (el.getAttribute("role") || "").toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (role === "radio" || role === "menuitemradio" || type === "radio") return "radio";
    if (role === "checkbox" || role === "switch" || role === "menuitemcheckbox") {
      return "checkbox";
    }
    if (type === "checkbox") return "checkbox";
    return "unknown";
  }

  /** Can the ticked state be read, or would clicking be a coin flip? */
  function hasReadableState(el) {
    return el.hasAttribute("aria-checked") || typeof el.checked === "boolean";
  }

  function isChecked(el) {
    const aria = el.getAttribute("aria-checked");
    if (aria !== null) return aria === "true";
    return el.checked === true;
  }

  /**
   * Every toggle in the dialog, with its label and kind.
   *
   * Deliberately NOT filtered by visibility: the real control is regularly a
   * zero-size or transparent input sitting behind the visual one. The dialog
   * itself is on screen, so anything inside it is fair game.
   */
  function collectToggles(root) {
    const seen = new Set();
    const toggles = [];
    for (const el of deepQueryAll(TOGGLE_SELECTOR, root)) {
      if (seen.has(el) || isDisabled(el)) continue;
      seen.add(el);
      toggles.push({ el, label: toggleLabel(el, root), kind: toggleKind(el) });
    }
    return toggles;
  }

  /**
   * A wrapper and the input inside it can both match. Prefer whichever exposes
   * a state we can actually read, so we never click blind.
   */
  function bestToggle(candidates) {
    return (
      candidates.find((t) => t.el.hasAttribute("aria-checked")) ||
      candidates.find((t) => hasReadableState(t.el)) ||
      candidates[0]
    );
  }

  /**
   * Tick it if it is not already ticked — never toggle off. The dialog
   * remembers the last run, so a blind click would switch off a box that was
   * already on. Returns false if the state could not be read or the click did
   * not take.
   */
  async function ensureChecked(el) {
    if (!el || !hasReadableState(el)) return false;
    if (isChecked(el)) return true;
    realClick(el);
    await sleep(TICK_MS);
    return isChecked(el);
  }

  /** Structural dump for when a control cannot be resolved. */
  function dumpDialog(dialog) {
    const rows = [];
    for (const el of deepQueryAll("*", dialog)) {
      const role = el.getAttribute("role");
      const ariaChecked = el.getAttribute("aria-checked");
      const isInput = el.tagName === "INPUT";
      if (!role && ariaChecked === null && !isInput) continue;
      rows.push({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute("type") || "",
        role: role || "",
        "aria-checked": ariaChecked === null ? "" : ariaChecked,
        "aria-label": (el.getAttribute("aria-label") || "").slice(0, 40),
        text: (el.innerText || "").trim().split("\n")[0].slice(0, 40),
      });
    }
    console.log("[presenter-f4] could not resolve the dialog's controls. What is in it:");
    console.table(rows);
    console.log("[presenter-f4] dialog element:", dialog);
  }

  /**
   * Canva's and Google's controls listen for pointer events, not just `click`,
   * so replay the full sequence a real mouse would produce.
   */
  function realClick(el) {
    try {
      el.scrollIntoView({ block: "center", inline: "center" });
    } catch {}
    const rect = el.getBoundingClientRect();
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      button: 0,
    };
    if (typeof el.focus === "function") el.focus();

    const sequence = [
      ["pointerover", 0],
      ["pointerenter", 0],
      ["mouseover", 0],
      ["pointerdown", 1],
      ["mousedown", 1],
      ["pointerup", 0],
      ["mouseup", 0],
      ["click", 0],
    ];
    for (const [type, buttons] of sequence) {
      const pointer = type.startsWith("pointer") && typeof PointerEvent === "function";
      const init = pointer
        ? { ...base, buttons, pointerId: 1, pointerType: "mouse", isPrimary: true }
        : { ...base, buttons };
      el.dispatchEvent(pointer ? new PointerEvent(type, init) : new MouseEvent(type, init));
    }
  }

  // ------------------------------------------------------------------ toast --
  let toastHost = null;
  function toast(message, durationMs = 2800) {
    if (!toastHost) {
      toastHost = document.createElement("div");
      toastHost.attachShadow({ mode: "open" });
      document.documentElement.appendChild(toastHost);
    }
    toastHost.shadowRoot.innerHTML = `
      <style>
        .t {
          position: fixed; z-index: 2147483647; left: 50%; bottom: 32px;
          transform: translateX(-50%);
          padding: 10px 16px; border-radius: 8px;
          background: rgba(20, 20, 22, .92); color: #fff;
          font: 500 13px/1.4 -apple-system, "Segoe UI", system-ui, sans-serif;
          box-shadow: 0 6px 24px rgba(0, 0, 0, .3);
          pointer-events: none; max-width: 70vw;
          white-space: pre-line;
        }
      </style>
      <div class="t"></div>`;
    toastHost.shadowRoot.querySelector(".t").textContent = message;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => {
      if (toastHost) toastHost.shadowRoot.innerHTML = "";
    }, durationMs);
  }

  // --------------------------------------------------- talking to the worker --
  let pendingPopOut = null;

  /**
   * Ask the service worker to pull this tab into a window of its own, and wait
   * until it has. Resolves either way: if the message fails the presenting
   * still works, it just happens in the window the tab is already in.
   */
  function popOutTab(timeoutMs = 2500) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        pendingPopOut = null;
        resolve();
      };
      pendingPopOut = finish;

      try {
        const sending = chrome.runtime.sendMessage({ type: "pop-out-tab" });
        if (sending && typeof sending.then === "function") sending.then(finish, () => {});
      } catch {
        finish();
      }
      setTimeout(finish, timeoutMs);
    });
  }

  /**
   * Tell the worker to watch for the window the app is about to open, so it can
   * pop the slides out and park them on the other display. Fire this *before*
   * the click: the window can appear immediately.
   */
  function armWindowMover() {
    try {
      const sending = chrome.runtime.sendMessage({ type: "arm-presenter-move" });
      if (sending && typeof sending.catch === "function") sending.catch(() => {});
    } catch {
      // Extension reloaded out from under this page. Presenting still works;
      // only the window move is lost.
    }
  }

  // ------------------------------------------------------ strategy: Canva --
  async function runPopAndMove(site) {
    // The menu may already be open — take the shortcut if so.
    const open = findMatch(site.itemPatterns);
    if (open) {
      armWindowMover();
      realClick(open);
      return;
    }

    const opener = findMatch(site.openPatterns);
    if (!opener) {
      toast(`F4: no present control found on this ${site.name} page.`);
      return;
    }
    realClick(opener);

    const item = await waitForMatch(site.itemPatterns, MENU_TIMEOUT_MS);
    if (!item) {
      toast(`F4: opened the ${site.name} present menu, but found no "Presenter view".`);
      return;
    }
    armWindowMover();
    realClick(item);
  }

  // ---------------------------------------------- strategy: Google Slides --
  function findDialog() {
    for (const dialog of deepQueryAll(DIALOG_SELECTOR)) {
      if (!isVisible(dialog)) continue;
      const text = dialog.innerText || "";
      if (/display options|start slideshow/i.test(text)) return dialog;
    }
    return null;
  }

  /**
   * Pick the monitor to present on: the pinned one if a display name is set in
   * the options, otherwise whichever option is not the screen the browser is on. Slides
   * lists the current screen as "(current)", and names the other one, so the
   * one to take is simply the one that is not "(current)".
   *
   * Only the first line of each row is considered: the second line of the
   * "(current)" row also contains the other monitor's name, which would make a
   * naive name match ambiguous.
   */
  function pickDisplayOption(toggles, site) {
    // Prefer anything that says it is a radio; otherwise take whatever is left
    // once the three named checkboxes are accounted for.
    let candidates = toggles.filter((t) => t.kind === "radio");
    if (!candidates.length) {
      candidates = toggles.filter(
        (t) => t.label && !site.togglePatterns.some((p) => p.test(t.label)),
      );
    }
    if (!candidates.length) return null;

    const pinnedName = (settings.preferredDisplayName || "").trim();
    if (pinnedName) {
      const pinned = candidates.find((t) =>
        t.label.toLowerCase().includes(pinnedName.toLowerCase()),
      );
      if (pinned) return pinned;
    }

    const other = candidates.find((t) => t.label && !CURRENT_SCREEN.test(t.label));
    return other || candidates[0];
  }

  async function runDisplayOptions(site) {
    // 1. Give the deck a window of its own before anything else.
    await popOutTab();
    await sleep(SETTLE_MS); // the tab was re-parented; let layout settle

    // 2. Open the menu beside the Slideshow button.
    let opener = findMatch(site.openPatterns);
    if (!opener) {
      // Unlabelled caret: find it by position instead.
      const slideshow = findMatch([/^slideshow$/i, /^slideshow\b/i]);
      if (slideshow) opener = findAdjacentControl(slideshow);
    }
    if (!opener) {
      toast("F4: couldn't find the Slideshow dropdown.");
      return;
    }
    realClick(opener);

    // 3. Presentation display options.
    const item = await waitForMatch(site.itemPatterns, MENU_TIMEOUT_MS);
    if (!item) {
      toast('F4: no "Presentation display options" in the Slideshow menu.');
      return;
    }
    realClick(item);

    // 4. The dialog: tick the three boxes, choose the other monitor.
    const dialog = await waitFor(findDialog, DIALOG_TIMEOUT_MS);
    if (!dialog) {
      toast("F4: the display options dialog never appeared.");
      return;
    }

    const toggles = collectToggles(dialog);
    const failed = [];

    for (const pattern of site.togglePatterns) {
      const matches = toggles.filter((t) => pattern.test(t.label));
      const best = matches.length ? bestToggle(matches) : null;
      if (!best || !(await ensureChecked(best.el))) {
        failed.push(readableName(pattern));
      }
    }

    const display = pickDisplayOption(toggles, site);
    if (!display || !(await ensureChecked(display.el))) {
      failed.push("the monitor choice");
    }

    if (failed.length) {
      dumpDialog(dialog);
      toast(
        `F4: couldn't set ${failed.join(", ")}.\n` +
          "The dialog is still open — set it by hand.\n" +
          "Details are in this page's DevTools console.",
        8000,
      );
      return; // better an open dialog than a slideshow with the wrong settings
    }

    // 5. Go. Slides puts the slideshow on the chosen monitor itself, so the
    //    service worker has nothing to do here.
    const startButton = findMatch(site.startPatterns, dialog);
    if (!startButton) {
      toast('F4: everything is set, but no "Start slideshow" button was found.', 5000);
      return;
    }
    realClick(startButton);
  }

  // ------------------------------------------------------------------- main --
  let running = false;

  async function openPresenterView() {
    if (running) return;
    running = true;
    try {
      const site = siteFor();
      if (!site) return; // not a deck we know how to present

      if (site.strategy === "display-options") await runDisplayOptions(site);
      else await runPopAndMove(site);
    } finally {
      running = false;
    }
  }

  const IS_TOP = window.top === window;

  function onKeyDown(event) {
    if (event.key !== settings.triggerKey) return;
    if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
    if (event.repeat) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    if (IS_TOP) openPresenterView();
    // Focus is inside one of the app's iframes; the present control lives in
    // the top document, so hand the request up.
    else window.top.postMessage({ __canvaF4: "trigger" }, "*");
  }

  document.addEventListener("keydown", onKeyDown, true);

  if (IS_TOP) {
    const site = siteFor();
    // One line, so a glance at the page console answers "is it even running?".
    console.log(
      `[presenter-f4] ready — ${site ? site.name : "no matching app on this page"}` +
        `, key: ${settings.triggerKey}`,
    );
  }

  if (IS_TOP) {
    window.addEventListener("message", (event) => {
      if (!event.data || event.data.__canvaF4 !== "trigger") return;
      openPresenterView();
    });

    chrome.runtime.onMessage.addListener((message) => {
      if (!message) return;
      // The worker reports failures, so the result is visible without opening
      // the worker's console.
      if (message.type === "canva-f4-report") toast(message.text, message.durationMs || 6000);
      // Backstop in case the message port broke while the tab was re-parented.
      if (message.type === "canva-f4-popped" && pendingPopOut) pendingPopOut();
    });
  }

  // ------------------------------------------------------------ diagnostics --
  window.__canvaF4 = {
    site: siteFor(),
    trigger: openPresenterView,
    debug() {
      const site = siteFor();
      console.log("site:", site ? `${site.name} (${site.strategy})` : "(none — F4 does nothing here)");
      if (site) {
        let opener = findMatch(site.openPatterns);
        if (!opener && site.strategy === "display-options") {
          const slideshow = findMatch([/^slideshow$/i, /^slideshow\b/i]);
          console.log("slideshow button:", slideshow);
          opener = slideshow && findAdjacentControl(slideshow);
          console.log("caret (found by position):", opener);
        } else {
          console.log("open control:", opener);
        }
        console.log("menu item:", findMatch(site.itemPatterns));
      }
      const dialog = findDialog();
      if (dialog) {
        const toggles = collectToggles(dialog);
        console.log("dialog is open. Toggles found:");
        console.table(
          toggles.map((t) => ({
            label: t.label,
            kind: t.kind,
            readable: hasReadableState(t.el),
            checked: hasReadableState(t.el) ? isChecked(t.el) : "?",
            matches: (site ? site.togglePatterns : [])
              .filter((p) => p.test(t.label))
              .map(String)
              .join(" "),
          })),
        );
        const display = site && pickDisplayOption(toggles, site);
        console.log("monitor it would pick:", display ? display.label : "(none)");
        if (!toggles.length) dumpDialog(dialog);
      }
      const rows = deepQueryAll(CLICKABLE_SELECTOR)
        .filter(isVisible)
        .map((el) => ({ label: labelOf(el), element: el }))
        .filter((row) => row.label);
      console.table(rows.map((r) => ({ label: r.label })));
      return rows;
    },
  };
})();
