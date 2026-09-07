# Voice Overlay for OpenCode — Design (Tauri v2, offline)

**Date:** 2026-09-07
**Status:** Sections 1–5 presented in chat; Section 1 approved («согласовано» → build); v1 TUI implemented in `feat/voice-overlay` (TS green 15/15, Rust E2E pending on toolchain machines). Section 6 (Web target) — written supplement, awaiting review.
**Path:** Architectural (new out-of-TUI subsystem + new repo node + Rust toolchain + OS-level audio)

## Goal

Дать пользователю внешнюю плавающую кнопку голосового ввода для OpenCode: нажал → наговорил → текст появился в строке ввода уже открытого TUI. Строго офлайн (без облачных STT-API), ОС Windows и Linux, запись только через `ffmpeg`.

Явный не-результат: никакой кнопки внутри TUI, никакого стриминга распознавания в v1.

Дополнение Section 6: второй таргет доставки — браузерный клиент (`opencode web` на том же сервере). Запись/STT общие; различается только доставка: TUI = черновик в промпт (`POST /tui/append-prompt`, Enter жмёт пользователь), Web = сообщение в выбранную сессию (Messages API, явное подтверждение в окне оверлея, автоотправка запрещена тем же решением, что и автосабмит в TUI).

## Decisions log (chat-approved)

- **Вариант B — Tauri v2 overlay.** A (Python+tkinter, быстрый MVP) отклонён пользователем; C (только плагин `/voice` внутри TUI) отклонён как противоречащий требованию «кнопка вне TUI». B строится на том же фронтенд-стеке, что `dashboard/` (React + Vite + Tailwind), но как изолированный узел.
- **Доставка — append в промпт TUI** (не автоотправка, не прямое сообщение в сессию, не только буфер). Основание: Server API это поддерживает штатно — `POST /tui/append-prompt` (проверено по `https://opencode.ai/docs/server/` 2026-09-07). Пользователь проверяет текст и сам жмёт Enter.
- **STT — локальный whisper.cpp, модели ggml.** Дефолт `base` (~140 МБ, русский из коробки), опция `small` (~460 МБ, точнее). Никаких API-ключей и сети после первой загрузки модели.
- **Запись — ffmpeg.** Linux `pulse` (fallback `alsa`); Windows `dshow` (fallback `wasapi`) + селект устройства.
- **Контракт доставки (снят с живого opencode 1.18.19, 2026-09-07):** `POST {host}:{port}/tui/append-prompt`, тело строго `{"text": string}`, ответ `boolean`. Важно: headless `serve` без TUI тоже отвечает `true`, текст при этом никуда не попадает — `true` не доказывает наличие живого TUI. Единственный fallback v1 (копия в буфер обмена + подсказка запустить `opencode --port 4096`) срабатывает только на транспортные ошибки и не-2xx (в т.ч. 401 — неверный пароль). Фиксированный порт + живой TUI — жёсткое предусловие, проверяется ручным E2E (Section 5).
- **YAGNI v1:** стриминг STT, waveform/уровень в реальном времени, глобальный хоткей, выбор сессии, облачный fallback.
- **Дополнение Section 6 (Web target, 2026-09-07, по вопросу «а для браузерной версии десктопа?»):** v1 покрывает только TUI — `POST /tui/append-prompt` в браузере (`opencode web`) делать нечего: TUI-промпта там нет, сервер ответит `true`, а пользователь ничего не увидит (тот же класс молчаливой потери, что `serve` без TUI). Поэтому вводится второй таргет доставки с переключателем в настройках (дефолт `tui` — поведение v1 не меняется). Выбор сессии, снятый с повестки в v1 по YAGNI, для Web-таргета становится обязательным (сессий N, активной одной нет). Автоотправка запрещена в обоих таргетах: Web-поток тоже требует явного подтверждения транскрипта в окне оверлея перед отправкой в сессию.

## Verified context (2026-09-07, this repo)

