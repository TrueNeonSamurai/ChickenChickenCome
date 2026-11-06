import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import "./styles.css";

type ClickConfig = {
  intervalMs: number;
  repeatCount: number | null;
  mouseButton: "left" | "right" | "middle";
  clickType: "single" | "double";
  useCurrentPosition: boolean;
  x: number;
  y: number;
  stopOnEdge: boolean;
};

type StatusPayload = { running: boolean; message: string };
type ProgressPayload = { clicks: number; cycles: number };

const byId = <T extends HTMLElement>(id: string) => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing UI element: ${id}`);
  return node as T;
};
const value = (id: string) => byId<HTMLInputElement | HTMLSelectElement>(id).value;
const numberValue = (id: string) => Number(value(id));
const checked = (id: string) => byId<HTMLInputElement>(id).checked;
const toast = byId<HTMLDivElement>("toast");
let toastTimer: number | undefined;
let running = false;
let desktop = false;
let unlistenFns: UnlistenFn[] = [];
type HotkeyKind = "toggle" | "stop";
let capturingHotkey: HotkeyKind | null = null;
let toggleShortcut = "F6";
let stopShortcut = "F7";
let registeredShortcuts: string[] = [];

function notify(message: string) {
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("show"), 2700);
}

function readConfig(): ClickConfig {
  const hours = numberValue("hours");
  const minutes = numberValue("minutes");
  const seconds = numberValue("seconds");
  const milliseconds = numberValue("milliseconds");
  if (![hours, minutes, seconds, milliseconds].every(Number.isFinite)) throw new Error("Enter valid interval values.");
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59 || seconds < 0 || seconds > 59 || milliseconds < 0 || milliseconds > 999) {
    throw new Error("Use 0–23 hours, 0–59 minutes/seconds and 0–999 milliseconds.");
  }
  const intervalMs = (((hours * 60 + minutes) * 60 + seconds) * 1000) + milliseconds;
  if (intervalMs < 1) throw new Error("The interval must be at least 1 millisecond.");
  const repeatMode = document.querySelector<HTMLInputElement>('input[name="repeat-mode"]:checked')?.value ?? "infinite";
  const repeatCount = repeatMode === "finite" ? numberValue("repeat-count") : null;
  if (repeatCount !== null && (!Number.isInteger(repeatCount) || repeatCount < 1 || repeatCount > 1_000_000)) {
    throw new Error("Repeat count must be between 1 and 1,000,000 cycles.");
  }
  const positionMode = document.querySelector<HTMLInputElement>('input[name="position-mode"]:checked')?.value ?? "current";
  const x = numberValue("position-x");
  const y = numberValue("position-y");
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0) throw new Error("X and Y must be non-negative whole numbers.");
  return {
    intervalMs,
    repeatCount,
    mouseButton: value("mouse-button") as ClickConfig["mouseButton"],
    clickType: value("click-type") as ClickConfig["clickType"],
    useCurrentPosition: positionMode === "current",
    x,
    y,
    stopOnEdge: checked("edge-stop"),
  };
}

function intervalLabel(ms: number) {
  if (ms < 1000) return `${ms} ms`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} hour${ms === 3_600_000 ? "" : "s"}`;
  if (ms % 60_000 === 0) return `${ms / 60_000} minute${ms === 60_000 ? "" : "s"}`;
  if (ms % 1000 === 0) return `${ms / 1000} second${ms === 1000 ? "" : "s"}`;
  return `${(ms / 1000).toFixed(3).replace(/0+$/, "").replace(/\.$/, "")} seconds`;
}

function updateIntervalSummary() {
  try {
    const config = readConfig();
    byId<HTMLSpanElement>("interval-summary").textContent = `One click cycle every ${intervalLabel(config.intervalMs)}`;
  } catch {
    byId<HTMLSpanElement>("interval-summary").textContent = "Check your interval values";
  }
}

