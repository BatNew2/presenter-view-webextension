/*
 * Shared settings, loaded by the content script, the service worker and the
 * options page alike. Stored in chrome.storage.sync, so they follow the user
 * to their other Chrome installs.
 *
 * Everything here has a working default: the extension behaves correctly
 * without anyone ever opening the options page.
 */
(function (scope) {
  "use strict";

  const DEFAULTS = {
    // Content script.
    triggerKey: "F4",
    // Google Slides picks the monitor itself, by the name shown in its own
    // dialog. Empty means "whichever screen is not the current one".
    preferredDisplayName: "",

    // Service worker (the Canva path).
    targetDisplay: "secondary", // "secondary" | "leftmost" | a display id
    // Where the presenter/notes window goes.
    //   "primary"  -> the primary monitor (the default)
    //   "opposite" -> whichever monitor the slides did not go to
    //   a display id
    notesDisplay: "primary",
    slidesWindow: "source", // "source" | "new"
    finalState: "fullscreen", // "fullscreen" | "maximized" | "normal"
    focusNotesAfter: true,
  };

  /** Stored setting -> the CONFIG key the service worker already uses. */
  const CONFIG_KEYS = {
    targetDisplay: "TARGET_DISPLAY",
    notesDisplay: "NOTES_DISPLAY",
    slidesWindow: "SLIDES_WINDOW",
    finalState: "FINAL_STATE",
    focusNotesAfter: "FOCUS_NOTES_AFTER",
  };

  async function load() {
    try {
      // Passing the defaults object means missing keys come back filled in.
      const stored = await chrome.storage.sync.get(DEFAULTS);
      return { ...DEFAULTS, ...stored };
    } catch {
      // Storage can be unavailable (extension reloading, profile locked).
      // Defaults keep everything working.
      return { ...DEFAULTS };
    }
  }

  async function save(patch) {
    await chrome.storage.sync.set(patch);
  }

  function onChange(callback) {
    if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.onChanged) {
      return;
    }
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "sync") callback(changes);
    });
  }

  /** Copy stored settings onto the service worker's CONFIG object in place. */
  function applyToConfig(settings, config) {
    for (const [key, configKey] of Object.entries(CONFIG_KEYS)) {
      if (settings[key] !== undefined) config[configKey] = settings[key];
    }
    return config;
  }

  scope.PresenterSettings = { DEFAULTS, load, save, onChange, applyToConfig };
})(typeof self !== "undefined" ? self : globalThis);
