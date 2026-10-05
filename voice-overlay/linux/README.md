# Горячая клавиша и вставка на Linux

## WSL: кнопка поверх терминала Windows / WSLg

Если OpenCode запущен в WSL, команда `opencode-orchestra voice-overlay`
автоматически запускает **Windows-оверлей** через WSL interop. Он привязывается
к реальному окну Windows Terminal или Desktop/WSLg и показывает ту же кнопку,
красную пульсацию, таймер записи и индикатор распознавания. При смене приложения
кнопка скрывается. Микрофон, Whisper и модели в этом режиме работают на Windows.

В оверлее нажмите **«Привязать к окну TUI / Desktop»** и за три секунды
переключитесь в окно OpenCode, установив курсор в поле ввода. Главное окно
оверлея можно свернуть. Повторное нажатие микрофона останавливает запись;
отправка текста остаётся ручной. При другом окне/поле результат сохраняется.
Терминал с `OpenCode` в заголовке определяется автоматически; произвольный
заголовок можно привязать вручную. Для Desktop через WSLg тоже можно использовать
ручную привязку к его окну на Windows.

Нужен Windows-комплект оверлея с этой кнопкой, установленный рядом с ffmpeg,
Whisper и DLL. По умолчанию CLI находит его в Windows `%LOCALAPPDATA%`, а модели
в `%APPDATA%`. Если Windows companion доступен этому CLI, он обновляет установку;
иначе используется существующая. При неполной установке CLI сообщает команду
установки, которую нужно выполнить в Windows PowerShell.

Для собранного из этого репозитория оверлея, из WSL:

В корне этого checkout можно выполнить **`bash scripts/voice-wsl-overlay.sh`**:
скрипт использует локальную сборку из `.cache/voice-widget-build`, если она есть.
Для явного указания пути:

```bash
ORCHESTRA_VOICE_WINDOWS_BINARY='/mnt/c/Users/Oe-Admin/Desktop/opencode-orchestra/.cache/voice-widget-build/voice-overlay.exe' \
  node /mnt/c/Users/Oe-Admin/Desktop/opencode-orchestra/dist/cli.js voice-overlay
```

Переменная принимает абсолютный путь `/mnt/.../voice-overlay.exe` либо Windows
путь `C:\...\voice-overlay.exe`; путь с пробелами заключайте в кавычки. Явная
локальная сборка не заменяется npm companion. Обычный запуск после выпуска
обновлённого CLI: `opencode-orchestra voice-overlay`.

Нужны включённый WSL interop, доступный `powershell.exe` в PATH и команда
`wslpath`. Внутри полноценного Linux desktop, запущенного в WSL, прежний нативный
Linux-оверлей можно выбрать явно: `ORCHESTRA_VOICE_LINUX_NATIVE=1`.
`voice-web`, `/voice`, `voice-tui` и `voice-model` сохраняют свои Linux-пути;
модели Windows-оверлея выбирайте/устанавливайте на стороне Windows.

