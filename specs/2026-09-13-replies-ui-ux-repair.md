# Replies Inbox и Sentiment Analysis — план исправления UI/UX для SOL

## Goal

Сделать Replies полноценным ежедневным рабочим экраном SDR: список, переписка, разметка и следующий шаг доступны одновременно, интерфейс не исчезает при выборе сообщения, а состояние сохранения понятно. Sentiment Analysis должна объяснять состояние работы и причины ответов человеческим языком и вести к точному набору диалогов.

Основание: live-аудит открытой пользователем вкладки `https://app.ciphercross.dev/#/replies` и страницы `/sentiment-analysis` 2026-09-13, примерно 22:32–22:36 Europe/Madrid. Просмотр выполнен через Computer Use в существующей авторизованной Chrome-вкладке, viewport скриншотов 1280×660. Исходный диалог — Evelyn Barcos, аккаунт karina-1; исходный focus message 15882702. Проверены прокрутка, выбор исходящего сообщения, scope «Все», аналитика и переход из карточки Negative / objection.

Этот документ заменяет UI-компоновку и UX-детали исходного [плана v4](2026-09-11-manual-reply-review-sentiment-analysis.md), сохраняя согласованные бизнес-правила и модель данных. Текущее поручение — аудит и план; исправления продукта ещё не выполнялись.

## Non-goals

- Повторный schema cutover, возврат AI-разметки, отправка сообщений, новая CRM, изменение причин или бизнес-статусов.
- Переписывание базы Leads, общего дизайна всего дашборда или backend без подтверждённой зависимости от исправления.
- «Косметический» проход с сохранением текущей длинной формы и общей прокрутки.
- Production save, назначение владельцев, DNC и изменение реальных переписок в рамках аудита. Эти действия не выполнялись.

## Research findings

### Подтверждено в браузере

