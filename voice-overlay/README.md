# Voice Overlay — офлайн голосовой ввод для OpenCode (Tauri v2)

Плавающая кнопка вне TUI: нажал → наговорил → текст появился в строке ввода уже открытого TUI.
Строго офлайн (без облачных STT-API). ОС: Windows и Linux. Запись только через `ffmpeg`, распознавание — локальный whisper.cpp (`ggml`).

Явный не-результат v1: никакой кнопки внутри TUI, никакого стриминга распознавания.

Окно содержит кнопку микрофона, таймер и кнопку остановки. Во время распознавания
показывается индикатор; настройки и закрытие заблокированы до завершения операции.
Окно можно перетащить за заголовок. Настройки и длинный результат прокручиваются.

### Linux: ffmpeg и графика

Приложение ищет ffmpeg и Whisper рядом со своим исполняемым файлом, включая имена
с target triple из npm и короткие имена из Tauri-бандла. Повторный `install`
обновляет файлы и восстанавливает права на запуск всех трёх исполняемых файлов.

Linux-пакет собирает минимальный ffmpeg из исходников с поддержкой входа PulseAudio;
на системе нужна `libpulse.so.0` (Ubuntu/Debian: пакет `libpulse0`) и доступный
PulseAudio или PipeWire с совместимостью PulseAudio. Проверка `-devices` выполняется
до записи; если комплектный ffmpeg непригоден, пробуется системный.
Старые пакеты со статическим ffmpeg могут не поддерживать PulseAudio. Для них:

```bash
sudo apt install ffmpeg pulseaudio-utils
pactl info
```

Подробная причина сбоя доступна в раскрывающемся блоке «Подробности ошибки».
Отсутствие Whisper теперь сообщается как ошибка распознавания, а не ffmpeg.

