# Architecture Decision Records (ADR)

ADR фиксируют решения, которые дорого менять: архитектуру, модель угроз,
форматы данных, внешние зависимости и способ эксплуатации.

## Правила

1. Один файл — одно решение. Имя: `NNNN-kratkoe-imya.md`.
2. Номер не переиспользуется. Следующий номер — максимальный + 1.
3. Статус меняется, текст решения — нет. Если решение устарело, создаётся
   новый ADR со статусом `accepted`, а старый получает `superseded` и ссылку.
4. ADR создаётся одновременно с изменением в `CHANGELOG.md`.
5. Шаблон: [`0000-template.md`](0000-template.md).

## Реестр

| № | Решение | Статус | Дата |
|---|---|---|---|
| [0001](0001-dvuhryadnaya-verhnyaya-panel.md) | Двухрядная верхняя панель | accepted | 2026-11-04 |
| [0002](0002-gitbook-vnutri-prilozheniya.md) | GitBook-документация внутри приложения | accepted | 2026-11-04 |
| [0003](0003-openspec-i-multica.md) | OpenSpec как вход, Multica как доска | accepted | 2026-11-04 |
| [0004](0004-docker-pesochnicy.md) | Docker-песочницы с публикацией портов | accepted | 2026-11-04 |
| [0005](0005-keycloak-postgres.md) | Keycloak на Postgres | accepted, дополнено 0028 | 2026-11-04 |
| [0006](0006-revizor-vtoraya-model.md) | Ревизор: вторая модель проверяет ответ | accepted, дополнено 0027, 0036 | 2026-11-04 |
| [0007](0007-offline-distributiv.md) | Офлайн-дистрибутив с node_modules | accepted | 2026-11-04 |
| [0008](0008-kubernetes-i-dns.md) | Kubernetes и DNS как отдельный слой | accepted | 2026-11-04 |
| [0009](0009-openscion-ne-zamena-git.md) | OpenScion не заменяет локальный git | accepted | 2026-11-04 |
| [0010](0010-pesochy-kak-papka.md) | Песочница-папка остаётся режимом по умолчанию | accepted, дополнено 0028 | 2026-11-04 |
| [0011](0011-guardrails.md) | Guardrails встроенного агента | accepted, дополнено 0027, 0035 | 2026-11-06 |
| [0012](0012-observability-otel.md) | Observability на OpenTelemetry | accepted | 2026-11-06 |
| [0013](0013-vneshnie-rantajmy-v-kontejnerah.md) | Внешние рантаймы в отдельных контейнерах | accepted, дополнено 0029 | 2026-11-06 |
| [0014](0014-harbor-registry.md) | Harbor как registry, а не среда запуска | accepted | 2026-11-06 |
| [0015](0015-oblegchenie-sborki-electron.md) | Облегчение сборки Electron | accepted | 2026-11-07 |
| [0016](0016-vlozheniya-cherez-fajly-proekta.md) | Вложения через файлы проекта, а не через текст промпта | accepted, дополнено 0.2.0 | 2026-11-05 |
| [0017](0017-rezhimy-razreshenij.md) | Режимы разрешений: авто, вручную, принимать правки, план | superseded частично 0027 | 2026-11-05 |
| [0018](0018-tajmauty-podtverzhdenij-i-instrumentov.md) | Таймауты подтверждений и инструментов | accepted, дополнено 0031 | 2026-11-08 |
| [0019](0019-limity-pamyati-docker.md) | Лимиты памяти для локальных Docker-стеков | accepted | 2026-11-08 |
| [0020](0020-mav-servis-ozvuchki.md) | Сервис озвучки MAV и подбор голоса | accepted | 2026-11-08 |
| [0021](0021-golosovoj-vvod-cherez-mas.md) | Голосовой ввод через локальный MAS | accepted | 2026-11-12 |
| [0022](0022-temnaya-polosa-zagolovka.md) | Тёмная полоса заголовка вместо системной | accepted | 2026-11-13 |
| [0023](0023-ocr-cherez-adaptery-dvizhkov.md) | OCR через адаптеры движков | accepted | 2026-11-14 |
| [0024](0024-versii-pamyati.md) | Версии памяти в хранилище артефактов | accepted | 2026-11-15 |
| [0025](0025-eksport-otveta-v-dokumenty.md) | Экспорт ответа в MD, TXT, DOCX, XLSX | accepted | 2026-11-16 |
| [0026](0026-vtoroj-transport-responses-api.md) | Второй транспорт к шлюзу: OpenAI Responses API | accepted, дополнено 0.2.0 | 2026-11-16 |
| [0027](0027-policy-engine.md) | PolicyEngine: одна точка решения о вызове инструмента | accepted | 2026-11-18 |
| [0028](0028-doverie-k-papke-i-matrica-ipc.md) | Доверие к папке проекта и матрица прав IPC | accepted | 2026-11-19 |
| [0029](0029-rezhim-razreshenij-dlya-cli.md) | Режим разрешений и передача запроса для внешних CLI | accepted | 2026-11-19 |
| [0030](0030-plaginy-v-otdelnom-processe.md) | Плагины в отдельном процессе, песочница окон и CSP | accepted | 2026-11-19 |
| [0031](0031-shifrovanie-klyuchej-i-dialogovye-instrumenty.md) | Шифрование ключей и диалоговые инструменты ask_user, exit_plan | accepted | 2026-11-19 |
| [0032](0032-kontekst-i-kompakciya.md) | Учёт контекста и компакция истории | accepted | 2026-11-20 |
| [0033](0033-chekpointy-i-otkat.md) | Чекпоинты правок и откат к сообщению | accepted | 2026-11-20 |
| [0034](0034-hranilishche-chatov.md) | Чаты: файл на сессию, индекс, поиск | accepted | 2026-11-20 |
| [0035](0035-huki.md) | Хуки на события агента | accepted | 2026-11-20 |
| [0036](0036-subagenty.md) | Субагенты | accepted | 2026-11-20 |
| [0037](0037-pakety-plaginov.md) | Пакеты плагинов | accepted | 2026-11-20 |
| [0038](0038-urovni-nastroek.md) | Уровни настроек и панель «Разрешения» | accepted | 2026-11-20 |
| [0039](0039-rezhim-avto.md) | Режим «Авто» с классификатором | accepted | 2026-11-20 |
| [0040](0040-pesochnica-dlya-komand.md) | Песочница для команд агента | accepted | 2026-11-20 |
| [0041](0041-oauth-dlya-mcp.md) | OAuth для удалённых MCP-серверов | accepted | 2026-11-20 |
| [0042](0042-marketpleys-paketov.md) | Маркетплейс пакетов | accepted | 2026-11-21 |
| [0043](0043-navyki-fajly-i-razresheniya.md) | Навыки: файлы и allowed-tools | accepted | 2026-11-21 |
| [0044](0044-zashchita-ot-udaleniya.md) | Защита от удаления и корзина | accepted | 2026-11-21 |
| [0045](0045-rabochie-papki-chata.md) | Рабочие папки чата | accepted | 2026-11-21 |
| [0046](0046-rezhim-zadacha.md) | Режим «Задача» | accepted | 2026-11-21 |
| [0047](0047-rezultaty-zadachi.md) | Результаты задачи | accepted | 2026-11-21 |
| [0048](0048-otpravka-cherez-konnektory.md) | Отправка через коннекторы | accepted | 2026-11-21 |
| [0049](0049-dokumenty-docx-xlsx.md) | Документы: создание и чтение DOCX и XLSX | accepted | 2026-11-21 |
| [0050](0050-planovye-zadachi.md) | Плановые задачи | accepted | 2026-11-21 |
| [0051](0051-dlinnye-zadachi.md) | Длинные задачи и прогресс | accepted | 2026-11-21 |