- `dashboard/`: React 19 + Vite + Tailwind, `target ES2023`, `jsx: react-jsx`; сборки `build:dashboard → dashboard-dist/`, `build:plugin → dist/` (`package.json`). Повторное использование — только паттерны/стили, не общий билд.
- `**/*tauri*`, `**/Cargo.toml` — отсутствуют: Tauri-узла в репо нет, создаётся с нуля.
- В этом контейнере отсутствуют `cargo`, `rustc`, `ffmpeg` (есть только `python3`): сборка Tauri и ручной end-to-end тест здесь невозможны — сборка/проверка идут на машинах Win/Linux с тулчейном (см. Section 5). Это зафиксированный риск, а не блокер спека.
- Server API (доки): `GET /global/health`, `POST /tui/append-prompt`, `POST /tui/submit-prompt` (не используем в v1), OpenAPI-спек на `/doc`, Basic-auth через `OPENCODE_SERVER_PASSWORD` / `OPENCODE_SERVER_USERNAME`.
- Server API для Web (доки `https://opencode.ai/docs/server/`, 2026-09-07, оглавление + HTML-выгрузка): `opencode` = TUI + server (TUI — клиент сервера); `opencode serve` — headless-сервер; `opencode web` — браузерный клиент того же сервера, делит сессии/состояние, работает параллельно с терминалом. Группы эндпоинтов разделены: `TUI` (`/tui/*`) vs `Sessions`/`Messages` (`GET /session`, `GET /session/:id`, `GET|POST /session/:id/message`, `POST /session/:id/prompt_async`, `POST /session/:id/abort`, …). Точная форма тела `POST /session/:id/message` фиксируется сверкой с живым `/doc` на машине с тулчейном до реализации (тот же приём, что сверка флагов whisper.cpp в Section 5) — см. Section 6.

## Section 1/5 — Architecture (approved in chat)

Новый изолированный узел `voice-overlay/` рядом с `dashboard/`, не внутри плагина orchestra. Пять компонентов, у каждого одна ответственность:

1. `overlay-ui` — frameless always-on-top окно ~320×140: кнопка Record/Stop, таймер, статус (`idle | recording | transcribing | error`), превью транскрипта, вход в настройки. Только UI; прямого доступа к железу/сети нет.
2. `tauri-commands (Rust)` — `start_recording / stop_recording / transcribe / append_to_prompt / health_check`. Весь доступ к железу и сети только здесь; UI ходит только через `invoke`.
3. `recorder (ffmpeg sidecar)` — пишет `record.wav` (`-ar 16000 -ac 1 pcm_s16le`). Детали по ОС — Section 3.
4. `stt (whisper.cpp sidecar + ggml)` — офлайн-транскрипция, `lang=ru`. Детали — Section 3.
5. `opencode-link` — `GET /global/health` → `POST /tui/append-prompt`. Конфиг: `host / port / username / password`. Предусловие: opencode запущен с фиксированным портом (`opencode --port 4096 --hostname 127.0.0.1` либо `serve` + `attach`); со случайным портом TUI внешний процесс адресовать не может — это показывается в UI как явная ошибка, а не молчаливый фол.

Границы: `overlay-ui → tauri-commands → {ffmpeg sidecar, whisper sidecar, opencode server}`. Существующие `src/`, `dashboard/`, `dist/` не затрагиваются, кроме добавления скриптов `dev:voice` / `build:voice` в корневой `package.json`.

## Section 2/5 — Data flow

```
[Record] → start_recording(device) → спавн ffmpeg → wav растёт, таймер идёт
[Stop]   → stop_recording() → graceful-стоп ffmpeg (Linux: SIGTERM; Windows: `q` в stdin
         процесса, fallback — taskkill) → проверка wav (размер/длительность > ~0.5 с)
         → transcribe(wav) → whisper.cpp lang=ru → текст → превью в окне
[Вставить] (авто после transcribe) → append_to_prompt(text) → POST /tui/append-prompt с {"text"}
         → 200 true = принято сервером; transport/non-2xx → clipboard-fallback + error
```

Состояния окна: `idle → recording → transcribing → idle(ok) | error(причина + действие)`. Параллельная запись запрещена гардом (кнопка дизейблится в `recording/transcribing`). Лимит записи 120 с с автостопом. Повторный Stop без записи — no-op. Пустой транскрипт — `error(empty-transcript)`, а не пустая вставка. Порядок отмены: пользовательский Stop всегда имеет приоритет над автостопом.