function updateModeControls() {
  const repeatMode = document.querySelector<HTMLInputElement>('input[name="repeat-mode"]:checked')?.value;
  byId<HTMLInputElement>("repeat-count").disabled = repeatMode !== "finite";
  const positionMode = document.querySelector<HTMLInputElement>('input[name="position-mode"]:checked')?.value;
  const fixed = positionMode === "fixed";
  byId<HTMLInputElement>("position-x").disabled = !fixed;
  byId<HTMLInputElement>("position-y").disabled = !fixed;
  byId<HTMLDivElement>("coordinate-row").setAttribute("aria-disabled", String(!fixed));
}

function setRunning(next: boolean, message: string) {
  running = next;
  const card = byId<HTMLDivElement>("status-card");
  card.dataset.state = next ? "running" : "idle";
  byId<HTMLSpanElement>("status-title").textContent = next ? "Clicking in progress" : (message || "Ready when you are");
  byId<HTMLSpanElement>("status-detail").textContent = next ? `Press ${toggleShortcut} or ${stopShortcut} to stop` : message;
  byId<HTMLButtonElement>("start-button").disabled = next || !desktop;
  byId<HTMLButtonElement>("stop-button").disabled = !next || !desktop;
  byId<HTMLButtonElement>("start-button").querySelector("span")!.textContent = next ? "Running…" : "Start clicking";
  byId<HTMLDivElement>("engine-note").innerHTML = next
    ? '<span class="engine-dot active"></span><span>Rust click engine is running</span>'
    : `<span class="engine-dot"></span><span>${desktop ? "Native engine ready" : "Native engine connects in the desktop app"}</span>`;
}

function persistSettings(showMessage = false) {
  const ids = ["hours", "minutes", "seconds", "milliseconds", "repeat-count", "mouse-button", "click-type", "position-x", "position-y"];
  const saved: Record<string, string | boolean> = {};
  ids.forEach((id) => saved[id] = value(id));
  saved["repeat-mode"] = document.querySelector<HTMLInputElement>('input[name="repeat-mode"]:checked')?.value ?? "infinite";
  saved["position-mode"] = document.querySelector<HTMLInputElement>('input[name="position-mode"]:checked')?.value ?? "current";
  saved["edge-stop"] = checked("edge-stop");
  saved["toggle-shortcut"] = toggleShortcut;
  saved["stop-shortcut"] = stopShortcut;
  localStorage.setItem("clickforge-settings-v1", JSON.stringify(saved));
  if (showMessage) notify("Settings saved on this device.");
}

function loadSettings() {
  const raw = localStorage.getItem("clickforge-settings-v1");
  if (!raw) return;
  try {
    const saved = JSON.parse(raw) as Record<string, string | boolean>;
    if (typeof saved["toggle-shortcut"] === "string") toggleShortcut = saved["toggle-shortcut"] as string;
    if (typeof saved["stop-shortcut"] === "string") stopShortcut = saved["stop-shortcut"] as string;
    Object.entries(saved).forEach(([id, savedValue]) => {
      if (id === "edge-stop") { byId<HTMLInputElement>(id).checked = Boolean(savedValue); return; }
      if (id === "repeat-mode" || id === "position-mode") {
        const radio = document.querySelector<HTMLInputElement>(`input[name="${id}"][value="${savedValue}"]`);
        if (radio) radio.checked = true;
        return;
      }
      const node = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
      if (node && typeof savedValue === "string") node.value = savedValue;
    });
  } catch { localStorage.removeItem("clickforge-settings-v1"); }
}

