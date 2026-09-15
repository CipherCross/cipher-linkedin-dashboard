# UI standardization — authenticated acceptance review, 15 September 2026

**Результат: приёмка не пройдена.** Визуальная основа стала значительно чище, но на двух из трёх целевых PC-размеров недоступна основная функция Replies. Остались ошибки размещения элементов и невыполненные пункты согласованного плана.

Основание: [согласованный план](2026-09-14-ui-cleanup-standardization.md), [действующий UI standard](../docs/ui-standard.md), авторизованный production в Chrome и актуальный код. Это проверка результата, не реализация исправлений.

## Что и как проверено

- Production: `https://app.ciphercross.dev/`, существующая сессия администратора. Проверка началась ночью 15 сентября Europe/Madrid и продолжилась около 11:00 после паузы. Счётчики между проходами менялись; числовой паритет с предыдущим днём не проверялся.
- Локальный HEAD при обоих проходах: `fb846b2`. В production наблюдались `/assets/index-CXLvJtMV.css` и `/assets/Overview-DVgUjPIf.css`; основной CSS filename соответствует записанному release handoff. Побайтовая проверка deployment в этой сессии не выполнялась.
- Просмотрены все 20 типов внутренних маршрутов на 1280×720. Overview, Replies и Follow-ups дополнительно проверены на 1440×900 и 1920×1080. Это не полная матрица 20×3 и не проверка каждой ветви состояния.
- Выполнены навигация, выбор сообщений, вкладок и фильтров, пагинация Leads, открытие/закрытие overlays, проверка фокуса и несохранённого New search draft. Draft очищен; запись не создавалась.
- Сообщения, оценки, CRM, Team, Playbook, sequence content, CSV и publishing не изменялись. Send to Slack, AI prompts, сохранения и импорт не запускались. Временные размеры браузера восстановлены.
- Screenshots и измерения находятся в истории этой задачи. В репозиторий не экспортировались изображения переписок и персональные данные.

## Что исправлено и подтверждено

| Область | Фактический результат |
| --- | --- |
| Общая поверхность | Overview на трёх PC-размерах: однородный светлый фон, без прежнего стекла и тяжёлых теней. В DOM Overview: background `rgb(247,248,250)`, background-image `none`, 0 элементов с backdrop blur |
| Основная типографика | На проверенных основных страницах h1 28 px; body 16 px; основной UI заметно читабельнее |
| Основные controls | Refresh, Filters, основные select/input используют единый вид и высоту 44 px; перечисленные ниже исключения остаются |
| Leads | При default filters table header начинается на y≈287, первая строка около y≈332 на 1280×720; прежний большой блок фильтров убран. Переход на страницу 2/102 завершился с данными |
| Replies filters | Окно открывается поверх страницы: workspace остаётся на y=144, его высота не уменьшается; фон inert, диалог помещается между y=24 и y=696 |
| Replies message selection | На широком экране выбор исходящего сохраняет переписку, показывает объяснение и переход к последнему входящему; Next step остаётся доступен |
| New search | Sticky footer виден на 1280×720. Escape с изменённым Name открывает подтверждение; Shift+Tab удерживается в нём; Keep editing/Escape сохраняет draft и возвращает фокус в Name. Чистая форма закрывается |
| Calendar / Quick navigation | Escape закрывает и возвращает фокус к trigger; Quick navigation снимает inert и scroll lock. Размытие подложки убрано |
| English | Проверенные основные системные тексты Replies и Sentiment переведены; пользовательский контент оставлен как есть. Название Sequences унифицировано |
| Editor / admin | Comments & history в builder закрыты по умолчанию; Chat/diagnostic copy исправлены; редкие действия Health перемещены в Actions; Team и CSV setup читаемее |

## Подтверждённые замечания

### R1 — P1. На 1280 и 1440 невозможно открыть панель review в Replies

**Воспроизведение:** открыть Replies → Unreviewed → Evelyn Barcos на 1280×720 или 1440×900, sidebar открыт. Входящий ответ выбран, но ни review, ни кнопки перехода к нему нет. На 1920×1080 inspector появляется.

Измерения: на 1280 content container ≈1000 px, workspace grid `320px 678px`; `.replies-inspector-pane` и `.replies-pane-switch` имеют `display: none`. На 1440 container 1144 px, оба элемента также скрыты. Поэтому недоступны разметка ответа, Next step и Save из этой рабочей области.

