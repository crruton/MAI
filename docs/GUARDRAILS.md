# Guardrails

Guardrails — это предсказуемые запреты, которые проверяются **до** запуска
команды встроенным агентом. Они не заменяют песочницу и не защищают от
внешних CLI: те запускаются как отдельные процессы или контейнеры и не проходят
эти проверки.

## Что блокируется по умолчанию

| Правило | Примеры |
|---|---|
| Удаление корня | `rm -rf /`, `rm -rf ~`, `rm -rf $HOME` |
| Удаление диска Windows | `del /f /s /q C:\`, `rd /s /q D:\` |
| PowerShell-удаление корня | `Remove-Item -Recurse -Force C:\` |
| Форматирование и разделы | `format C:`, `Format-Volume`, `diskpart`, `mkfs` |
| Запись в блочное устройство | `dd ... of=/dev/sda` |
| Выключение машины | `shutdown`, `reboot`, `poweroff`, `halt` |
| Fork-бомба | `:(){ :|:& };:` |
| Pipe-to-shell | `curl https://x \| sh`, `irm ... \| iex` |
| `chmod 777` на корень | `chmod -R 777 /` |
| Затирание диска | `cipher /w:C:` |

Дополнительно:

- **Длина команды** — по умолчанию 4000 символов.
- **Секретные файлы** — `.env`, `.env.*` (кроме `.env.example`, `.env.sample`,
  `.env.template`, `.env.dist`), `.npmrc`, `.pypirc`, `.netrc`,
  `.git-credentials`, `id_rsa`, `id_ed25519`, `*.pem`, `*.key`, `*.pfx`,
  `*.p12`, `.ssh/`, `.aws/credentials`, `.docker/config.json`.
- **Свои запреты** — список регулярных выражений в настройках.

## Где применяется

- `run_shell` встроенного агента;
- чтение, запись и изменение файлов (`read_file`, `write_file`, `apply_patch`);
- поиск по файлам (`search_files` не показывает секреты);
- стадии деплоя на досках (`boards:stageRun`);
- вложения в композере: файлы с секретными именами не прикрепляются, пока не
  включено «Разрешить доступ к секретам»;
- журнал ошибок и телеметрия — секреты маскируются (`redactSecrets`).

## Настройки

`%APPDATA%\mai-code\settings.json`:

```json
{
  "guardrails": {
    "enabled": true,
    "blockDangerous": true,
    "protectSecrets": true,
    "allowSecrets": false,
    "maxCommandLength": 4000,
    "extraDeny": ["\\bterraform\\s+destroy\\b"]
  }
}
```

Те же поля есть в **Настройки → Guardrails**.

`allowSecrets: true` снимает запрет на доступ к секретным файлам. Включайте
осознанно: агент сможет прочитать `.env` и ключи.

## Что guardrails не делают

- Не изолируют процессы и сеть.
- Не проверяют команды, которые выполняет внешний рантайм (OpenCode, Claude
  Code, Hermes, `dsh` и т. п.).
- Не мешают агенту записать вредоносный код в файл и запустить его позже,
  если команда сама по себе выглядит безопасной.
- Не являются антивирусом.

Для реальной изоляции используйте Docker-песочницу или docker-режим рантайма.
См. [SANDBOXES.md](SANDBOXES.md).

## Проверка

```powershell
node -e "import('./electron/lib/guardrails.js').then(g => console.log(g.checkCommand('rm -rf /')))"
```

Ожидаемый результат: `allowed: false`, правило `dangerous`.