| ID / приоритет | Наблюдение и воспроизведение | Последствие |
| --- | --- | --- |
| U01 / P1 | При 1280×660 workspace начинается примерно на y=348. Header и открытые фильтры занимают верхнюю половину. Короткий inbound уже ниже края первого экрана. | Основная задача чтения уступает место настройкам. |
| U02 / P1 | Прокрутка правой панели к причинам/сохранению прокручивает всю страницу. Заголовки, список и сообщения уходят вверх, остаются две огромные пустые колонки. Для короткого ответа до workflow нужно несколько прокруток. | SDR теряет контекст сообщения и следующего диалога. |
| U03 / P1 | Чекбоксы причин оторваны от текста; названия ужаты до узкой колонки и переносятся на 3–5 строк. Девять причин со всеми пояснениями раскрыты даже для «Hi, Karina» без выбранного sentiment. | Форма трудно читается и требует лишней прокрутки. |
| U04 / P1 | Refresh и три save-кнопки выглядят как мелкие нативные кнопки браузера; основная команда не выделена. Сохранение разметки и действия далеко друг от друга. | Непонятно, что будет сохранено и куда нажать для завершения шага. |
| U05 / P1 | Клик по уже загруженному outbound (focus 15156430) и смена scope скрывают весь workspace: общий skeleton → «Проверяем доступность…» → «Replies Inbox временно недоступен» → повторная загрузка. | Выбор сообщения выглядит как отказ сервиса; теряется визуальная непрерывность. Точное время загрузки не измерялось. |
| U06 / P1 | Выбрать outbound в диалоге с видимым inbound: справа написано «Этот диалог содержит только исходящие сообщения», пропадают и разметка, и conversation actions. | Ложное сообщение о данных; следующий шаг ошибочно зависит от типа выбранного сообщения. |
| U07 / P1 | Один inbound в списке показывается Sep 13, 01:54 AM, а внутри переписки 11:54 PM; timezone не объяснён. | Кажется, что выбрано другое сообщение или нарушена хронология. |
| U08 / P2 | В списке нет avatar, аккаунта отправителя, владельца и action; вместо некоторых имён raw profile slug. В header виден `karina-1`, длинный headline занимает несколько строк. | Сложно быстро узнать собеседника и понять, от какого аккаунта ведётся работа. |
| U09 / P2 | Owner filter содержит только «Все ответственные», хотя owner picker справа и аналитика содержат шесть участников. В campaign select есть одинаковые названия без аккаунта. В аналитике два одинаковых Mykyta Shevchenko. | Выбор людей/кампаний неполон или неоднозначен. Наличие назначенных owner в отфильтрованной когорте не проверялось. |
| U10 / P2 | Основные views спрятаны в select «View», рядом другая группа «Новые / История / Все» и четыре checkbox. Не объяснено, означает ли «Новые» прочтение или дату миграции. Историческая очередь показывает `50+` — загруженные строки вместо полного размера. | Навигация по работе смешана с техническим scope и пагинацией. |
| U11 / P2 | В UI видны «ОТВЕТ #15882702», «WORKFLOW», «Ревизия workflow: 0 · inbound: 1», «необязательно при установке DNC». В аналитике — «Знаменатели переданы сервером», `legacy`, `inbound`, `non-auto`, «серверный metric». | Текст технического контракта попал в продуктовый интерфейс. Он объясняет реализацию вместо задачи SDR. |
| U12 / P1 | В аналитике 0 разобранных из 91 сообщения и 0 из 67 диалогов, однако таблица аккаунтов показывает Negative / objection 0.0%. Рядом общая формула правильно показывает `0 / 0 · —`. | Отсутствие оценки выглядит как измеренное отсутствие негативных ответов. Причина уровня API или mapper требует fixture-проверки. |
| U13 / P2 | При отсутствии ручной разметки аналитика показывает семь KPI, длинный список нулевых причин, нулевые sentiment bars и все пустые workflow buckets; причины слева растягивают пустую правую карточку. | Нет ясного ответа «с чего начать», огромное количество визуального шума. |
| U14 / P1 | Карточка Negative / objection ведёт в URL `metric_scope=sentiment:business_rate&sentiment=business_rate`. В Replies видны «Все» фильтры, 0 результатов и «Новые ответы появятся после синхронизации». Период/metric scope не показаны, возврата к отчёту нет. | Неясно, почему список пуст. `business_rate` отсутствует в sentiment vocabulary; точность ненулевого drill-down не доказана. |
| U15 / P2 | Недельная динамика выводит по одной полоске числа сообщений, машинные даты и строку `auto: 0 · neutral: 0 · negative: 0`. | Не видно распределения sentiment и изменения причин по неделям, заявленных в плане. |
| U16 / P2 | Сравнение аккаунтов и кампаний смешано в одной таблице; названия строк CAPS, одинаковые аккаунты не различимы. Карточки Legacy AI/Intent считают сообщения, но ссылки открывают диалоги без объяснения единицы. | Таблицу трудно сравнивать, ожидания от цифры и результата перехода расходятся. |

Не считать нулевую ручную разметку дефектом данных: после отказа от AI это допустимое состояние. Исправлению подлежит её представление и выводы.

### Подтверждено чтением локального кода

Локальный HEAD при аудите: `47c0d08`; его равенство deployed SHA не проверялось. Причины ниже совпадают с наблюдаемым поведением, но не являются доказательством live build hash.

- `src/pages/replies-inbox.css:11–16,31,44`: `min-height` без ограниченного контейнера; `overflow:auto` у детей без нужной высоты; grid растягивается по inspector. Это объясняет U02.
- `replies-inbox.css:59`: `.replies-fieldset input { width:100% }` затрагивает checkbox. Flex item занимает ширину строки и сжимает label text — конкретная причина U03.
- `ReplyReviewPanel.tsx`: `showReasons=true` по умолчанию; пояснения каждого reason постоянны. Кнопки используют `.primary/.secondary`, тогда как общий набор кнопок — `.btn/.btn.accent/.btn.ghost` в `styles.css:1662+`.
- `DataContext.tsx:553,795–818,978–997`: `load` зависит от полного pathname+search, вызывает global loading и bootstrap phase. `Layout.tsx:210–225` заменяет Outlet skeleton-ом, размонтируя Replies; `useRepliesInbox.ts` вновь загружает capabilities. `thread/focus` не должны запускать этот цикл.
- `useRepliesInbox.ts`: thread effect зависит от объекта `scope.thread`, очищает `thread` перед загрузкой; даже локальная смена focus повторяет thread fetch. List key уже исключает thread — сохранить это намерение.
- `Replies.tsx:165,183`: selected outbound ошибочно назван «outbound-only conversation»; workflow находится под общей inbound-only веткой.
- `Replies.tsx:166`: owner options берутся из `capabilities.facets.owners`; panel получает `capabilities.members`. Нужен один полный roster + отдельные facet counts.
- `Replies.tsx:181–183`: selection/workflow зависит от `selectedItem` текущей страницы списка. После фильтра/сохранения вне списка dialog details могут исчезнуть. `saveWorkflow`/`actionRefresh` сбрасывают reviewDirty; риск потери несохранённого review проверить на fixtures, не на production.
- `Replies.tsx` formatTime использует browser timezone, `ConversationThread.tsx` time принудительно UTC. Date separators следует проверить вместе с `lib/format.ts`.
- `WeeklyTrendChart.tsx:22–26`: первые три `Object.entries` показываются как breakdown; `38–44` отрисовывают messages или coverage, а не согласованную динамику sentiment/reasons.
- `SentimentAnalysis.tsx` link builder допускает business_rate как обычный sentiment. Existing scope codec убирает неизвестный sentiment, но сохраняет metric_scope. EmptyState в Replies одинаков для всех scopes, а banner drill-down отсутствует.
- `replies-inbox.css:65`: при <=1100 inspector переносится под обе колонки. На mobile back button расположен внутри thread-pane, которая скрыта в режиме review; риск отсутствующего возврата. Эти breakpoints не проверены в live viewport и не должны называться воспроизведёнными дефектами.