**Причина:** `frontend/src/pages/replies-inbox.css:91` включает переключатель внутри container query, а строка 93 с той же специфичностью снова задаёт `display: none` после query.

**Исправление:** базовое скрытие расположить до условного показа либо явно разделить широкий/двухпанельный режим. Проверять видимость и доступность действия, а не только существование DOM-элемента.

**Повторная приёмка:** три PC-размера, sidebar visible/collapsed, container 1239/1240 px; открыть review, вернуться к списку, проверить selected message, draft и независимый scroll. Save/conflict — на изолированных данных.

### R2 — P2. Основная кнопка Follow-ups обрезается на 1280

**Воспроизведение:** Follow-ups → Task owner: All owners → первая строка Overdue на 1280×720. `Review in Replies` переносится на три строки; `Open follow-up` обрезается справа.

Измерения: правая граница списка x=1256, правая граница action x=1280.25, около 24 px скрыто. Список имеет `overflow: hidden`; grid: `240px 200px 240px 279.25px` плюс gaps и padding. На 1440 и 1920 action помещается. Высота primary Open follow-up — 36 px с границами, хотя dense variant предназначен для второстепенных действий.

**Причина:** `frontend/src/styles.css:2822–2837`, `.follow-item`; переход к другой компоновке срабатывает только при viewport ≤1050 (`:3051`), а место теряется уже при поддерживаемых 1280 из-за sidebar и gutters.

**Исправление:** выбирать размещение по ширине содержимого; при недостатке места переносить actions/preview на отдельную строку. Primary action полностью виден, 44 px, secondary links не сдавливают его. Убирать `overflow: hidden` без исправления grid недостаточно.

### R3 — P2. Apply/Cancel у расширенных фильтров не реализованы

**Воспроизведение:** Leads → Filters → Milestone: Accepted. URL сразу становится `#/leads?stage=accepted`; Escape закрывает окно, но фильтр остаётся. В footer только Clear all и Done, Cancel отсутствует. После загрузки отфильтрованный список показал 786 из 5092 leads; это не ошибка получения данных.

В Replies аналогичная схема подтверждена UI и кодом: каждый onChange сразу вызывает `guardedScope`, Done только закрывает окно.

**Код:** `frontend/src/pages/LeadsExplorer.tsx:706–724`, `frontend/src/pages/Replies.tsx:336–383`.

**Исправление:** восстановить согласованный контракт draft → Apply / Cancel. До Apply URL и результат не меняются; Cancel/Escape возвращают прежние фильтры; Apply атомарно обновляет scope и cursor. Сохранить защиту несохранённых review edits.

### R4 — P2. Аккаунты с одинаковыми именами по-прежнему неразличимы

В Overview, Leads и Manager review dropdown показывает два одинаковых `Mykyta Shevchenko`. При выборе нельзя понять, к какому notebook относится пункт. Follow-ups/Pipeline добавляют notebook id, Sentiment добавляет полное account label — единый helper ещё не применяется повсеместно.

**Код:** `frontend/src/components/overview/OverviewAnalytics.tsx:474–477`, `frontend/src/pages/LeadsExplorer.tsx:490–491` и `:695`, `frontend/src/pages/Review.tsx:190–192`.

**Исправление:** общий formatter для всех account options, active-filter chips и табличного account context. При дубликатах отображать имя + понятное название аккаунта; id использовать как fallback. Проверить также повторяющиеся campaign names в общих campaign selectors.

### R5 — P2. Размеры controls всё ещё зависят от старых правил

В Overview date trigger — **31.5 px / 13 px text**, соседний Account select — **44 px / 16 px**. Это видно и на широком мониторе. На 1280×720 nav rows — **34 px**, хотя standard задаёт 44 px.

**Код:** `frontend/src/styles.css:72–78` (`.drp-trigger`); `:592–600` (height-based compact sidebar). Новая `.ui-btn--sm` допускает 36 px для плотных строк, но это не объясняет 31.5 px у основного date filter.

**Исправление:** привести календарь к той же геометрии controls; не уменьшать navigation ниже зафиксированного размера на основном PC viewport. Если навигация длиннее окна, прокручивать соответствующую область. Проверять реальные экранные controls, а не только экземпляр Button в gallery.

### R6 — P2. Builder всё ещё отдаёт половину строки пустому Add variation

