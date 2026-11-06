use enigo::{Button, Coordinate, Direction, Enigo, Mouse, Settings};
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::thread::{self, Thread};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
struct ClickerState {
    running: Arc<AtomicBool>,
    worker_thread: Arc<Mutex<Option<Thread>>>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClickConfig {
    interval_ms: u64,
    repeat_count: Option<u64>,
    mouse_button: String,
    click_type: String,
    use_current_position: bool,
    x: i32,
    y: i32,
    stop_on_edge: bool,
}

#[derive(Clone, Serialize)]
struct StatusEvent {
    running: bool,
    message: String,
}

#[derive(Clone, Serialize)]
struct ProgressEvent {
    clicks: u64,
    cycles: u64,
}

fn emit_status(app: &AppHandle, running: bool, message: impl Into<String>) {
    let _ = app.emit(
        "clickforge-status",
        StatusEvent {
            running,
            message: message.into(),
        },
    );
}

fn emit_progress(app: &AppHandle, clicks: u64, cycles: u64) {
    let _ = app.emit("clickforge-progress", ProgressEvent { clicks, cycles });
}

fn parse_button(value: &str) -> Result<Button, String> {
    match value {
        "left" => Ok(Button::Left),
        "right" => Ok(Button::Right),
        "middle" => Ok(Button::Middle),
        _ => Err("Choose left, right or middle mouse button.".into()),
    }
}

fn validate_config(config: &ClickConfig) -> Result<(), String> {
    if !(1..=86_400_000).contains(&config.interval_ms) {
        return Err("Interval must be between 1 ms and 24 hours.".into());
    }
    if let Some(count) = config.repeat_count {
        if !(1..=1_000_000).contains(&count) {
            return Err("Repeat count must be between 1 and 1,000,000 cycles.".into());
        }
    }
    if config.x < 0 || config.y < 0 {
        return Err("Coordinates cannot be negative.".into());
    }
    if config.click_type != "single" && config.click_type != "double" {
        return Err("Choose single or double click.".into());
    }
    parse_button(&config.mouse_button)?;
    Ok(())
}

fn cursor_is_at_edge(enigo: &Enigo, width: i32, height: i32) -> Result<bool, String> {
    let (x, y) = enigo.location().map_err(|e| format!("Could not read cursor position: {e}"))?;
    Ok(x <= 0 || y <= 0 || x >= width - 1 || y >= height - 1)
}

fn click_loop(
    app: AppHandle,
    running: Arc<AtomicBool>,
    worker_thread: Arc<Mutex<Option<Thread>>>,
    config: ClickConfig,
) {
    if let Ok(mut slot) = worker_thread.lock() {
        *slot = Some(thread::current());
    }

    let finish_message = (|| -> Result<String, String> {
        let button = parse_button(&config.mouse_button)?;
        let mut enigo = Enigo::new(&Settings::default())
            .map_err(|e| format!("Could not initialize mouse control: {e}"))?;
        let (width, height) = enigo
            .main_display()
            .map_err(|e| format!("Could not read primary display size: {e}"))?;

        if width < 2 || height < 2 {
            return Err("The primary display size could not be detected.".into());
        }
        if !config.use_current_position
            && (config.x >= width || config.y >= height)
        {
            return Err(format!(
                "Fixed position is outside the primary display ({} × {}).",
                width, height
            ));
        }
        if config.stop_on_edge
            && !config.use_current_position
            && (config.x == 0 || config.y == 0 || config.x >= width - 1 || config.y >= height - 1)
        {
            return Err("Choose a fixed position away from the screen edges, or turn off edge stopping.".into());
        }

        let interval = Duration::from_millis(config.interval_ms);
        let mut cycles = 0_u64;
        let mut clicks = 0_u64;
        emit_status(&app, true, "Clicking in progress");
        emit_progress(&app, clicks, cycles);

        while running.load(Ordering::SeqCst) {
            if config.stop_on_edge && cursor_is_at_edge(&enigo, width, height)? {
                return Ok("Stopped automatically: cursor reached a screen edge.".into());
            }

            if !config.use_current_position {
                enigo
                    .move_mouse(config.x, config.y, Coordinate::Abs)
                    .map_err(|e| format!("Could not move to the selected position: {e}"))?;
            }

            enigo
                .button(button, Direction::Click)
                .map_err(|e| format!("Mouse click failed: {e}"))?;
            clicks += 1;

            if config.click_type == "double" {
                thread::sleep(Duration::from_millis(55));
                if !running.load(Ordering::SeqCst) {
                    break;
                }
                if config.stop_on_edge && cursor_is_at_edge(&enigo, width, height)? {
                    return Ok("Stopped automatically: cursor reached a screen edge.".into());
                }
                if !config.use_current_position {
                    enigo
                        .move_mouse(config.x, config.y, Coordinate::Abs)
                        .map_err(|e| format!("Could not move to the selected position: {e}"))?;
                }
                enigo
                    .button(button, Direction::Click)
                    .map_err(|e| format!("Second click failed: {e}"))?;
                clicks += 1;
            }

            cycles += 1;
            emit_progress(&app, clicks, cycles);
            if config.repeat_count.is_some_and(|limit| cycles >= limit) {
                return Ok("Finished: repeat limit reached.".into());
            }

            // park_timeout sleeps efficiently and can be interrupted immediately by Stop.
            thread::park_timeout(interval);
        }

        Ok("Stopped by user.".into())
    })();

    running.store(false, Ordering::SeqCst);
    if let Ok(mut slot) = worker_thread.lock() {
        *slot = None;
    }
    match finish_message {
        Ok(message) => emit_status(&app, false, message),
        Err(message) => emit_status(&app, false, message),
    }
}

#[tauri::command]
fn start_clicking(
    app: AppHandle,
    state: State<'_, ClickerState>,
    config: ClickConfig,
) -> Result<(), String> {
    validate_config(&config)?;
    if state
        .running
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("ClickForge is already running.".into());
    }

    let running = Arc::clone(&state.running);
    let worker_thread = Arc::clone(&state.worker_thread);
    let app_for_thread = app.clone();
    let handle = thread::Builder::new()
        .name("clickforge-engine".into())
        .spawn(move || click_loop(app_for_thread, running, worker_thread, config));

    match handle {
        Ok(_detached_handle) => Ok(()),
        Err(error) => {
            state.running.store(false, Ordering::SeqCst);
            Err(format!("Could not start click worker: {error}"))
        }
    }
}

#[tauri::command]
fn stop_clicking(state: State<'_, ClickerState>) -> Result<(), String> {
    state.running.store(false, Ordering::SeqCst);
    if let Ok(slot) = state.worker_thread.lock() {
        if let Some(worker) = slot.as_ref() {
            worker.unpark();
        }
    }
    Ok(())
}

#[tauri::command]
fn is_running(state: State<'_, ClickerState>) -> bool {
    state.running.load(Ordering::SeqCst)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(ClickerState::default())
        .invoke_handler(tauri::generate_handler![start_clicking, stop_clicking, is_running])
        .run(tauri::generate_context!())
        .expect("error while running ClickForge");
}
