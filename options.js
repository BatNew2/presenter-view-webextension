/*
 * Options page. Saves on every change — there is no Save button to forget.
 *
 * The "Present on" list is built from the monitors Chrome can actually see, so
 * you pick a real screen by name instead of typing one.
 */
(() => {
  "use strict";

  const { DEFAULTS, load, save } = self.PresenterSettings;

  // Chrome claims these before a web page ever sees them.
  const CHROME_KEYS = { F1: "help", F3: "find", F5: "reload", F6: "address bar", F11: "fullscreen", F12: "DevTools" };

  const el = (id) => document.getElementById(id);
  const status = el("status");

  let saveTimer = null;
  function flash() {
    status.classList.add("show");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => status.classList.remove("show"), 1200);
  }

  async function put(patch) {
    await save(patch);
    flash();
  }

  function buildTriggerKeys(selected) {
    const select = el("triggerKey");
    select.innerHTML = "";
    for (let n = 1; n <= 12; n++) {
      const key = `F${n}`;
      const option = document.createElement("option");
      option.value = key;
      option.textContent = CHROME_KEYS[key] ? `${key} — Chrome uses this for ${CHROME_KEYS[key]}` : key;
      select.append(option);
    }
    select.value = selected;
    if (select.value !== selected) {
      // A key that is not in the list (hand-edited storage); keep it visible.
      const option = document.createElement("option");
      option.value = selected;
      option.textContent = selected;
      select.append(option);
      select.value = selected;
    }
  }

  function addOption(select, value, text) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    select.append(option);
    return option;
  }

  function displayLabel(display) {
    const { width, height } = display.bounds;
    const name = display.name || `Display ${display.id}`;
    return `${name} — ${width}×${height}${display.isPrimary ? " (primary)" : ""}`;
  }

  /**
   * Fill a monitor picker: some named choices that work on any machine, then
   * every monitor currently attached. Keeps a saved-but-unplugged monitor in
   * the list so the setting is not silently lost when it is disconnected.
   */
  function fillDisplaySelect(select, displays, saved, generic, fallbackLabel) {
    select.innerHTML = "";
    for (const [value, text] of generic) addOption(select, value, text);
    for (const display of displays) addOption(select, display.id, displayLabel(display));

    select.value = saved;
    if (select.value !== saved) {
      addOption(select, saved, `${fallbackLabel || saved} — not connected`);
      select.value = saved;
    }
  }

  async function buildDisplays(settings) {
    let displays = [];
    try {
      displays = await chrome.system.display.getInfo();
    } catch {
      // Fall through with just the generic choices.
    }

    const slides = el("targetDisplay");
    const notes = el("notesDisplay");

    fillDisplaySelect(
      slides,
      displays,
      settings.targetDisplay,
      [
        ["secondary", "My other monitor (default)"],
        ["leftmost", "The left-hand monitor"],
      ],
      settings.preferredDisplayName,
    );

    fillDisplaySelect(
      notes,
      displays,
      settings.notesDisplay,
      [
        ["primary", "My main monitor (default)"],
        ["opposite", "Whichever screen the slides did not go to"],
      ],
    );

    if (displays.length <= 1) {
      el("displayHint").textContent =
        "Only one monitor is connected, so the slides will go fullscreen on this one.";
    }

    // Remember the chosen monitor's NAME too: Google Slides picks the screen in
    // its own dialog, where the only thing to go on is the name the OS reports.
    slides.addEventListener("change", () => {
      const chosen = displays.find((d) => String(d.id) === slides.value);
      put({
        targetDisplay: slides.value,
        preferredDisplayName: chosen ? chosen.name || "" : "",
      });
    });

    notes.addEventListener("change", () => put({ notesDisplay: notes.value }));
  }

  function bindSelect(id) {
    el(id).addEventListener("change", (event) => put({ [id]: event.target.value }));
  }

  function bindCheckbox(id) {
    el(id).addEventListener("change", (event) => put({ [id]: event.target.checked }));
  }

  async function init() {
    const settings = await load();

    buildTriggerKeys(settings.triggerKey || DEFAULTS.triggerKey);
    await buildDisplays(settings);

    el("focusNotesAfter").checked = settings.focusNotesAfter;
    el("slidesWindow").value = settings.slidesWindow;
    el("finalState").value = settings.finalState;

    bindSelect("triggerKey");
    bindSelect("slidesWindow");
    bindSelect("finalState");
    bindCheckbox("focusNotesAfter");
  }

  init();
})();