WSLg не предоставляет полноценный Linux desktop; Windows-программы можно
запускать из WSL как `.exe` ([Microsoft: interop](https://learn.microsoft.com/en-us/windows/wsl/interop),
[WSLg](https://learn.microsoft.com/en-us/windows/wsl/tutorials/gui-apps)).
Этот режим не требует GNOME/KDE, xclip или доступа к XWayland для определения
окна Windows Terminal.

В исходниках добавлен нативный Wayland backend. Для него нужна **новая Linux-сборка**
voice-overlay; ранее опубликованный npm companion не содержит эту поддержку.
Горячая клавиша запускает и останавливает запись, распознавание остаётся локальным,
а результат вставляется без отправки. Модель и язык работают как на Windows:
`base`, `small`, `large-v3-turbo-q5_0`; `ru`, `en`, `zh`, `auto`.

| Сессия | Горячая клавиша | Вставка и определение окна |
| --- | --- | --- |
| X11 | X11 GrabKey | xclip, XTEST, EWMH |
| GNOME Wayland, Shell 45+ | Поставляемое расширение Shell | Буфер Shell, виртуальная клавиатура, фокус Mutter |
| KDE Plasma Wayland | GlobalShortcuts portal или команда `--toggle` | RemoteDesktop portal; Clipboard portal либо wl-copy; фокус через kdotool |
| Sway / Hyprland | GlobalShortcuts portal, если доступен, либо команда `--toggle` | wl-copy, wtype и IPC композитора |

При смене окна, приложения или заголовка вкладки вставка отклоняется, текст остаётся
в оверлее. Вернитесь в исходное поле и нажмите хоткей для повторной вставки.
Как и в остальных нативных режимах, сохраняйте курсор в том же поле во время STT:
Wayland не предоставляет универсальный API для идентификации поля внутри приложения.
Не используется XWayland для ввода в нативные окна.

## Запуск новой сборки

Соберите приложение на Linux по `voice-overlay/README.md` с подготовленными
ffmpeg/Whisper sidecars. Для первого запуска из исходников:

```bash
./voice-overlay/src-tauri/target/release/voice-overlay
```

После установки нового companion исполняемый файл обычно находится в
`~/.local/bin/voice-overlay`. В примерах ниже `voice-overlay` означает именно новую
сборку; используйте её полный путь, если каталог не входит в PATH.

## GNOME

Расширение входит в бинарник, отдельная загрузка и sudo не нужны:

```bash
voice-overlay --install-gnome-extension
```

Команда записывает только `extension.js` и `metadata.json` в
`${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/voice-input@opencode.ai/`
и пытается включить расширение. Если Shell ещё не обнаружил его, выйдите и войдите
в Wayland-сессию, затем выполните:

```bash
gnome-extensions enable voice-input@opencode.ai
```

Запустите оверлей, поставьте курсор в промпт и используйте **Ctrl+Alt+Space**.
Если сочетание занято, освободите его в системных настройках.
Расширение ждёт отпускания модификаторов, проверяет фокус непосредственно перед
вставкой и разрешает запись в буфер/эмуляцию клавиш только процессу, который владеет
session D-Bus именем оверлея. В терминалах используется Ctrl+Shift+V, в других
приложениях — Ctrl+V. Enter не эмулируется.

Чтобы отключить интеграцию:

```bash
gnome-extensions disable voice-input@opencode.ai
```

GNOME меняет API Shell между версиями. В коде предусмотрены старый и новый способы
получения backend Clutter; установка записывает текущую major-версию Shell.
Это не заменяет проверку расширения на конкретной версии GNOME.

## KDE Plasma

Нужны `xdg-desktop-portal` и backend `xdg-desktop-portal-kde`, а также
[kdotool](https://github.com/jinliu/kdotool#installation) в PATH для идентификации
исходного окна. Для систем без Clipboard portal установите `wl-clipboard`.

При первом подключении подтвердите горячую клавишу в системном диалоге
GlobalShortcuts и разрешите клавиатуру в RemoteDesktop. Приложение запрашивает
клавиатуру, не выбирает экран или микрофон для удалённого доступа.
Разрешение действует до закрытия оверлея; следующему запуску может потребоваться
новое подтверждение. Отказ сохраняет текст и показывает причину.

Если GlobalShortcuts недоступен, создайте системное сочетание Ctrl+Alt+Space
с командой **полного пути к бинарнику** и аргументом `--toggle`, например:

```text
/home/your-user/.local/bin/voice-overlay --toggle
```

Оверлей должен быть запущен заранее. Команда обращается к существующему экземпляру,
не открывает второе окно и не запускает сервер на TCP-порту.

## Sway / Hyprland

Установите `wl-clipboard` и `wtype`; для получения активного окна используются
`swaymsg` или `hyprctl`, поставляемые вместе с композитором. Если портал хоткеев
недоступен, добавьте привязку к `--toggle`.

Sway, в `~/.config/sway/config`:

```text
bindsym --release Ctrl+Mod1+space exec /home/your-user/.local/bin/voice-overlay --toggle
```

Hyprland с конфигурацией `~/.config/hypr/hyprland.conf`:

```text
bindr = CTRL ALT, SPACE, exec, /home/your-user/.local/bin/voice-overlay --toggle
```

Для версий с Lua-конфигурацией задайте эквивалентное сочетание, запускающее ту же
команду при отпускании клавиш. Синтаксис выбирайте для установленной версии через
[version selector Hyprland](https://wiki.hypr.land/version-selector/).

Замените путь своим, перечитайте конфигурацию и оставьте оверлей запущенным.
Не назначайте одновременно портал и внешнюю команду на одно сочетание.
`wtype` требует поддержки протокола virtual-keyboard композитором; при его
отсутствии приложение сообщает ошибку и сохраняет черновик.

## Проверки

Из корня репозитория:

```bash
npm --prefix voice-overlay test
cargo test --locked --manifest-path voice-overlay/linux/check/Cargo.toml
ORCHESTRA_WAYLAND_SMOKE=1 dbus-run-session -- cargo test --locked \
  --manifest-path voice-overlay/linux/check/Cargo.toml \
  wayland_gnome_dbus_focus_clipboard_and_toggle -- --ignored --test-threads=1
```

Изолированный crate использует те же Rust-файлы, что Tauri, и не требует GTK/WebKit.
Workflow `voice-linux-input` проверяет протоколы в отдельном D-Bus-сеансе и Xvfb.
GNOME JS-тесты исполняют исходник расширения с mock API и покрывают Unicode, Ctrl+V /
Ctrl+Shift+V без Enter, отказ чужому D-Bus-клиенту, смену окна, автоповтор, таймаут
отпускания модификаторов и ошибки виртуальной клавиатуры.

Перед релизом остаётся ручной тест в настоящих GNOME/Plasma/Sway/Hyprland:
диктовка в TUI, Desktop и браузере, смена окна во время STT, повторная вставка,
отказ/отзыв разрешений и выключение расширения. Mock-тесты и кросс-компиляция
не подтверждают работу на настоящем Wayland-десктопе.

Протоколы: [GlobalShortcuts](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.GlobalShortcuts.html),
[RemoteDesktop](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html),
[Clipboard](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.Clipboard.html).
