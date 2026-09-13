/*
 * Puts the SLIDES on your other monitor, in a window of their own, fullscreen.
 * The presenter/notes window is left where it lands.
 *
 * This half is app-agnostic: it never looks at which site the deck came from,
 * only at which windows appeared. Canva and Google Slides both split presenter
 * view the same way (observed for Canva, assumed for Slides):
 *   - the tab you pressed F4 in -> the SLIDES
 *   - the new window that opens -> the notes + timer panel
 * So the tab to pop out is the one you started from. If an app does it the
 * other way round, flip CONFIG.SLIDES_WINDOW to "new".
 *
 * An extension cannot press Win+Shift+Left -- that is an OS shortcut and Chrome
 * has no way to send keystrokes to the window manager. What it can do is set the
 * window's position directly. Chrome window coordinates live in one virtual
 * desktop that spans every monitor, so a display to the left of the primary one
 * simply has a negative `left`. Moving a window there is the same end result.
 *
 * The fiddly part is that `state: "fullscreen"` fullscreens a window on the
 * display it is CURRENTLY on. If the move has not landed yet, fullscreen drags
 * it straight back to the old monitor. So every placement is verified and
 * retried rather than fired and forgotten -- see placeAndVerify.
 */

// The worker is a classic (non-module) service worker, so this is how the
// shared settings are pulled in.
importScripts("settings.js");

// ------------------------------------------------------------------ config --
const CONFIG = {
  // Which surface holds the slides.
  //   "source" -> the tab you pressed F4 in (how Canva behaves today)
  //   "new"    -> the window Canva opens
  SLIDES_WINDOW: "source",

  // Where to send the slides. Any of:
  //   "secondary"       -> the first non-primary monitor (the default)
  //   "leftmost"        -> the monitor with the lowest x
  //   "left-of-current" -> one display left of the Canva window, wrapping at
  //                        the edge, which is what Win+Shift+Left does
  //   0, 1, 2 ...       -> an explicit display, indexed left to right
  //   "<display id>"    -> an explicit display by id
  //
  // "secondary" rather than "leftmost" because Windows' arrangement of your
  // monitors need not match where they physically sit: an external screen kept
  // on your left is commonly still arranged to the RIGHT of the laptop, giving
  // it a positive x. "The other monitor" survives that; "the left one" does not.
  // The console log lists every display with its index and id, so if the
  // automatic choice is wrong you can pin the exact one here.
  TARGET_DISPLAY: "secondary",

  // Where the presenter/notes window goes once the slides are placed.
  //   "primary"  -> the primary monitor (the default)
  //   "opposite" -> whichever monitor the slides did not go to
  //   "<display id>"
  // Skipped when it resolves to the display the slides are on, or when the
  // notes window is already there. Its own window state is preserved: a
  // presenter panel that fullscreened itself stays fullscreen.
  NOTES_DISPLAY: "primary",

  // "fullscreen" | "maximized" | "normal"
  FINAL_STATE: "fullscreen",

  // Fullscreen the slides on the screen they start on, hold for this long, and
  // only then move them across.
  //
  // 0 (the default) skips that: the window is created on the target monitor at
  // full-monitor size and fullscreens there, once. Any value above 0 means the
  // window fullscreens TWICE -- once where it started, then again after the
  // move -- because Chrome cannot reposition a fullscreen window, so crossing
  // monitors has to drop it back to `normal` in between.
  FULLSCREEN_FIRST_MS: 0,

  // After the slides are placed, hand focus back to Canva's presenter window so
  // you can drive the deck from it. Set false to leave focus on the slides.
  FOCUS_NOTES_AFTER: true,

  // How long to watch for Canva to open its presenter window after F4.
  ARM_MS: 12000,

  // Once it appears, how long to let the original tab settle into presentation
  // mode before pulling it out.
  SETTLE_MS: 900,

  // Backoff between failed placement attempts. Window operations no longer
  // wait a fixed time -- they poll until the window stops moving -- so this
  // only applies when an attempt has to be retried.
  STEP_MS: 250,

  // Pause between the window arriving on the target monitor and going
  // fullscreen. This one is deliberately short: it is the only stretch your
  // audience sees a windowed browser. Raise it only if fullscreen starts
  // landing on the wrong screen again.
  PRE_FULLSCREEN_MS: 40,

  // How many times to re-place the window if it does not stay put.
  PLACE_ATTEMPTS: 3,

  // Show a toast on the slides when the move fails. Silent on success, so it
  // never covers the deck during an actual presentation.
  SHOW_FAILURE_TOAST: true,

  // Log to the service worker console.
  DEBUG: true,
};

