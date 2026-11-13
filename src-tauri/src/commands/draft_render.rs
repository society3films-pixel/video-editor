//! Native long-form draft render (see video::ffmpeg::draft_render): one at a time, with progress
//! polled by the app and a cancel switch.

use crate::video::ffmpeg::draft_render::{render_draft, DraftRenderSpec};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::AppHandle;

static RUNNING: AtomicBool = AtomicBool::new(false);
static CANCEL: AtomicBool = AtomicBool::new(false);
/// Progress 0..1 as f64 bits.
static PROGRESS: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftRenderResult {
    pub file_path: String,
    pub encoder: String,
}

/// Renders the draft into the project's exports folder as `file_name`.
#[tauri::command]
pub async fn render_draft_native(
    app: AppHandle,
    project_id: String,
    file_name: String,
    spec: DraftRenderSpec,
) -> Result<DraftRenderResult, String> {
    if RUNNING.swap(true, Ordering::AcqRel) {
        return Err("A draft is already rendering.".into());
    }
    CANCEL.store(false, Ordering::Release);
    PROGRESS.store(0f64.to_bits(), Ordering::Release);
    let result = (|| -> Result<std::path::PathBuf, String> {
        std::fs::create_dir_all(crate::clipper::data::clipper_project_exports_dir(
            &app,
            &project_id,
        )?)
        .map_err(|e| e.to_string())?;
        crate::clipper::data::clipper_export_file_path(&app, &project_id, &file_name)
    })();
    let path = match result {
        Ok(path) => path,
        Err(error) => {
            RUNNING.store(false, Ordering::Release);
            return Err(error);
        }
    };
    let outcome = tokio::task::spawn_blocking(move || {
        let summary = render_draft(&spec, &path, &CANCEL, |p| {
            PROGRESS.store(p.to_bits(), Ordering::Release)
        })?;
        Ok::<_, String>(DraftRenderResult {
            file_path: path.to_string_lossy().into_owned(),
            encoder: summary.encoder,
        })
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r);
    RUNNING.store(false, Ordering::Release);
    outcome
}

#[tauri::command]
pub fn draft_render_progress() -> f64 {
    f64::from_bits(PROGRESS.load(Ordering::Acquire))
}

#[tauri::command]
pub fn cancel_draft_render() {
    CANCEL.store(true, Ordering::Release);
}
