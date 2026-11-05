# Design: офлайн-дистрибутив

## Состав архива

```
mai-code-0.1.0-offline-win-x64/
  MAI Code.exe              portable-сборка
  resources/app.asar        код приложения
  node_modules/             production-зависимости
  start-mai-code.cmd        запуск
  README-OFFLINE.txt        инструкция
```

## Почему portable, а не NSIS

Portable EXE не требует установки и прав администратора. NSIS остаётся
основным способом для обычного пользователя, но для переноса на чужую машину
portable проще.

## Ограничения

- `node_modules` содержит нативные модули под Windows x64.
- Размер архива — сотни мегабайт.
- SmartScreen предупредит, потому что подписи нет.