function resetSettings() {
  (byId<HTMLInputElement>("hours")).value = "0";
  byId<HTMLInputElement>("minutes").value = "0";
  byId<HTMLInputElement>("seconds").value = "1";
  byId<HTMLInputElement>("milliseconds").value = "0";
  byId<HTMLInputElement>("repeat-count").value = "100";
  byId<HTMLInputElement>('input[name="repeat-mode"][value="infinite"]').checked = true;
  byId<HTMLSelectElement>("mouse-button").value = "left";
  byId<HTMLSelectElement>("click-type").value = "single";
  byId<HTMLInputElement>('input[name="position-mode"][value="current"]').checked = true;
  byId<HTMLInputElement>("position-x").value = "500";
  byId<HTMLInputElement>("position-y").value = "350";
  byId<HTMLInputElement>("edge-stop").checked = true;
  updateModeControls(); updateIntervalSummary(); persistSettings(); notify("Defaults restored.");
}

async function startClicking() {
  if (!desktop) { notify("Open the installed desktop app to enable real mouse clicks."); return; }
  if (running) return;
  try {
    const config = readConfig();
    await invoke("start_clicking", { config });
    persistSettings();
    setRunning(true, "Session started");
  } catch (error) { notify(String(error)); }
}

async function stopClicking() {
  if (!desktop || !running) return;
  try { await invoke("stop_clicking"); }
  catch (error) { notify(String(error)); }
}

function applyTheme(theme: "light" | "dark") {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("clickforge-theme", theme);
}

function renderHotkeys() {
  byId<HTMLButtonElement>("toggle-hotkey").textContent = capturingHotkey === "toggle" ? "Press keys…" : toggleShortcut;
  byId<HTMLButtonElement>("stop-hotkey").textContent = capturingHotkey === "stop" ? "Press keys…" : stopShortcut;
}

function shortcutFromKeyboardEvent(event: KeyboardEvent): string | null {
  const modifierOnly = ["Control", "Alt", "Shift", "Meta"].includes(event.key);
  if (modifierOnly) return null;

  const code = event.code;
  let key = "";
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) key = code;
  else {
    const named: Record<string, string> = {
      Space: "Space", Escape: "Escape", Enter: "Enter", Tab: "Tab",
      Backspace: "Backspace", Delete: "Delete", Insert: "Insert",
      Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
      ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
      Pause: "Pause", PrintScreen: "PrintScreen"
    };
    key = named[code] ?? "";
  }
  if (!key) return null;

  const modifiers: string[] = [];
  if (event.ctrlKey) modifiers.push("Ctrl");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  if (event.metaKey) modifiers.push("Super");
  if (/^[A-Z0-9]$/.test(key) && modifiers.length === 0) return "__NEEDS_MODIFIER__";
  return [...modifiers, key].join("+");
}

async function configureHotkeys() {
  if (!desktop) return;
  const next = [toggleShortcut, stopShortcut];
  if (toggleShortcut === stopShortcut) throw new Error("Start/stop and Stop shortcuts must be different.");
  if (registeredShortcuts.length) {
    await unregister(registeredShortcuts);
    registeredShortcuts = [];
  }
  await register(toggleShortcut, (event) => {
    // The plugin reports both key-down and key-up. Act only on key-down,
    // otherwise the clicker starts on press and immediately stops on release.
    if (event.state !== "Pressed") return;
    if (running) void stopClicking(); else void startClicking();
  });
  try {
    await register(stopShortcut, (event) => {
      if (event.state === "Pressed") void stopClicking();
    });
    registeredShortcuts = next;
  } catch (error) {
    await unregister(toggleShortcut).catch(() => undefined);
    throw error;
  }
}

async function beginHotkeyCapture(kind: HotkeyKind) {
  if (!desktop) {
    notify("Shortcut editing is available in the installed desktop app.");
    return;
  }
  try {
    if (registeredShortcuts.length) await unregister(registeredShortcuts);
    registeredShortcuts = [];
    capturingHotkey = kind;
    renderHotkeys();
    notify("Press the shortcut you want. Escape cancels.");
  } catch (error) {
    notify(`Could not enter shortcut capture mode: ${String(error)}`);
  }
}

