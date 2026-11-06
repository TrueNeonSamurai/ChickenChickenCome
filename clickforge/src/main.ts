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
  byId<HTMLSpanElement>("status-detail").textContent = next ? "Press F6 or Stop to end the session" : message;
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
  localStorage.setItem("clickforge-settings-v1", JSON.stringify(saved));
  if (showMessage) notify("Settings saved on this device.");
}

function loadSettings() {
  const raw = localStorage.getItem("clickforge-settings-v1");
  if (!raw) return;
  try {
    const saved = JSON.parse(raw) as Record<string, string | boolean>;
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
  try {
    await register("F6", async () => { if (running) await stopClicking(); else await startClicking(); });
    await register("F7", async () => stopClicking());
  } catch (error) { notify(`Global shortcuts unavailable: ${String(error)}`); }
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
document.querySelectorAll<HTMLInputElement>('input[name="repeat-mode"], input[name="position-mode"]').forEach((radio) => radio.addEventListener("change", () => { updateModeControls(); persistSettings(); }));
document.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input, select").forEach((field) => field.addEventListener("change", () => { updateIntervalSummary(); persistSettings(); }));

void initializeDesktop();
window.addEventListener("beforeunload", () => { unlistenFns.forEach((unlisten) => unlisten()); if (desktop) { void unregister("F6"); void unregister("F7"); } });
