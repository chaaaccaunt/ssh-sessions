# ssh-session

`ssh-session` — TypeScript-библиотека и терминальный CLI поверх системного OpenSSH. Проект не реализует SSH-протокол самостоятельно: он безопасно формирует аргументы и запускает установленные `ssh`, `scp`, `sftp` и `ssh-keygen`, сохраняя совместимость с пользовательскими `ssh_config`, `known_hosts`, `ssh-agent`, `ProxyJump` и другими возможностями OpenSSH.

Проект предоставляет:

- интерактивное SSH-подключение;
- выполнение удалённых команд с capture- или streaming-выводом;
- загрузку и скачивание файлов через `scp`;
- интерактивный и пакетный режимы `sftp`;
- аутентификацию через SSH-конфигурацию, пароль или приватный ключ;
- контролируемую обработку host key и структурированную диагностику ошибок;
- API, не зависящий от CLI и подготовленный для подключения другого UI.

## Статус и границы

Основное приложение находится в `src/` и собрано как CommonJS-пакет. У него нет сторонних runtime-зависимостей: в production используются только Node.js и системные программы OpenSSH.

В текущую область проекта не входят собственная реализация SSH/SFTP, хранение секретов, синхронизация каталогов, автоматическое восстановление оборванной shell-сессии, встроенный PTY-адаптер для GUI и OpenSSH multiplexing. Неуспешная передача файлов или пакетная SFTP-операция может оставить частичный результат.

## Требования

- Node.js с поддержкой ES2022, `AbortSignal` и `node:test`;
- npm;
- OpenSSH в `PATH`: `ssh`, `scp`, `sftp` и `ssh-keygen`.

Доступность OpenSSH можно проверить командой `doctor` после сборки.

## Установка и сборка

```bash
npm install
npm run build
node build/src/bin/index.js doctor
```

Для локального использования команды `ssh-session` можно выполнить `npm link`. Публикуемый entry point библиотеки — `build/src/index.js`, CLI — `build/src/bin/index.js`.

## CLI

```text
ssh-session --help
ssh-session doctor
ssh-session connect <target> [connection-options]
ssh-session exec <target> [connection-options] [--tty] -- "<remote-command>"
ssh-session upload <target> <local-path> <remote-path> [connection-options] [--recursive]
ssh-session download <target> <remote-path> <local-path> [connection-options] [--recursive]
ssh-session files <target> [connection-options]
```

Общие параметры подключения:

```text
--user <name> --password
--user <name> --key <key-name-or-path>
--port <number>
--config <path>
--host-key-policy <ask|accept-new|strict>
--connect-timeout <milliseconds>
--timeout <milliseconds>
```

Если `--password` и `--key` не указаны, target передаётся OpenSSH как alias из SSH-конфигурации. Параметр `--user` допустим только вместе с одним из этих способов аутентификации. Имя ключа разрешается относительно `~/.ssh`, абсолютный путь используется как есть.

Примеры:

```bash
# Alias и параметры из ~/.ssh/config
ssh-session connect production

# Пароль запрашивается скрытым prompt и не передаётся через argv
ssh-session connect example.org --user deploy --password

# Явный приватный ключ
ssh-session exec example.org --user deploy --key id_ed25519 -- "uname -a"

# Каталог передаётся только в явно указанном recursive-режиме
ssh-session upload production ./dist /srv/app --recursive

# Интерактивный SFTP-клиент
ssh-session files production
```

Удалённая команда после `--` должна быть одним аргументом. Локальная shell не запускается, но строку интерпретирует shell удалённой системы, поэтому её правила quoting по-прежнему важны. По умолчанию `exec` запрещает PTY через `-T`; `--tty` запрашивает его через `-tt`.

### Политики host key

- `ask` — политика по умолчанию; новый ключ требует явного подтверждения;
- `accept-new` — OpenSSH автоматически принимает только ранее неизвестные ключи;
- `strict` — разрешены только уже доверенные ключи.

Изменившийся ключ никогда не принимается как новый. Его следует независимо проверить, а запись `known_hosts` — исследовать через `HostKeyTrustService`; сервис подготавливает безопасную команду удаления, но не выполняет её автоматически.

## TypeScript API

Основной facade — `OpenSshSessionService`. Зависимость от запуска процессов передаётся через интерфейс `ProcessRunner`; готовая реализация — `NodeProcessRunner`.

```ts
import {
  NodeProcessRunner,
  OpenSshSessionService,
  type ConnectionRequest
} from "ssh-session"

const service = new OpenSshSessionService(new NodeProcessRunner())

const connection: ConnectionRequest = {
  target: { host: "production" },
  auth: { kind: "ssh-config" },
  hostKeyPolicy: "strict",
  connectTimeoutMs: 10_000,
  overallTimeoutMs: 60_000
}

const result = await service.execute({
  connection,
  command: "uname -a",
  stdin: { mode: "null" },
  output: { mode: "capture", maxBytes: 1024 * 1024 }
})

if (result.status === "completed") {
  console.log(Buffer.from(result.stdout ?? []).toString("utf8"))
} else {
  console.error(result.error?.code, result.exitCode)
}
```

Поддерживаемые операции facade:

- `connect(connection, options)` — интерактивный `ssh` с наследованием terminal stdio;
- `execute(request)` — удалённая команда, управляемые stdin, capture/streaming и PTY;
- `upload(request)` / `download(request)` — передача через `scp`;
- `files(connection, options)` — интерактивный `sftp`;
- `executeFileBatch(request)` — типизированные `put`, `get`, `mkdir`, `rename`, `remove` и `rmdir` через SFTP batch.

