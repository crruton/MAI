# Proposal: офлайн-дистрибутив

## Проблема

Пользователь скачивает TAR и не может запустить приложение без сети: в архиве
нет `node_modules`, а `npm install` требует доступа к registry.

## Решение

Собирать `mai-code-<version>-offline-win-x64.tar.gz`:

- `dist/win-unpacked` (portable EXE и ресурсы);
- production-`node_modules`;
- `start-mai-code.cmd`;
- `README-OFFLINE.txt` и SHA-256.

## Критерии приёмки

- Архив распаковывается на чистой Windows без Node.js.
- `start-mai-code.cmd` запускает приложение.
- Приложение работает без сети, кроме запросов к провайдеру.
- SHA-256 совпадает с опубликованным.
- README честно пишет: подписи нет, SmartScreen предупредит, автообновления нет.

## Вне scope

- Подпись кода.
- Автообновление.
- Сборка macOS/Linux в этом изменении.