## Section 3/5 — OS specifics (ffmpeg + whisper, offline)

Запись (единый wav-профиль везде: `-ar 16000 -ac 1 -c:a pcm_s16le -y <tmp>/record.wav`):

- **Linux:** `-f pulse -i default`; fallback `-f alsa -i default`. Предстартовая проверка `pactl info` (или PipeWire-эквивалент); при отсутствии — `error(no-audio-server)` с текстом что поставить.
- **Windows:** енумерация `ffmpeg -list_devices true -f dshow -i dummy` → селект устройства в настройках → `-f dshow -i audio="<name>"`; fallback `-f wasapi -i default`. Имя устройства экранируется (кавычки/юникод).

STT: whisper.cpp sidecar, вызов `whisper-bin -m <model.ggml> -l ru -f record.wav -otxt -of <out>` (флаги фиксируются при интеграции с конкретной сборкой whisper.cpp; несоответствие флагов — пункт проверки Section 5). Модели: `base` дефолт, `small` опция; первая загрузка с huggingface с sha-проверкой в app-data, дальше без сети. Отсутствие модели — `error(model-missing)` с кнопкой «Скачать» (единственное место, где сеть допустима).

Таймауты: остановка ffmpeg — graceful-стоп + 5 с grace, затем SIGKILL (Linux) / taskkill /F (Windows); транскрипция — 10 мин hard-cap (длиннее быть не может из-за лимита 120 с записи, cap страховочный).

## Section 4/5 — Files & build (new, existing untouched)

```
voice-overlay/
  package.json            # отдельный пакет: react, vite, @tauri-apps/api; скрипты dev/build/typecheck
  vite.config.ts          # отдельный root+port, НЕ трогает dashboard/vite.config.ts
  index.html
  src/main.tsx            # минимальная обвязка (без QueryClient/Router дашборда — YAGNI)
  src/App.tsx             # окно: кнопка, таймер, статус, превью
  src/settings.tsx        # host/port/auth, микрофон, модель base/small
  src/api.ts              # invoke-обёртки + типы состояний/ошибок
  src-tauri/Cargo.toml
  src-tauri/tauri.conf.json  # окно 320×140 always-on-top; sidecars ffmpeg-*, whisper-bin-*;
                             # bundle targets: deb/appimage (linux), nsis (windows)
  src-tauri/src/main.rs  # 5 команд Section 1
```

Корневой `package.json`: добавить только `dev:voice` / `build:voice`. Версионирование overlay независимо от версии плагина orchestra. Стили: переиспользовать Tailwind-токены/`cn`, Hugeicons-кнопку микрофона, `i18n` (ru) по образцу дашборда — копированием, не shared-импортами (изоляция сборок).

## Section 5/5 — Errors & verification

Каталог ошибок (каждая — видимое состояние окна + действие): `no-mic | no-ffmpeg | no-audio-server(linux) | model-missing | server-unreachable | unauthorized(401) | empty-transcript | too-long(>120с) | transcribe-failed | empty-recording`. Тексты на русском, с конкретным следующим шагом (какую команду запустить / где поменять порт / где вписать пароль).

Верификация (всё в build-среде с тулчейном, не в этом контейнере):

1. `tsc --noEmit` в `voice-overlay/` + `cargo check` в `src-tauri/` — green.
2. `tauri build` на Linux; Windows — на Win-машине или CI (кросс-пак nsis из Linux не гарантируем, фиксируем как риск).
3. Ручной чеклист: 5 с русской речи → текст в промпте открытого `opencode --port 4096`; негативы: сервер выключен (ожидаем clipboard-fallback), неверный пароль (ожидаем `unauthorized`), нет микрофона; отдельно: `serve` без TUI отвечает `true` и теряет текст — кейс документирует предусловие живого TUI, fallback на нём НЕ срабатывает.
4. Микрофон в CI мокается (фикстура wav → transcribe → мок `/tui/append-prompt`); живых устройств в CI нет.
5. Флаги whisper.cpp сверяются с вендоренной сборкой до релиза (см. Section 3).