Пароль и passphrase API получает лениво через `SecretProvider`, возвращающий `Promise<Uint8Array>`. Операции поддерживают `AbortSignal`, события `state`, `output`, `prompt`, `failure` и состояния `starting`, `running`, `completed`, `failed`, `cancelled`. Capture ограничен одним MiB по умолчанию; при превышении границы результат отмечается флагами `stdoutTruncated` или `stderrTruncated`.

## Архитектура

Код разделён на независимые слои:

```text
src/
├── domain/          типы подключения, результаты и SSH-ошибки
├── application/     сценарии connect/exec/transfer и сервисы диагностики
├── infrastructure/  OpenSSH arguments, process runner и ASKPASS IPC
├── presentation/    разбор CLI и terminal prompts
├── security/        редактирование чувствительных диагностических данных
├── bin/             composition root CLI
└── tests/           модульные и процессные тесты
```

Поток выполнения выглядит так: входной запрос строго валидируется, builder создаёт массив аргументов OpenSSH, `ProcessRunner` запускает бинарник через `spawn()` с `shell: false`, а результат обогащается стабильным `SshError` и событиями приложения. `OpenSshTargetResolver` использует `ssh -G`, чтобы получить фактические hostname, user, port, identity files и ProxyJump без собственного разбора сложного `ssh_config`.

`DoctorService` проверяет наличие всех системных инструментов. `HostKeyTrustService` ищет записи через `ssh-keygen -F`, диагностирует неизвестный или изменившийся ключ и только формирует отдельную команду `ssh-keygen -R` для осознанного исправления.

## Модель безопасности

- Процессы запускаются без локальной shell, а параметры передаются отдельным массивом аргументов.
- Входные структуры не принимают неизвестные поля; host, user, port, пути и timeout проверяются до запуска.
- Пароль и passphrase не помещаются в argv, конфигурационные файлы или журналы.
- Для неинтерактивной передачи секрета создаётся краткоживущий локальный ASKPASS IPC: named pipe в Windows или Unix socket в POSIX.
- IPC защищён случайным токеном; сравнение токена выполняется constant-time, endpoint и секреты очищаются после операции.
- Broker различает password, key passphrase, host authenticity и MFA prompts. Пароль не выдаётся в ответ на fingerprint, MFA или неизвестный prompt, число password prompts ограничено.
- Для password-аутентификации отключаются случайные ключи; для явного ключа включается `IdentitiesOnly=yes` и отключается fallback на пароль.
- Диагностика очищается от terminal control sequences, ограничивается по размеру и проходит редактирование чувствительных полей.

JavaScript не позволяет гарантированно стереть все копии строки из памяти. Поэтому секреты представлены изменяемыми байтовыми буферами и живут минимально возможное время, но это не является гарантией защищённой памяти.

## Результаты и ошибки

Методы возвращают `ProcessResult`: статус, исходный exit code, signal, длительность, признаки timeout и усечения вывода, а также бинарные stdout/stderr при capture. Ненулевой код удалённой команды сохраняется без подмены; код `255` может означать как ошибку SSH, так и код самой команды.

Если ошибка распознана, поле `error` содержит `SshError` со стабильным кодом, например `dns_failed`, `connection_refused`, `host_key_changed`, `authentication_failed`, `process_timeout`, `remote_command_failed` или `transfer_failed`. Классификация сначала использует структуру результата, затем очищенную диагностику OpenSSH. Инфраструктурные ошибки запуска могут быть выброшены как исключения.

Для `upload`, `download` и `executeFileBatch` возвращается дополнительный флаг `potentiallyPartial`. Он равен `true` при failed/cancelled результате: уже выполненные файловые изменения не откатываются, а `scp` не обеспечивает атомарную замену.

## Разработка

```bash
npm run typecheck  # строгая проверка TypeScript без генерации файлов
npm test           # сборка и запуск тестов через node:test
npm run check      # typecheck + test
npm run build      # build/ с JS, declarations и source maps
```

Тесты проверяют валидацию контрактов, отсутствие shell-инъекций, формирование OpenSSH-команд, timeout/cancellation, ограниченный capture, ASKPASS IPC, host key, streaming, CLI, `scp`/`sftp` и классификацию ошибок. Интеграционные подключения к внешним SSH-серверам в стандартный test script не входят.

Дополнительные документы:

- [`docs/REMOTE_COMMANDS.md`](docs/REMOTE_COMMANDS.md) — quoting и семантика удалённых команд;
- [`docs/FILE_TRANSFERS.md`](docs/FILE_TRANSFERS.md) — частичные передачи и SFTP batch;
- [`docs/GUI_READINESS.md`](docs/GUI_READINESS.md) — границы будущего GUI/PTY;
- [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) — исходные требования и этапы реализации;
- [`docs/code-style.md`](docs/code-style.md) — правила кодовой базы.

## Вспомогательные скрипты репозитория

Каталоги `scripts/project-runner/` и `scripts/linux/` не участвуют в сборке или runtime `ssh-session` и не экспортируются пакетом.

`scripts/project-runner/` — автономный CommonJS runner для другого monorepo-layout (`monolith`, `site-admin`, `services`, `gateways`, root development/production config). Требуемых каталогов и конфигураций в этом репозитории нет, а npm script для runner не зарегистрирован, поэтому он не является готовой частью SSH CLI.

`scripts/linux/` содержит root-скрипты Debian/Ubuntu для отдельного multi-site provisioning-контура: установку nginx/Certbot, создание ограниченного системного пользователя и sudo wrappers для nginx, сертификатов и Certbot. Эти скрипты изменяют системную конфигурацию и также не вызываются приложением автоматически.

## Лицензия

ISC.