## Decisions

1. Сохранить Replies, Leads и Sentiment Analysis отдельными страницами. Сохранить ручную разметку, несколько причин, intent, workflow, revisions, audit и ограничения DNC.
2. Replies становится viewport workspace с независимой прокруткой трёх областей. Header/filter UI компактный. Inspector не уходит под переписку на средних экранах.
3. Существующий стиль дашборда — источник typography, buttons, field surfaces и icons. Новая UI-библиотека и глобальный редизайн не нужны.
4. Пользовательские подписи внутри Replies/Analysis — последовательно на русском; существующие названия разделов Replies и Sentiment Analysis сохраняются. Не переводить весь дашборд в рамках задачи.
5. Основной рабочий сценарий: выбрать диалог → прочитать → выбрать входящее → разметить → при необходимости выбрать следующий шаг → сохранить всё изменённое → следующий неразобранный ответ. Сообщение и состояние диалога остаются разными сущностями данных.
6. Изменение определения метрик ради визуально приятных цифр запрещено. Zero-denominator означает «Пока нет оценки», а не 0%.

## Approach

### A. Постоянная компоновка Replies

Максимальная высота верхней зоны при viewport 1280×660 — 116 px внутри content: одна строка title/refresh/«Аналитика» (44–48 px), одна строка основных views/«Мои»/«Фильтры» (40–44 px), небольшой отступ. Удалить eyebrow и explanatory paragraph из постоянной шапки. Help — иконка с краткой подсказкой.

Views всегда видны как compact segmented tabs: «Все», «Не разобрано», «Нужен ответ», «Отложено», «Завершено». При нехватке ширины tabs скроллятся горизонтально, не переносят весь toolbar в четыре строки. Поиск живёт в header списка, не занимает всю ширину над workspace. Account selector и «Фильтры N» остаются доступными; advanced panel содержит campaign, owner, sentiment, reason, action, backlog scope. Активные фильтры показываются chips с удалением и «Сбросить».

Backlog scope назвать «Поступление: после запуска ручного разбора / до запуска / за всё время» с фактической датой в tooltip; не использовать двусмысленное «Новые» как замену unread. В queue view отдельный счётчик «X ответов требуют разметки», conversation count имеет свою подпись. Значения facets брать с сервера; `50 из 67` либо «Загружено 50, есть ещё», но не имитировать полный count через items.length.

Desktop layout определяется доступной шириной content, не только window width:

| Доступная ширина workspace | Компоновка |
| --- | --- |
| >=1120 px | Список 300–320 px, thread гибкий минимум 460 px, inspector 320–360 px. |
| 944–1119 px (текущий 1280 с sidebar) | Список 248–264 px, thread минимум 384 px, inspector 296–312 px; компактные padding и без внешних промежутков между тремя панелями. |
| 680–943 px | Список + thread, inspector открывается right sheet с явным возвратом и сохранением выбора; не вставляется снизу страницы. |
| <680 px | Одна область: список → переписка → разбор; собственный всегда видимый header/back и save footer в каждом соответствующем состоянии. |