/**
 * Fallback test for "did this new tab come from the deck we armed on?", used
 * when Chrome does not report an openerTabId.
 */
const PRESENTER_URL = /^https?:\/\/([^/]*\.)?(canva\.com|docs\.google\.com)\//;

const log = (...args) => {
  if (CONFIG.DEBUG) console.log("[presenter-f4]", ...args);
};

/**
 * Fold the user's saved options into CONFIG. Called at the start of each flow
 * rather than once at startup: a service worker is torn down and restarted
 * constantly, and this way a change made in the options page applies to the
 * very next keypress.
 */
async function refreshConfig() {
  const settings = await self.PresenterSettings.load();
  self.PresenterSettings.applyToConfig(settings, CONFIG);
  return settings;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Surface a problem on the page itself, so the worker console is optional. */
function report(tabId, text) {
  if (!CONFIG.SHOW_FAILURE_TOAST || tabId === undefined) return;
  chrome.tabs
    .sendMessage(tabId, { type: "canva-f4-report", text })
    .catch(() => {}); // tab may have navigated or closed
}

// ------------------------------------------------------------------- state --
let armed = null;

function disarm() {
  if (!armed) return;
  clearTimeout(armed.expiry);
  if (armed.settle) clearTimeout(armed.settle);
  armed = null;
}

function arm(tab) {
  disarm();
  armed = {
    sourceTabId: tab.id,
    sourceWindowId: tab.windowId,
    newTabIds: [],
    expiry: setTimeout(() => {
      log("timed out: Canva never opened a presenter window");
      disarm();
    }, CONFIG.ARM_MS),
    settle: null,
  };
  log("armed on tab", tab.id, "in window", tab.windowId);
}

// ---------------------------------------------------------------- displays --
async function pickDisplay(currentWindowId) {
  const displays = await chrome.system.display.getInfo();
  if (!displays.length) return null;

  // Left to right across the virtual desktop.
  const byX = [...displays].sort((a, b) => a.bounds.left - b.bounds.left);
  byX.forEach((d, i) => {
    const b = d.bounds;
    log(
      `display[${i}] id=${d.id} x=${b.left} y=${b.top} ${b.width}x${b.height}` +
        `${d.isPrimary ? " PRIMARY" : ""} ${d.name || ""}`,
    );
  });

  const target = CONFIG.TARGET_DISPLAY;

  if (typeof target === "number") {
    const index = Math.max(0, Math.min(byX.length - 1, target));
    if (index !== target) log("display index", target, "out of range, using", index);
    return byX[index];
  }

  if (target === "secondary") {
    const other = byX.find((d) => !d.isPrimary);
    if (other) return other;
    log("only one display, no secondary");
    return byX[0];
  }

  if (target === "left-of-current") {
    if (byX.length === 1) return byX[0];
    const win = await chrome.windows.get(currentWindowId).catch(() => null);
    if (!win || typeof win.left !== "number") return byX[0];
    const centerX = win.left + (win.width || 0) / 2;
    const current = byX.findIndex(
      (d) => centerX >= d.bounds.left && centerX < d.bounds.left + d.bounds.width,
    );
    if (current === -1) return byX[0];
    return byX[(current - 1 + byX.length) % byX.length]; // wrap, like the OS does
  }

  if (target !== "leftmost") {
    const byId = byX.find((d) => String(d.id) === String(target));
    if (byId) return byId;
    log("no display with id", target, "- falling back to leftmost");
  }

  return byX[0];
}

/**
 * Which monitor the presenter/notes window should end up on. Returns null when
 * there is nowhere sensible to put it — one monitor, or the only candidate is
 * the one the slides are already using.
 */
async function pickNotesDisplay(slidesDisplay) {
  const displays = await chrome.system.display.getInfo();
  if (displays.length < 2) return null;

  const target = CONFIG.NOTES_DISPLAY;
  let chosen = null;

  if (target === "opposite") {
    const others = displays.filter((d) => d.id !== slidesDisplay.id);
    chosen = others.find((d) => d.isPrimary) || others[0] || null;
  } else if (target === "primary") {
    chosen = displays.find((d) => d.isPrimary) || displays[0];
  } else {
    chosen = displays.find((d) => String(d.id) === String(target)) || null;
    if (!chosen) log("no display with id", target, "- leaving the notes window alone");
  }

  if (chosen && chosen.id === slidesDisplay.id) {
    log("notes want display", chosen.id, "but the slides are there - leaving it alone");
    return null;
  }
  return chosen;
}

/** Is the window sitting on this display? */
function isOn(win, display) {
  if (!win || typeof win.left !== "number") return false;
  const centerX = win.left + (win.width || 0) / 2;
  const centerY = win.top + (win.height || 0) / 2;
  const b = display.bounds;
  return (
    centerX >= b.left &&
    centerX < b.left + b.width &&
    centerY >= b.top &&
    centerY < b.top + b.height
  );
}

// ------------------------------------------------------------------ moving --
/**
 * Ask Chrome to put the window at `bounds`, then check where it actually went.
 *
 * Chrome's window coordinates and chrome.system.display's bounds do not always
 * agree across monitors with different DPI scaling -- ask for x=1536 and the
 * window can land somewhere else. Rather than model that, measure the error and
 * push by the same amount again.
 */
/**
 * Read a window's geometry once it has stopped changing.
 *
 * Reading straight after an update can return the window's OLD position, which
 * would make the offset correction below overshoot badly. Waiting a fixed
 * 250ms was safe but it is time the audience spends looking at a windowed
 * browser, so instead poll until two consecutive reads agree -- usually a
 * couple of frames.
 */
async function readSettled(windowId, timeoutMs = 600) {
  const deadline = Date.now() + timeoutMs;
  let previous = null;
  while (Date.now() < deadline) {
    const win = await chrome.windows.get(windowId).catch(() => null);
    if (!win) return null;
    if (
      previous &&
      previous.left === win.left &&
      previous.top === win.top &&
      previous.width === win.width &&
      previous.state === win.state
    ) {
      return win;
    }
    previous = win;
    await sleep(30);
  }
  return previous;
}

async function moveTo(windowId, bounds) {
  await chrome.windows.update(windowId, { ...bounds, focused: true });

  let win = await readSettled(windowId);
  if (!win) return null;

  const dx = bounds.left - win.left;
  const dy = bounds.top - win.top;
  if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
    log(`asked for x=${bounds.left} y=${bounds.top}, landed at x=${win.left} y=${win.top}`);
    await chrome.windows.update(windowId, {
      left: bounds.left + dx,
      top: bounds.top + dy,
      width: bounds.width,
      height: bounds.height,
    });
    win = await readSettled(windowId);
    if (win) log(`after correction: x=${win.left} y=${win.top}`);
  }
  return win;
}