В существующей Karina Product → UX/UI при закрытых Comments & history на 1280 textarea имеет ширину **458 px** и высоту 218 px. Справа от единственной вариации находится пустая половина grid с Add variation. План требовал основной текстовый столбец минимум 560 px на desktop.

**Код:** `frontend/src/styles.css:3806`, `.sequence-variation-grid`; Add variation участвует в том же auto-fit grid, что и редактор.

**Исправление:** одиночной вариации выделять рабочую ширину; Add variation сделать обычным действием либо размещать после содержимого. Не растягивать пустую add tile до размера редактора. Проверить длинный текст и включение Comments & history без потери редактируемого контекста.

### R7 — P2. Дата одного ответа различается между Replies и Campaign

Для входящего `Hi, Karina` в том же диалоге Replies показывает **13 Sept, 01:54 (Madrid time)**, Campaign Leads & replies — **Sep 12**. Пользователь видит разные календарные дни одной переписки, а в колонке Reply не указан UTC.

**Причина:** `frontend/src/components/leads-and-replies/LeadsAndRepliesWorkspace.tsx:196` вызывает `shortDate(reply.sent_at)`. `frontend/src/lib/format.ts:10–18` берёт YYYY-MM-DD prefix, тогда как операционное время Replies отображается в Madrid. Кроме того, legacy format helpers используют en-US/local time, а новый `src/ui/datetime.ts` существует параллельно.

**Исправление:** операционные reply/follow-up timestamps форматировать единым helper с Madrid и английской locale. Аналитические UTC day slices, cohorts и хранящиеся timestamps не менять. Тестировать ответ по обе стороны полуночи Madrid и переходы DST.

### R8 — P2. Часть запланированной компоновки аналитики и Sequences осталась прежней

- Account и Campaign Performance: Reply intent занимает высокую полноширинную карточку; значения находятся у правого края далеко от labels. Согласованная компактная смысловая группа не получилась. Источник — `frontend/src/components/KpiCards.tsx:182–195`, `frontend/src/styles.css:4372–4396`.
- Sequences Deployments: на каждую группу/кампанию по-прежнему отдельная карточка с повторёнными заголовками таблицы. На 1280 видны примерно две группы, хотя в списке 66 deployments. Уменьшение общего h1 помогло, но групповая таблица из плана не реализована.
- Manager review: P3 KPI сохраняют отдельную уменьшенную подачу внутри вложенных карточек, отличную от Overview/Team. Требуется единая роль KPI, а не только одинаковый page title.

**Исправление:** завершить перенос по семействам: общий KPI group и table frame, значения рядом с labels, меньше повторяющихся контейнеров. Смысл runtime/publishing, разные знаменатели и maturation warnings сохранить.

### R9 — P2. CSV setup продолжает обесцвечивать полезные инструкции

Пока Added by не выбран, вся Upload card полупрозрачна, включая ограничения файла и объяснение следующего шага. Блокировка upload уместна; ухудшение читаемости пояснения не соответствует согласованному контракту disabled states.

**Код:** `frontend/src/styles.css:3211`, `.csv-upload-card.disabled { opacity: 0.68; }`; состояние включается в `frontend/src/pages/UnifiedApolloCsvImport.tsx:575`.

**Исправление:** отключать действие, оставлять body/help text в обычном контрасте. Проверить итоговый composed contrast на реальной странице; значения палитры до opacity не доказывают контраст этого состояния.

## Покрытие маршрутов

«Просмотрен» означает загрузившийся интерфейс и перечисленные read-only действия, а не успешность сохранения или полную приёмку маршрута.