Workspace — единая поверхность с тонкими разделителями, без трёх отдельных вытянутых карточек. У route-scoped оболочки `height` от доступного `100dvh`, `min-height:0`, `overflow:hidden`; у внутренних scroll-children `min-height:0; overflow:auto`. Разделить scrolling list, thread и inspector body; headers и footer остаются на месте. Не навешивать `overflow:hidden` на body для всех страниц. Existing sidebar остаётся пользовательским; не менять его preference автоматически.

При 1280×660 и коротком ответе должны быть одновременно видны имя/аккаунт, минимум три строки списка, inbound body, sentiment controls и save footer. Причины не должны растягивать соседние области; list из 50 элементов прокручивается внутри себя. При browser zoom 200% включается адаптивная компоновка без горизонтального document overflow.

### B. Inspector с понятным сохранением

- Верх: «Разбор ответа», дата и короткая двухстрочная цитата выбранного inbound. Убрать DB message ID из основного UI. Sender name используется вместо обезличенного «Лид»; outbound подписывается именем LinkedIn-аккаунта, не всегда «Вы» текущего администратора.
- Sentiment — шесть нормальных radio tiles по 2 в ряд, label 13–14 px. Объяснения границ positive/neutral/objection — tooltip/помощь, не постоянная инструкция.
- Для negative/objection причины раскрываются автоматически; для остальных без выбранных причин — «Добавить причину», для уже выбранных — compact chips с возможностью редактировать. При изменении sentiment не удалять причины молча. Checkbox имеет фиксированные 16–18 px (`flex:0 0 auto; width:auto`); текст `flex:1; min-width:0`. Whole label clickable. Описание причины открывается через help, название остаётся слева.
- Intent свернуть в «Коммерческий интерес · Не оценён / выбранный уровень». Внутри один control: «Не оценён», «Нет», «P1 · Вежливый интерес», «P2 · Обсуждает задачу», «P3 · Готов к следующему коммерческому шагу». Сохранять backend mapping intent_state+intent_level и auto not_applicable. «Не применимо» не предлагается для обычного human reply.
- Комментарий необязателен и раскрывается по ссылке. Для other — раскрыть и явно отметить обязательность. Не прятать уже набранный/сохранённый comment.
- Conversation action — компактный самостоятельный блок ниже sentiment/reasons и перед optional details: action, owner, conditional date. «Прочитать и разметить» не требует обязательного заполнения всей CRM. DNC виден отдельным контролом; предупреждение человеческое: «Напоминания в дашборде будут отменены. Остановите рассылку в Linked Helper отдельно». Не показывать слово «атомарно» пользователю.
- Один sticky footer на inspector: primary «Сохранить и следующий», secondary «Сохранить», короткое состояние «Есть изменения / Сохранено / Ошибка». Оба сохраняют **все изменённые поля в видимой форме** через existing atomic review+optional workflow payload. При workflow-only draft используется workflow command. Если невалидна любая изменённая часть, ничего не сохранять, показать field error и привести её в видимую область.
- Partial review разрешён прежним контрактом: если workflow не менялся, сохранить только разметку; затем показать «Разметка сохранена · Следующий шаг ещё не выбран», без ложного «Диалог обработан». Не сохранять `Не выбрано` как guessed action.
- Workflow всегда доступен при выбранном диалоге, даже если focus outbound. Review area тогда пишет «Выбрано исходящее сообщение» и предлагает перейти к ближайшему/последнему inbound; не утверждает отсутствие inbound во всём thread. При truly outbound-only thread показывать корректное состояние по full-thread metadata.
- Никакого сброса review draft из-за workflow save, background refresh или фильтра. При уходе с dirty form — existing styled dialog «Сохранить / Не сохранять / Вернуться»; pending/conflict сохраняют ввод. Native OK/Cancel с двусмысленным discard убрать.

### C. Стабильные данные и выбор