function handleHotkeyCapture(event: KeyboardEvent) {
  if (!capturingHotkey || event.repeat) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.key === "Escape") {
    capturingHotkey = null;
    renderHotkeys();
    void configureHotkeys().catch((error) => notify(`Could not restore shortcuts: ${String(error)}`));
    return;
  }
  const shortcut = shortcutFromKeyboardEvent(event);
  if (shortcut === "__NEEDS_MODIFIER__") {
    notify("Use Ctrl, Alt or Shift with a letter or number.");
    return;
  }
  if (!shortcut) return;
  const previousToggle = toggleShortcut;
  const previousStop = stopShortcut;
  if (capturingHotkey === "toggle") toggleShortcut = shortcut;
  else stopShortcut = shortcut;
  if (toggleShortcut === stopShortcut) {
    toggleShortcut = previousToggle;
    stopShortcut = previousStop;
    notify("Those shortcuts must be different. Choose another key.");
    return;
  }
  capturingHotkey = null;
  persistSettings();
  renderHotkeys();
  void configureHotkeys().then(() => notify("Global shortcuts updated.")).catch((error) => {
    toggleShortcut = previousToggle;
    stopShortcut = previousStop;
    renderHotkeys();
    void configureHotkeys().catch(() => undefined);
    notify(`That shortcut could not be registered: ${String(error)}`);
  });
}

async function initializeDesktop() {
  desktop = isTauri();
  if (!desktop) {
    setRunning(false, "Preview mode · open the desktop app to click");
    byId<HTMLButtonElement>("start-button").disabled = true;
    byId<HTMLButtonElement>("stop-button").disabled = true;
    return;
  }
  byId<HTMLButtonElement>("start-button").disabled = false;
  byId<HTMLDivElement>("engine-note").innerHTML = '<span class="engine-dot"></span><span>Native engine ready</span>';
  unlistenFns.push(await listen<StatusPayload>("clickforge-status", (event) => {
    setRunning(event.payload.running, event.payload.message);
    if (!event.payload.running && event.payload.message) notify(event.payload.message);
  }));
  unlistenFns.push(await listen<ProgressPayload>("clickforge-progress", (event) => {
    byId<HTMLElement>("click-count").textContent = event.payload.clicks.toLocaleString();
    byId<HTMLElement>("cycle-count").textContent = `${event.payload.cycles.toLocaleString()} cycles completed`;
  }));
  renderHotkeys();
  try { await configureHotkeys(); }
  catch (error) { notify(`Global shortcuts unavailable: ${String(error)}`); }
}

loadSettings();
updateModeControls();
updateIntervalSummary();
const savedTheme = localStorage.getItem("clickforge-theme");
const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
applyTheme(savedTheme === "light" || savedTheme === "dark" ? savedTheme : (prefersDark ? "dark" : "light"));

byId<HTMLButtonElement>("theme-toggle").addEventListener("click", () => applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));
byId<HTMLButtonElement>("start-button").addEventListener("click", startClicking);
byId<HTMLButtonElement>("stop-button").addEventListener("click", stopClicking);
byId<HTMLButtonElement>("save-button").addEventListener("click", () => persistSettings(true));
byId<HTMLButtonElement>("reset-button").addEventListener("click", resetSettings);
byId<HTMLButtonElement>("toggle-hotkey").addEventListener("click", () => { void beginHotkeyCapture("toggle"); });
byId<HTMLButtonElement>("stop-hotkey").addEventListener("click", () => { void beginHotkeyCapture("stop"); });
window.addEventListener("keydown", handleHotkeyCapture, true);
document.querySelectorAll<HTMLInputElement>('input[name="repeat-mode"], input[name="position-mode"]').forEach((radio) => radio.addEventListener("change", () => { updateModeControls(); persistSettings(); }));
document.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input, select").forEach((field) => field.addEventListener("change", () => { updateIntervalSummary(); persistSettings(); }));

void initializeDesktop();
window.addEventListener("beforeunload", () => { unlistenFns.forEach((unlisten) => unlisten()); if (desktop && registeredShortcuts.length) void unregister(registeredShortcuts); });