/**
 * Move `windowId` onto `display` and put it in CONFIG.FINAL_STATE, checking
 * that it actually went there. Chrome will happily report success on an update
 * it then undoes, so this re-reads the window and retries.
 */
async function placeAndVerify(windowId, display, finalState = CONFIG.FINAL_STATE) {
  // Full monitor bounds, not the work area. The window is only in this geometry
  // for a few frames before going fullscreen, and matching the fullscreen rect
  // exactly means the audience sees no resize -- just the browser chrome
  // vanishing. Sizing to the work area would visibly jump by the taskbar.
  const bounds = {
    left: display.bounds.left,
    top: display.bounds.top,
    width: display.bounds.width,
    height: display.bounds.height,
  };

  for (let attempt = 1; attempt <= CONFIG.PLACE_ATTEMPTS; attempt++) {
    const current = await readSettled(windowId);
    if (!current) return false;

    // Bounds are ignored on a maximized or fullscreen window.
    if (current.state !== "normal") {
      await chrome.windows.update(windowId, { state: "normal" });
      await readSettled(windowId);
    }

    // windows.create may already have landed it exactly where we want, in which
    // case repositioning only adds another visible frame.
    if (attempt === 1 && current.state === "normal" && isOn(current, display)) {
      log("already on display", display.id, "- going straight to fullscreen");
    } else {
      await moveTo(windowId, bounds);
    }

    // Apply the final state unconditionally, even when the move looks wrong.
    // A fullscreen window on the wrong monitor is one drag away from right; a
    // small window left in limbo because we bailed out early is just broken.
    if (finalState !== "normal") {
      await sleep(CONFIG.PRE_FULLSCREEN_MS);
      await chrome.windows.update(windowId, { state: finalState });
    }

    const win = await readSettled(windowId);
    if (isOn(win, display)) {
      log("placed on display", display.id, win.state, "at x =", win.left);
      return true;
    }

    log(
      `attempt ${attempt}: wanted display ${display.id} (x=${display.bounds.left}), ` +
        `window is at x=${win && win.left} ${win && win.state}`,
    );
    await sleep(CONFIG.STEP_MS * 2);
  }

  log(
    "!! could not get the window onto display",
    display.id,
    "- left it",
    finalState,
    "where it is. Try raising CONFIG.PRE_FULLSCREEN_MS, or pin",
    "CONFIG.TARGET_DISPLAY to the index or id above.",
  );
  return false;
}