На Linux приложение по умолчанию устанавливает `WEBKIT_DISABLE_DMABUF_RENDERER=1`
до запуска WebKit, если переменная ещё не задана пользователем. Это обход проблем
DMA-BUF на WSL/виртуальных машинах ([описание WebKitGTK](https://planet.webkitgtk.org/)).
Предупреждения EGL/Mesa могут зависеть и от системного драйвера. Для диагностики
старой версии или оставшихся проблем можно проверить программный рендеринг:

```bash
WEBKIT_DISABLE_DMABUF_RENDERER=1 LIBGL_ALWAYS_SOFTWARE=1 ~/.local/bin/voice-overlay
```

## Предусловие: живой TUI с фиксированным портом

Overlay ходит в Server API живого TUI:

- `GET http://{host}:{port}/global/health`
- `POST http://{host}:{port}/tui/append-prompt` с телом строго `{"text": string}`, ответ `boolean`

Запусти OpenCode с фиксированным портом:

```bash
opencode --port 4096 --hostname 127.0.0.1
```

Со случайным портом внешний процесс адресовать TUI не может — окно покажет явную ошибку.
Важно (проверено на opencode 1.18.19): headless `serve` без TUI тоже отвечает `true`, текст при этом никуда не попадает. `true` не доказывает наличие живого TUI. Clipboard-fallback срабатывает только на транспортные ошибки и не-2xx (в т.ч. 401).

## Требования

- Node 22+, npm
- Rust stable через rustup:
  - Linux: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y`
  - Windows: `winget install Rustlang.Rustup`
- Системный ffmpeg для dev-режима (до упаковки sidecars):
  - Linux: `sudo apt install ffmpeg pulseaudio-utils` (или PipeWire-эквивалент)
  - Windows: `winget install Gyan.FFmpeg` + селект устройства в настройках
- Модели whisper.cpp — скачиваются один раз (единственное место, где нужна сеть):

```bash
# Linux: app-data каталог, например ~/.local/share/ai.opencode.voice-overlay/models/
mkdir -p ~/.local/share/ai.opencode.voice-overlay/models
cd ~/.local/share/ai.opencode.voice-overlay/models
curl -L -o ggml-base.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin
# опционально точнее:
curl -L -o ggml-small.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin
sha256sum ggml-base.bin ggml-small.bin
```

```powershell
# Windows (PowerShell): %APPDATA%\ai.opencode.voice-overlay\models\
mkdir "$env:APPDATA\ai.opencode.voice-overlay\models" -Force
cd "$env:APPDATA\ai.opencode.voice-overlay\models"
Invoke-WebRequest -Uri https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin -OutFile ggml-base.bin
Get-FileHash ggml-base.bin -Algorithm SHA256
```

## Sidecars (упаковка)

Имена load-bearing (`sidecar_file` в `src-tauri/src/main.rs` их конструирует):

- `src-tauri/binaries/ffmpeg-x86_64-unknown-linux-gnu` — минимальная сборка из [FFmpeg 7.0.2](https://ffmpeg.org/releases/ffmpeg-7.0.2.tar.xz) через `scripts/build-voice-ffmpeg.sh`, с `--enable-libpulse` ([документация входа](https://ffmpeg.org/ffmpeg-devices.html#pulse)); библиотеки FFmpeg статические, libpulse системная.
- `src-tauri/binaries/ffmpeg-x86_64-pc-windows-msvc.exe` — Windows essentials build (https://www.gyan.dev/ffmpeg/builds/)
- `src-tauri/binaries/whisper-x86_64-unknown-linux-gnu` и `whisper-x86_64-pc-windows-msvc.exe` — matching whisper.cpp release (https://github.com/ggerganov/whisper.cpp/releases)

Флаги whisper сверяются до релиза: `<path-to-whisper-sidecar> --help` должен содержать `-m -l -f -otxt -of` с теми же смыслами. Модели в бандл не входят.

## Dev и сборка

```bash
# из корня репо:
npm run dev:voice      # tauri dev (фронт на http://localhost:1421)
npm run build:voice    # tauri build -> deb/appimage (linux), nsis (windows, только на Win)

# внутри voice-overlay/:
npm run dev:frontend   # только Vite
npm run build:frontend # только Vite build
npm run typecheck      # tsc --noEmit
npm test               # tsc + node --test (чистые TS-библиотеки)
cargo check && cargo test  # в src-tauri/ (на машине с тулчейном)
```

Для Linux перед упаковкой AppImage из корня репозитория задайте путь к
скачанным библиотекам whisper:

```bash
export LD_LIBRARY_PATH="$PWD/voice-overlay/src-tauri/binaries${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
npm --prefix voice-overlay run build -- --verbose
```

В CI это делает workflow. Tauri переносит whisper в `usr/bin`, а библиотеки
из `bundle.resources` — в каталог ресурсов. Без указанного пути `linuxdeploy`
останавливается с `Could not find dependency: libwhisper.so.1`.
Скрипт подготовки npm-пакета берёт приложение из `target/release`, а sidecars
и их библиотеки — из `src-tauri/binaries`, сохраняя исходные имена.
Проверка этого шага: `node --test scripts/pack-voice-overlay.test.mjs` из корня.

## Ручной E2E чеклист (на машинах с тулчейном)

| # | Действие | Ожидание |
|---|----------|----------|
| 1 | Открыть `opencode --port 4096`, Record, 5 с русской речи, Stop | Текст в промпте TUI, статус idle, превью совпадает |
| 2 | Остановить сервер, повторить | Текст в буфере обмена + notice про буфер |
| 3 | Неверный пароль в настройках, повторить | `unauthorized`-текст из каталога |
| 4 | Stop без Record | Окно остаётся в idle, UI показывает текст ошибки как есть |
| 5 | `serve` без TUI, повторить | Ответ `true`, текст теряется — предусловие живого TUI (не баг) |
| 6 | 121 с записи | Автостоп на 120 с, notice про лимит |

Дополнительно: `ffmpeg -f lavfi -i "sine=frequency=440:duration=2" -ar 16000 -ac 1 -c:a pcm_s16le -y /tmp/voice-probe.wav` должен дать файл ≥ 64000 байт (профиль записи).

## Web-таргет (opencode web)

### Микрофон внутри веб-интерфейса

Из исходников после `npm run build:plugin`, в двух терминалах:

```bash
opencode web --port 4096
bunx @oeronteros-1/opencode-orchestra@latest web
```

Откройте **http://127.0.0.1:4097**. Кнопка микрофона появится рядом с отправкой
в поле ввода OpenCode. Разрешите браузеру доступ к микрофону; повторное нажатие
останавливает запись. Лимит — 120 секунд. Запись и распознавание можно отменить.
Распознавание выполняет локальный
Whisper из установки voice-overlay с моделью `ggml-base.bin`; запись и перевод
в WAV выполняет браузер. Требуется предварительная установка voice-overlay и модели.

Сессия определяется по адресу открытой вкладки, включая проект. Текст дописывается
в её черновик, сохраняя выбранные модель, агента и вложения. Отправка — обычной
кнопкой OpenCode. Если во время записи или распознавания перейти в другую сессию,
текст останется в редактируемой панели: его можно скопировать или удалить либо
вернуться в исходную сессию и вставить. Невставленный результат сохраняется в
`sessionStorage` вкладки и переживает перезагрузку.

Другие порты: `bunx @oeronteros-1/opencode-orchestra@latest web --upstream http://127.0.0.1:4096 --port 4097`.
Прокси слушает только loopback. Используйте Chrome/Edge с поддержкой MediaRecorder.
Обычный адрес OpenCode на порту 4096 остаётся без встроенной кнопки.
Интеграция использует DOM редактора OpenCode (`data-component="prompt-input"`
и кнопку submit); после изменения интерфейса upstream может потребоваться адаптация.
Исходник редактора: [prompt-input.tsx](https://github.com/anomalyco/opencode/blob/dev/packages/app/src/components/prompt-input.tsx).

### Отдельное окно оверлея

Предусловие: `opencode web --port 4096` (та же Basic-auth через `OPENCODE_SERVER_PASSWORD`). В настройках оверлея переключи «Куда вставлять» на «Web-сессия» и выбери сессию из списка (`GET /session`). Дефолт — TUI, поведение v1 не меняется.

Правило как в TUI: автоотправки нет. После транскрипции окно показывает превью и кнопку «Отправить в сессию» — сообщение уходит только по нажатию.

Выбор эндпоинта (снято с живых доков `https://opencode.ai/docs/server/`, 2026-09-07): `POST /session/:id/prompt_async` с телом `{ parts: [{ type: "text", text }] }` — тот же body, что у `POST /session/:id/message`, но возвращает 204 и не ждёт ответа модели (блокирующий `/message` для оверлея не подходит — подвесит окно). Форму `parts` сверить с живым `/doc` (`curl -s http://127.0.0.1:4096/doc`) до релиза; отклонений на 2026-09-07 нет.

Чеклист Web: открыть `opencode web --port 4096`, создать сессию, target=web + сессия, 5 с русской речи → сообщение в выбранной сессии только после «Отправить»; негативы: сессий нет (`no-session`), неверный пароль (`unauthorized`), сервер выключен (буфер обмена), сессия удалена (`session-not-found`).

## Известные ограничения v1

- Модель base устанавливается и проверяется по SHA-256 командой
  `opencode-orchestra install`; модель small пока устанавливается вручную.
- Нет глобального хоткея, стриминга STT, waveform, выбора сессии, облачного fallback.
- `nsis` собирается только на Windows (кросс-пак из Linux не гарантируется).
- Linux: при отсутствии PulseAudio/PipeWire — `error(no-audio-server)`, поставь звуковой сервер и проверь `pactl info`.