1. Отделить metadata route key от URL state инбокса. Для `/replies` и `/sentiment-analysis` смена search/filter/thread/focus не запускает общий DataProvider load. Общий Layout не размонтирует уже готовый Outlet из-за background reload. Не ослаблять auth gate. Для остальных страниц сохранить их необходимые route-dependent reads и проверить regressions.
2. Разделить keys: metadata, listScope (без selection), threadKey (instance+profile), focusMessageId. Выбор уже загруженного сообщения — local selection плюс URL update, без capabilities/list/thread reload. Для focus вне window загрузить нужную страницу, сохраняя существующие messages и list.
3. На смене диалога loading показывается только в thread/inspector; остаются list/header/filters. Initial metadata loading — нейтральный skeleton; unavailable только после реального unsupported/error result. Ошибка запроса не превращается в «0 диалогов».
4. Thread identity/workflow читаются из thread detail cache, а не только `items.find`. Смена фильтра, pagination и исчезновение обработанной строки не обнуляют открытый dialog. «Сохранить и следующий» использует настоящий next pending по active scope, включая следующую серверную страницу; конец текущих 50 rows не равен концу очереди.
5. Единая функция отображения даты/времени для list, messages, selected quote и audit: timezone Europe/Madrid с понятным tooltip. Date group и «Сегодня/Вчера» используют тот же timezone. Аналитические интервалы остаются UTC; timezone поясняется в date filter. Database timestamps не переписывать.
6. Scroll сохранён для списка; focus message находится в видимой области thread. После older-page prepend сохранить anchor. Новое входящее не крадёт selection: «Есть новый ответ» с явным переходом. Initial selection не выбирает другой message вместо отсутствующего focus молча.

### D. Identity, фильтры и copy

Reuse существующих `LeadAvatar`, `instanceName`, roster mapping и identity components без требования наличия lead row. Avatar fallback — инициалы/нейтральная иконка; при действительно неизвестном имени показать «Контакт LinkedIn» плюс сокращённый slug как secondary identifier, а не выдуманное имя. Не объединять профили по похожим именам.

Row: avatar+name+short time; company/role максимум одна строка; двухстрочный snippet с направлением («Ответ:» / «Отправлено:»); account chip и компактный action/owner indicator. Header: name, company, account human label с различителем двух аккаунтов одного владельца, LinkedIn link и details disclosure. Raw instance ID только в tooltip при необходимости. Сохранить существующий импорт истории и явно дать доступ к нему; не создавать composer.

Owner filter — active roster с facet counts отдельно; «Без ответственного» явно. Campaign options используют «Название · Аккаунт» и группируются/фильтруются по выбранному account. Одинаковые человеческие имена аккаунтов различаются через existing account label, например personal/business; не придумывать тип аккаунта без данных.

Copy replacements:

| Сейчас | Вместо этого |
| --- | --- |
| View / Scope / WORKFLOW | Очередь / Период поступления / Следующий шаг |
| Все sentiment | Все типы ответа |
| Коммерческий intent | Коммерческий интерес |
| Ревизия workflow / inbound | Убрать из normal UI; diagnostics по запросу |
| Знаменатели переданы сервером | «Разобрано X из Y ответов» |
| Legacy AI | «Старая AI-разметка — требует ручной проверки» в раскрываемом пояснении |
| ограниченное окно переписки | «Выберите диалог слева» |
| История просмотрена при pending=0 | «Нет ответов для разметки» только при известном состоянии; unknown не объявлять просмотренным |

Font: основной текст сообщений 14 px, формы 13–14 px, metadata 12 px; 10 px не использовать для инструкций/контролов. Button height 36–40 px desktop, touch target минимум 44 px mobile. Цветовые accents через существующие theme tokens; selected/keyboard-focus — один понятный indicator, не двойная рамка.

### E. Аналитика и переходы

Верх: compact title/date presets («7 дней», «30 дней», «Этот месяц», «Свой период»), account, more filters. Далее 4 KPI: диалоги с ответом; разобранные ответы X/Y; требуют разбора; требуют следующего шага. Message/conversation units всегда подписаны; coverage legacy/intent — раскрываемые детали, не равноправные headline карточки.

При 0 ручных ответов показать coverage и рабочие workflow counts, а вместо нулевых sentiment/reason charts — «Ответы ещё не размечены. Разберите ответы, чтобы увидеть причины и распределение» + «Перейти к разбору» с exact pending scope. Отсутствие negative/objection после ненулевой разметки имеет другой empty state: «В разобранных ответах нет отказов или возражений».

При данных: sentiment distribution, top reasons descending с «Все причины», рядом доля/число и denominator tooltip. Зеро-buckets скрыть из top reasons, но оставить доступными в полном справочнике; шкала 0 остаётся нулём без colored minimum 2 px. Multi-select пояснение: «У одного диалога может быть несколько причин, поэтому сумма долей может превышать 100%».

