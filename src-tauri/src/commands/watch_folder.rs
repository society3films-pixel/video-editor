//! Lists the video files in a folder for the watch-folder automation (polled from the app).

use serde::Serialize;
use std::path::Path;
use std::time::UNIX_EPOCH;

const VIDEO_EXTENSIONS: &[&str] = &["mp4", "mov", "m4v", "mkv", "webm", "avi"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchedVideoFile {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub modified_ms: u64,
}

fn is_video(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| VIDEO_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Video files directly inside `dir` (not subfolders), oldest first.
#[tauri::command]
pub fn list_watch_folder_videos(dir: String) -> Result<Vec<WatchedVideoFile>, String> {
    let root = Path::new(&dir);
    if !root.is_dir() {
        return Err(format!("The watch folder doesn't exist: {dir}"));
    }
    let mut files = Vec::new();
    for entry in std::fs::read_dir(root).map_err(|e| e.to_string())? {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        if !path.is_file() || !is_video(&path) {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        // Skip hidden and partial downloads.
        if name.starts_with('.') || name.ends_with(".part") || name.ends_with(".crdownload") {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        files.push(WatchedVideoFile {
            path: path.to_string_lossy().into_owned(),
            name: name.to_string(),
            size: meta.len(),
            modified_ms,
        });
    }
    files.sort_by_key(|file| file.modified_ms);
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_only_videos() {
        let dir = std::env::temp_dir().join(format!("oc-watch-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.mp4"), b"x").unwrap();
        std::fs::write(dir.join("b.MOV"), b"xy").unwrap();
        std::fs::write(dir.join("notes.txt"), b"x").unwrap();
        std::fs::write(dir.join("c.mp4.part"), b"x").unwrap();
        let mut names: Vec<String> = list_watch_folder_videos(dir.to_string_lossy().into_owned())
            .unwrap()
            .into_iter()
            .map(|f| f.name)
            .collect();
        names.sort();
        assert_eq!(names, vec!["a.mp4", "b.MOV"]);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

/// Sound level per `frame_ms` of a media file (RMS of a mono mix), decoded natively.
#[tauri::command]
pub async fn media_audio_levels(path: String, frame_ms: u32) -> Result<Vec<f32>, String> {
    tokio::task::spawn_blocking(move || {
        crate::video::ffmpeg::audio_levels::audio_levels_blocking(&path, frame_ms)
    })
    .await
    .map_err(|e| e.to_string())?
}
