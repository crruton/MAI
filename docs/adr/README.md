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
| [0052](0052-katalog-konnektorov.md) | Каталог коннекторов и токены MCP | accepted | 2026-11-21 |
| [0053](0053-zashchita-ot-prompt-injection.md) | Защита от prompt injection | accepted | 2026-11-21 |
| [0054](0054-glob-edit-file-limit-vyvoda.md) | glob, правка файлов и лимит вывода | accepted | 2026-11-21 |
| [0055](0055-fonovye-komandy.md) | Фоновые команды | accepted | 2026-11-21 |
| [0056](0056-web-fetch-web-search.md) | web_fetch и web_search | accepted | 2026-11-21 |
| [0057](0057-povtory-i-zapasnaya-model.md) | Повторы и запасная модель | accepted | 2026-11-21 |
| [0058](0058-vozmozhnosti-modeli.md) | Возможности модели и глубина рассуждений | accepted | 2026-11-21 |
| [0059](0059-git-potok.md) | Git-поток: защита веток, /commit, /review | accepted | 2026-11-21 |
| [0060](0060-shemy-ipc.md) | Проверка данных IPC | accepted | 2026-11-21 |
| [0061](0061-ostanovka-agenta.md) | Остановка агента: прерываемые инструменты и сторож простоя | accepted | 2026-11-22 |
| [0062](0062-doski-i-artefakty-bez-poteri.md) | Доски и артефакты без потери правок | accepted | 2026-11-22 |
| [0063](0063-trassirovka-agenta.md) | Трассировка цикла агента | accepted | 2026-11-22 |
| [0064](0064-revizor-subagent.md) | Ревизор знает режим и проверяет файлы сам | accepted | 2026-11-22 |
| [0065](0065-proekty.md) | Проекты | accepted | 2026-11-22 |
| [0066](0066-prezentacii-pptx.md) | Презентации PPTX | accepted | 2026-11-22 |
| [0067](0067-pdf-iz-markdown.md) | PDF из Markdown через Chromium | accepted | 2026-11-22 |
| [0068](0068-prevyu-dokumenta-dlya-samoproverki.md) | Превью документа для самопроверки агентом | accepted | 2026-11-22 |
| [0069](0069-brauzer-agenta.md) | Браузер агента и разрешения по сайтам | accepted | 2026-11-22 |
| [0070](0070-roli-i-onbording.md) | Наборы по ролям и онбординг | accepted | 2026-11-22 |
| [0071](0071-mcp-resursy-prompty-sse.md) | MCP: ресурсы, промпты и SSE | accepted | 2026-11-22 |
| [0072](0072-lokalnye-konnektory.md) | Локальные коннекторы | accepted | 2026-11-22 |
| [0073](0073-chaty-imya-kopiya-hranenie.md) | Чаты: имя, копия, хранение и точки отката | accepted | 2026-11-22 |
| [0074](0074-interfeys-tema-statusnaya-stroka-dostupnost.md) | Интерфейс: !команда, статусная строка, тема, доступность | accepted | 2026-11-22 |
| [0075](0075-izolyaciya-i-fonovye-subagenty.md) | Изоляция субагента в git worktree и фоновые субагенты | accepted | 2026-11-22 |
| [0076](0076-pr-security-review-worktree.md) | /pr, /security-review и чат в рабочей копии /worktree | accepted | 2026-11-22 |
| [0077](0077-bezgolovyj-rezhim-cli.md) | Безголовый режим: mai -p и поток событий | accepted | 2026-11-22 |
| [0078](0078-modeli-bez-instrumentov-i-model-dlya-plana.md) | Модели без tool calling и отдельная модель для «Плана» | accepted | 2026-11-23 |
| [0079](0079-noutbuki-diagnostika-otlozhennye-instrumenty.md) | Ноутбуки, диагностика кода и отложенная загрузка инструментов | accepted | 2026-11-23 |
| [0080](0080-pamyat-sovmestimost-kesh-dubli-navykov.md) | Предел памяти, инструкции других агентов, кэш промпта, дубли навыков | accepted | 2026-11-23 |
| [0081](0081-uvedomleniya.md) | Уведомления на рабочем столе и в мессенджеры (Telegram, MAX, WhatsApp, Rocket.Chat, webhook) | accepted | 2026-11-23 |
| [0082](0082-nabor-scenariev-eval.md) | Набор сценариев (eval) по профилям агента | accepted | 2026-11-23 |
| [0083](0083-pdf-obedinenie-i-formy.md) | PDF: объединение, выборка страниц и формы (pdf-lib) | accepted | 2026-11-23 |
| [0084](0084-zapomnit-i-ocr-instrument.md) | «Запомнить?» после прогона и инструмент ocr | accepted | 2026-11-23 |
| [0085](0085-runtimes-versiya-i-perenos.md) | Рантаймы: версия CLI и перенос пресетов | accepted | 2026-11-23 |
| [0086](0086-agent-shem-predlozhenie.md) | Агент схем: предложение с diff и «Применить» | accepted | 2026-11-23 |
| [0087](0087-avtosinhronizaciya-hranilishcha.md) | Автосинхронизация хранилища с Postgres и SeaweedFS | accepted | 2026-11-23 |
| [0088](0088-perezapusk-zavisshego-mcp.md) | Перезапуск зависшего MCP-сервера Repowise | accepted | 2026-11-23 |
| [0089](0089-statusy-multica-v-openspec.md) | Статусы Multica обратно в OpenSpec | accepted | 2026-11-23 |
| [0090](0090-kalibrator-arhitektury.md) | Калибратор архитектуры и PRD — субагент и вкладка доски | accepted | 2026-11-23 |
| [0091](0091-proekt-v-otdelnoy-papke.md) | «Проект в отдельной папке» вместо «песочницы проекта» | accepted | 2026-11-23 |
| [0092](0092-golos-sostoyanie-povtor-dvizhok.md) | Голосовой ввод: состояние на кнопке, повтор и выбор движка | accepted | 2026-11-23 |
| [0093](0093-korporativnyy-vhod-keycloak.md) | Корпоративный режим: обязательный вход через Keycloak и продление сессии | accepted | 2026-11-23 |
| [0094](0094-metriki-agenta-grafana.md) | Метрики агента и панели Grafana | accepted | 2026-11-23 |
| [0095](0095-ustanovshchik-v-ci-i-sistemnye-sertifikaty.md) | Установщик в CI на чистом Windows и системные сертификаты в процессе | accepted | 2026-11-23 |
| [0096](0096-krossplatformennye-ispolniteli.md) | Кроссплатформенные исполнители: выбор оболочки и остановка дерева процессов | accepted | 2026-11-23 |
| [0097](0097-signoff.md) | /signoff — статус коммита «тесты проходят у меня» | accepted | 2026-11-23 |
| [0098](0098-granitsy-dannyh.md) | /privacy — отчёт «куда уходят данные» | accepted | 2026-11-23 |
| [0099](0099-filtr-sekretov-v-zaprosah.md) | Фильтр секретов в запросах к модели | accepted | 2026-11-23 |
| [0100](0100-lokalnye-modeli.md) | Локальные модели в один клик | accepted | 2026-11-23 |
| [0101](0101-impeccable-4-10-i-hook-ui.md) | impeccable 4.10.0, обновление встроенных навыков и пакет с хуком проверки UI | accepted | 2026-11-23 |
| [0102](0102-skaner-obnovleniy.md) | Проактивный сканер обновлений и обновление на ветке с тестами | accepted | 2026-11-23 |
| [0103](0103-chistilshchik-staryh-versiy.md) | Чистильщик старых версий | accepted | 2026-11-23 |
| [0104](0104-electron-45-openai-7.md) | Electron 45, openai 7 и устранение уязвимостей зависимостей | accepted | 2026-11-23 |
| [0105](0105-novyy-interfeys-glavnogo-okna.md) | Новый интерфейс главного окна (N9) | accepted | 2026-11-24 |
| [0106](0106-hook-post-commit-ne-blokiruet-kommit.md) | Хук post-commit не блокирует коммит | accepted | 2026-11-24 |
| [0107](0107-bezopasnaya-obrezka-surogatnyh-par.md) | Безопасная обрезка текста: границы суррогатных пар | accepted | 2026-11-24 |
| [0108](0108-mai-ship-gitlab-ispolnenie-v-ci.md) | MAI Ship для GitLab: агенты ревью, steward и approver в GitLab CI | proposed | 2026-11-26 |
| [0109](0109-politika-apruva-v-repozitorii.md) | Политика апрува как файл в репозитории | proposed | 2026-11-26 |
| [0110](0110-razdelenie-provayderov-v-ship.md) | Разделение провайдеров и учёток в MAI Ship | proposed | 2026-11-26 |
| [0111](0111-katalog-navykov-komandy.md) | Каталог навыков команды в репозитории MAI | accepted | 2026-11-26 |
| [0112](0112-multica-workspace-i-proekt-v-nastroykah-proekta.md) | Workspace и проект Multica — в настройках проекта | accepted | 2026-11-26 |
| [0113](0113-navyki-kataloga-v-multica.md) | Навыки каталога → Multica MAI | accepted | 2026-11-26 |
| [0114](0114-eksport-navykov-v-drugie-agenty.md) | Экспорт навыков каталога в Claude Code, OpenCode и Codex | accepted | 2026-11-26 |
| [0115](0115-nabory-navykov-po-rolyam.md) | Наборы навыков каталога по ролям | accepted | 2026-11-26 |
| [0116](0116-atribuciya-kommitov-agenta.md) | Атрибуция коммитов агента: трейлеры Agent-Model и Agent-User | accepted | 2026-11-26 |
| [0117](0117-roli-developer-i-lead.md) | Роли developer и lead в матрице прав IPC | accepted | 2026-11-26 |
| [0118](0118-profil-komandy.md) | Профиль команды: каталоги, MCP, AGENTS.md и workspace из одного репозитория | accepted | 2026-11-26 |
| [0119](0119-ship-approver-bez-okna.md) | MAI Ship: approver без окна, парсер YAML и гейт для GitLab Free | accepted | 2026-11-26 |
| [0120](0120-ship-revyuer.md) | MAI Ship: ревьюер с состязательной проверкой и статус своего pipeline | accepted | 2026-11-26 |
| [0121](0121-ship-zhurnal-i-soglasie.md) | MAI Ship: журнал решений в MR и согласие approver ↔ человек | accepted | 2026-11-27 |