Weekly chart должен реально показывать выбранную серию: «Типы ответов / Причины / Покрытие», числа/доли, читаемые week intervals и признаки неполной недели. Recharts уже есть, повторно не устанавливать. Не выбирать первые три JSON keys. Недостающие series не выдумывать: добавить bounded typed adapter к existing aggregate response, либо ограниченную API-projection после проверки фактического payload. Согласованные weekly formulas исходного плана не менять. Уточнить units графика, чтобы message volume не притворялся unique conversations.

Comparison: toggle «Аккаунты / Кампании», нормальный case текста, label аккаунта как различитель, сортировка по meaningful column. `0/0` → «Нет оценки»; positive-only reviewed cohort → настоящий 0% negative допустим. DTO должен сохранять numerator/denominator/null для rate. Если current SQL возвращает ложный 0 через COALESCE, исправить источник, не маскировать CSS-ом.

Drill-down всегда сообщает, что открылось: banner «Из аналитики · 15 августа — 13 сентября · Отказы и возражения» с возвратом и очисткой metric scope. Период и metric scope не исчезают из UI, даже если спрятаны advanced filters. Empty state учитывает scope: «В этом периоде нет разобранных отказов» вместо ожидания sync.

Запретить generic `sentiment=business_rate`. Для карточки combined negative/objection использовать точный union predicate в typed metric scope или сделать rate informational, а рядом отдельные ссылки negative и objection. Предпочтение — union, если backend его уже поддерживает; сначала проверить. Каждый ненулевой numerator имеет проверяемый destination; если metric считает сообщения, ссылка подписана «Диалоги с такими ответами», а count списка не обещает равенства message count. Нулевая/undefined rate card не притворяется активным полезным переходом.

## Implementation phases

### 1. P1 foundation: layout + lifecycle (M–L)

Исправить U01–U07: route-local viewport shell, native button/checkbox defects, local selection без global loading, сохранение workflow при outbound focus, единое время. Сначала SOL лично проверяет в браузере 1280×660: короткий inbound, раскрытые причины, 50-row list, клик между двумя сообщениями. Пока контекст пропадает или action footer вне экрана, phase не считается выполненной.

### 2. SDR flow, identity, filters (M)

Единый form coordinator/sticky footer, progressive fields, dirty/conflict behavior, owner/filter metadata, account-aware rows и ссылки, корректные empties, mobile back. Проверка реальных saves только на fixtures/disposable staging с явно тестовыми диалогами. Live production audit остаётся read-only до отдельной авторизации writes.

### 3. Analytics и drill-down (M)

Coverage-led empty state, компактные KPI, meaningful trends, rates/null, раздельная comparison, typed navigation banner и exact matching. Сначала fixtures zero reviewed, partially reviewed и mixed reasons; потом read-only live parity по доступным данным. Нельзя ограничить проверку одним пустым production dataset.

### 4. Интеграционная и визуальная приёмка (M)

SOL использует Luna для кода по правилам исходного handoff. Не параллелить workers на одном CSS/Replies.tsx/Layout/DataContext. Первая волна: Luna A — `Layout.tsx`, `DataContext.tsx`, `useRepliesInbox.ts` и lifecycle tests; Luna B — `Replies.tsx`, `replies-inbox.css`, conversation panels и UI tests. Перед стартом согласовать интерфейс hook, чтобы B не правил A-файлы. Вторая волна: Luna C — analysis page/components/styles и точечно analytics DTO, после готовности route scopes. Shared file changes исполняет один designated integration worker. SOL проверяет diff, запускает тесты и **сам** визуально проходит сценарии, не полагаясь только на screenshots автора кода.

No production deploy/push/schema changes без соответствующего текущего разрешения пользователя. На каждую completed implementation phase — logical scoped commit по AGENTS.md; итог с хешами и перечнем пройденной визуальной проверки.

## Affected files/modules

