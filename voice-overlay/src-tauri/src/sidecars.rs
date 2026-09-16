use std::path::{Path, PathBuf};

pub fn sidecar_file(base: &str) -> Result<String, String> {
    let triple = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => "x86_64-unknown-linux-gnu",
        ("linux", "aarch64") => "aarch64-unknown-linux-gnu",
        ("windows", "x86_64") => "x86_64-pc-windows-msvc.exe",
        ("windows", "aarch64") => "aarch64-pc-windows-msvc.exe",
        (os, arch) => return Err(format!("unsupported-os: {os}/{arch}")),
    };
    Ok(format!("{base}-{triple}"))
}

// npm ships original names next to the executable. Tauri bundles strip the
// target triple; older layouts put the original files under resources/binaries.
pub fn candidates(base: &str, exe_dir: &Path, resource_dir: Option<&Path>) -> Result<Vec<PathBuf>, String> {
    let name = sidecar_file(base)?;
    let bundled = format!("{base}{}", std::env::consts::EXE_SUFFIX);
    let mut paths = vec![exe_dir.join(&name), exe_dir.join(&bundled)];
    if let Some(dir) = resource_dir {
        paths.extend([dir.join("binaries").join(&name), dir.join(&name), dir.join(&bundled)]);
    }
    Ok(paths)
}

pub fn resolve(base: &str, exe_dir: &Path, resource_dir: Option<&Path>) -> Result<PathBuf, String> {
    let paths = candidates(base, exe_dir, resource_dir)?;
    paths.iter().find(|path| path.is_file()).cloned().ok_or_else(|| {
        let code = if base == "ffmpeg" { "no-ffmpeg" } else { "transcribe-failed" };
        format!("{code}: {base} missing; searched: {}", paths.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join(", "))
    })
}

pub fn supports_pulse(devices: &str) -> bool {
    supports_input(devices, "pulse")
}

pub fn supports_input(devices: &str, name: &str) -> bool {
    devices.lines().any(|line| {
        let mut fields = line.split_whitespace();
        matches!(fields.next(), Some(flags) if flags.contains('D')) && fields.next() == Some(name)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_npm_and_tauri_layouts_without_using_the_working_directory() {
        let root = std::env::temp_dir().join(format!("voice-sidecars-{}", std::process::id()));
        let exe = root.join("bin");
        let resources = root.join("resources");
        std::fs::create_dir_all(resources.join("binaries")).unwrap();
        std::fs::create_dir_all(&exe).unwrap();
        for base in ["ffmpeg", "whisper"] {
            let error = resolve(base, &exe, Some(&resources)).unwrap_err();
            assert!(error.starts_with(if base == "ffmpeg" { "no-ffmpeg:" } else { "transcribe-failed:" }));
            let paths = candidates(base, &exe, Some(&resources)).unwrap();
            for candidate in paths.iter().rev() {
                std::fs::write(candidate, "binary").unwrap();
                assert_eq!(resolve(base, &exe, Some(&resources)).unwrap(), *candidate);
            }
            assert_eq!(resolve(base, &exe, None).unwrap(), paths[0]);
        }
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn pulse_requires_an_input_device_not_just_an_output_or_configuration_flag() {
        assert!(supports_pulse("Devices:\n DE pulse Pulse audio output\n"));
        assert!(supports_pulse(" D  pulse Pulse audio input\n"));
        assert!(!supports_pulse(" E pulse Pulse audio output\n--enable-libpulse\n"));
        assert!(!supports_pulse(" D alsa ALSA audio input\n"));
    }
}
