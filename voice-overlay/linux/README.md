# Горячая клавиша и вставка на Linux

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
