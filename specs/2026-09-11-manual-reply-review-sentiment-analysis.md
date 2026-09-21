# Replies Inbox, manual reply review and Sentiment Analysis

> Дополнение после live UI-аудита 2026-09-13: [план исправления UI/UX для SOL](2026-09-13-replies-ui-ux-repair.md). Для дальнейших UI-исправлений его компоновка, UX-правила и критерии визуальной приёмки имеют приоритет над UI-деталями этого документа. Бизнес-правила и архитектурные ограничения ниже сохраняются, кроме явно перечисленных исправлений.

## Goal

SDR-ы вручную классифицируют все входящие ответы, указывают причины отказа/возражения и дальнейшее действие по диалогу. Отдельный Replies Inbox становится рабочим местом для чтения и разбора переписок; Sentiment Analysis показывает статистику и открывает соответствующие диалоги в Replies. Leads сохраняется как таблица всей базы, включая лидов без ответов.

Статус: план v4 от 2026-09-11, реализация не начата. Пользователь согласовал отдельный Replies Inbox и поручил включить техническую архитектуру и инструкции для SOL-оркестратора с Luna-исполнителями. Раздел 7 — обязательный технический контракт реализации; раздел 8 — порядок работы агентов. Поручение относится к подготовке плана, не запускает реализацию сейчас.

## Non-goals

- AI-классификация ответов, AI-подсказки категорий, AI-backfill и проверка менеджером.
- Отключение остальных AI-функций продукта: briefing, chat, coaching, demographics. Запрос касается классификации ответов.
- Автоматическая отправка сообщений, управление очередью Linked Helper, синхронизация запрета контакта с внешними инструментами.
- Редактор справочника категорий, CSV-экспорт, оценка эффективности SDR по доле негативных ответов и сложная атрибуция выручки в v1.
- Изменение измеряемых milestone-метрик приглашений/коннектов/ответов и семантики durable P3.

## Research findings

