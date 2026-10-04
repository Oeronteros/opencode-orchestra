//! Check the actual Linux backends without a GTK/WebKit installation.
#[path = "../../src-tauri/src/input_target.rs"]
mod input_target;
pub use input_target::InputTarget;
#[path = "../../src-tauri/src/linux_input.rs"]
pub mod linux;
#[path = "../../src-tauri/src/wayland_policy.rs"]
pub mod wayland_policy;
#[path = "../../src-tauri/src/wayland_input.rs"]
pub mod wayland_input;
