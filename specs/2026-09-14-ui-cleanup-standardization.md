# UI cleanup and standardization — desktop, light, spacious, English

## Goal

Привести desktop dashboard Outreach Deck к единому спокойному светлому интерфейсу: чёткие непрозрачные поверхности, читаемый текст, просторные элементы управления и предсказуемые страницы. Устранить причины визуальной «грязи» в общей системе компонентов и стилях, затем последовательно перевести на неё все действующие маршруты. Целевые PC viewport: 1280×720, 1440×900 и 1920×1080.

Основание — авторизованный аудит production в Chrome 14 сентября 2026 года и исследование актуального frontend. Это план реализации; в рамках подготовки продукт, данные, интеграции и deployment не изменялись.

## Non-goals

- Изменение воронки, формул, знаменателей, ручной классификации ответов, CRM-статусов, правил follow-up, DNC или publishing.
- Изменение содержимого сообщений, названий кампаний, Playbook, ICP и других пользовательских данных ради перевода интерфейса.
- Отправка сообщений, запуск AI, публикация последовательностей, CSV-импорт, Slack-публикации и tenant/provider operations во время аудита.
- Ремонт runtime/sync/backend, обнаруженных рядом с UI-проблемами: фактические ошибки остаются видимыми и получают отдельные задачи.
- Поддержка тёмной темы, выбор плотности и многоязычный интерфейс в целевом варианте. Пользователь выбрал одну светлую тему, английский язык и более просторную плотность.
- Мобильные/планшетные layouts, touch-specific navigation и их визуальная приёмка. Пользователь отдельно уточнил: dashboard предназначен только для PC. Уже сделанные mobile observations ниже являются историей аудита, не backlog этой реализации.
- Замена React/Vite/Router/Recharts, внедрение полного стороннего UI-фреймворка или переписывание всех data hooks.

## Research findings

### Метод и границы доказательств

- Production: `https://app.ciphercross.dev/`, существующая авторизованная Chrome-сессия администратора. Основной проход — около 12:51–12:59 Europe/Madrid; продолжение после паузы — около 15:12–15:46. Данные продолжали поступать, поэтому счётчики в разных снимках не являются проверкой числового паритета.
- Просмотрены 20 типов внутренних экранов, перечисленных ниже. Сделаны снимки экрана в процессе аудита, прочитаны доступные элементы и выборочно измерены реальные размеры и вычисленные стили. Снимки находятся в истории этой задачи; в репозиторий изображения переписок не экспортировались.
- Основной desktop viewport: 1280×660, после паузы 1280×716; дополнительные проверки: 1440×900, 1920×1080 (Overview), 1024×768, 390×844, 320×720. Узкие размеры были проверены до уточнения пользователя о PC-only и не входят в целевую приёмку. Финальный desktop standard проверяется на 1280×720, 1440×900 и 1920×1080.
- Выполнены чтение, раскрытие панелей, выбор диалога/сообщения, фильтра владельца, вкладок, календаря и существующего редактора; открыта и закрыта незаполненная форма New search. Ничего не сохранялось и не публиковалось.
- Полный набор ошибок, conflicts, успешного сохранения, импорта и publishing нельзя доказать таким read-only аудитом. Их проверка на изолированных данных включена в реализацию. Тёмная тема исключена из целевой приёмки по решению пользователя.
- Sign-in был виден до входа в предыдущем проходе; recovery, non-admin access и все ветви ошибок проверены только как область влияния исходного кода, не как пройденные live-сценарии.

### Карта покрытия и конкретные наблюдения