| Маршрут | Что просмотрено | Оставшиеся замечания |
| --- | --- | --- |
| Overview | Header, system/performance, account table; календарь; три PC-размера | R4, R5 |
| Account | Anastasia: KPI, intent, charts, campaign table | R5, R8; отдельный функциональный сигнал ниже |
| Campaign | Karina Product UX/UI: Leads & replies, Performance, Sequence | R5, R7, R8 |
| Replies | Inbound/outbound, inspector, filters; три PC-размера | **R1**, R3 |
| Sentiment Analysis | Filters, KPI, empty reviewed cohort, workflow | Основная подача и English улучшены; populated sentiment charts не проверены |
| Follow-ups | Mykyta empty, All owners populated; три PC-размера | R2; account labels исправлены |
| Pipeline | Populated board, cards and controls | Читаемее; мелкие legacy actions и truncation требуют финального прохода |
| Leads | Default/filtered list, page 2, ConversationDrawer, Escape | R3, R4; первая строка помещается в бюджет y≤340 |
| Sequences | Deployments, вход в существующий документ | R8 |
| Sequence editor | Build и Preview; без редактирования | R6; Comments закрыты по умолчанию |
| Review | P3 outcomes, cohort matrix, loaded Leads Added с итогом | R4, R5, R8 |
| Playbook | Edit view, split preview, page actions; без изменений | Общие controls и heading hierarchy улучшены |
| Searches | Empty, New search, dirty confirmation, focus trap/return | Проверенные close/draft сценарии прошли |
| Team | Directory, KPI, actions; без управления доступом | Основной вид улучшен |
| CSV Import | Initial setup, disabled upload | R9; файл не загружался |
| Health | Compatibility, sync runs, раскрытие error text, accounts | Raw codes ещё без человеческого объяснения; glow у freshness dots остался |
| Chat | Empty state, prompts и composer; без отправки | Устаревшая ссылка на Supabase убрана |
| ICP | Existing card и actions | User content сохранён; некоторые controls остались legacy |
| Hypotheses | Comparison table | Таблица читаема; есть legacy icon actions |
| Neon activity | Loaded 0-row diagnostic state | Copy обновлён; дополнительные page padding отличаются от основной сетки |

Дополнительно проверены Quick navigation, calendar и ConversationDrawer. Sign-in/reset, non-admin access, 200% zoom и полная матрица каждого маршрута на всех трёх размерах в этой сессии не закрыты. Auth screen был проверен в предыдущем release handoff, но это не новое доказательство данной проверки.

## Отдельные функциональные сигналы

- Account Anastasia показывает 9 campaigns в header и `No campaigns match these filters` в списке с default Current. Такое состояние было и до стандартизации; новая регрессия не установлена.
- ConversationDrawer для lead без переписки показал `The requested thread was not found`. Требуется отличать ожидаемое отсутствие сообщений от ошибки чтения; причина в этом UI-аудите не установлена.
- Health сообщает `STATUS_PROFILE_VERSION_MISMATCH` / `STATUS_PROFILE_MISSING`. Это фактические сообщения системы, не доказательство нового UI-дефекта. Внешние notebooks/config не менялись.
- Во время отдельных scope changes были видны краткие empty/skeleton состояния перед конечным результатом. Background refresh и initial load требуют отдельной проверки с контролируемой задержкой.

## Что сделать перед повторной приёмкой

1. Исправить R1 и добавить browser-level проверку фактической видимости Review/Save при 1280/1440. Наличие компонентов в jsdom не ловит CSS cascade.
2. Исправить R2 и R6 на настоящих композициях с длинными именами, сообщениями и всеми действиями.
3. Довести общие контракты R3–R5 и R7; не менять бизнес-значения enum, UTC slices и requests ради визуальных изменений.
4. Завершить R8–R9 и пройти оставшиеся legacy exceptions. В gallery включить DateRangePicker, реальный sidebar, populated Follow-ups и настоящий single-variation builder, а не их упрощённые макеты.
5. После исправлений закрыть 20×3 route matrix, keyboard/zoom, account isolation и изолированные save/conflict/import/publish сценарии. Только после этого отмечать стандарт полностью внедрённым.

Существующий implementation handoff сообщает о зелёных build/tests и проверенной gallery. Эти проверки не запускались повторно в этой read-only сессии и не подменяют обнаруженные production-проблемы. Код продукта, deployment и данные в ходе проверки не изменялись; создан только этот отчёт.

---

## Устранение замечаний — 15 сентября 2026

Ниже — что изменено в коде по каждому пункту и чем это проверено. Ни один
результат не проверялся на авторизованном production в этой сессии: сессия
администратора в браузере здесь недоступна, поэтому геометрия измерялась в
настоящем headless Chrome по реальным таблицам стилей (см. «Как проверено»).
Пункт 5 списка «что сделать перед повторной приёмкой» — полная матрица 20×3,
keyboard/zoom, account isolation и изолированные save/conflict/import/publish —
остаётся открытым и требует авторизованного прохода.

### Как проверено