## Section 6/5+1 — Web target (`opencode web`, дополнение)

### Почему отдельный таргет

`opencode web` — другой клиент того же сервера: у него нет TUI-промпта, есть список сессий и поле ввода веба. TUI-доставка (`POST /tui/append-prompt`) в вебе бессмысленна: сервер может ответить `true`, но текст нигде не появится. Поэтому доставка ветвится по настройке `target: "tui" | "web"` (дефолт `"tui"`). Запись (`recorder`), STT (`whisper.cpp`), окно и состояния общие; различаются только шаги после превью транскрипта.

### Контракт доставки Web (фиксируется сверкой с `/doc`)

- Список сессий: `GET {host}:{port}/session` → массив сессий (поля `id`, при наличии `title`/`updatedAt` — отобразить в селекторе; точные имена полей сверить с `/doc`, несоответствие — пункт проверки).
- Отправка: `POST {host}:{port}/session/:id/message` (альтернатива — `POST /session/:id/prompt_async`, выбор фиксируется той же сверкой: берётся тот эндпоинт, который по `/doc` означает «отправить сообщение пользователя в сессию»; второй не используется).
- Тело запроса и семантика «черновик vs сразу модели» фиксируются сверкой с `/doc` до реализации. Правило неизменно: **автоотправка запрещена** — после транскрипции окно показывает превью + кнопку «Отправить в сессию»; отправка происходит только по явному нажатию. Нарушить это — значит нарушить решение «не автоотправка» из Decisions log.
- Auth/health те же: `GET /global/health`, Basic-auth (`OPENCODE_SERVER_PASSWORD` / `OPENCODE_SERVER_USERNAME`). CORS (`opencode serve/web --cors …`) касается только браузерного fetch; Rust-команды ходят через `reqwest` из Tauri-процесса и под CORS не подпадают — отдельной настройки CORS в оверлее нет, в README одна строка-примечание.

### Data flow Web

```
[Record] → start_recording(device) → wav растёт, таймер идёт          (общее с TUI)
[Stop]   → stop_recording() → проверка wav → transcribe(wav) → текст → превью в окне
           (общее с TUI, включая лимит 120 с, гард параллельной записи,
           error(empty-transcript) вместо пустой отправки)
[Выбрать сессию] (настройки: target=web + sessionId; список из GET /session;
           пустой список — error(no-session), см. каталог ниже)
[Отправить] (только по кнопке в окне) → send_to_session(sessionId, text)
           → POST /session/:id/message → 2xx = отправлено, статус idle + notice
           → transport/non-2xx → clipboard-fallback + error (та же логика, что в TUI)
```

Переключение `target` не сбрасывает транскрипт-превью, но сбрасывает статус `error` в `idle` (смена таргета — осознанное действие, старая ошибка к новому таргету не относится). `sessionId`, указывающий на удалённую сессию (404), — `error(session-not-found)` с действием «обнови список и выбери снова», а не молчаливый фол.

### Настройки (дополнение к `settings.tsx`)

- `target: "tui" | "web"` — радиопереключатель, дефолт `"tui"`. При `tui` селектор сессии скрыт и disabled; при `web` обязателен.
- `sessionId: string` — выбранная сессия, персист в том же `localStorage`-ключе (`voice-overlay-settings:v1`, миграция: отсутствующие поля добиваются дефолтами `target: "tui"`, `sessionId: ""`). Пустой `sessionId` при `target=web` блокирует кнопку «Отправить» (disabled + подсказка «выбери сессию»).
- Остальные поля без изменений: `host / port / username / password / device / model`.

### Каталог ошибок Web (дополняет Section 5, тексты на русском с действием)