| Экран / маршрут | Что проверено | Что исправить |
| --- | --- | --- |
| Overview `/` | Полная страница, account drill-down, календарь и Escape; PC вплоть до 1920×1080 | Размытые цветные поверхности, тяжёлые тени, чрезмерные радиусы, отдельная шкала заголовков, мелкие подписи, дублирующийся All time |
| Account `/account/:id` | Загруженный аккаунт с KPI, intent, графиками и списком кампаний | Другие KPI и заголовки, огромный блок intent с далёкими от подписей числами; неоднозначные account labels |
| Campaign `/campaign/:id` | Leads & replies, Performance, Sequence | Перегруженный header со статусами и revision, повторяющиеся рамки, другой набор табов/KPI; сохранить отдельный смысл runtime/publishing |
| Replies `/replies` | Список, входящий и исходящий, inspector scroll, filters, mobile thread → review | Нативные прямоугольные кнопки рядом со стилизованными select; мелкие имена/метаданные; фильтры резко сжимают workspace; duplicate empty guidance |
| Sentiment Analysis `/sentiment-analysis` | KPI, период, доступное empty state без ручных оценок, workflow summary | Русский UI внутри английской оболочки; собственные карточки и кнопки; менее выраженная иерархия состояния и действия |
| Follow-ups `/follow-ups` | Пустая очередь Mykyta и наполненная All owners | Крупные карточки с очень мелким содержимым, текст и действия обрезаются; несогласованные owner/account labels |
| Pipeline `/pipeline` | Наполненная доска, раскрытие Manage lead | Почти все тексты обрезаны; слишком много мелких плашек, цветных границ и вложенных контейнеров; управление карточкой слишком мелкое |
| Leads `/leads` | Фильтры, таблица, открытие ConversationDrawer, Escape; mobile 390 | 12 полей фильтра + digest + tabs отодвигают таблицу вниз; большое число одновременно видимых колонок; смешанный язык |
| ConversationDrawer | Открыт из Leads; чтение header/form; закрыт Escape | Узкая область, неодинаковые размеры селектов, сильный blur подложки, много метаданных перед перепиской |
| Sequence Hub `/sequences` | Deployments, фильтры, вход в существующий builder | Заголовок несоразмерно крупный, разница названия в sidebar и на странице, технический source-фильтр в основной панели, повтор таблиц внутри карточек |
| Sequence editor `/sequences/:id` | Build существующего документа, Preview | Повторяющиеся toolbars, маленькая textarea, открытые Comments занимают треть ширины даже без комментариев; два входа в Preview |
| Review `/review` | KPI, cohort matrix; загруженная таблица Leads Added с итоговой строкой | Плотная матрица, цветные микробейджи, маленькие кнопки периодов, ещё один способ оформления KPI; таблицу Leads Added перевести на общий стандарт |
| Playbook `/playbook` | Редактор и preview | Две тесные области в одной карточке, слабое разделение Edit/Preview, дублирующийся h1 в рендере Markdown |
| Searches `/searches` | Empty state, New search modal, начальный фокус, Escape | Два разных оформления New search; длинная форма, footer ниже первого viewport; потребуется общий Dialog/FormField |
| Team `/team` | Directory и сводные числа | Отдельные оформление таблицы, роль-бейдж и маленькие Edit; выровнять с другими таблицами |
| CSV Import `/csv-import` | Set up, stepper, disabled upload | Слабый контраст пояснений; определить единые состояния stepper, fields, disabled и ошибок. Файл не загружался |
| Health `/health` | Publishing compatibility, sync runs, account summary | Низкая читаемость мелких статусов/логов, сырые error codes, fading нижней части таблицы; редкое Regenerate and post доминирует над диагностикой |
| Chat `/chat` | Empty state и composer | Устаревшие упоминания Supabase/read-only SQL в пользовательском UI; ещё одно оформление input/empty state. Запрос не отправлялся |
| ICP `/icp` | Существующая карточка | Общие кнопки/формы и читаемость, не переводить пользовательское содержимое; маршрут сохранить |
| Hypotheses `/hypotheses` | Comparison table | Общие таблица, filters, actions и пустые состояния; маршрут сохранить |
| Neon activity `/neon-activity` | Загруженное состояние 0 rows | Техническая диагностическая страница с нативным Reload и устаревшей подписью о Supabase; сохранить URL, стандартизировать оболочку |
| Shell + Quick navigation | Sidebar, группы, поиск переходов, модальное окно | Нативный Sign out/Close среди стилизованных кнопок, маленькие nav targets; разные overlay-формы и blur; mobile overflow |

### Приоритетные дефекты

Приоритеты относятся к этой UI-программе: P1 — мешает чтению/работе или затрагивает общую основу; P2 — несогласованность и лишняя нагрузка; P3 — завершающая полировка.

| ID | Приоритет | Доказательство / причина | Требуемый результат |
| --- | --- | --- | --- |
| UI-01 | P1 | Overview сочетает несколько цветных градиентов, прозрачность, blur, rim и многослойные тени; это видно и в Chrome, и в CSS | Непрозрачные нейтральные поверхности, без декоративного свечения и blur |
| UI-02 | P1 | Refresh/Filters/Save в Replies и Close/Sign out имеют нативный вид; рядом .btn, link-btn и кастомные pills | Все продуктовые действия через единый Button/LinkButton/IconButton |
| UI-03 | P1 | В live Overview secondary copy 12 px и подписи KPI 11 px, `rgb(108,120,145)` | Body 16 px, metadata минимум 13 px, таблицы 14 px, контраст AA |
| UI-04 | Вне scope | Мобильная шапка при viewport 320 имеет document scrollWidth 394; sync chip выходит вправо до x≈381 | Историческое наблюдение, ремонт mobile не требуется по уточнению пользователя |
| UI-05 | P1 | В Leads на desktop 1280×660 table header начинается около y≈480: 12 filters, digest и tabs занимают большую часть экрана; mobile усугубляет эффект, но исключён из scope | На PC первые результаты видны без прохождения экрана фильтров; второстепенные фильтры закрыты по умолчанию |
| UI-06 | P1 | При открытии фильтров Replies на 1280×660 workspace смещается с y≈145 к y≈362 | Расширенные фильтры в overlay/sheet с явным Apply, без уменьшения рабочей высоты |
| UI-07 | P2 | Заголовки: global 20 px, Replies 22 px, Overview 24–32 px; Sequence Hub заметно крупнее | Одна шкала page/section/subsection для всех маршрутов |
| UI-08 | P2 | Крупные карточки Follow-ups/Account и тесные текстовые области редактора не соответствуют размерам содержимого | Простор достигается распределением места, а не увеличением пустой оболочки |
| UI-09 | P2 | В selector Overview/Follow-ups/Leads/Hub два Mykyta без уточнения; Sentiment уже различает их | Единый account label: имя + название аккаунта при неоднозначности |
| UI-10 | P2 | Русские labels в Replies/Sentiment и «Открыть Replies» в Leads; даты разными locale | Только английские системные тексты и единая явная политика дат |
| UI-11 | P2 | Рамки у вложенных карточек/таблиц/плашек; разные табы, radii и способы selected state | Ограниченная глубина поверхностей, общие Tabs, Badge, TableFrame |
| UI-12 | P2 | При переходе account scope и ряда вкладок содержимое заменяется общими skeleton; ранее загруженный контекст исчезает | Различать initial load и refresh; сохранять контекст при том же scope, защищать draft и очищать несовместимый selection при смене scope |
| UI-13 | P2 | Chat/Neon page показывают устаревшие provider explanations; runtime показывает коды в обычных filters | Пользовательское объяснение наверху, точная диагностика в Details; не скрывать реальные ошибки |
| UI-14 | P2 | Разные dialog/drawer/focus реализации; Search footer ниже первого экрана; Quick navigation визуально отличается от других окон | Один поведенческий контракт overlay и общий sticky footer |
| UI-15 | P2 | Table/identity truncation скрывает имена и account context; много категорий закодировано цветом | Стабильные колонки, приоритет идентичности, tooltip/detail с клавиатуры; текстовый смысл всех статусов |

