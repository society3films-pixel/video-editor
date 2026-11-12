//! Lists the video files in a folder for the watch-folder automation (polled from the app).

use serde::Serialize;
use std::path::Path;
use std::time::UNIX_EPOCH;

const VIDEO_EXTENSIONS: &[&str] = &["mp4", "mov", "m4v", "mkv", "webm", "avi"];
const AUDIO_EXTENSIONS: &[&str] = &["wav", "mp3", "m4a", "aac", "flac", "aif", "aiff", "ogg"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchedVideoFile {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub modified_ms: u64,
    /// Subfolder inside the chosen folder ("" for files directly in it), with `/` separators.
    pub folder: String,
}

fn has_extension(path: &Path, list: &[&str]) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| list.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn is_video(path: &Path) -> bool {
    has_extension(path, VIDEO_EXTENSIONS)
}

/// Video files directly inside `dir` (not subfolders), oldest first.
#[tauri::command]
pub fn list_watch_folder_videos(dir: String) -> Result<Vec<WatchedVideoFile>, String> {
    list_files(&dir, is_video)
}

/// Video and audio files directly inside `dir` (a shoot folder for Folder → draft), oldest first.
#[tauri::command]
pub fn list_media_files(dir: String) -> Result<Vec<WatchedVideoFile>, String> {
    let root = Path::new(&dir);
    if !root.is_dir() {
        return Err(format!("The folder doesn't exist: {dir}"));
    }
    let keep = |path: &Path| is_video(path) || has_extension(path, AUDIO_EXTENSIONS);
    let mut files = Vec::new();
    collect_media(root, "", 0, &keep, &mut files);
    files.sort_by(|a, b| a.folder.cmp(&b.folder).then(a.name.cmp(&b.name)));
    Ok(files)
}

/// Folders skipped when looking through a shoot: hidden ones and editors' proxy / cache folders.
fn skip_folder(name: &str) -> bool {
    let lower = name.to_lowercase();
    name.starts_with('.')
        || matches!(
            lower.as_str(),
            "proxy"
                | "proxies"
                | "cache"
                | "cachefiles"
                | "render"
                | "renders"
                | "thumbnails"
                | "__macosx"
        )
}

fn collect_media(
    dir: &Path,
    folder: &str,
    depth: usize,
    keep: &impl Fn(&Path) -> bool,
    files: &mut Vec<WatchedVideoFile>,
) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path
            .file_name()
            .and_then(|n| n.to_str())
            .map(str::to_string)
        else {
            continue;
        };
        if path.is_dir() {
            if depth < 8 && !skip_folder(&name) {
                let sub = if folder.is_empty() {
                    name.clone()
                } else {
                    format!("{folder}/{name}")
                };
                collect_media(&path, &sub, depth + 1, keep, files);
            }
            continue;
        }
        if !keep(&path)
            || name.starts_with('.')
            || name.ends_with(".part")
            || name.ends_with(".crdownload")
        {
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
            name,
            size: meta.len(),
            modified_ms,
            folder: folder.to_string(),
        });
    }
}

fn list_files(dir: &str, keep: impl Fn(&Path) -> bool) -> Result<Vec<WatchedVideoFile>, String> {
    let root = Path::new(dir);
    if !root.is_dir() {
        return Err(format!("The watch folder doesn't exist: {dir}"));
    }
    let mut files = Vec::new();
    for entry in std::fs::read_dir(root).map_err(|e| e.to_string())? {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        if !path.is_file() || !keep(&path) {
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
            folder: String::new(),
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