/**
 * Move the presenter/notes window onto `display`, keeping whatever window state
 * it already had — Canva's presenter panel fullscreens itself, and it should
 * stay fullscreen on its new monitor rather than being dropped to a bare window.
 */
async function placeNotesWindow(windowId, display) {
  const win = await chrome.windows.get(windowId).catch(() => null);
  if (!win) return;

  if (isOn(win, display)) {
    log("notes window is already on display", display.id);
    return;
  }

  const keepState =
    win.state === "fullscreen" || win.state === "maximized" ? win.state : "normal";
  log("moving notes window", windowId, "to display", display.id, "as", keepState);
  await placeAndVerify(windowId, display, keepState);
}

/**
 * Give `tabId` a window of its own on `display`.
 * Returns the id of the window it ended up in, or null.
 */
async function popOutOnto(tabId, display) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) {
    log("tab", tabId, "is gone");
    return { windowId: null, placed: false };
  }

  const win = await chrome.windows.get(tab.windowId, { populate: true }).catch(() => null);
  if (!win) return { windowId: null, placed: false };

  let windowId = win.id;

  const holdFirst = CONFIG.FULLSCREEN_FIRST_MS > 0 && CONFIG.FINAL_STATE !== "normal";

  if (win.tabs && win.tabs.length > 1) {
    // Sharing a window with your other tabs -- pull this one out into its own.
    //
    // With no hold, aim it at the target monitor at full-monitor size straight
    // away: the window is born where it belongs and the only thing left to do
    // is drop the browser chrome. With a hold, leave it where Chrome puts it,
    // next to the window it came from, so it fullscreens there first.
    const created = await chrome.windows.create(
      holdFirst
        ? { tabId, focused: true }
        : {
            tabId,
            left: display.bounds.left,
            top: display.bounds.top,
            width: display.bounds.width,
            height: display.bounds.height,
            focused: true,
          },
    );
    if (!created) {
      log("windows.create failed for tab", tabId);
      return { windowId: null, placed: false };
    }
    windowId = created.id;
    log("popped tab", tabId, "into new window", windowId, "at x =", created.left);
    await readSettled(windowId);
  } else {
    log("tab", tabId, "is already alone in window", windowId);
  }

  if (holdFirst) {
    await chrome.windows.update(windowId, { state: CONFIG.FINAL_STATE });
    const shown = await readSettled(windowId);
    log(
      `${CONFIG.FINAL_STATE} at x = ${shown && shown.left}, holding ` +
        `${CONFIG.FULLSCREEN_FIRST_MS}ms before moving`,
    );
    await sleep(CONFIG.FULLSCREEN_FIRST_MS);
  }

  const placed = await placeAndVerify(windowId, display);
  return { windowId, placed };
}