### Что уже работает и должно сохраниться

- В проверенном Replies выбор исходящего сообщения сохраняет workspace и показывает корректный контекст; ложное «только исходящие» из старого аудита не воспроизведено.
- Inspector прокручивается независимо; список и переписка остаются на месте. Сохранение остаётся в нижней панели. Существующий mobile thread → review переход работает.
- В Replies время одного выбранного ответа в списке и переписке совпало: 01:54, с обозначением времени Мадрида в доступном имени. Не открывать заново уже исправленную timezone-проблему без нового воспроизведения.
- В Replies campaign options содержат account suffix, а owner filter содержит участников, включая нулевые количества. Эти уже сделанные исправления сохранить и распространить.
- Escape закрывает проверенный календарь и возвращает фокус на его trigger; ConversationDrawer и New search закрылись Escape.
- URL scope/deep links, ручная разметка и независимое conversation workflow являются продуктовыми контрактами, не объектом косметического упрощения.

### Причины в коде

- `frontend/src/styles.css` — около 4,817 строк, где tokens, reset, shell, формы, overlays и page-specific selectors находятся вместе. Отдельно Overview — 504 строки, Replies — 158, Sentiment — 80. Размер сам по себе не дефект; дефект — конкурирующие правила для одних ролей.
- Базовые tokens уже есть (`styles.css:5–60`), но общих Button, PageHeader, FormField, Tabs, Dialog, DataTable primitives нет.
- Глобальный `header` (`styles.css:313`) влияет на вложенные semantic headers. `.sa-header` используется и в Overview, и в lazy-loaded Sentiment CSS: риск зависимости от порядка переходов. Видимый сдвиг от этого отдельно не доказан.
- Стекло находится не только на Overview: body (`styles.css:260`), cards (`:477`), buttons (`:1683`), overlays (`:2484`), SVG refraction в `Layout.tsx:114–142`, tooltip в `chartTheme.tsx:57–76`.
- Light `--text-muted: #6c7891` даёт примерно 4.44:1 на белом и 3.92:1 на `#eef1f8` по формуле WCAG. Live цвет и размер подтверждены; финальный контраст на текущих прозрачных слоях требует compositing, эти значения — расчёт исходных пар.
- Есть полезная основа: `EmptyState`, `Skeleton`, `DateRangePicker`, `Avatar`, `QuickNavigation`, `ConversationDrawer`, `chartTheme`, центральный `lib/navigation.ts`. Их нужно переиспользовать и нормализовать.

### Внешние ориентиры