- `frontend/src/pages/Replies.tsx`, `replies-inbox.css`.
- `frontend/src/components/conversation/ReplyReviewPanel.tsx`, `ConversationActionPanel.tsx`, `ConversationThread.tsx`; общий save coordinator в page/hook, не скрытые независимые saves.
- `frontend/src/lib/useRepliesInbox.ts`, `useReplyReviewActions.ts`, `replyReview.ts`, существующие `format.ts`/account-name helpers.
- `frontend/src/lib/DataContext.tsx`, `dashboardReads.ts`, `frontend/src/components/Layout.tsx`: ограниченный lifecycle/shell fix с regression checks остальных страниц.
- Existing avatar/identity/import primitives; общий `styles.css` изменять только если локальное использование design system недостаточно. Не создавать global `.primary/.secondary` ради этих двух страниц.
- `frontend/src/pages/SentimentAnalysis.tsx`, `sentiment-analysis.css`, `components/reply-analysis/*`.
- При доказанной необходимости: `frontend/api/_lib/data/operations/replyReviews.ts` и aggregate DTO/mapper для rates/series/union scopes; без изменения source labels или schema только ради layout.

## Risks & how to verify

### Acceptance checklist для SOL

| Сценарий | Обязательный результат |
| --- | --- |
| 1280×660, 1440×900, 1920×1080 | Нет document scroll для desktop inbox; list/thread/inspector scroll независимы; header/footer всегда видны. |
| 1024×768, 768×1024, 390×844, 200% zoom | Ни один контрол не обрезан; inspector не появляется под длинной перепиской; back из review возвращает к тому же message/list position. |
| Один короткий inbound | Прочитать, выбрать sentiment и сохранить можно без прокрутки всей страницы. |
| Negative с 3 reasons, other+comment | Названия читаются, checkboxes рядом, footer не уезжает; payload содержит все значения без скрытого удаления. |
| Клик по inbound/outbound одного thread | Нет global skeleton/capability fetch; workflow остаётся; сообщения не заменяются ошибочным «только исходящие». |
| Два аккаунта и один profile URL | Обе строки различимы; смена accounts не показывает данные прежнего thread даже на медленной сети. |
| Dirty review + dirty workflow + save | Сохраняется всё изменённое атомарно; field error блокирует обе части; ни один save не очищает unsaved sibling draft. |
| Concurrent update/409 | Ввод остаётся, актуальная версия предлагается для сравнения/перезагрузки; следующий диалог не открывается. |
| Обновление/переход при dirty form | Явный dialog; background load не размонтирует форму; отказ от ухода сохраняет все поля. |
| Pagination list/thread | Позиция/anchor сохраняется, duplicate rows отсутствуют; Next пересекает границу страницы, а не объявляет очередь пустой. |
| 0 reviewed и 0 negative denominator | «Пока нет оценки» и CTA к разбору; никакого фиктивного 0% negative в comparison. |
| Положительные reviewed, без negative | Реальный 0% negative допустим; reasons empty объясняет отсутствие отказов, а не отсутствие разметки. |
| Multi-reason + latest positive | Причина остаётся в encountered-period report; exact drill-down совпадает с формулой, а не latest-only filter. |
| Analytics → Replies → Back | Видны период/условие, правильная единица счёта и возврат; initial queue defaults не меняют metric scope. |
| UTC midnight/Madrid DST fixtures | List time, bubble и separator согласованы; analytics UTC boundary и follow-up Madrid boundary остаются прежними. |
| Keyboard, loading, error, light/dark | Logical tab order, visible focus, labels/aria-selected корректны; contrast и disabled states проверены. Dark/mobile пока не проверялись live в этом аудите. |

Relevant checks: `npm run build`; meaningful UI/hook tests для lifecycle, preservation и scope; `npm run typecheck:api` и targeted API tests при изменении backend. Build-only не является UI acceptance. Для финального handoff сохранить screenshots до/после на одинаковых viewport и состояниях, без секретов. Snapshot всего экрана только в конце не заменяет проверку save/next/scroll.

## Definition of done

- Все подтверждённые U01–U16 закрыты либо конкретное непройденное условие явно отражено в handoff; нет расплывчатого «UI улучшен».
- Replies визуально и поведенчески соответствует трёхобластному inbox из согласованного референса; чтение и действия не требуют прокрутки страницы целиком.
- Sentiment Analysis показывает данные, отсутствие данных и ограничения оценки понятно; разрезы ведут в объяснимый, точный список.
- Согласованные AI-off, classification/audit/revision/DNC/CRM boundaries сохранены; production business data не использовались как тестовые.
- SOL сообщает hashes, проверенные viewport/scenarios, что проверено live и что только локально; не заявляет deployment без отдельного release proof.