- `frontend/api/classify.ts` классифицирует sentiment и P1/P2/P3 совместно; этот же файл обслуживает ручной `/api/reclassify` и demographics. Отключать функцию целиком или удалять cron без разделения обязанностей нельзя.
- `frontend/src/components/ConversationDrawer.tsx` уже позволяет вручную менять sentiment/intent, но сейчас это admin-only. Ручная метка защищена от AI overwrite; reviewer и полноценной истории классификации нет.
- `frontend/src/lib/pipeline.ts` содержит negative с `soft_no|hard_no|lost`; эти значения описывают состояние, а не причину отказа. Pipeline, owner и follow-up уже имеют собственные потоки и события.
- SQL auto-triage умеет переводить ещё не разобранные лиды по sentiment. По текущему `classify.ts` scheduled Neon auto-advance уже retired, но admin classify и manual reclassify всё ещё вызывают его; Supabase fallback тоже имеет вызовы. Убрать эти вызовы из reply-classification путей, а не утверждать, что production cron сейчас двигает лидов.
- Leads использует последний ответ на `(instance_id, profile_url)`, а Review и `campaign_reply_sentiment` считают сообщения. Эти числа нельзя выдавать за одну метрику.
- Review имеет ограниченное окно истории в route snapshot; новая аналитика требует серверной агрегации и пагинации, а не загрузки всей переписки в браузер.
- Навигация централизована в `frontend/src/lib/navigation.ts`, маршруты — в `App.tsx`. Новые операции должны использовать существующий dispatch: лимит верхнеуровневых Vercel-функций уже занят.
- Схема развивается через append-only `postgres/tenant-baseline/v1/ledger.manifest.json`. Старые baseline-файлы и `supabase/migrations/` не редактировать. Tenant rollout выполняется по operations contract.
- Внешние ориентиры: [HubSpot properties](https://knowledge.hubspot.com/properties/hubspots-default-deal-properties) разделяет причину потери, этап, владельца и следующий шаг; [Google PAIR](https://pair.withgoogle.com/guidebook-v2/chapter/feedback-controls/) рекомендует понятные и исправляемые ручные решения. [Gong](https://www.gong.io/blog/objection-handling-techniques) рассматривает возражения по цене, продукту, времени и внутреннему согласованию. Это ориентиры для таксономии, не измеренные данные CipherCross.

## Decisions

| Вопрос | Решение пользователя / конкретизация плана |
| --- | --- |
| Роль AI | Полностью убрать AI из классификации ответов: sentiment, причины и P1/P2/P3 назначаются человеком. P1/P2/P3 остаются отдельной ручной осью. Остальные AI-функции вне этой фичи. |
| Область | Все входящие ответы, включая positive, neutral, negative, objection, referral и автоматические ответы. `auto` означает тип ответа, не источник классификации. |
| Объект разметки | Конкретное сообщение; текущее действие — один диалог `(instance_id, profile_url)`. CRM stage остаётся на существующих lead rows. |
| Причины | Пользователь принял предложенный список и разрешил несколько причин. В v1 причины равноправны, обязательной «главной» нет. |
| Дальнейшее действие | Шесть согласованных вариантов сохранены. Для полного цикла добавлены «Ждём ответа» и «Завершено — дальнейшее действие не требуется»; передача — событие смены владельца с выбором следующего действия. |
| Права | Любой активный участник может размечать и исправлять. Отдельных ролей и manager approval нет; общая аутентификация и tenant isolation сохраняются. |
| Страницы | Replies — инбокс и разбор; Sentiment Analysis — аналитика; Leads — полная база. Очередь не дублируется в Sentiment Analysis. Пользователь согласовал это разделение. |
| Аналитика | Покрытие разметкой, причины с переходом в Replies, состояние работы, раздельные временные определения. |
| Исторические данные | Рекомендация: сохранить старые AI-метки как legacy, не считать их ручными. Существующие manual-метки сохранить с признаком неизвестного автора, если его нельзя доказать. Историю можно разбирать отдельно. |

## Approach

### 1. Ручная классификация

Выделить общие компоненты переписки и разметки из ConversationDrawer. В Replies выбранное inbound message размечается в правой панели; в существующем drawer использовать те же компоненты и серверные операции. Поля: sentiment, несколько причин, необязательный комментарий, ручной P1/P2/P3/«нет коммерческого intent». Intent не требуется для сохранения sentiment: «ещё не оценён» отличается от явно выбранного «нет intent». Положительный sentiment не означает P3.

Причины обязательны при negative/objection; допустимо несколько уникальных значений:

| ID | Подпись |
| --- | --- |
| no_need | Нет потребности / неинтересно |
| timing | Не сейчас / неверный тайминг |
| budget | Нет бюджета / дорого |
| existing_solution | Уже есть поставщик или внутреннее решение |
| offer_fit | Не подходит продукт или предложение |
| wrong_person | Не тот человек / перенаправление |
| trust_information | Недоверие / недостаточно информации |
| do_not_contact | Не связываться / unsubscribe |
| other | Другое |

`other` требует комментария. Причины можно указать и при другом sentiment, например referral + wrong_person или positive + budget: тон и причина независимы. UI объясняет это коротким примером. При смене sentiment уже выбранные причины не исчезают молча; пользователь редактирует их при сохранении. Для каждого значения нужны краткое определение и пример, особенно для пересекающихся no_need/offer_fit и timing/budget.

Определения: negative — явный отказ; objection — препятствие или условие без окончательного отказа; positive — явно положительная реакция; neutral — содержательный ответ без этих сигналов; referral — направление к другому контакту; auto — автоматический ответ. При нескольких сигналах SDR выбирает основной смысл сообщения. «Нет потребности» означает отсутствие задачи/интереса, «Не подходит предложение» — конкретное несоответствие; «Не сейчас» — срок, «Бюджет» — денежное ограничение. «Неинтересно» без объяснения допустимо как no_need, без догадки о бюджете или конкурентах.

Разметка завершена, когда вручную выбран sentiment и выполнены требования к причинам/комментарию. Intent остаётся необязательным и имеет отдельное покрытие; отсутствие intent не удерживает сообщение в основной очереди. Для auto причины пустые, intent явно «не применимо»; при переводе сообщения в auto UI требует явно очистить несовместимые значения в том же сохранении. Причина do_not_contact требует установки флага запрета контакта в той же транзакции. Снятие причины само по себе этот флаг не снимает.

Действие по диалогу выбирается рядом, но хранится отдельно. «Сохранить» фиксирует разметку, «Сохранить и следующий» помогает последовательно читать очередь. Никакой массовой маркировки как прочитанного или автоматического заполнения категорий в v1.

### 2. Действия и существующий CRM

Встроить действия в существующие owner/follow-up/pipeline операции через одну серверную транзакцию. Не создавать второй независимый планировщик follow-up.

| Действие | Проверяемый результат |
| --- | --- |
| Нужен ответ (`needs_reply`) | Открытое действие, обязательный ответственный; прежняя дата follow-up отменяется с событием. Время ожидания видно, но без срока оно не называется просрочкой. |
| Follow-up позже (`follow_up`) | Обязательные владелец и дата не раньше сегодняшней по Europe/Madrid; existing follow-up — источник срока. Дата раньше текущего business day означает просрочку, сегодня — отдельную группу. |
| Передан другому | Обязательный активный получатель и выбор needs_reply/follow_up/awaiting_reply. Это событие передачи, а не взаимоисключающий с follow-up постоянный статус. |
| Ждём ответа (`awaiting_reply`) | SDR явно подтверждает, что ответ отправлен или ожидается следующий шаг собеседника; если нужен срок напоминания, выбирает follow_up. Synced outbound сам не закрывает работу и не считается доказательством выполнения SDR. |
| Завершено (`resolved`) | Нейтральное завершение для positive/neutral/referral/auto без следующего действия; доступно для любого sentiment, не означает сделку или отказ. |
| Закрыт — мягкий отказ (`closed_soft`) | Закрытое действие, возможно ручное возвращение; не создавать скрытый follow-up без даты. |
| Закрыт — окончательный отказ (`closed_hard`) | Закрытое действие, ручное возвращение сохраняет историю. |
| Не связываться | Явный флаг на диалоге, исключение из рекомендаций follow-up внутри дашборда. UI сообщает, что LH2 нужно остановить отдельно. Новый inbound не снимает этот флаг. |

Все закрытые действия и do_not_contact отменяют активный follow-up с audit event; owner сохраняется. DNC — отдельный устойчивый флаг поверх состояния: установка отменяет запланированный контакт; снять его может любой активный участник явным действием с комментарием. Пока флаг установлен, API блокирует needs_reply/follow_up/awaiting_reply и schedule/reschedule во всех dashboard entry points. Новое входящее можно разобрать и закрыть при сохранённом DNC.

Полный action enum: `needs_reply|follow_up|awaiting_reply|resolved|closed_soft|closed_hard`; NULL означает, что действие ещё не выбрано. Установка DNC записывает action=resolved плюс отдельный флаг; снятие флага требует явно выбрать следующий action и не восстанавливает старый срок. В сводке текущего состояния группы взаимоисключающие: сначала DNC, затем неподтверждённая inbound revision/NULL action, затем остальные action и календарные buckets follow_up. Общее количество неподтверждённых шагов дополнительно показывается отдельным индикатором, включая DNC; его не суммировать с группами состояний.

Классификация и выбор действия **не меняют CRM stage/substatus автоматически** на любом этапе. Existing negative soft_no/hard_no/lost остаются CRM-значениями; новые action states не проецируются в них. Если SDR хочет изменить CRM, он использует существующий явный picker на конкретном lead row, с campaign context; Lost сохраняет обязательный reason. Это устраняет откат переговоров и неоднозначное изменение всех кампаний одного диалога.

Владелец действий — `conversation_follow_up_state.owner_id`, даже для действия без даты; при первом назначении существующий lead owner может быть подсказкой, но требует сохранения. CRM assignment остаётся отдельным полем. В новой странице фильтр подписан «Ответственный за диалог»; новая передача обновляет именно conversation owner. Старые follow-up mutations обязаны менять соответствующий action state в общей транзакции: schedule/reschedule → follow_up; cancel/complete без следующей даты → resolved; с новой датой → follow_up; reassign сохраняет действие. Skip требует явного следующего действия. Нельзя позволять старому UI обходить DNC или оставлять расходящиеся состояния.

Новый inbound всегда создаёт необходимость разбора сообщения. Action state хранит `acknowledged_inbound_revision`: сервер увеличивает conversation inbound revision только при первом появлении inbound, не при re-sync. Различие revisions означает «Нужно подтвердить следующий шаг». Поздний импорт старого ответа также требует просмотра. Подтверждение шага записывает текущую revision и не удаляет прежнюю историю. Изменение старой категории само по себе не открывает завершённое действие; DNC — описанное выше исключение.

«Сохранить разметку» разрешено без действия и убирает завершённое сообщение из очереди разметки. Диалог остаётся в фильтре «Без подтверждённого следующего шага». Для «Завершить разбор диалога» должны быть разобраны все его новые сообщения и подтверждён шаг на текущую inbound revision. Сообщения, добавленные параллельно, не получают подтверждение заочно. Закрытие drawer ничего не сохраняет и не считается разбором.

### 3. Replies Inbox и Sentiment Analysis

**Replies** — отдельный маршрут `/replies`, пункт основной навигации рядом с Leads. Текущий legacy redirect `/replies` заменить страницей, сохранив поддержку существующих query-параметров через явное преобразование и тесты ссылок. **Sentiment Analysis** — `/sentiment-analysis`, рядом с Review. Обе страницы доступны всем активным участникам. Не переименовывать и не заменять Leads.

Replies использует трёхколоночный layout из референса, адаптированный к существующему оформлению дашборда:

| Область | Содержимое |
| --- | --- |
| Слева: список диалогов | Поиск по имени/компании/тексту, фильтры, avatar/name, snippet с направлением, время последнего ответа, аккаунт, ответственный, action badge и число неразобранных сообщений. Один `(instance_id, profile_url)` — одна строка. |
| Центр: переписка | История inbound/outbound с датами и отметками источника, выделение выбранного сообщения и переход к первому неразобранному. Заголовок показывает собеседника и LinkedIn-аккаунт, чтобы не спутать одинаковый профиль в разных аккаунтах. |
| Справа: разбор и действия | Разметка явно выбранного inbound с его датой и короткой цитатой, затем conversation owner/action/follow-up и данные лида. CRM picker показывает campaign context. |

В v1 нет composer, кнопки Send или имитации отправки. Есть ссылка на LinkedIn profile и существующий импорт истории через общий компонент. Переход в LinkedIn не отмечает задачу выполненной. История загружается страницами; состояние синхронизации видно рядом с перепиской, неизвестное не выдаётся за актуальное.

Основные views: «Все», «Не разобрано», «Нужен ответ», «Отложено», «Завершено». «Мои» — независимый переключатель по conversation owner, который сочетается с любым view. «Не разобрано» означает наличие незавершённой ручной разметки; открытие диалога не меняет этот признак. «Нужен ответ» = needs_reply без DNC; «Отложено» = follow_up; «Завершено» = resolved/closed_soft/closed_hard либо DNC. Awaiting_reply доступен через action filter во «Все». Дополнительные быстрые фильтры: «Без подтверждённого шага», «Без владельца»; отдельный счётчик просроченных follow-up открывает соответствующий scope. Эти views могут пересекаться, их счётчики не суммируются.

При первом входе открывается «Не разобрано», новые после cutoff, старые по first_seen_at первыми; legacy сортируется по sent_at. Для остальных views default sort — последний message sent_at DESC, со стабильным thread-key tie-break. Inbox «Все» включает диалоги хотя бы с одним inbound; outbound-only лиды остаются доступны в Leads. Прямая ссылка из Leads может открыть такую переписку с пустым состоянием «Ответов ещё нет», не добавляя её в reply counts.

Дополнительные фильтры: новые после запуска/исторические/все, account, campaign, action, sentiment, reason и поиск. Разбор одного сообщения не подтверждает остальные. Auto также размечается вручную и учитывается по контракту аналитики. «Сохранить и следующий» открывает следующее неразобранное сообщение текущего диалога, затем следующий подходящий диалог в активной очереди. Ошибка/конфликт не переключает выбор. Сохранённый диалог не исчезает из центра внезапно при обновлении списка: пользователь явно переходит дальше.

На узком экране показывается одна область: список → переписка → панель разбора, с возвратом к сохранённой позиции и фильтрам. При уходе с изменённой формой показать сохранение/отмену/возврат; посещение сообщения и простое закрытие ничего не сохраняют. Поля имеют подписи, выбор доступен клавиатурой, статусы не передаются только цветом.

Leads сохраняет существующие табличные фильтры, CRM и действия. Добавить «Открыть в Replies» на строке/в drawer с account-scoped thread key. Overview New Replies и ссылки из follow-up могут открывать тот же инбокс. Общие компоненты заменяют дублирование логики между drawer и инбоксом.

**Sentiment Analysis** содержит только следующие аналитические блоки; собственного workflow inbox на странице нет:

1. Покрытие: диалоги с inbound за период; разобраны полностью; содержат неразобранные ответы; доля разобранных сообщений. Отдельно показывает legacy AI и неоценённый intent.
2. Распределение всех sentiment, включая positive и neutral. Рядом число диалогов, по которым ещё нет ручного решения; неизвестные не распределяются пропорционально.
3. Причины отказа/возражения: горизонтальные бары «N диалогов · X%». При multi-select сумма долей может превышать 100%; каждая причина считает диалог только один раз.
4. Динамика sentiment и причин по неделям, в переключаемых абсолютных числах и долях. Показывать объём выборки и покрытие ручной разметкой, чтобы неполная неделя/разбор не выглядели улучшением качества.
5. Дальнейшая работа: без подтверждённого шага; нужен ответ; follow-up сегодня/позже/просрочен; ждём ответа; завершено; мягкий/окончательный отказ; не связываться. Передачи показывать отдельным событием/фильтром, не суммировать со статусами. Переход к диалогам по клику.
6. Сравнение аккаунтов и кампаний: объём ответивших, покрытие, доля negative/objection, наиболее частые причины. Без рейтинга SDR по негативу: аудитория и кампании различаются.

Общие фильтры аналитики: период ответа (по умолчанию сегодня и 29 предыдущих дней UTC), account, campaign, ответственный за диалог. Sequence-фильтр исключён из v1; кампаний достаточно. Sentiment/reason — локальные фильтры drill-down, чтобы выбор причины не превращал её общий процент в 100%. «Кто разметил» — локальный фильтр списка ручных решений, не фильтр покрытия (у неразобранных ответов автора нет). Каждый график открывает Replies с точным scope метрики, периодом и теми же базовыми фильтрами. Drill-down переопределяет default cutoff/view, чтобы количество строк совпадало с исходной метрикой, и показывает banner с условием отбора и возвратом в аналитику. Фильтр причины ищет сообщения по контракту «хотя бы одно за период», не по latest sentiment. Центр показывает полную переписку с выделением подходящих сообщений, включая контекст вне периода.

URL хранит inbox view, filters, metric scope, выбранные instance_id/profile_url и message_id; значения корректно кодируются. Browser back восстанавливает выбор и фильтры; история перехода между диалогами не засоряет back stack на каждое фоновое обновление. Недоступное/удалённое сообщение даёт явное состояние, не открывает другой диалог молча.

Конверсия после возражения отложена до второй итерации: она требует определённого окна созревания и исторического события первого возражения. Existing Review сохраняет message-level trend, получает подпись «Входящие сообщения, ручная разметка» и ссылку на Sentiment Analysis; новая страница считает диалоги по следующему контракту.

### 4. Контракт подсчётов

- Диалог: `(instance_id, profile_url)`. Один человек у двух LinkedIn-аккаунтов — два диалога. Lead rows нескольких кампаний не умножают число диалогов.
- Для распределения sentiment за период выбрать последнее inbound **в выбранном периоде**, после фильтра кампании, исключив лишь вручную подтверждённые auto. Если оно не размечено человеком, весь диалог попадает в «Последний ответ не разобран»; отката к более старой метке нет. При равных sent_at использовать message ID DESC. Если все inbound диалога в периоде — подтверждённые auto, он относится к «Только автоответы».
- Знаменатель долей sentiment — все диалоги с inbound в scope: positive + neutral + negative + objection + referral + последний ответ не разобран + только автоответы = 100%. Отдельная business rate negative/objection = диалоги с последним вручную negative/objection / диалоги с последним вручную размеченным non-auto; рядом показывать этот знаменатель и неполное покрытие. При нуле знаменателя показывать «—», не 0%.
- Для причин считать уникальные диалоги с данной причиной хотя бы на одном вручную разобранном negative/objection в периоде. Знаменатель — диалоги с вручную разобранным negative/objection в периоде. Это «причины, встречавшиеся за период», а не причины только последнего ответа. Причины при других sentiment доступны через отдельный явный фильтр с пересчитанным знаменателем.
- Weekly buckets применяют те же правила внутри недели: один диалог может встречаться в нескольких неделях; сумма недель не обязана совпадать с уникальным числом за весь период.
- Аналитический период основан на `messages.sent_at`, очередь и история правок — на собственных received/reviewed timestamps. Известное ограничение: LH2 timestamps могут отражать время action-run; пояснение существующего Review сохранить.
- Объём работы «сейчас» берётся из текущего action state для выбранной когорты диалогов и подписывается как текущее состояние, а не состояние на историческую дату.
- Сообщения без campaign_id входят в «Без кампании». Campaign attribution причины — кампания сообщения; не размножать её по всем lead rows профиля. Итоги по кампаниям могут пересекаться, если диалог отвечал в нескольких кампаниях.
- Исправление разметки пересчитывает исторические графики по текущей ручной версии. Audit хранит прежние версии; воспроизведение графика «как его видели тогда» вне v1.
- Полностью разобранный диалог — все inbound в выбранном scope имеют завершённую разметку; доля разобранных сообщений = завершённые inbound / все inbound, включая подтверждённые auto. Legacy AI считается неразобранным; legacy manual negative без причины — частично разобранным. Статус последнего ответа и полнота истории — разные колонки.
- Фильтры периода задаются полуоткрытым UTC-интервалом [начало первого дня, начало дня после последнего]. Неделя начинается в понедельник UTC. Сроки follow-up отдельно используют существующий Europe/Madrid calendar day.

Примеры приёмки подсчётов:

| Сообщения одного диалога в периоде | Sentiment distribution | Причины |
| --- | --- | --- |
| negative: budget+timing; затем positive | Один positive | Один диалог в budget и один в timing; каждый 100% при единственном негативном диалоге |
| positive; затем неразобранный inbound | Один «Последний ответ не разобран» | Нет причин |
| Два negative с budget | Один negative | Один budget, не два |
| Только вручную auto | Один «Только автоответы» | Не входит в знаменатель отказов |
| Manual negative без причины из legacy | Один negative, история не полностью разобрана | В знаменателе negative/objection; отдельный счётчик «Причина не указана» |

Причины отвечают на вопрос «что встречалось», sentiment — «каков последний ответ»; заголовки графиков должны это явно отражать.

### 5. Хранение и API

Фиксированная форма: `reply_reviews` (PK message_id, sentiment, intent state/level, comment, taxonomy_version, reviewed_by, reviewed_at, revision); `reply_review_reasons` (PK message_id + reason_id); append-only `reply_review_events`. Справочник фиксирован в версии `reply-reasons-v1`; IDs не переиспользуются, UI показывает русские/английские подписи по существующему языку интерфейса. Comment ограничен 1000 символами, причины уникальны и только из справочника.

`reply_reviews` — источник ручной истины. Существующие message sentiment/intent поля — совместимая проекция, обновляемая только в той же транзакции; все writes старого `/api/reclassify` направляются в общий новый сервис. `legacy_reply_classifications` сохраняет старые значения и provenance отдельно. Отсутствующая review row означает отсутствие ручного решения. Для legacy manual допускается unknown actor; новые записи всегда имеют authenticated actor. Отдельные provenance sentiment и intent сохраняются.

Расширить existing `conversation_follow_up_state` полями action, do_not_contact, acknowledged_inbound_revision и supporting message; использовать его owner/date/revision, не создавать конкурирующий action store. Revision поступления inbound хранить в отдельной conversation review projection, обновляемой в транзакции вставки сообщения. Новым сообщениям добавить серверный immutable `first_seen_at`; legacy получают отметку существования до cutoff, без выдуманной исторической даты поступления. Audit включает actor, предыдущие и новые значения, время. Actor определяется серверной сессией.

Сохранение разметки и явно выбранного действия атомарно: payload содержит expected review revision, expected workflow revision при изменении action, observed inbound revision при подтверждении шага и caller-stable mutation_id. Несовпадение любой обязательной revision возвращает 409 с актуальными значениями без частичной записи. Повтор того же mutation_id с тем же payload возвращает прежний результат; с другим payload — конфликт. Проверять направление inbound, tenant, существование и принадлежность message/thread, допустимые reason IDs и обязательные поля. Активный member может редактировать чужую разметку.

Для inbound без lead row ручная разметка и conversation action остаются доступны; identity берётся из message/thread. Новый endpoint не должен наследовать обязательный lead parameter старого UI; CRM picker отсутствует до появления lead row. Все read/write операции выполняются через существующий server dispatch, без новой верхнеуровневой Vercel-функции.

Чтения: отдельные ограниченные операции для counts/facets/trends и keyset-пагинируемой очереди/drill-down; thread detail подгружает разметку сообщений. Aggregates и списки используют один predicate builder. Учитывать source coverage во всех потребителях sentiment/P3: Leads, Overview, Review, briefing, AI schema, exports. Не допускать, чтобы удаление AI из новой страницы оставило AI-метки текущей истиной на других страницах.

### 6. Отключение AI и переход

1. Прекратить все sentiment/intent AI-вызовы и их записи на scheduled, manual-run и provider-fallback путях. Сохранить ручной endpoint. Demographics выделить в отдельную внутреннюю ветку существующего handler; проверить GET/POST.
2. Отключить sentiment-driven automatic pipeline triage, включая вызовы после классификации и фоновые вызовы. Явные ручные изменения сохраняются.
3. До перехода зафиксировать количество AI/manual/unclassified сообщений и intent-источники. Сохранить старые AI-значения в legacy history; не стирать и не представлять как ручные. Аналитика после перехода использует ручную проекцию. AI-only P3 виден как historical AI, не как подтверждённый вручную P3; прежние measured booking/milestone события сохраняются.
4. Старые ручные sentiment и intent мигрировать независимо: manual sentiment не доказывает manual intent. Не выдумывать actor. Negative без причин имеет незавершённую детализацию, хотя sentiment уже ручной.
5. Новые сообщения не получают sentiment до действия SDR. Новую очередь по умолчанию ограничить моментом запуска, исторический backlog сделать отдельным доступным фильтром. Для охвата использовать сохранённое время поступления/launch cutoff, включая поздно импортированные старые ответы; не полагаться только на sent_at.
6. Agent ingest, ручной import, delete и повторная синхронизация не перезаписывают разметку. При удалении сообщения текущая проекция исчезает, audit сохраняет допустимый tombstone и не раскрывает удалённое тело.
7. Порядок активации: additive schema → совместимый backend/UI в неактивном режиме → остановить admission AI reply jobs и дождаться/заблокировать записи уже начавшихся jobs → snapshot legacy → переключить все readers на manual-only → включить очередь с единым cutoff. Не должно быть окна, когда старый worker перезаписывает manual projection. Legacy pre-cutoff сообщения помечаются отдельно; поздно вставленные сообщения попадают в новую очередь по first_seen_at.
8. Поддержка providers: отключение AI обязательно в обоих путях. Новые review/workflow writes v1 включаются только для Neon tenant с новой schema capability. На Supabase fallback новый UI показывает недоступность, не пытается писать в отсутствующие таблицы; старый reclassify не должен обходить новую модель. Расширение Supabase schema вне v1, frozen migrations не трогать.
9. Rollback приложения после активации возможен только на совместимую manual-aware сборку, не на старую AI-writing версию. Новые данные и audit сохраняются; down migration отсутствует. Production rollout требует отдельного одобрения конкретного плана по operations contract; текущий документ — только план.

### 7. Технический контракт для реализации

#### 7.1. Стек и границы

Сохранить React/Vite, существующий router/navigation registry, Recharts, существующие UI primitives, `authPost`, `getDataStore()` и named operation registry. Не добавлять ORM, state-management библиотеку, queue broker, WebSocket, новый сервис или новую Vercel function. Новая функциональность работает в Neon с actor-scoped `app_runtime`; никаких browser SQL или service-role writes от имени SDR.

Проверенные точки расширения:

| Слой | Файлы и ответственность |
| --- | --- |
| Authenticated reads | `frontend/api/activity-daily.ts`: существующий `op` allowlist и parsers; `frontend/api/_lib/data/operations/index.ts`: регистрация named queries/commands. |
| Authenticated writes | `frontend/api/pipeline.ts`: новые action branches, повторяющие existing auth/provider resolution; orchestration в новом `_lib/neonReplyReviewWrites.ts`. |
| SQL operations | Новые `_lib/data/operations/replyReviews.ts` для чтений и `replyReviewWrites.ts` для SQL-команд. Команды не принимают клиентский SQL. |
| Транзакции | `frontend/api/_lib/data/contracts.ts`, `store.ts`, `neon.ts`: использовать существующий `DataStore.transaction`, пул и timeout; второй pool не создавать. |
| Existing workflow | `conversationWrites.ts` вызывает `apply_follow_up_action`; новая additive migration обновляет эту функцию и workflow constraints. `pipelineWrites.ts` и `_lib/neonWrites.ts` сохраняют существующие операции. |
| Browser reads | `frontend/src/lib/dashboardReads.ts`: typed wrappers новых read operations; query/lifecycle hooks отдельно, не расширять глобальный DataContext до полной загрузки всех сообщений. |
| Browser writes | Новый `frontend/src/lib/useReplyReviewActions.ts`; existing `useFollowUpActions.ts` получает согласованные результаты workflow. |

HTTP writes: `POST /api/pipeline` с `action=save_reply_review` (message review + optional workflow), `action=set_reply_workflow` (только действие/owner/DNC), `action=activate_manual_reply_review` (операторский cutover, admin-only и не показывается SDR). Последний action только завершает заранее одобренный rollout, не применяет schema; обычные Luna-задачи его не вызывают на production. Existing `/api/reclassify` делегирует в этот же внутренний service, не делает внутренний HTTP запрос и не имеет самостоятельного write-path. Его UI callers должны передавать revisions и mutation_id; запрос без них после cutover получает 409 `review_refresh_required`.

HTTP reads: existing activity endpoint с `op=replies.capabilities|replies.inbox|replies.thread|replies.analytics|replies.reviewHistory`. Эти же имена зарегистрировать в operation vocabulary; capabilities требует authenticated actor. Для route shell при необходимости добавить `replies` и `sentiment-analysis` в обе route-snapshot vocabularies, возвращая только bounded metadata. Новые страницы не запрашивают старый all-history snapshot.

#### 7.2. Модель данных и целостность

Следующий ledger step на момент проверки — 017; рабочее имя `017_manual_reply_review.sql`. Перед созданием сверить manifest: если номер занят, использовать следующий, не переписывать существующий. Все поля ссылок повторяют реальные типы referenced PK (messages.id, users/team_members IDs); не объявлять UUID для всех идентификаторов по умолчанию.

| Объект | Обязательные поля/ограничения |
| --- | --- |
| `reply_reviews` | message_id PK/FK с ON DELETE CASCADE; sentiment enum из текущих шести значений; intent_state=`unreviewed|none|level|not_applicable`; intent_level=p1/p2/p3 только при level; comment ≤1000; taxonomy_version; reviewed_by nullable только для legacy; provenance=`human|legacy_manual`; reviewed_at; revision >0. |
| `reply_review_reasons` | message_id FK к review с cascade; reason_id CHECK по девяти IDs; составной PK. `other` требует непустой comment; negative/objection требует минимум одной причины для новых saves, legacy incomplete допускается только миграцией. |
| `reply_review_events` | event ID, thread identity, message_id nullable ON DELETE SET NULL, original_message_id без FK, actor/provenance, before/after JSON только полей разметки, event time, mutation_id. Никаких копий body сообщения. Append-only для runtime. |
| `reply_review_mutations` | mutation_id PK в tenant DB; actor ID, canonical payload hash, result JSON, committed_at. Replay проверяет actor и hash. В v1 не удалять записи автоматически. |
| `conversation_reply_review_state` | PK(instance_id, profile_url), inbound_revision >=0, timestamps. Это счётчик поступления, не второй owner/action store. |
| `conversation_follow_up_state` extension | action nullable с шестью значениями выше; do_not_contact boolean NOT NULL DEFAULT false; acknowledged_inbound_revision >=0; supporting_message_id nullable ON DELETE SET NULL. Existing owner/date/revision остаются canonical. |
| `messages` extension | first_seen_at nullable для legacy, DEFAULT clock_timestamp() для новых вставок; immutable после вставки. NULL трактуется как существовавшее до включения capture. Existing updated_at не использовать как first_seen. |
| `legacy_reply_classifications` | snapshot по message_id, отдельные sentiment/intent values и model/timestamps, snapshot_at; actor не угадывать. Таблица не используется текущими метриками. |
| `reply_review_settings` | singleton, schema_version, mode=`prepared|manual`, capture_started_at, activated_at. Серверная capability и DB guard читают этот источник; browser feature flag не является защитой. |

Ручной intent может быть сохранён до sentiment: legacy/mixed case представлен review row с nullable sentiment; `complete=false` до ручного sentiment и выполнения причин. Это конкретизация nullable sentiment относительно описания выше, не потеря уже существующего manual intent. `intent_state=not_applicable` допустим только с auto; для auto обязателен именно этот state.

Первоначальные existing follow-up rows: с активной датой → action=follow_up; без даты → action=NULL; DNC=false; acknowledgement=0. Не объявлять историческую работу завершённой автоматически. Legacy review rows и source mappings заполняются при cutover, а не при обычном первом открытии страницы.

RLS: active tenant member читает/пишет reviews и workflow, actor проверяется сервером и policy. Actor ID берётся из canonical identity, owner_id — из roster того же provider. Machine/system не имеют доступа к ручным labels; узкие trigger-права для inbound revision не предоставляют им общий UPDATE workflow/reviews. На service operations и schema preflight действуют существующие admin/operations boundaries.

#### 7.3. Транзакции, ingest и cutover

Порядок каждой review/workflow транзакции: resolve authenticated actor → capability check → existing thread advisory lock → replay lookup → revision validation → review/reasons/projection → explicit workflow change → audit → replay result → commit. Для изменений только workflow review row не трогать. Блокировку использовать **точно как existing import/follow-up**: `pg_advisory_xact_lock(hashtextextended(jsonb_build_array(instance_id, profile_url)::text, 0))`. Не вводить отдельную lock namespace. Несколько threads в bulk ingest блокировать в стабильном sorted порядке; тест на concurrency/deadlock обязателен.

Новая BEFORE INSERT логика сериализует поступление inbound на том же thread lock; AFTER INSERT увеличивает revision только для действительно вставленных строк. `ON CONFLICT UPDATE/DO NOTHING` revision не увеличивает. По body/direction нормализацию и существующий import dedup не менять. При UPDATE body/direction/sent_at уже размеченного сообщения инвалидировать ручную разметку в audit и вернуть его на разбор; semantic no-op update её сохраняет. Изменение identity существующего message отклонять, использовать existing supported import/delete flow. Ingest, manual edit/delete и review используют согласованный порядок блокировок. Удаление supporting message не стирает action/DNC и не уменьшает inbound revision.

DB-level guard в mode=manual отклоняет попытку восстановить AI sentiment/intent/classified metadata даже от старого worker. Manual service записывает compatibility projection согласованно с review row; runtime не обходит правило простым `classified_model='manual'` без соответствующего review. Existing ingest upserts сохраняют classification columns. Сценарий «AI started до cutover, UPDATE после cutover» должен завершиться отказом без изменения проекции.

Cutover идемпотентен: mode=prepared доступен только совместимому backend; admission reply-AI выключается до snapshot. Под блокировкой settings snapshot сохраняется один раз, legacy manual sentiment/intent выводятся независимо по подтверждённым provenance, остальные current compatibility fields очищаются, mode=manual активируется. Большие tenants мигрируются возобновляемыми пакетами с прогрессом; readers не переключаются на частично заполненную проекцию. Во время финального перехода manual mutations получают retryable unavailable, не partial success. Повтор activation с тем же mutation ID безопасен. Schema apply всегда через operations contract; AI для demographics продолжает отдельную ветку existing cron.

#### 7.4. Payload и read contracts

`save_reply_review`: `{action, mutation_id, instance_id, profile_url, message_id, expected_review_revision, review:{sentiment,intent_state,intent_level,reason_ids,comment}, workflow?:{expected_revision,observed_inbound_revision,action,owner_id,next_follow_up_date,do_not_contact,change_reason}}`. Отсутствующий workflow означает «не менять», а не очистить. Новый review использует expected_review_revision=0. `set_reply_workflow` использует тот же workflow object без review. Server timestamp/actor не принимаются из payload.

Success: `{review,workflow,inbound_revision,needs_action_confirmation,mutation_id}`; UI применяет возвращённые canonical значения и инвалидирует inbox/analytics. Ошибки: 400 invalid input; 401/403 auth; 404 unknown thread/message; 409 revision/replay conflict с текущими версиями; 503 feature/schema unavailable. Legacy AI имеет отдельный read-only history response, не предзаполняет picker.

Inbox request: view, scope=`new|historical|all`, account/campaign/owner, action/sentiment/reason, query, cursor, limit (default 50, max 100), optional metric_scope и UTC date bounds. Cursor кодирует сортировку + tie-break и fingerprint фильтров; чужой scope cursor → 400. Response: `{items,next_cursor,facets,scope}`; item включает thread identity, latest snippet/direction/time, selected candidate message_id, pending count, owner/action/due/DNC, revision. Full body не входит в list payload.

Thread request: instance_id/profile_url, optional focus_message_id, cursor, limit (50/100). Первый response возвращает bounded окно вокруг focus или последних сообщений с cursors older/newer; интерфейс не загружает весь thread ради перехода к старому ответу. Review history пагинируется отдельно.

Analytics request содержит только базовые фильтры и UTC bounds. Response: coverage, sentiment buckets, reasons, weekly trend, workflow buckets, bounded account/campaign comparison и dataset timestamp. Каждая метрика возвращает numerator/denominator и typed drill-down scope, а не только вычисленный процент. Списки и aggregates используют один SQL filter builder в `replyReviews.ts`, все values параметризованы. Не применять reasons filter раньше формирования знаменателя.

Поиск v1 — server-side case-insensitive literal match по имени/компании и EXISTS(body) в scoped messages; `%`/`_` экранируются как литералы, ввод ≤200 символов, debounce 300 ms. Не вводить внешний search engine. Проверить EXPLAIN на representative dataset; если substring search не укладывается в текущий timeout, добавить pg_trgm индексы отдельной частью той же additive migration при доступной extension, иначе ограничить поиск именем/компанией с явной подписью и отразить отклонение в handoff. Нельзя молча сделать вид, что поиск по body работает.

Базовые индексы: messages thread+sent_at+id, inbound first_seen для очереди, reasons(reason_id,message_id), events(thread,time,id), workflow(action,date,owner) по реальным predicate. Reuse существующих индексов до добавления дублей. Для analytics snapshots использовать согласованное чтение в одном SQL statement либо transaction с согласованным snapshot; не выдавать counts разных конкурентных состояний как один результат.

#### 7.5. Frontend architecture

- `src/lib/replyReview.ts`: types, labels, validation helpers, URL scope codec (без SQL/auth); API enum/schema в `_lib/replyReview.ts`. Не импортировать browser runtime в API; parity test фиксирует enums обоих TS roots.
- `src/lib/useRepliesInbox.ts`: URL state, paginated list, abort stale requests, selected thread; `useReplyReviewActions.ts`: saves/revisions/conflicts/cache invalidation. Использовать текущие React hooks, не устанавливать query library ради этой фичи.
- `src/components/conversation/ConversationThread.tsx`: presentational messages/focus/pagination, общая для drawer и inbox; `ReplyReviewPanel.tsx`: selected-message form; `ConversationActionPanel.tsx`: owner/action/follow-up. Existing import UI переиспользуется, не копируется parser.
- `src/pages/Replies.tsx`: layout и composition; `src/pages/SentimentAnalysis.tsx`: aggregate charts/drill-down links. Ни один page component не рассчитывает итоговые counts по загруженным 50 строкам.
- Cache key включает весь scope и thread identity; смена аккаунта отменяет старый request. После save сохранять selection до явного next. Доступность старого drawer не зависит от наличия нового route в истории браузера.
- Polling: использовать existing refresh cadence и refresh при focus; realtime transport вне задачи. Показывать loading/error/empty/stale состояния. Фото получать текущим signed-photo механизмом.

### 8. Handoff: SOL orchestrator → Luna workers

Этот раздел — инструкция следующей реализации, не команда текущему агенту запускать кодирование. SOL отвечает за архитектурную целостность, интеграцию и итоговую проверку. Код пишут Luna workers (`gpt-5.6-luna`); использовать tool-supported identifier, не угадывать алиас, если имя недоступно. Назначать bounded subtasks с явным ownership и сообщением: «Вы не одни в репозитории; не отменяйте чужие изменения, учитывайте общие контракты». Не создавать отдельные пользовательские tasks вместо subagents без запроса пользователя.

SOL начинает с AGENTS.md/CLAUDE.md, этого документа, git status и актуальных touched modules. Проверяет drift кода, manifest и API signatures; не проводит повторное продуктовое проектирование. Сохраняет существующие изменения, включая tsbuildinfo и чужие specs. Разрешены мелкие адаптации к фактическим интерфейсам, но изменение семантики, scope, provider support или формул записывается как отклонение и не маскируется под «implementation detail».

| Пакет Luna | Exclusive ownership | Результат / зависимость |
| --- | --- | --- |
| A — Schema и lifecycle | Новый SQL step, его ledger entry, dedicated clean-room tests | Tables/constraints/RLS, existing follow-up function extension, inbound revisions, guards. Старт после фиксации DTO; B использует этот контракт. |
| B — Backend | Новые `_lib/replyReview.ts`, `neonReplyReviewWrites.ts`, operations/replyReviews.ts и replyReviewWrites.ts, dedicated API tests | Typed queries/commands, orchestration и DTO. Не редактирует общие registries/handlers, отдаёт интеграционный список SOL. |
| C — Inbox UI | Новые frontend hooks, conversation components, Replies.tsx, dedicated UI tests/styles | Работает по DTO с fixtures. Не редактирует App/navigation/DataContext или существующий drawer, передаёт integration patch instructions. |
| D — Analytics UI | SentimentAnalysis.tsx, новые charts и их tests | После готовности shared types от C и aggregate DTO от B; reuse canonical scopes. |
| E — Cutover/compatibility | classify.ts и dedicated classification tests, consumers по заранее выданному SOL списку | После A/B; отключение AI, old reclassify delegation, manual-only consumers. Не пересекается с активным ownership остальных. |

При лимите 4 concurrent slots держать SOL + максимум 3 Luna. Первая волна A/B/C после согласования интерфейсов; вторая D/E и исправления A/B/C по завершении соответствующих владельцев. Dependency-ready не означает запуск всех пакетов сразу. Не давать двум workers один файл одновременно.

SOL владеет integration files: `operations/index.ts`, `activity-daily.ts`, `pipeline.ts`, `App.tsx`, `navigation.ts`, `dashboardReads.ts`, `DataContext.tsx`, существующий `ConversationDrawer.tsx`, routeSnapshots и shared tests. При требовании «код пишут Luna» SOL поручает эти файлы одному отдельному Luna integration worker после завершения пакетов; SOL делает review, проверку и координацию, не распределяет эти файлы между параллельными исполнителями. Worker не коммитит общий worktree самостоятельно; SOL создаёт scoped logical commits после проверки.

Каждый пакет сдаёт: изменённые файлы; принятые DTO/SQL контракты; команды и результаты проверок; незавершённое; требуемые integration edits. «Готово» без проверяемых результатов не является handoff. SOL передаёт исправления исходному owner и не принимает дублирующую реализацию поверх первой.

Порядок сборки результата: DTO/enums → schema+backend+inbox → integration routes/registries → analytics+cutover consumers → full integration verification. Фазы можно тестировать отдельно, но production release выполняется совместимой единицей с описанным cutover. Не выкатывать промежуточный backend, который очищает AI-метки до готовности ручного UI.

Финальные локальные checks из `frontend/`: `npm run build`, `npm run typecheck:api`, targeted `npm test -- <реальные пути тестов>`. Скрипт typecheck:api присутствует в текущем package.json и нужен для новых server modules. `npm run test:neon` и `npm run test:cleanroom` запускать только с разрешённым disposable test DB/существующим harness; production connection не подставлять. Если окружения нет, указать gate как непроверенный, не объявлять SQL готовым к production. SOL проверяет drawer regression, filters/drill-down parity, parallel update conflict, old worker guard, DNC через старые follow-up controls, shared-profile accounts и mobile layout.

Итоговый handoff SOL: commits; завершённые пункты DoD; реальные результаты tests/build/visual QA; schema capability/cutover status; известные отклонения; отдельный конкретный release plan по operations contract. Завершение локальной реализации не означает deployment или authenticated live proof. Новые зависимости, composer/send, AI reply suggestions, самостоятельные CRM transitions и переработка Leads за пределами ссылок/общих компонентов не входят в разрешённый scope.

## Implementation phases

1. **S — Зафиксировать контракты тестовыми fixtures.** Превратить правила этого документа в сценарии: отсутствие автоматической смены CRM, единый workflow state, revisions, provenance и приведённые формулы. Продуктовые решения не откладывать на эту фазу.
2. **L — Additive schema и операции.** Ручная разметка, причины, audit, revisions поступления/разметки/workflow, интеграция existing follow-up commands, агрегаты, очередь, permissions; ledger и clean-room проверки. Проверяется независимо от UI.
3. **M — Выключение AI и legacy-переход.** Все entry points и provider branches, совместимые проекции, read consumers, fixtures старых manual/AI intent. Верифицируемое отсутствие model calls для replies.
4. **L — Replies Inbox и SDR UI.** Выделить общие thread/review компоненты из drawer; построить отдельный трёхколоночный инбокс с mobile navigation, поиском, пагинацией, views, owner/action/follow-up и «сохранить и следующий». Обновить `/replies` redirect, ссылки Leads/Overview, права и обработку конфликтов.
5. **M — Аналитика.** Отдельный маршрут, server aggregation, покрытие, причины, trends, текущая работа, account/campaign comparison и переходы в точный scope Replies; согласование Review.
6. **M — Интеграционная проверка и release handoff.** Build, meaningful API/schema/metric tests, визуальная проверка desktop/mobile, dataset parity; отдельный deploy plan и live verification после одобрения.

## Affected files/modules

- `frontend/api/classify.ts`, `frontend/api/_lib/data/operations/aiWrites.ts`, все вызывающие auto-triage пути; `frontend/vercel.json` только если потребуется адаптация dispatch.
- `frontend/src/components/ConversationDrawer.tsx`, `frontend/src/pages/LeadsExplorer.tsx`, существующие pipeline/follow-up/owner UI и API.
- `frontend/src/pages/Replies.tsx` и `frontend/src/pages/SentimentAnalysis.tsx` (new), общие conversation/review компоненты, inbox list/category picker/charts и агрегаты.
- `frontend/src/components/overview/NewReplies.tsx`, ссылки в Leads/Follow-ups; сохранить drawer для существующих сценариев с общими компонентами.
- `frontend/src/App.tsx`, `frontend/src/lib/navigation.ts`, `types.ts`, `leads.ts`, `review.ts`, `dashboardReads.ts`, `DataContext.tsx`.
- `frontend/api/activity-daily.ts`, `frontend/api/_lib/data/operations/routeSnapshots.ts`, `messages.ts`, `leads.ts`; новая operation module в существующем registry/dispatch.
- `frontend/api/_lib/core.ts` (`SCHEMA_DOC`), `briefing.ts`, связанные exports и P3 metric consumers.
- Новый numbered SQL step в `postgres/tenant-baseline/v1/`, ledger manifest и соответствующие clean-room/schema assertions. Старые published steps неизменны.
- Существующие tests классификации, навигации, dashboard reads, pipeline/follow-up, agent ingest, auth и новые fixtures статистики.

## Risks & how to verify

- **AI продолжает писать в обход UI:** тесты scheduled/manual/fallback entry points с запретом reply model invocation; demographics остаётся работоспособным.
- **Смешение legacy и manual:** fixtures manual sentiment + AI intent, AI-only P3, unknown author, negative без причин; проверить все current read consumers.
- **Двойной счёт:** несколько сообщений, причин, кампаний, одинаковые sent_at, один профиль у двух аккаунтов, null campaign; counts совпадают с drill-down и контрактом знаменателей.
- **Потеря работы SDR:** concurrent saves возвращают конфликт; retry не дублирует events; ingest не затирает labels; новое inbound создаёт pending, сохраняя действие.
- **Расхождение workflow:** перевод owner, просрочка, soft/hard closure, глубокий pipeline и do-not-contact проверяются сквозными сценариями. DNC не считается внешней остановкой LH2.
- **Права:** active member CRUD своей/чужой разметки; inactive/anonymous/другой tenant отклоняются; audit actor не подменяется.
- **Производительность:** aggregate queries ограничены выбранным периодом и indexed keys; queue/detail пагинируются; проверить планы запросов и отсутствие полного history download при первом открытии.
- **UI:** клавиатура, multi-select, видимый статус сохранения/ошибки, длинные причины, пустые/неполные данные, mobile layout, URL filters и возврат из drawer.
- **Inbox routing и parity:** прежние `/replies` ссылки, аккаунты с одним и тем же профилем, direct link к outbound-only диалогу, browser back, несохранённая форма, новый inbound во время чтения, metric drill-down без default cutoff. Открытие диалога не снимает pending; число уникальных результатов drill-down совпадает с графиком.
- Проверки реализации: обязательный `npm run build` после TS, существующие релевантные тесты плюс перечисленные риск-сценарии. Проверка документа не требует frontend build.

## Definition of done

- Все новые sentiment, intent и причины replies назначаются только активным человеком; AI reply classification не вызывается ни одним поддерживаемым entry point.
- SDR может разобрать любой inbound, назначить несколько причин и action, исправить решение, увидеть автора/время и конфликт правки.
- Очередь показывает неразобранные сообщения независимо от старого AI-sentiment; historical backlog доступен отдельно.
- Follow-up, передача, closure и do-not-contact имеют проверяемое поведение внутри дашборда и согласованы с текущим workflow.
- Replies — отдельный responsive inbox со списком, перепиской и ручной разметкой; Leads остаётся полной базой. Общие компоненты используются и в ConversationDrawer.
- Sentiment Analysis включает покрытие, все sentiment, multi-reason statistics, weekly trends, текущую работу и разрезы, ведущие в точно отфильтрованный Replies. Дублирующей очереди на странице аналитики нет.
- Формулы, периоды, provenance и единицы счёта совпадают между агрегатами и списками; multi-select percentages подписаны корректно.
- Legacy AI не считается ручной разметкой, старые человеческие решения сохранены без выдуманной атрибуции.
- Additive migration и релевантные тесты проходят; визуальная проверка выполнена. Реализация завершается scoped commits с хешами; deployment и authenticated live proof указываются отдельно.