- [WCAG text contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html): минимум 4.5:1 для обычного текста; [non-text contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html): 3:1 для необходимых границ/графики состояния.
- [WCAG reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html) рассмотрен при исследовании, но 320 px reflow исключён из текущего PC-only scope. План использует конкретные требования contrast/focus/keyboard, не заявляет полную сертификацию WCAG AA.
- [Target size minimum](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html): AA — 24×24 либо допустимые исключения. Выбранные здесь 44 px — более просторный продуктовый стандарт.
- [Visible focus](https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html), [focus not obscured](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html) и [WAI modal dialog](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/): видимый фокус, его удержание в modal, Escape, inert background и возврат.
- [Carbon spacing](https://carbondesignsystem.com/elements/spacing/overview/) и [data tables](https://carbondesignsystem.com/components/data-table/usage/) используются как примеры последовательных правил. Установка Carbon не предлагается.

## Decisions

### Ответы пользователя — обязательная часть контракта

| Вопрос | Ответ |
| --- | --- |
| Оформление | «Спокойный плоский UI, только светлая тема» |
| Язык | «Единый английский интерфейс» |
| Плотность | «Более просторную: крупнее текст и элементы» |
| Устройства | «I don't care about adaptives working on mobile devices, as this meant as a pc only dashboard» — только PC |
| Текущий результат работы | Полная проверка и письменный план; реализация отдельным следующим этапом |

### Конкретизация выбранного направления

- Один визуальный стандарт для всех маршрутов, включая редкие, auth и overlays. Сохранить текущие URL и структуру бизнес-функций.
- English относится к тексту приложения, aria-label, tooltip, placeholder, validation, toast и empty state. Контент пользователей, LinkedIn-тексты, имена и названия остаются как введены.
- `Sequence Builder` в sidebar и `Sequence Hub` на landing привести к одному пользовательскому названию **Sequences**. Внутри оставить понятные разделы Deployments и Builder; маршруты не менять.
- Принять перечисленные ниже размеры как исходный норматив реализации; корректировать только системно после проверки эталонных экранов, не создавать исключение для каждой страницы.
- Сохранять React, Inter Variable, Lucide, существующие hooks, selectors и предметные компоненты. Не вводить второй UI-framework параллельно старому.

## Approach

### 1. Единая визуальная основа

| Роль | Целевое правило |
| --- | --- |
| Page background | `#F7F8FA`, однородный |
| Surface | `#FFFFFF`, 100% opacity |
| Subtle surface | `#F2F4F7`, только для группировки и disabled/selected context |
| Primary / secondary / muted text | `#182230` / `#475467` / `#596579` |
| Accent / hover | `#2563EB` / `#1D4ED8`; белый текст на primary action |
| Decorative separator / meaningful input border | `#D0D5DD` / `#7A8699`; разница намеренная |
| Success / warning / danger text | `#067647` / `#92400E` / `#B42318`; иконка/текст дополняют цвет |
| Body / controls | 16/24 px; regular 400, labels/actions 500–600 |
| Table content / metadata | 14/20 px / 13/18 px; не уменьшать ниже 13 ради размещения |
| Page title | 28/36 px, 600, единый для поддерживаемых PC размеров |
| Section / subsection | 20/28 px / 16/24 px, 600 |
| KPI | 32/40 px, 600; tabular numerals |
| Space scale | 4, 8, 12, 16, 24, 32, 48, 64 px; 1–2 px допустимы для border/icon alignment |
| Controls / icons | Default height 44 px; icon button hit area 44×44, glyph 20 px |
| Table rows | Single line minimum 52 px; identity + secondary line minimum 68 px; auto-grow для переноса |
| Radius | 8 px controls, 12 px cards, 16 px dialogs; pill только для badges/chips |
| Elevation | Cards без shadow; одна мягкая тень только у popup/dialog/drawer |
| Focus | 2 px solid accent outline с 2 px offset; не заменять слабым прозрачным halo |

Расчёт предложенных непрозрачных пар: muted на white ≈5.90:1, на subtle ≈5.35:1; accent на white ≈5.17:1; input border на white ≈3.69:1. Это проверка палитры, финальное состояние компонентов проверяется в браузере отдельно.

Убрать decorative radial/linear gradients, backdrop-filter, turbulence/displacement, glowing dots, inset rim и lift-on-hover с data surfaces. Допустимые исключения по назначению: графики/heatmap передают данные, аватары и логотипы содержат изображение, skeleton показывает загрузку, LinkedIn preview имитирует внешнее представление. Исключения не распространяются на app chrome вокруг них.

Однотипные поверхности различаются отступами, текстовой иерархией и разделителями. Максимум два видимых уровня: page → section; строки и обычные KPI внутри section не получают ещё одну рамку и тень одновременно.

### 2. Архитектура стилей и primitives

Предлагаемая структура: `src/ui/` для общих React-компонентов, `src/styles/` для tokens/reset/base, shell styles рядом с Layout, route-specific CSS Modules рядом с pages/components. `styles.css` на переходный период остаётся compatibility entrypoint и постепенно теряет перенесённые правила.

| Primitive | Контракт |
| --- | --- |
| Button / LinkButton / IconButton | `primary`, `secondary`, `ghost`, `danger`; loading/disabled/pressed; одинаковый размер и focus; link остаётся ссылкой, action — button |
| PageHeader | Один h1, необязательные breadcrumb/description/context; один primary action; дополнительные действия в меню |
| Panel / SectionHeader | Единые padding/heading/actions; `plain` и `surface`, без page-specific теней |
| Field / Input / Textarea / Select / Checkbox / RadioGroup | Видимый label, help/error IDs, required/disabled/readOnly; стандартизированная высота, ошибка не только цветом |
| Tabs / SegmentedControl | Tabs переключают раздел, segmented — режим/период; клавиатура, selected state, локальная прокрутка при необходимости |
| Toolbar / FilterSheet / ActiveFilters | Search и 1–2 главных selector снаружи; остальные в доступном sheet; applied filter count + Clear all |
| Badge / StatusText / AccountIdentity | Смысловые variants, no glow; нормальный текст unknown, единый label аккаунта и avatar fallback |
| TableFrame / TableToolbar / Pagination | Общая оболочка и поведение, domain-specific columns и data hooks остаются у экрана |
| Dialog / Drawer / Popover | Общие header/footer/backdrop/focus/Escape/scroll lock; отдельные типы с разной семантикой |
| Loading / Empty / Error / Toast | Единые размеры, язык и действия; distinguish initial load, refresh, empty results, unavailable |

Не делать универсальную мегатаблицу с бизнес-логикой всех разделов. Не стилизовать любой `header`, `aside`, `button` или `table` как продуктовый компонент глобально. Не использовать неограниченные `.primary`, `.secondary`, `.sa-*` для новых компонентов.

Новые primitives не знают о Neon, LH2, reply enums или API. Domain adapters преобразуют существующие значения в labels/variants. CSS Modules изолируют page layout; все их цвета/шрифты/геометрия используют tokens.

### 3. Светлая тема без остаточного поведения тёмной

- Перевести `index.html` bootstrap, `ThemeContext`, `meta theme-color`, `color-scheme`, error/auth/recovery screens на светлую тему до первого кадра.
- Удалить theme toggle в sidebar и mobile bar, dark selectors и unused theme consumers. Если нужен временный provider для поэтапного перехода, он всегда возвращает light и удаляется после переноса последних consumers.
- Старое сохранённое `theme=dark` игнорируется/нормализуется только для ключа темы. Не очищать весь localStorage и не трогать auth, filters или drafts.
- OS dark mode, private storage failure, deep link и reload не должны давать тёмную вспышку. UA form controls также светлые.

### 4. Компоновка: больше места содержимому

- Sidebar: 232 px, nav rows 44 px, пользователь может свернуть её текущей командой. Полная freshness и account context доступны на PC; новую mobile navigation не проектировать.
- Page gutters: 32 px, на PC viewport 1280 px допустим единый шаг 24 px; обычная аналитика max-width 1600 px. Границы страниц и заголовков совпадают между маршрутами.
- Основные списки: title → краткий context → toolbar → results. Digest, demographics, технические filters и редкие операции убираются из постоянного верхнего блока в соответствующие disclosure/menu.
- FilterSheet открывается поверх страницы и не изменяет её высоту. Внутри draft filters, Apply/Cancel; Cancel оставляет URL/данные прежними, Apply атомарно меняет scope и сбрасывает cursor, Clear all возвращает documented defaults. Смена scope при несохранённой форме проходит dirty guard из раздела «Состояния и поведение»; существующую защиту Replies сохранить.
- На списках при default filters первый результат должен начинаться не ниже y=340 на 1280×720. Для пустого результата на этом месте показывается empty state. Измерять после загрузки без открытых advanced controls.
- Широкие tables/kanban допускают горизонтальную прокрутку только внутри своей области с видимой подсказкой и доступной клавиатурой. Нельзя уменьшать всю таблицу до нечитаемого текста.

### 5. Перенос по семействам экранов

**Overview, Account, Campaign Performance, Review, Sentiment.** Общие KPI, date/account filters, section headings, chart palette/tooltips и table framing. У Overview убрать внешнюю декоративную оболочку. Период указывать один раз у блока, не повторять All time в каждой карточке. Intent-метрики собирать в компактную смысловую группу с числами рядом с labels. Сохранить различие all-time, interval и mature cohort; не объединять разные знаменатели ради более красивой карточки. В cohort matrix детали изменения и sample warning доступны через cell detail; таблица сохраняет сравнение, текстовые значения и семантику.

**Replies.** Режим зависит от доступной ширины content container. От 1240 px — list 320 + thread минимум 560 + inspector 360. Ниже 1240 px в поддерживаемых PC окнах — две области: list 300 + thread минимум 480 либо thread минимум 480 + review 360. Ширины включают разделители (`border-box`), межпанельного gap нет, оставшееся место получает thread. Например, при viewport 1280 px, sidebar 232 и gutters 2×24 контейнер равен 1000 px: list 300 + thread 700 либо thread 640 + review 360. На 1920 px помещаются три области. Переключение list+thread ↔ thread+review явное; есть Back to conversations. Selected thread/message, drafts и scroll сохраняются при изменении ширины и переключении панелей. Смена account/filter scope обрабатывается отдельно по правилам ниже. Footer review sticky, primary `Save and next`, secondary `Save`; pending/disabled статусы читаемы. В списке имя приоритетнее времени, до двух строк для identity, snippet и account owner context не конкурируют одинаковой яркостью. Без выбранного диалога один объясняющий empty state. Отдельный mobile flow не разрабатывать.

**Leads, Follow-ups, Campaign Leads.** Общие toolbar, identity и table/list states. В Leads default columns: Lead, Account / campaign, Milestone, Pipeline, Next follow-up, Latest activity; остальные доступны через Columns/Details, без изменения существующих фильтров и exports. Desktop identities минимум 220 px, details открываются с клавиатуры. Follow-ups — выровненные строки или карточки с отдельными зонами identity/status/preview/actions, primary Open follow-up; редкие links в menu. Сохранить Today/Overdue/Upcoming и timezone semantics.

**Pipeline.** Колонки 320–360 px, содержимое карточки 14–16 px, максимум две строки identity и две snippet, явный next step. Убрать сочетание цветной рамки колонки, цветной рамки каждой карточки и множества цветных микробейджей; один статусный акцент на уровне колонки. Manage actions открыть в общем меню; drag-and-drop дополнен существующим явным Move to, без изменения stage transitions.

**Sequences и builder.** Общий page title. Deployments — toolbar и группированная таблица вместо тяжёлой самостоятельной карточки на каждую строку. Source/profile details в Advanced diagnostics. Builder: основной текстовый столбец минимум 560 px на desktop, Comments/History по умолчанию свёрнуты в вызываемую панель; текущий selected step/variation сохраняется. Variables/emoji/secondary commands в компактном toolbar/menu с hit area 44; большие сообщения получают нормальную textarea. Деструктивные actions отделены от повседневных. Auto-save, conflict, branch revision и publish workflow остаются без изменений. LinkedIn preview сохраняет назначение и отличается от app chrome осознанно.

**Playbook, Searches, ICP, Hypotheses.** Общие формы и overlays. Playbook — явные Edit/Preview режимы; split только при достаточной ширине, preview до 72ch. User Markdown headings визуально и семантически вложены под page title. Search/ICP/Hypothesis dialogs: fixed header/footer, прокручивается содержимое, Create/Save всегда доступны в viewport. Никакого autosave в формах, где его сейчас нет.

**Team, CSV Import, Health, Chat, auth, Neon activity.** Общие таблицы/stepper/fields/empty/error. Health сначала показывает текущую работоспособность; редкое Regenerate and post находится в action menu. Runtime, publish readiness и freshness не сливаются в один misleading green badge. Raw code доступен в Details с copy, а строка имеет человеческое объяснение. Chat/auth не рассказывают о внутренних provider/SQL, если это не нужно для решения пользователя. Диагностический Neon route остаётся доступен и честно обозначен как diagnostic.

### 6. English и единые display labels

- Одна англоязычная карта системного UI copy и domain display labels; не вводить language picker. Сырые enum/API значения остаются прежними.
- Основные labels: `Replies`, `All`, `Unreviewed`, `Needs reply`, `Deferred`, `Completed`, `Review reply`, `Sentiment`, `Reasons`, `Buying interest`, `Next step`, `Conversation owner`, `Do not contact`, `Save`, `Save and next`, `Changes saved`, `Could not save. Try again.`
- Словарь account identity используется во всех dropdown/list/table: имя + account label при дубликатах. Не угадывать человеческое имя по profile slug; `LinkedIn contact` + secondary identifier при отсутствии данных.
- `Intl` с явно выбранной английской locale для labels/дат. Операционные business dates — Europe/Madrid (например, `14 Sep, 13:20 · Madrid`), аналитические interval slices — UTC с видимым UTC context. Относительная дата имеет доступное абсолютное значение. UTC data contract не менять.
- Все errors/validation/aria/toasts проходят copy inventory; raw server diagnostics могут оставаться в раскрытых технических details.

### 7. Состояния и поведение

| Состояние | Отображение и действие |
| --- | --- |
| Initial load | Skeleton соответствует финальному layout; aria-busy у загружаемой области |
| Background refresh / scope loading | Заголовок и controls остаются; старые данные явно помечены как updating и не выданы за новый scope; новый результат заменяется атомарно |
| Empty dataset | Объяснение и релевантное первое действие; не рисовать нули как подтверждённые бизнес-метрики |
| No filter matches | Активные фильтры + Clear filters; отличать от отсутствия данных |
| Read failure | Inline error + Retry; остальная рабочая область сохраняется |
| Save pending | Loading на вызванном action, повторный submit предотвращён, ширина кнопки стабильна |
| Save failed / conflict | Draft сохранён; inline причина и retry/reload options; не очищать ввод |
| Saved | Ненавязчивое подтверждение рядом с действием; не перезагружать весь экран |
| Disabled | Действие недоступно программно; причина рядом/в accessible description; не снижать opacity всей секции с полезным текстом |

Overlay: role/name, начальный фокус, Tab/Shift+Tab внутри modal, inert фон, Escape, возврат focus, scroll lock и nested overlay order. Persistent panes не должны объявляться modal.

Единый контракт закрытия редактируемой формы: чистая форма закрывается сразу; при изменениях Escape, Close, backdrop и уход со страницы показывают `Keep editing` / `Discard changes`. Keep editing возвращает фокус к последнему активному полю; Discard changes удаляет только несохранённый draft и выполняет отложенное закрытие/переход. Во время отправки повторный submit и закрытие формы недоступны до результата; ошибка оставляет draft и возвращает возможность редактировать или закрыть с подтверждением. Это дополнение стандартизации: существующие guards Replies сохранить, а в New search добавить защиту, которой сейчас нет (`SearchLibrary.tsx`: Escape/backdrop/Close закрывают форму напрямую).

Контракт смены scope: изменение layout не меняет выбранную переписку. Если новый account/filter исключает selected thread, сначала разрешить dirty state по описанному guard, затем сбросить старый selection и показать допустимый новый результат или empty state. При отмене перехода URL, scope и selection остаются прежними. Пока грузится новый scope, старое содержимое можно сохранять только с явной подписью прежнего аккаунта и состояния loading; действия над старым scope временно недоступны. Нельзя показывать старую переписку под именем нового аккаунта. Сохранённые server-side данные и drafts другого аккаунта не смешиваются.

## Implementation phases

Оценка S/M/L — относительный объём и риск, не календарное обещание. Каждый этап заканчивается проверяемым результатом и scoped commit. Общий rollout — после прохода всех маршрутов; промежуточные этапы допустимы в локальном/preview окружении.

1. **Эталон и реестр UI (M).** Зафиксировать tokens и component API, создать локальную dev-only gallery состояний и четыре репрезентативных композиции: Overview, Replies, Leads, Sequence editor. Никаких production data writes. Результат: размеры/контраст/простор можно увидеть до массового переноса; checklist связывает UI-01…15 с исправлениями.
2. **Foundation, light-only, shell (M).** Bootstrap/ThemeContext, palette/type/spacing, убрать общие эффекты и SVG refraction, единая desktop navigation. Проверить старое theme=dark, private mode, auth screens и три целевых PC размера. Новые foundation styles не накладываются бесконечным override-файлом поверх старых.
3. **Controls, overlays и English foundation (L).** Button/Field/Tabs/Badge/identity/table frame/states; перенести date picker, QuickNavigation, ConversationDrawer, Search/other modals. Удалить заменённые селекторы по мере миграции. Общий словарь и date formatters.
4. **Основная рабочая зона: Replies, Leads, Follow-ups, Pipeline, Campaign Leads (L).** Перекомпоновать filters/results и панели, перевести copy, сохранить dirty guards/deep links. Проверить read, paging, selection, empty, long content и save/conflict на изолированных данных.
5. **Analytics family (L).** Overview, Account, Campaign Performance, Review/Leads Added, Sentiment. Общие KPI/charts/tables; проверить scope, interval labels, знаменатели, route-order и независимость загрузок. Полностью удалить старый Overview glass layer после переноса.
6. **Editor/strategy/admin/auth (L).** Sequences/Builder/Preview, Playbook, Searches, Team, CSV, Health, Chat, ICP/Hypotheses/Neon, sign-in/recovery. Провести формы и длинный контент через общий стандарт; сохранения/импорт/publishing проверять только в изоляции до release.
7. **Удаление наследия и регрессионная приёмка (M).** Удалить unused tokens/classes/dark branches, итоговый English inventory, полный route matrix, keyboard/zoom/viewport checks, behavioural suites/build. Остаточные исключения документированы по назначению, не по названию страницы.
8. **Release и подтверждение production (M, отдельная операция после разрешения на deployment).** Деплой проверенного commit, затем авторизованный read-only smoke тех же маршрутов; отдельно зафиксировать deployment Ready, browser evidence и результаты изолированных write tests. Если нарушена визуальная/поведенческая приёмка — вернуть предыдущий frontend release, без отката базы.

## Affected files/modules

- Foundation: `frontend/src/styles.css`, новые `frontend/src/styles/{tokens,reset,base}.css`, `frontend/src/main.tsx`, `frontend/index.html`, `frontend/src/lib/ThemeContext.tsx`.
- Shell: `frontend/src/components/Layout.tsx`, `QuickNavigation.tsx`, `Logo.tsx`, `frontend/src/lib/navigation.ts`, их локальные стили.
- Новые shared primitives: `frontend/src/ui/` и dev-only gallery/fixtures; production route gallery не добавлять.
- Existing reusable pieces: `Avatar.tsx`, `EmptyState.tsx`, `Skeleton.tsx`, `DateRangePicker.tsx`, `CopyButton.tsx`, `chartTheme.tsx`, `ConversationDrawer.tsx`, `LostReasonModal.tsx`, `CompanyResolutionModal.tsx`, `ChipInput.tsx`.
- Operations: `pages/Replies.tsx`, `pages/replies-inbox.css`, `components/conversation/*`, `pages/LeadsExplorer.tsx`, `pages/FollowUps.tsx`, `pages/Pipeline.tsx`, `components/leads-and-replies/*`, `FollowUpPanel.tsx`.
- Analytics: `pages/Overview.tsx`, `components/overview/*`, `pages/{AccountDetail,CampaignDetail,Review,SentimentAnalysis}.tsx`, `pages/sentiment-analysis.css`, `components/reply-analysis/*`, shared KPI/chart/table components.
- Editor/other routes: `pages/{SequenceBuilder,Playbook,SearchLibrary,Team,UnifiedApolloCsvImport,Health,Chat,Icp,Hypotheses,NeonActivity,ResetPassword}.tsx`; auth UI in `lib/AuthContext.tsx`.
- Labels/date formatting: существующие domain helpers + новые общие UI display helpers; server enums/data operations не менять.
- Tests: существующие behavioural suites; новые targeted primitive/gallery/browser regression checks. `package.json` менять только если выбран минимальный необходимый browser-test runner; отдельный Storybook не обязателен.
- Постоянный стандарт после реализации: `docs/ui-standard.md` и короткая ссылка из AGENTS/CLAUDE. Этот план остаётся в specs до завершения, затем переносится по правилам репозитория.

## Risks & how to verify

### Матрица обязательной приёмки реализации

| Область | Проверка |
| --- | --- |
| Visual baseline | Все 20 route types: 1280×720, 1440×900 и 1920×1080; сравнить с gallery, одинаковые page gutter/title/control roles |
| PC window sizes | Sidebar visible/collapsed, Replies container 1239/1240 px по обе стороны переключения панелей; короткий viewport 1280×660 как дополнительная стресс-проверка sticky footer; мобильная матрица не требуется |
| Desktop zoom | 200% browser zoom на PC: текст/действия доступны через предусмотренную прокрутку, focus не полностью скрыт; новый mobile layout и 400%/320 px gate не требуются |
| Long content | Длинное имя, 100+ символов campaign title, длинный error, message и label; не обрезать primary action, доступен full value |
| Keyboard | Tab/Shift+Tab, arrows в tabs/date picker, Enter/Space, Escape, return focus; focus не уходит под overlay/sticky footer |
| Theme retirement | stored dark, OS dark, missing storage, reload/deep links, sign-in/reset: первый и последующий кадр light |
| Route order | Overview → Sentiment → Overview; Replies → Campaign → Replies; переходы без reload и прямой deep link дают одинаковую геометрию |
| Filters/pagination | Apply/Cancel/Clear, URL back/forward, cursor reset при scope, append без дублей; context сохранён при том же scope, исключённый thread очищен после dirty guard; account/thread isolation |
| Analytics | Те же fixtures дают те же значения/denominators; pending refresh не подписан как новый scope; UTC boundaries и mature cohorts неизменны |
| Forms | Validation, disabled/readOnly/loading, double submit, retry, failed save, conflict и dirty navigation на disposable fixtures |
| Editors / import | Existing auto-save/revision/branch/publish/export/CSV phase transitions не меняются; write checks в изолированном окружении |
| Contrast | Автоматический расчёт rendered token combinations и ручная проверка focus, charts, disabled/help текста; AA baseline |
| Deployment | Ready не равно UI acceptance; нужен авторизованный read-only production smoke после подтверждённого release |

Особые риски:

- Массовый global CSS rewrite может поломать непросмотренные вложенные элементы. Сначала primitives и scoped migration, затем удаление старых rules; проверить lazy route order.
- Увеличение шрифта без перекомпоновки создаёт overflow. Поэтому новые controls и layout должны переходить вместе по семействам экранов.
- Общий TableFrame не должен поглотить бизнес-логику сортировки, пагинации и фильтров. Сохранить ownership текущих hooks.
- Frontend refactor не должен remount selected conversation/editor при фоне обновления; это проверяется отдельными draft/selection сценариями.
- Отсутствующий sentiment dataset не позволяет проверить все charts на production; gallery должна содержать положительные/нейтральные/отрицательные ответы, objections, причины, P1/P2/P3 и zero/partial coverage.
- Live Health содержал `STATUS_PROFILE_VERSION_MISMATCH`/`STATUS_PROFILE_MISSING`, а один Account показывал «No campaigns match» при ненулевом числе кампаний. Это сопутствующие функциональные сигналы; их причины и ремонт не доказаны данным аудитом. Дизайн обязан честно показывать состояние, не маскировать его.

Проверки из `frontend/`: `npm run build`, scoped `npm run test -- …`, `git diff --check`. Использовать существующие `overviewOperations`, `dateRangePickerAccessibility`, `quickNavigation`, `navigation`, `repliesInboxPagination` (включая account/thread isolation), Replies/review workflow, `sentimentAnalysis`, `campaignWorkspace`, `sequenceBuilderPage`, `sequencePublishWizard`, `playbookPage` suites. Точные имена сверить перед запуском. `typecheck:api` нужен при изменении API/type contracts; Neon/cleanroom tests требуют явно изолированной базы.

Для визуального regression gate добавить небольшой browser suite для gallery и ключевых маршрутов с фиксированными fixtures, viewport и deterministic date. Не считать jsdom/build визуальной проверкой. Не писать snapshot-тест на каждую CSS-декларацию.

## Definition of done

- [ ] Все перечисленные route types и общие overlays переведены на одну систему; нет «старых» участков с нативными продуктовым кнопками.
- [ ] Светлая тема применяется до первого кадра; dark toggle/branches/effects удалены, старое preference не возвращает dark.
- [ ] UI полностью английский, включая aria/help/error/toast; user-generated content сохранён.
- [ ] Body 16 px, table 14 px, metadata минимум 13 px; primary controls 44 px, единые radii/gutters/heading roles.
- [ ] Нет декоративного blur, gradient, glow и многослойных теней на app surfaces; исключения имеют функциональное назначение.
- [ ] На трёх целевых PC размерах нет непредусмотренного document overflow; широкие таблицы/доски прокручиваются локально; sidebar, header и основные actions доступны.
- [ ] Leads/Follow-ups/default lists соответствуют first-result y≤340 на 1280×720; advanced filters не вытесняют workspace. Mobile не входит в Definition of done.
- [ ] Replies сохраняет thread/review context и drafts при переключении панелей; scope/navigation защищены dirty guard и не оставляют чужую переписку под новым аккаунтом. Footer и кнопки доступны без прокрутки всей страницы.
- [ ] Все одинаковые account/person/status roles используют общие display components; duplicate account names различимы.
- [ ] Не изменились data semantics, manual-only reply classification, DNC, follow-up, cohort/UTC, imports и publishing contracts.
- [ ] Пройдены meaningful tests/build, keyboard/contrast/viewport/route-order проверки и изолированные mutation scenarios.
- [ ] Удалены заменённые CSS-правила; новые route styles не задают собственную palette/type scale; gallery и `docs/ui-standard.md` отражают итоговый UI.
- [ ] Итоговый handoff содержит scoped commits, фактически пройденные проверки и оставшиеся ограничения. Production verification отмечена отдельно и только после разрешённого deployment.

План готов к реализации в рамках зафиксированных решений. До начала реализации текущий артефакт можно уточнять; его создание само по себе не является разрешением на product changes или deployment.
