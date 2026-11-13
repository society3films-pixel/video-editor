//! Forwards AI requests to a local model server (Ollama, LM Studio) on this computer.
//!
//! The webview can't call these servers directly: they reject the app's origin (CORS). Only
//! loopback hosts are allowed, so this can't be used to reach anything outside the machine.

use std::time::Duration;

fn check_local_url(raw: &str) -> Result<url::Url, String> {
    let parsed = url::Url::parse(raw).map_err(|e| format!("Invalid local AI address: {e}"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("The local AI address must start with http://".to_string());
    }
    match parsed.host_str() {
        Some("localhost") | Some("127.0.0.1") | Some("[::1]") | Some("::1") => Ok(parsed),
        _ => Err("Only AI servers on this computer (localhost) are allowed.".to_string()),
    }
}

/// `body` = None sends a GET. Returns the response body; non-2xx statuses become errors.
#[tauri::command]
pub async fn local_ai_request(url: String, body: Option<String>) -> Result<String, String> {
    let url = check_local_url(&url)?;
    tokio::task::spawn_blocking(move || {
        let client = reqwest::blocking::Client::builder()
            // Local models can take a while on a long transcript.
            .timeout(Duration::from_secs(600))
            .build()
            .map_err(|e| e.to_string())?;
        let request = match body {
            Some(body) => client
                .post(url)
                .header("Content-Type", "application/json")
                .body(body),
            None => client.get(url),
        };
        let response = request.send().map_err(|e| {
            if e.is_connect() {
                "Couldn't reach the local AI server. Is Ollama or LM Studio running?".to_string()
            } else {
                e.to_string()
            }
        })?;
        let status = response.status();
        let text = response.text().map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(format!(
                "Local AI error (HTTP {}): {}",
                status.as_u16(),
                text.chars().take(300).collect::<String>()
            ));
        }
        Ok(text)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::check_local_url;

    #[test]
    fn only_loopback_hosts() {
        assert!(check_local_url("http://localhost:11434/v1/models").is_ok());
        assert!(check_local_url("http://127.0.0.1:1234/v1/chat/completions").is_ok());
        assert!(check_local_url("http://example.com/v1").is_err());
        assert!(check_local_url("http://192.168.1.5:11434").is_err());
        assert!(check_local_url("file:///etc/passwd").is_err());
    }
}