- `no-session` — «Нет ни одной сессии. Создай сессию в `opencode web` и обнови список.»
- `session-not-found` — «Сессия не найдена (удалена?). Обнови список и выбери снова.»
- Остальные общие: `server-unreachable | unauthorized(401) | empty-transcript | empty-recording | too-long | transcribe-failed | no-mic | no-ffmpeg | no-audio-server` — те же тексты, что в Section 5. Каталог `ERROR_CODES` при реализации Task 6 растёт с 10 до 12 (`+ no-session | session-not-found`), списки в `errorCopy`/`codeOf` обновляются синхронно. TUI-специфичный кейс «`serve` без TUI отвечает `true`» на Web не распространяется; молчаливого success-без-эффекта в Web-потоке нет: 2xx означает принятое сообщение.

### Файлы (дополнение к Section 4, существующее не трогается)

```
voice-overlay/
  src/lib/opencode.ts   # + sessionRequest(cfg, sessionId, text), parseSessionList(json),
                        #   типы SessionRef { id: string; title: string }, Target = "tui" | "web"
  src/api.ts            # + listSessions(cfg): Promise<SessionRef[]>,
                        #   sendToSession(cfg, sessionId, text): Promise<boolean>
  src/settings.tsx      # + target-переключатель, sessionId-селектор, миграция дефолтов
  src/App.tsx           # + ветвление после превью: tui → appendToPrompt (как сейчас),
                        #   web → кнопка «Отправить в сессию» → sendToSession
  src-tauri/src/main.rs # + команды list_sessions(cfg), send_to_session(cfg, session_id, text)
                        #   + чистые fns session_url, message_url (тестируются как append_url)
```

Контракт ошибок Rust→UI прежний: `Err("<code>: <человеческий текст>")`, UI делит по первому `": "`.

### Верификация Web (дополняет Section 5, всё на машинах с тулчейном)

1. Сверка с живым `/doc` (`opencode web`/`serve` той же версии, что прод): имена полей `GET /session`, форма тела `POST /session/:id/message` (или решение в пользу `prompt_async` с записью отклонения в README). Без этой сверки код отправки не пишется.
2. `tsc --noEmit` + `cargo test` (новые тесты: `session_url`, `message_url`, `parseSessionList`, allowlist таргета) — green; старые 7 Rust-тестов и 15 TS-тестов без регрессий.
3. Ручной чеклист Web: открыть `opencode web --port 4096`, создать сессию, в оверлее target=web + выбрать сессию, 5 с русской речи → сообщение появляется в выбранной сессии только после нажатия «Отправить»; негативы: список пуст (`no-session`), неверный пароль (`unauthorized`), сервер выключен (clipboard-fallback), удалённая сессия (`session-not-found`); регрессия TUI-матрицы Section 5 полностью зелёная.

## Risks

- Web: семантика `POST /session/:id/message` vs `prompt_async` (черновик vs сразу модели) различается между версиями сервера — лечится обязательной сверкой с `/doc` (Section 6, п.1) и явной кнопкой подтверждения в окне.
- Web: отправка не в ту сессию при устаревшем `sessionId` — лечится `error(session-not-found)` + ручным обновлением списка, авторетраи в другую сессию запрещены.
- Rust/ffmpeg отсутствуют в текущем контейнере — сборка только на целевых машинах/CI.
- Windows-устройства dshow с юникод-именами — экранирование тестируется вручную на Win.
- Случайный порт TUI по умолчанию — лечится требованием фиксированного `--port` + явной ошибкой в UI.
- Размер дистрибутива (ffmpeg + whisper + модели) — модели докачиваются отдельно, не в бандл.

## Rollout (build order)

1. Скаффолд `voice-overlay/` + `src-tauri/`, окно Record/Stop с таймером (мок команд).
2. `start/stop_recording` через системный ffmpeg (до упаковки sidecars).
3. `transcribe` через локальный whisper.cpp `base`, превью.
4. `append_to_prompt` + `health_check` + экран настроек.
5. Sidecars, бандлы deb/appimage/nsis, README (порт, модели, устройства), ручной чеклист Section 5.
6. Web-таргет (Section 6, отдельным Task 6 плана): сверка с `/doc` → `list_sessions/send_to_session` (TS+ Rust + тесты) → target-переключатель и селектор сессии в настройках → ветвление App.tsx → README (web-раздел) → ручной чеклист Section 6 + регрессия TUI-матрицы.
