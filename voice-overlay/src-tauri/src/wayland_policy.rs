//! Focus identity is supplied by the compositor, never by XWayland.
use super::InputTarget;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Focus {
    pub backend: String,
    pub id: String,
    pub process: u32,
    pub title: String,
    pub app_id: String,
}

impl Focus {
    pub fn target(&self) -> Result<InputTarget, String> {
        if self.id.is_empty()
            || self.process == std::process::id()
            || self.app_id == "ai.opencode.voice-overlay"
        {
            return Err("Поставьте курсор в поле ввода OpenCode.".into());
        }
        Ok(InputTarget {
            window: -1,
            focus: 0,
            process: self.process,
            title: serde_json::to_string(self).map_err(|e| e.to_string())?,
        })
    }

    pub fn from_target(target: &InputTarget) -> Result<Self, String> {
        if target.window != -1 || target.focus != 0 {
            return Err(
                "Сохранённое окно относится к другой графической сессии. Текст сохранён.".into(),
            );
        }
        let focus: Self =
            serde_json::from_str(&target.title).map_err(|_| "Неверное назначение Wayland")?;
        if focus.process != target.process || focus.id.is_empty() {
            return Err("Неверное назначение Wayland".into());
        }
        Ok(focus)
    }

    pub fn terminal(&self) -> bool {
        super::linux::terminal_class(self.app_id.as_bytes())
    }
}

pub fn sway_focus(tree: &serde_json::Value) -> Option<Focus> {
    if tree["focused"].as_bool() == Some(true) {
        return Some(Focus {
            backend: "sway".into(),
            id: tree["id"].as_u64()?.to_string(),
            process: tree["pid"]
                .as_u64()
                .and_then(|v| u32::try_from(v).ok())
                .unwrap_or(0),
            title: tree["name"].as_str().unwrap_or_default().into(),
            app_id: tree["app_id"]
                .as_str()
                .or_else(|| tree["window_properties"]["class"].as_str())
                .unwrap_or_default()
                .into(),
        });
    }
    ["nodes", "floating_nodes"]
        .into_iter()
        .find_map(|key| tree[key].as_array()?.iter().find_map(sway_focus))
}

pub fn hyprland_focus(window: &serde_json::Value) -> Option<Focus> {
    let id = window["address"].as_str()?;
    if id.is_empty() || id == "0x0" {
        return None;
    }
    Some(Focus {
        backend: "hyprland".into(),
        id: id.into(),
        process: window["pid"]
            .as_u64()
            .and_then(|v| u32::try_from(v).ok())
            .unwrap_or(0),
        title: window["title"].as_str().unwrap_or_default().into(),
        app_id: window["class"].as_str().unwrap_or_default().into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn focus_guard_tracks_native_window_title_and_process() {
        let focus = Focus {
            backend: "gnome".into(),
            id: "23".into(),
            process: 42,
            title: "OpenCode 中文".into(),
            app_id: "org.gnome.Terminal".into(),
        };
        assert!(focus.terminal());
        assert_eq!(Focus::from_target(&focus.target().unwrap()).unwrap(), focus);
        let mut changed = focus.clone();
        changed.id = "24".into();
        assert_ne!(changed.target().unwrap(), focus.target().unwrap());
        changed = focus.clone();
        changed.title = "another tab".into();
        assert_ne!(changed.target().unwrap(), focus.target().unwrap());
        changed = focus.clone();
        changed.process = std::process::id();
        assert!(changed.target().is_err());
        let mut stale = focus.target().unwrap();
        stale.window = 123;
        assert!(Focus::from_target(&stale).is_err());
    }
    #[test]
    fn sway_includes_floating_and_xwayland_windows() {
        let tree = serde_json::json!({"nodes": [], "floating_nodes": [{"focused": true,
            "id": 77, "pid": 42, "name": "测试", "window_properties": {"class": "kitty"}}]});
        let focus = sway_focus(&tree).unwrap();
        assert_eq!(focus.id, "77");
        assert!(focus.terminal());
        assert!(sway_focus(&serde_json::json!({"nodes": []})).is_none());
    }
    #[test]
    fn hyprland_rejects_empty_active_window() {
        assert!(hyprland_focus(&serde_json::json!({"address": "0x0"})).is_none());
        assert_eq!(
            hyprland_focus(&serde_json::json!({"address": "0xab", "pid": 42,
            "class": "OpenCode", "title": "Русский"}))
            .unwrap()
            .title,
            "Русский"
        );
    }
}