- `npm run build` (`tsc -b && vite build`) — зелёный.
- `npm run test` — 75 файлов, 1247 тестов, зелёный (было 74/1244; +1 файл, +3 теста).
- Измерения в настоящем Chrome (headless, puppeteer из глобального
  `@mermaid-js/mermaid-cli`) по реальным `tokens.css` / `styles.css` /
  `replies-inbox.css`. Для R1, R6 и R8a один и тот же замер прогонялся против
  `HEAD` и против исправления: на `HEAD` он падает, после — проходит, то есть
  проверка не холостая. Для R2 воспроизвести исходное обрезание в стенде не
  удалось (содержимое строки в стенде уже, чем в production), поэтому там
  подтверждено только то, что новая компоновка держит primary внутри рамки.
- `#/ui-gallery` в этой сессии открыть не удалось: dev-сервер без
  `VITE_SUPABASE_*` останавливается на экране входа. Галерея изменена, но
  визуально не просмотрена.

### R1 — P1, исправлено

`frontend/src/pages/replies-inbox.css`: базовое `.replies-pane-switch { display: none }`
перенесено **до** container query, внутри query — `display: flex`; переключателю
добавлены `flex: 0 0 auto`, разделитель и отступы, чтобы он не сжимался в
колонке треда.

Измерено при ширине контейнера 1000 / 1144 / 1400 px, в обоих состояниях
`pane-review`:

| container | switch | inspector (обычный / review) | list |
| --- | --- | --- | --- |
| 1000 | `flex` | `none` / `flex` | `flex` / `none` |
| 1144 | `flex` | `none` / `flex` | `flex` / `none` |
| 1400 | `none` | `flex` / `flex` | `flex` |

На `HEAD` тот же замер даёт `switch: none` при 1000 и 1144 — то есть панель
review недостижима, как и описано в отчёте.

Добавлен `frontend/tests/repliesWorkspaceCss.test.ts`: он разбирает саму
таблицу стилей и запрещает безусловному правилу перекрывать то, что открывает
условный блок. Тест падает на CSS из `HEAD` и проходит после исправления.
Рендеринг-тест этот дефект поймать не может: jsdom не вычисляет container
queries, а компонент всё это время присутствовал в дереве.

### R2 — исправлено

`.follow-item` переведён на **container query** по ширине самого списка
(`.follow-list { container-type: inline-size }`): при < 1080 px строка
раскладывается в две строки (`open`/`context`, затем `message`/`actions`), при
< 620 px — в одну колонку. Прежний порог был viewport-медиазапросом на 1050 px,
который при развёрнутом rail не срабатывал ни на одном поддерживаемом размере.
`Open follow-up` больше не `size="sm"` — 44 px, как и требует стандарт для
единственного основного действия строки; ссылки рядом получили `white-space: nowrap`,
чтобы «Review in Replies» не разваливалось на три строки.

Замер при ширине списка 1000 / 1144 / 1400 / 1608 px: правая граница primary —
на 17 px внутри рамки списка, высота 44 px во всех случаях.

### R3 — исправлено

Оба фильтра переведены на контракт draft → Apply / Cancel.

- `frontend/src/pages/LeadsExplorer.tsx`: `SHEET_FILTER_KEYS` (десять ключей
  внутри окна; поиск и выбор аккаунта остаются на странице и применяются сразу),
  черновик в состоянии, `applyFilters` пишет все ключи в URL одной операцией и
  сбрасывает `page`. Escape и Cancel закрывают окно, не меняя ни URL, ни
  результат. Clear all очищает черновик, а не применённые фильтры.
- `frontend/src/pages/Replies.tsx`: то же для десяти ключей области
  (`scope`, `campaign`, `owner`/`unowned`, `sentiment`, `reason`, `action`,
  `my`, `unacknowledged`, `overdue`). Apply по-прежнему идёт через
  `guardedScope`, поэтому защита несохранённых правок review сохранена.
- Счётчик в footer обоих окон теперь считает черновик и говорит «selected», а
  не «applied».

### R4 — исправлено

Новый общий `accountLabeller(instances)` в `frontend/src/lib/leads.ts`: при
совпадении отображаемых имён подставляет `label` аккаунта, иначе его id; при
отсутствии дубликатов — просто имя. На него переведены Overview (select,
aria-label строки таблицы, заголовок «… campaigns»), Leads, Manager review,
Follow-ups, Pipeline и Sentiment analysis — три последние имели собственные
копии этого правила с разным поведением.