// ---------------------------------------------------------------- deciding --
async function finish(snapshot) {
  const { sourceTabId, sourceWindowId, newTabIds } = snapshot;
  log("presenter windows opened:", newTabIds, "| source tab:", sourceTabId);

  const slidesTabId = CONFIG.SLIDES_WINDOW === "new" ? newTabIds[0] : sourceTabId;
  if (slidesTabId === undefined) {
    log("no candidate for the slides");
    return;
  }

  const display = await pickDisplay(sourceWindowId);
  if (!display) {
    report(slidesTabId, "F4: Chrome reported no displays.");
    return;
  }
  log("slides tab", slidesTabId, "-> display", display.id, "at x =", display.bounds.left);

  const { windowId: slidesWindowId, placed } = await popOutOnto(slidesTabId, display);
  if (!placed) {
    report(
      slidesTabId,
      `F4: couldn't move the slides to display ${display.id} (x=${display.bounds.left}).\n` +
        "Details in the extension's service worker console.",
    );
  }

  // The other half: the presenter/notes window.
  const notesTabId = CONFIG.SLIDES_WINDOW === "new" ? sourceTabId : newTabIds[0];
  if (notesTabId === undefined) return;
  const notesTab = await chrome.tabs.get(notesTabId).catch(() => null);
  if (!notesTab || notesTab.windowId === slidesWindowId) return;

  const notesDisplay = await pickNotesDisplay(display);
  if (notesDisplay) await placeNotesWindow(notesTab.windowId, notesDisplay);

  if (CONFIG.FOCUS_NOTES_AFTER) {
    // Focus last, so it survives the placement above.
    await chrome.windows.update(notesTab.windowId, { focused: true }).catch(() => {});
    log("focus returned to window", notesTab.windowId);
  }
}

// ------------------------------------------------------------------ wiring --
/**
 * Pull a tab into a window of its own, without moving it anywhere. Used by the
 * Google Slides path, where Slides places the slideshow on the chosen monitor
 * itself and all we owe it is a window that is not full of other tabs.
 */
async function popOutToOwnWindow(tab) {
  const win = await chrome.windows.get(tab.windowId, { populate: true }).catch(() => null);
  if (!win) return null;

  if (!win.tabs || win.tabs.length <= 1) {
    log("tab", tab.id, "is already alone in window", win.id);
    return win.id;
  }

  const created = await chrome.windows.create({ tabId: tab.id, focused: true });
  if (!created) {
    log("windows.create failed for tab", tab.id);
    return null;
  }
  await readSettled(created.id);
  log("popped tab", tab.id, "into its own window", created.id);
  return created.id;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !sender.tab) return;

  if (message.type === "arm-presenter-move") {
    // Arm synchronously so no window can open before we are watching; the
    // settings only matter later, once something has actually appeared.
    arm(sender.tab);
    refreshConfig();
    sendResponse({ armed: true });
    return;
  }

  if (message.type === "pop-out-tab") {
    refreshConfig().then(() => popOutToOwnWindow(sender.tab)).then((windowId) => {
      // Reply on the port, and also push a message: re-parenting a tab can
      // break the port it asked on, and the page is waiting on this.
      sendResponse({ windowId });
      chrome.tabs
        .sendMessage(sender.tab.id, { type: "canva-f4-popped", windowId })
        .catch(() => {});
    });
    return true; // keep the port open for the async reply
  }
});

chrome.tabs.onCreated.addListener((tab) => {
  if (!armed) return;

  const url = tab.pendingUrl || tab.url || "";
  const related = tab.openerTabId === armed.sourceTabId || PRESENTER_URL.test(url);
  if (!related) return;

  armed.newTabIds.push(tab.id);
  log("saw new tab", tab.id, url);

  // Canva may open more than one window. Wait for the dust to settle, and for
  // the original tab to switch into presentation mode, before moving anything.
  if (armed.settle) clearTimeout(armed.settle);
  armed.settle = setTimeout(() => {
    const snapshot = armed;
    disarm();
    finish(snapshot).catch((error) => log("failed:", String(error)));
  }, CONFIG.SETTLE_MS);
});
