# OpenSpec

Спецификации изменений MAI Code.

## Структура

```
openspec/
  project.md                 контекст и принципы
  specs/                     текущие спецификации возможностей
  changes/<name>/
    proposal.md              зачем и что меняем
    design.md                как устроено решение
    tasks.md                 задачи для Multica
    specs/<capability>/spec.md
```

## Команды

```powershell
npm.cmd install -g @fission-ai/openspec
openspec init
openspec validate
```

В MAI Code: панель «Multica» → «Синхронизировать OpenSpec» или
`npm.cmd run multica:sync`.

## Правило формулировок

Задачи пишутся по ASD-STE100:

- одно предложение — одна инструкция;
- активный залог;
- короткие предложения;
- без идиом, метафор и жаргона;
- глагол в начале задачи: «Добавить», «Проверить», «Удалить».

Пример:

> Добавить поле портов в форму песочницы. Проверить, что порт публикуется
> только на 127.0.0.1. Обновить `docs/SANDBOXES.md`.