### R5 — исправлено

- `.drp-trigger`: `min-height: var(--control-height)`, `font-size: var(--text-body)`,
  `border-radius: var(--radius-control)`. Замер в Chrome при 1280×720: 44 px / 16 px —
  ровно как у соседнего select (было 31.5 px / 13 px).
- Из медиазапроса `max-height: 820px` убраны уменьшения строк навигации и
  шапки. Замер: `.navlink` — 44 px при 720 px высоты окна (было 34 px).
  Уплотнение промежутков между строками сохранено; при нехватке высоты
  `.side-nav` прокручивается — это уже было реализовано.

### R6 — исправлено

`Add variation` вынесен из `.sequence-variation-grid` в отдельную строку
действий под редакторами, а минимум колонки поднят с 310 px до 560 px, поэтому
вторая колонка появляется, только когда обе получают рабочую ширину.

Замер при ширине рабочей области 1000 px: textarea 449 → 942 px, пустая плитка
Add variation 483 → 106 px (обычное действие). Отчёт измерял 458 px — сходится.

### R7 — исправлено

Добавлен `replyDate()` в `frontend/src/lib/replyTime.ts` — календарный день
сообщения на рабочих часах команды (Europe/Madrid, `en-GB`). На него переведены
три места, показывавшие время сообщения через `shortDate()` (UTC-префикс
строки): колонка Reply в `LeadsAndRepliesWorkspace`, дата сообщения в
Follow-ups и в карточке Pipeline. Каждое теперь `<time>` с `dateTime` и
`title="Madrid time"`. Аналитические UTC-срезы (когорты, daily activity,
milestones, `computed_at`) намеренно остались на `shortDate`.

### R8 — исправлено

- **Reply intent**: пятистрочный список с числами у правого края заменён на
  сетку под-метрик, где значение стоит под своей подписью. Замер: максимальное
  горизонтальное расстояние подпись → значение 872 → 0 px, высота карточки
  379 → 128–244 px в зависимости от ширины.
- **Sequences Deployments**: вместо карточки на каждую группу с повторённой
  шапкой таблицы — один `TableFrame` с единственной строкой заголовков и
  строкой-баннером на последовательность (название, тип, число кампаний,
  ссылка в builder).
- **Manager review**: `P3OutcomeSummary` больше не вкладывает уменьшенную
  `tmpl-stat` сетку внутрь панели, а использует ту же роль KPI, что Overview и
  Team: `SectionHeader` + `kpi-grid` из `card kpi`. Смысл метрик, знаменатели
  и оговорка про зрелость когорт не менялись.

### R9 — исправлено

`.csv-upload-card.disabled` больше не приглушает карточку целиком: ограничения
файла и подсказка следующего шага остаются в обычном контрасте, недоступной
остаётся только кнопка (она и раньше была `disabled`). Приглушена лишь
декоративная иконка.

### Галерея

Четыре композиции в `frontend/src/ui/Gallery.tsx` переписаны на **собственные
классы экранов** вместо похожих inline-стилей — макет из `style={{…}}`
рисуется правильно поверх сломанной таблицы стилей, и именно поэтому обрезанное
основное действие и недостижимая панель review прошли предыдущий проход по
галерее. Добавлены реальный `DateRangePicker` рядом с select, настоящая строка
Follow-ups со всеми действиями, рабочая область Replies на классах
`replies-inbox.css` с переключателем панелей и builder с одной вариацией.
Реальный sidebar в галерею не добавлен — он живёт в `Layout` и тянет за собой
auth-контекст.

### Что осталось открытым

1. Авторизованный повторный проход: матрица 20×3, keyboard/zoom, account
   isolation, изолированные save/conflict/import/publish.
2. Визуальный просмотр `#/ui-gallery` (нужен dev-сервер с `VITE_SUPABASE_*`).
3. Функциональные сигналы из отчёта — «No campaigns match these filters» на
   Anastasia, `The requested thread was not found` в ConversationDrawer,
   `STATUS_PROFILE_*` на Health — не UI-дефекты стандартизации и здесь не
   трогались.
4. Оставшиеся legacy-исключения из таблицы покрытия (ICP, Hypotheses, Health,
   Neon activity) — не входили в подтверждённые замечания R1–R9.
