# Managed company workspaces

## Goal

Превратить текущий dashboard в управляемый сервис для 3–5 внешних компаний. Каждая
компания получает собственный dashboard на поддомене владельца сервиса, физически
изолированные Supabase/Postgres/Auth/Storage, отдельные credentials и собственные
Linked Helper 2 instances, при этом исходный репозиторий, инфраструктурные аккаунты,
релизы и обновления остаются под контролем владельца сервиса.

Владелец управляет инфраструктурой командами из Codex через локальный owner-only
MCP server: сначала получает проверяемый план операции, затем подтверждает ее
выполнение. Администратор компании получает приглашение в уже подготовленный
workspace и дальше сам приглашает сотрудников. Агенты на Windows и macOS
устанавливаются сотрудниками клиента по инструкции, отправляют данные через
ограниченный ingest API и получают централизованные проверяемые обновления.

## Non-goals

- Shared-database multi-tenancy с `workspace_id` во всех бизнес-таблицах в первой
  итерации.
- Один Vercel runtime, который динамически подключается к разным Supabase-проектам.
- Supabase Dashboard, SQL-доступ, service-role keys, Vercel-доступ или доступ к
  репозиторию для клиентов.
- Полный self-service: самостоятельная регистрация новой компании, выбор тарифа,
  оплата и автоматическое создание инфраструктуры без участия владельца.
- Отдельная web control panel для platform owner в первой итерации. Операторским
  интерфейсом является локальный MCP в Codex; CLI остается аварийным fallback.
- Remote Streamable HTTP MCP, доступ из Codex cloud и работа нескольких операторов.
  Это отдельный будущий этап с OAuth, серверным secret store и усиленным RBAC.
- Физическое удаление Supabase/Vercel-проектов через MCP. MCP может подготовить
  offboarding-план и приостановить tenant, но delete остается ручной break-glass
  операцией вне MCP.
- Custom domains и индивидуальная функциональная ветка продукта для каждого клиента.
- Client-admin UI для Slack, Airtable, AI и других серверных секретов; в первой
  итерации их настраивает владелец сервиса.
- Абсолютная секретность кода, который выполняется на чужом устройстве. Браузерный
  JavaScript можно исследовать через devtools, а локальный агент — извлечь или
  декомпилировать даже после упаковки в executable. Защита строится на минимальных
  правах credentials, серверной валидации, аудите и возможности отзыва, а не на
  невозможности увидеть клиентскую часть кода.
- Перенос существующих клиентов между Supabase-проектами без отдельного проекта
  миграции данных.

## Research findings

- Сейчас один Supabase project является фактической границей workspace: вся схема,
  Auth, Storage, RLS, cron jobs, service-role API и Vercel deployment настроены на
  один URL и один набор ключей. В бизнес-таблицах нет `workspace_id`.
- Браузер читает Supabase напрямую через `frontend/src/lib/supabase.ts` и
  `frontend/src/lib/DataContext.tsx`. Это совместимо с выбранным решением: клиент
  видит публичный Supabase URL и publishable/anon key, но RLS ограничивает доступ
  активными участниками только его физически отдельного проекта.
- Текущая Auth-модель уже почти соответствует workspace-модели: `team_members`,
  роли `admin/member`, защита последнего администратора, invite/recovery flow и
  страница Team могут использоваться без cross-tenant переделки.
- Текущая RLS разрешает каждому активному участнику видеть все строки проекта.
  При отдельном проекте на компанию это правильная семантика; при общей базе она
  была бы недостаточной и потребовала бы tenant scope во всех таблицах, views,
  функциях, storage policies, foreign keys и уникальных ключах.
- AI SQL runner, serverless handlers, scheduled classification/briefing/notification
  jobs и deployment-wide интеграционные секреты сейчас предполагают одну компанию.
  Физически отдельные проекты уменьшают blast radius и позволяют сохранить эту
  модель.
- Главная проблема sync-agent: `config.yaml` содержит Supabase service-role key,
  который полностью обходит RLS. Такой ключ нельзя устанавливать на компьютеры
  внешних компаний. Агент должен работать через owner-controlled ingest API с
  отдельным отзывным credential для каждой машины.
- В агенте уже есть полезная основа: идемпотентные upsert, retries, remote config,
  health telemetry, version reporting, atomic self-replacement и безопасный отказ
  при schema drift.
- Текущий self-update проверяет hash, размер и синтаксис скачанного `agent.py`, но
  не удостоверяет издателя, не защищает от rollback/freeze attacks и не поддерживает
  canary channels. Перезаписываемый `latest` также нельзя безопасно координировать
  с разными schema versions клиентских баз.
- Текущий `frontend/api/mcp.ts` — tenant-local аналитический MCP, работающий с одной
  клиентской БД. Его нельзя превращать в инфраструктурный control plane: у него
  другая trust boundary, auth-модель и blast radius. Owner MCP должен быть отдельным
  локальным процессом и не входить в клиентские Vercel deployments.
- Исторический migration catalog нельзя применять новому клиенту как tenant
  bootstrap без фильтрации. Он содержит внутренний seed `Web 2 Mob`, последующие
  изменения этого ICP и cleanup конкретного `notebook-1:4`. Новым проектам нужен
  schema-only baseline без внутренних данных; будущие общие migrations должны
  накатываться поверх явно записанной baseline version.
- `VITE_SUPABASE_URL` и `VITE_SUPABASE_ANON_KEY` статически встраиваются Vite во
  время build. Поэтому разные Supabase projects означают отдельный build каждого
  tenant из одного и того же Git commit, а не один общий готовый frontend artifact.
- Сейчас в `frontend/api/` уже 12 top-level serverless functions. Добавление набора
  `/api/agent/*` должно учитывать фактический Vercel plan/framework limit:
  предпочтительно один multiplexed agent handler и обязательный deployment preflight.
- Vercel Function ограничивает request и response body 4.5 MB. Ingest нельзя
  проектировать только в «строках по 500»: нужны byte-size chunking, protocol
  version и resumable idempotency:
  [Vercel Function limits](https://vercel.com/docs/functions/limitations).
- Supabase production Auth требует отдельной настройки `SITE_URL`, redirect allowlist,
  templates и custom SMTP для каждого проекта. Default SMTP не предназначен для
  production, не отправляет произвольным внешним адресам и имеет очень низкий limit:
  [Supabase custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp) и
  [redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls).
- Supabase project creation требует owner organization, generated database password
  и явный region selection; plan/compute и backup policy влияют на стоимость и
  надежность. Эти значения должны быть частью onboarding plan или его блокирующих
  prerequisites:
  [Supabase Management API](https://supabase.com/docs/reference/api/getting-started).
- Current Auth schema знает только `admin/member`, а обычный Team invite endpoint
  уже требует существующего app admin. Значит, первый company admin и отдельный
  platform support principal должны создаваться bootstrap-операцией MCP через
  server-side credentials, а не через текущий пользовательский endpoint.
- Public `lead-photos` bucket публикует зеркальные копии аватаров по предсказуемому
  пути `<instance_id>/<slug>.jpg`. Для внешних компаний bucket должен стать private
  до первого production onboarding; факт публичности исходной LinkedIn-фотографии
  не заменяет access policy нового хранилища.
- Локальный MCP дает безопасный on-demand control surface, но не является
  always-on monitor: при выключенном Mac он не может обнаруживать stale agents,
  failed crons или outages. Постоянные alerts должны исходить из tenant-local
  production jobs или внешнего uptime monitor.
- Self-update внутри самого `agent.py` не может гарантированно откатиться, если
  новая версия вообще не стартует. Для проверяемого rollback нужен отдельный
  минимальный launcher/updater с A/B slots и watchdog, который обновляется реже,
  чем основной agent payload.
- Codex Desktop поддерживает локальные STDIO MCP servers, project-scoped
  `.codex/config.toml`, allowlist tools и default/per-tool approval modes. Режим
  `writes` запрашивает подтверждение для tools, не помеченных read-only:
  [Codex Model Context Protocol](https://learn.chatgpt.com/docs/extend/mcp).
- Codex использует sandbox и approvals как разные защитные слои. Side-effecting
  MCP tools должны честно объявлять эффекты, а destructive calls требуют approval;
  при этом annotations не заменяют серверную авторизацию и валидацию:
  [Agent approvals & security](https://learn.chatgpt.com/docs/agent-approvals-security).
- Официальная MCP schema поддерживает `readOnlyHint`, `destructiveHint`,
  `idempotentHint`, `openWorldHint` и `outputSchema`. Эти annotations помогают
  клиенту выбрать approval policy, но не являются security boundary:
  [MCP schema](https://modelcontextprotocol.io/specification/2025-11-25/schema).
- Supabase project является отдельной границей Postgres, Auth, Storage и API.
  Проекты можно создавать и обслуживать через
  [Management API](https://supabase.com/docs/reference/api/create-a-project),
  [Terraform provider](https://supabase.com/docs/guides/deployment/terraform) и
  общий каталог [database migrations](https://supabase.com/docs/guides/deployment/database-migrations).
- Publishable/anon key допустим в браузере только с корректным RLS, а secret и
  service-role keys нельзя передавать клиенту:
  [Supabase API keys](https://supabase.com/docs/guides/getting-started/api-keys) и
  [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security).
- Отдельный Supabase project имеет собственный compute и регулярную стоимость.
  Для ожидаемых 3–5 компаний это приемлемый обмен на сильную изоляцию, но стоимость
  должна входить в цену обслуживания:
  [Supabase compute usage](https://supabase.com/docs/guides/platform/manage-your-usage/compute).
- Несколько Vercel projects могут использовать одну кодовую базу и иметь собственные
  domains/env vars. Поэтому общий релиз можно раскатывать на все клиентские проекты,
  сохраняя отдельные runtime credentials:
  [Vercel Projects](https://vercel.com/docs/projects) и
  [Environment variables](https://vercel.com/docs/environment-variables).
- Для agent updates нужен подписанный versioned manifest, immutable artifacts,
  expiry, rollback protection и pinned public key. Это соответствует модели
  [The Update Framework](https://theupdateframework.io/docs/overview/); полную TUF
  реализацию можно заменить узким подписанным manifest для первой production-версии,
  не отказываясь от обязательных свойств безопасности.

## Decisions

1. **Доступ к Supabase.** Клиент не получает Supabase Dashboard, SQL credentials,
   secret/service-role keys или доступ к инфраструктурному аккаунту. Браузеру
   разрешено обращаться к Supabase API с публичным ключом и RLS.
2. **Изоляция.** У каждой компании отдельный Supabase project с собственными
   Postgres, Auth, Storage и API. Все проекты принадлежат владельцу сервиса.
3. **Масштаб.** Целевой горизонт — 3–5 компаний. Поэтому приоритет отдается сильной
   изоляции, понятному runbook и полуавтоматическому provisioning вместо раннего
   строительства сложной multi-tenant control plane.
4. **Роли.** Используются `platform owner`, `company admin` и `member`.
   Platform owner управляет инфраструктурой и имеет support-доступ; company admin
   приглашает/отключает сотрудников своего workspace; member пользуется dashboard.
5. **Адреса.** На старте каждая компания получает поддомен владельца сервиса,
   например `acme.dashboard.example.com`. Общий дизайн и общая функциональная версия.
6. **Установка агента.** Поддерживаются Windows и macOS. Клиент устанавливает агент
   самостоятельно по подготовленной инструкции и использует одноразовый enrollment
   code или установочный bundle, предназначенный для конкретного instance.
7. **Обновления.** Обновления автоматические, подписанные и поэтапные: внутренний
   instance владельца → canary instance → остальные компании. Должны быть
   совместимость со schema version, отзыв credential и rollback на last-known-good.
8. **Операторский интерфейс.** Provisioning, releases, status и безопасные
   lifecycle-операции выполняются через локальный STDIO MCP, подключенный только
   к Codex Desktop владельца на доверенном Mac.
9. **Master credentials.** Supabase Management и Vercel credentials хранятся в
   macOS Keychain. MCP считывает их локально во время выполнения и никогда не
   помещает в Git, registry, prompt, tool arguments/results или logs.
10. **Destructive boundary.** MCP не имеет tools для физического удаления tenant
    Supabase/Vercel resources и выполнения down migrations. Он может собрать
    offboarding-план, экспортировать статус и приостановить доступы; окончательное
    удаление выполняется владельцем вручную по отдельному runbook.
11. **Tenant database baseline.** Новый клиент получает schema-only baseline,
    зафиксированный на текущей migration version, без `Web 2 Mob`, test campaigns
    и других internal seeds/cleanup. После baseline все tenants и internal project
    получают один общий поток будущих migrations.
12. **Tenant-specific builds.** Каждый Vercel project отдельно собирает один и тот
    же утвержденный Git SHA со своими `VITE_SUPABASE_*` values. Tenant projects не
    выполняют auto production deploy из Git; production promotion запускает только
    approval-gated MCP release operation.
13. **Preview isolation.** Production tenant secrets выдаются только Production
    environment. Внешние tenant projects не создают previews с production DB;
    preview testing выполняется на internal/disposable project и защищенных URLs.
14. **Auth delivery.** Custom SMTP, Site URL, redirect allowlist и invite/recovery
    templates являются обязательной частью onboarding до отправки первого invite.
    Secret values вводятся локальной CLI-командой напрямую в Keychain, не в чат.
15. **Platform support identity.** В каждом tenant есть отдельный, явно видимый и
    аудируемый `platform_support` member, управляемый только MCP. Он не заменяет
    обязательного company admin и может быть временно активирован/деактивирован.
16. **Production prerequisites.** Region/data residency, Supabase plan/compute,
    Vercel plan/function limit, backup RPO/RTO и приблизительная ежемесячная стоимость
    являются обязательными полями или blockers onboarding plan; MCP не выбирает
    платный tier молча.
17. **Private lead photos.** Внешние tenants используют private `lead-photos`
    bucket и authenticated/signed delivery. Public bucket остается только
    временной совместимостью internal workspace до migration.
18. **Always-on health.** MCP показывает status on demand, а постоянные stale-sync,
    cron и deployment alerts выполняются tenant-local health job и отправляются
    в owner-only ops channel. Работа alerts не зависит от включенного Mac.
19. **Agent supervisor.** Основной agent обновляется отдельным стабильным
    launcher/updater через A/B slots. Manifest signature защищает publisher identity,
    watchdog подтверждает новый запуск и делает rollback без участия новой версии.
20. **Initial recovery target.** Если контракт клиента не требует большего,
    production default — RPO до 24 часов и RTO до одного рабочего дня, ежедневный
    provider backup, периодический зашифрованный logical export и квартальный
    restore drill. Более строгий PITR включается и тарифицируется отдельно.

## Approach

### 1. Tenant deployment как единица изоляции

Для каждой компании создаются:

- отдельный Supabase project в organization владельца;
- отдельный Vercel project в team владельца;
- поддомен `tenant-slug.<основной-домен>`;
- собственные browser и server environment variables;
- собственные Auth users, `team_members`, business data, Storage и cron jobs;
- собственные Slack/Airtable/notification secrets, если интеграции включены.

Все Vercel projects собираются из одного приватного репозитория и одной release
revision, но каждый tenant получает отдельный build, потому что его
`VITE_SUPABASE_*` values статически встраиваются в SPA. Client projects не
продвигают Git commits в production автоматически: `release_apply` создает build
из pinned SHA, проверяет его и отдельно назначает production deployment.

Production secrets имеют только Production scope. Preview builds внешних tenant
projects отключены либо выполняются без production Supabase/service/AI/integration
secrets и защищены Vercel Authentication. Полноценные previews с данными выполняются
только на internal/disposable Supabase project.

Один текущий internal workspace становится canary. Новая версия сначала проходит
build и smoke tests, затем миграции и deployment на canary, и только после проверки
раскатывается на остальные tenant deployments.

### 2. Clean tenant database baseline

Существующие migrations `001–current` остаются историей internal project, но не
являются bootstrap catalog для внешней компании. На момент cutover создается
immutable schema-only tenant baseline:

- содержит итоговую структуру tables/views/functions/triggers/RLS/Storage policies;
- не содержит `Web 2 Mob`, Airtable URLs, notebook-specific cleanup, test campaigns,
  annotations или другие internal rows;
- private `lead-photos` является baseline default;
- записывает baseline schema version в migration ledger;
- после него применяются только общие migrations, созданные после cutover.

Internal-only defaults переезжают в отдельный seed artifact, который operations
runner никогда не применяет tenant project. Каждая опубликованная baseline version
immutable; новая baseline создается как новая версия, а не переписывает уже
использованную.

CI/verification создает clean disposable database, применяет baseline + все будущие
migration deltas и запускает schema diff, seed-absence, SECURITY DEFINER, RLS,
Storage и first-admin bootstrap smoke tests. Только прошедшая baseline version
может появиться в `tenant_plan_onboarding`.

### 3. Owner-only operations core и локальный MCP

Для 3–5 компаний не строится отдельная control-panel UI. В репозитории появляется
изолированный `ops`-модуль на TypeScript/Node.js:

- **operations core** содержит tenant state machine, provider adapters, validation,
  plan/apply contract, audit и redaction;
- **local STDIO MCP adapter** предоставляет Codex только узкие business tools;
- **CLI adapter** вызывает тот же core и используется для тестов и break-glass
  диагностики, но не реализует отдельную логику;
- tenant-local `frontend/api/mcp.ts` остается аналитическим и не получает
  infrastructure credentials или platform tools.

MCP подключается user-global конфигурацией Codex владельца, а не изменяемой
project-scoped политикой из репозитория. Конфигурация указывает pinned trusted build
operations server, allowlist tool names, timeouts и approval policy, но не секреты.
Перед write preflight сверяет version/digest operations server. Для сервера задается
`default_tools_approval_mode = "writes"`; все mutating tools явно не read-only и
требуют подтверждения. Suspend/revoke tools также помечаются destructive, даже если
они обратимы.

Cross-tool `instructions` сервера кратко фиксируют обязательный workflow:
`preflight → plan → показать владельцу → approval → apply/resume → verify`.
Однако решение о доступе принимает сам operations core, а не model instructions
или MCP annotations.

### 4. MCP tools и границы полномочий

Первая версия предоставляет:

**Read-only tools**

- `tenant_list` — список tenants без секретов;
- `tenant_get` — desired/observed state и resource references;
- `tenant_preflight` — проверка Keychain credentials, provider access, naming,
  domain prerequisites и release compatibility;
- `tenant_plan_onboarding` — неизменяемый план создания компании;
- `tenant_drift` — schema/app/agent drift и health summary;
- `operation_get` — текущее состояние, завершенные/следующие шаги и ошибки;
- `release_plan` — canary/stable план общего релиза;
- `tenant_prepare_offboarding` — только план и checklist, без изменений.

**Approval-gated mutating tools**

- `tenant_apply_onboarding` — выполнить или продолжить утвержденный onboarding;
- `tenant_resume_operation` — продолжить failed/quarantined operation после
  исправления причины;
- `admin_invite` — отправить приглашение первому или последующему admin;
- `machine_enrollment_create` — отправить одноразовое enrollment-приглашение;
- `machine_revoke` — отозвать machine credential;
- `support_access_enable` / `support_access_disable` — временно управлять
  auditable platform support membership;
- `tenant_suspend` — обратимо заблокировать пользователей, machines и jobs;
- `release_apply` — выполнить утвержденный canary/fan-out release.

MCP принципиально не предоставляет arbitrary shell, SQL, HTTP, DNS, env read/set,
secret read, migration repair/down или provider delete tools. Названия resources,
domains, env keys и provider request payloads выводятся operations core из строгой
схемы, а не принимаются как свободный ввод от модели.

### 5. Plan/apply onboarding state machine

`tenant_plan_onboarding` принимает только безопасные business inputs: company name,
slug, admin email, выбранный release channel, ожидаемые instances, region/data
residency, выбранные Supabase/Vercel tiers, backup profile, SMTP/tenant-integration
Keychain labels и support-access policy. DB password и другие generated secrets
создает operations core и сразу сохраняет в Keychain. Он выполняет read-only
preflight и возвращает:

- `plan_id`, digest и expiry;
- ожидаемую registry version;
- точные имена/IDs планируемых resources;
- pinned Git revision, migration set и schema/app versions;
- список внешних эффектов, ориентировочную стоимость и smoke tests;
- отдельные Production/Preview env scopes, cron slot и backup RPO/RTO;
- blockers и ручные prerequisites.

После просмотра владельцем `tenant_apply_onboarding` принимает `plan_id`, digest,
registry version и caller-stable idempotency key. Любое изменение input/provider
state инвалидирует план и требует нового preview.

Onboarding — одна возобновляемая операция:

1. зарезервировать tenant slug и operation id;
2. создать или принять ранее созданный owner-tagged Supabase project;
3. дождаться readiness и применить проверенный schema-only tenant baseline либо
   общий migration delta поверх уже записанной baseline version;
4. настроить private Storage, Auth Site URL/redirects/templates/custom SMTP;
5. создать bootstrap `platform_support` membership в disabled/expired состоянии;
6. создать или принять Vercel project с выключенным Git auto-promotion;
7. записать Production-only tenant env vars, не возвращая их значения;
8. привязать заранее разрешенный поддомен;
9. собрать pinned application revision с tenant-specific public values;
10. развернуть и назначить production deployment;
11. выполнить schema/Auth/RLS/Storage/API/cron/preview-isolation smoke tests;
12. создать company-admin team row и только после успешных тестов отправить invite;
13. записать observed state и завершить operation.

Каждый provider resource ID сохраняется сразу после успешного шага. Повторный вызов
с тем же idempotency key продолжает операцию и не создает дубликаты. Долгие provider
операции выполняются короткими переходами; MCP возвращает `operation_id` и
`pending/failed/succeeded`, а Codex проверяет `operation_get` и вызывает resume
вместо одного непрозрачного многоминутного tool call.

Partial failure не запускает автоматическое удаление или down migration. Tenant
переходит в `failed`/`quarantined`, не получает admin invite, а MCP возвращает
redacted cleanup/resume plan.

### 6. Registry, audit и macOS Keychain

Локальный operations core использует durable SQLite registry в owner-only macOS
Application Support directory с зашифрованным backup. Это operational journal,
а не неизменяемый compliance ledger: целостность защищается schema constraints,
hash-linked audit entries, filesystem permissions и периодическим backup digest.
Registry содержит только:

- desired/observed tenant state;
- Supabase/Vercel resource IDs, domain и lifecycle;
- schema/app/agent versions и release channel;
- locks, operation states, provider request IDs и timestamps;
- ссылки/labels Keychain entries, но не значения секретов.

Audit append-only фиксирует actor, plan/operation/idempotency IDs, plan digest,
redacted inputs, state transitions, provider request IDs, approvals, errors и
timestamps. MCP tool results возвращают только allowlisted structured fields;
необработанные provider responses и environment values в модель не передаются.

Supabase Management token, generated tenant DB passwords, Vercel team token,
SMTP/integration secrets и другие credentials сохраняются отдельными entries macOS
Keychain. Их bootstrap/rotation выполняет локальная no-echo команда вида
`ops secrets set --scope platform|tenant --name ...`, запущенная вне MCP
conversation. Operations core неизбежно читает нужное значение в process memory,
но MCP не предоставляет secret-read tool, а adapters, errors, telemetry и outputs
не могут вернуть его модели.

По возможности используются короткоживущие/fine-grained provider tokens. Если
Supabase PAT наследует все права user account, используется отдельный platform-ops
account/organization boundary, а не основной личный аккаунт. Recovery runbook
описывает замену Mac: восстановить registry backup, перевыпустить master tokens,
повторно связать Keychain labels и reconcile owner-tagged provider resources.

Первому админу не отправляется общий или сгенерированный пароль. MCP инициирует
персональный email invite; администратор сам устанавливает пароль через существующий
invite/recovery flow. После входа он использует текущую Team page для сотрудников.
Machine enrollment также доставляется как короткоживущее одноразовое приглашение,
а не возвращается секретом в MCP result.

`platform_support` — отдельный тип membership, не учитываемый как последний company
admin. Company admins видят его состояние, но не могут менять; MCP активирует доступ
на ограниченный срок и фиксирует reason/expiry в audit. Обычный support login
проходит через отдельного Auth user каждого tenant, без impersonation.

### 7. Machine identity вместо service-role на клиентском компьютере

В каждом tenant Supabase project добавляется реестр машин:

- `agent_machines`: machine id, instance id, label, credential hash, status,
  created/revoked/last-seen timestamps, agent version и release channel;
- одноразовые enrollment tokens с коротким TTL и single-use семантикой;
- audit fields для enrollment, rotation, update и ingest failures.

После установки агент обменивает одноразовый code на случайный machine token.
В базе хранится только hash токена. Token привязан к одному tenant deployment и
одному `instance_id`, может быть отозван без влияния на другие машины и не дает
прямого доступа к Supabase.

Machine token хранится с OS-level protection, совместимой с non-interactive job:
macOS Keychain/ограниченный service credential и Windows Credential Manager/DPAPI.
Если конкретный scheduler account не может использовать secure store, fallback
config имеет минимальные filesystem ACL (`0600`/только service account), а installer
явно предупреждает об ослаблении защиты. Token не попадает в command line или logs.

Новый `/api/agent/*` слой выполняет:

- enrollment;
- прием синхронизации;
- выдачу несекретного remote config;
- heartbeat/version reporting;
- update check и выдачу короткоживущей ссылки на artifact.

API определяет tenant по конкретному Vercel deployment/host, а instance — только
по проверенному machine credential. Значения `tenant`, `instance_id` и разрешенные
таблицы нельзя доверять из произвольного request body.

### 8. Ingest gateway

`sync-agent` перестает выполнять прямые PostgREST writes с service-role key.
Вместо этого он отправляет нормализованные campaigns, leads, steps, messages,
events и sync run metadata в tenant `/api/agent/ingest`.

Gateway:

- проверяет machine token, status и привязанный `instance_id`;
- требует `protocol_version`, `agent_version`, `batch_id`, entity type, sequence и
  byte counts; неизвестная protocol version возвращает upgrade-required без записи;
- валидирует тип, размер, timestamp, допустимые поля и byte-size batch limits;
- принудительно проставляет instance scope на сервере;
- atomically регистрирует `(machine_id, batch_id)` и возвращает сохраненный результат
  для retry; один entity batch либо принимается полностью, либо полностью отклоняется;
- выполняет текущие идемпотентные upsert через server-side service role в порядке
  dependencies: instance/campaign → lead → steps/messages/events;
- возвращает per-entity counts, rejected rows и correlation id;
- имеет Postgres-backed rate limits, structured audit log и безопасные повторные
  запросы; process-memory counters не считаются rate limit в serverless runtime;
- никогда не возвращает service key или произвольный database error.

Agent режет payload по serialized byte size с запасом ниже Vercel 4.5 MB, а не
только по числу rows. Большой sync возобновляется по sequence/cursor. После commit
inbound messages server-side pipeline сам ставит notification work; внешний агент
больше не хранит общий `NOTIFY_SECRET` и не вызывает отдельный notify endpoint.

Переход выполняется через transport abstraction: extraction и mapping logic агента
не переписываются, меняется только способ доставки. Старый direct-Supabase transport
временно сохраняется для internal canary и удаляется после успешного rollout.

Чтобы не размножать serverless functions, agent surface реализуется одним
`/api/agent.ts` handler с внутренней маршрутизацией `enroll|ingest|config|heartbeat|
update-check`. Production preflight выполняет реальный Vercel build и блокирует
onboarding при превышении function/framework limits; выбранный Vercel tier
фиксируется в tenant plan.

### 9. Централизованные обновления агента

При установке создается минимальный стабильный launcher/updater, который запускает
agent из slot `A` или `B`. Основной agent никогда больше не заменяет исполняемый
сейчас файл самостоятельно. Update artifacts отделяются от Supabase-проектов
клиентов и публикуются владельцем в централизованное приватное object storage/CDN:

- immutable paths: `agent/<version>/<platform>/<artifact>`;
- manifest содержит version, channel, platform, SHA-256, размер, минимальную и
  максимальную schema version, дату выпуска, expiry и release notes;
- manifest подписывается online release key, защищенным в CI/owner signing service;
- в агент встроен только public verification key;
- клиентская БД и machine credential не могут подменить publisher identity;
- агент не принимает более старую version без явно подписанного rollback release;
- перед заменой проверяются signature, hash, platform и schema compatibility;
- launcher устанавливает artifact в inactive slot и сохраняет текущий как
  last-known-good;
- после переключения launcher ожидает startup marker и успешный heartbeat;
- crash/timeout подряд приводит к переключению на предыдущий slot и отдельному
  rollback heartbeat, даже если новая agent version не способна запуститься.

Publisher trust включает root public key, versioned signing keys, expiry и
документированную key-rotation/revocation процедуру. Root/online signing private
keys никогда не находятся на клиенте или в tenant projects. Если распространяется
standalone executable, release дополнительно проходит macOS notarization/signing и
Windows Authenticode/SmartScreen-compatible signing; manifest signature сама по
себе не заменяет OS publisher trust.

Каналы: `internal`, `canary`, `stable`. Владелец меняет канал конкретной машины или
tenant через закрытый operator flow. Release считается завершенным только после
наблюдаемого heartbeat с новой версией.

### 10. Windows/macOS installation

Готовятся две инструкции и два helper installer:

- macOS: prerequisite check, подписанный launcher + A/B slots, enrollment,
  Keychain/service credential, `launchd` job, manual dry-run, logs,
  update/rollback/uninstall;
- Windows: prerequisite check, подписанный launcher + A/B slots, enrollment,
  Credential Manager/DPAPI, Task Scheduler job, manual dry-run, logs,
  update/rollback/uninstall;
- диагностика LH2 SQLite discovery, permissions, proxy/firewall, clock skew и
  недоступного endpoint;
- обязательное сравнение первого `sync --dry-run` с цифрами LH2 до реальной отправки;
- безопасная повторная установка без создания новой machine identity;
- процедура rotation/revocation для потерянного компьютера.

Enrollment code передается отдельно от общего installer и действует один раз.
Локальный config содержит tenant endpoint, machine id, ссылку на OS credential и
несекретные настройки; raw token хранится в config только при явно отмеченном
ACL-protected fallback. Supabase URL/service-role там отсутствуют всегда.

### 11. Общие schema и application releases

Один release bundle связывает:

- Git commit/application version;
- требуемый диапазон schema version;
- tenant baseline version и ingest protocol compatibility;
- agent version/channel;
- migration set;
- tenant build inputs и generated deployment-config digest;
- release notes и verification checklist.

Используется expand/contract порядок:

1. обратносуместимые migrations;
2. canary backend/frontend;
3. canary agent;
4. проверка ingestion, Auth, metrics, cron и notifications;
5. migrations остальных tenant DB;
6. отдельный build каждого tenant из того же pinned Git SHA с его public/runtime
   configuration;
7. deployment/promotion остальных Vercel projects;
8. stable agent rollout;
9. отдельным последующим release — cleanup несовместимых старых полей.

`release_plan` и `release_apply` используют тот же plan/digest/idempotency contract,
что и onboarding. MCP показывает drift: tenant, текущая schema/app/agent version,
последний успешный sync и последний успешный cron. Ошибка одного tenant не должна
останавливать наблюдение за остальными; operation при этом помечается частично
завершенной и не скрывает отставший workspace.

Tenant-specific deployment config назначает стабильный `cron_slot`, чтобы 3–5
проектов не запускали общие AI jobs одновременно. Каждый AI/Slack/Airtable feature
имеет tenant capability flag, usage counters и budget/limit; shared provider key
не означает неограниченное потребление. Cron handlers сохраняют jobs/locks в БД,
поскольку Vercel не гарантирует retry и может доставить overlapping/duplicate run.

### 12. Operations, backup и offboarding

Для каждого tenant определяются:

- health checks приложения, Auth, private Storage и ingest;
- tenant-local scheduled health sweep, который независимо от owner Mac отправляет
  alert при пропавшем heartbeat/sync, failed cron/deployment, migration drift и
  repeated update failure в owner-only ops channel;
- Supabase backup/PITR profile с RPO/RTO, периодический encrypted logical export и
  квартальная проверка восстановления в disposable project;
- audit trail admin invitations, machine enrollments/revocations и releases;
- data inventory, выбранный region, retention/deletion rules, DPA/subprocessor list
  и явное описание передачи данных в Anthropic, Slack и Airtable;
- per-tenant AI/integration capability flags, usage/cost counters и budgets;
- export данных по запросу;
- offboarding: блокировка пользователей и машин, финальный export, retention window,
  подготовка MCP checklist и ручное удаление Vercel/Supabase ресурсов только через
  отдельный break-glass runbook вне MCP.

## Implementation phases

1. **Создать clean tenant baseline и закрыть public Storage — L.**
   Снять итоговую schema-only baseline, исключить internal seeds/cleanup, сделать
   `lead-photos` private, добавить signed/authenticated photo delivery и определить
   migration cutover version. Future migrations становятся общими для internal и
   tenant projects.
   Проверка: baseline + deltas применяются к пустой disposable DB; там нет `Web 2
   Mob`, internal URLs или notebook rows; RLS/Storage/SECURITY DEFINER diff совпадает
   с ожидаемой tenant schema.

2. **Зафиксировать operations, cost и recovery contracts — S.**
   Описать naming/resource tags, region/tier/SMTP/backup inputs, tenant state machine,
   registry schema, plan digest, idempotency, release/protocol compatibility,
   canary workspace, RPO/RTO и запретные операции.
   Проверка: onboarding полностью представлен deterministic plan без secret values
   и arbitrary provider payloads; неизвестный plan/tier/region является blocker.

3. **Создать operations core, Keychain bootstrap и CLI fallback — M.**
   Добавить provider interfaces, SQLite registry/audit, secret redaction, locks,
   Keychain no-echo bootstrap, registry recovery и test doubles Supabase/Vercel.
   CLI вызывает только тот же core и не получает обходного пути.
   Проверка: canary secrets не появляются в arguments, registry, fixtures, logs,
   crash/error paths или outputs; повтор idempotency key дает тот же результат.

4. **Добавить owner-only STDIO MCP и disposable provisioning — L.**
   Реализовать user-global MCP setup, read-only plan/status tools,
   approval-gated writes, strict schemas/annotations и resumable onboarding:
   Supabase baseline, private Storage, Auth/SMTP, support membership, Vercel
   Production env scope, tenant build, domain, smoke tests и first-admin bootstrap.
   На этом этапе создается только disposable tenant, не внешняя компания.
   Проверка: failure injection после каждого provider effect дает
   `failed/quarantined`; resume не дублирует billable resources; invite уходит
   только после smoke tests; MCP не имеет raw/delete/secret-read tools.

5. **Ввести versioned machine enrollment и ingest gateway — L.**
   Добавить machine credentials, one-time delivery, DB rate limits,
   `ingest_protocol_version`, byte-size chunking, persisted batch idempotency и
   единый `/api/agent.ts` handler. Новый transport проходит internal/disposable
   canary; direct transport пока сохраняется только internal.
   Проверка: oversized/unknown-version payload отвергается без partial write,
   batch retry возвращает прежний result, revoked token прекращает работу, чужой
   instance не принимает данные, Vercel production build проходит function limits.

6. **Сделать launcher, signed updates и Windows/macOS onboarding — L.**
   Реализовать минимальный launcher с A/B slots/watchdog, подписанный manifest,
   key rotation, OS signing/notarization при executable distribution, installers,
   scheduled execution, OS credential storage, dry-run, logs, repair и uninstall.
   Проверка: новая версия, которая не стартует, автоматически откатывается launcher;
   измененный/просроченный/несовместимый artifact отвергается; blind installation
   проходит на чистых Windows и macOS.

7. **Добавить tenant-build и MCP release orchestration — L.**
   Реализовать отдельный build каждого tenant из pinned SHA, Production-only env,
   отключенное auto-promotion, generated cron slots, canary, fan-out migrations,
   deployment promotion, drift report и resumable release.
   Проверка: production secrets отсутствуют в preview; один failed tenant не скрывает
   состояние остальных; повтор release не дублирует migrations/deployments;
   canary failure блокирует stable agent rollout.

8. **Подготовить always-on production operations и data governance — M.**
   Добавить tenant-local health sweep/ops alerts, job locks/retries, backup/export
   profile, quarterly restore rehearsal, support-access expiry/audit, per-tenant
   capabilities/budgets, retention/export/deletion и DPA/subprocessor checklist.
   Проверка: alerts приходят при выключенном owner Mac; support expiry закрывает RLS
   доступ; disposable restore укладывается в выбранные RPO/RTO; private photo URL
   без действующего Auth/signed token не читается.

9. **Провести controlled external rollout — M.**
   Internal workspace → disposable tenant → первая внешняя компания → остальные
   компании. Первая компания подключается только после завершения phases 1–8.
   После двух стабильных sync/update cycles удаляются direct service-role transport,
   local `notify_secret` и старый перезаписываемый `latest agent.py`.
   Проверка: полный MCP plan/apply/resume, admin/support login, Windows/macOS install,
   ingest, notification, update/rollback, machine revoke, tenant suspend, backup
   restore и offboarding rehearsal проходят без доступа клиента к infrastructure
   secrets или данным другого проекта.

### Recommended Codex session boundaries

Не следует реализовывать phases 1–9 в одной длинной сессии. Новая Codex-сессия
обязательна после каждого phase acceptance gate и желательна при смене trust
boundary или toolchain внутри большой фазы. Каждая новая сессия получает master
spec, один ограниченный session brief и handoff предыдущей сессии; полная история
всего проекта ей не нужна.

| Session | Phase | Ограниченный scope | Закрывающий gate |
|---|---:|---|---|
| `P1-A` | 1 | Audit migrations, internal seeds/cleanup, baseline cutover contract | Утвержден список schema-only/internal объектов и cutover version |
| `P1-B` | 1 | Создать baseline artifact, migration ledger и clean-room tests | Пустая DB проходит baseline + delta и не содержит internal markers |
| `P1-C` | 1 | Private `lead-photos`, signed/authenticated delivery и UI migration | Anonymous photo read запрещен, dashboard показывает фото после Auth |
| `P2` | 2 | Operations/state/cost/recovery contracts без production provider writes | Plan schemas, state transitions, RPO/RTO и forbidden actions зафиксированы |
| `P3-A` | 3 | `ops` package, SQLite registry/audit, locks и provider interfaces/fakes | State/idempotency tests проходят без реальных provider credentials |
| `P3-B` | 3 | Keychain, no-echo secrets CLI, redaction, registry recovery и CLI adapter | Canary secrets отсутствуют во всех output/error paths; recovery rehearsal проходит |
| `P4-A` | 4 | STDIO MCP server, tool schemas, instructions и approval policy | Read-only/write/destructive annotations и allowlist проверены |
| `P4-B` | 4 | Supabase/Vercel/Auth/SMTP/domain provider adapters и onboarding state machine | Dry-run plan детерминирован, failure injection не создает дубликаты |
| `P4-C` | 4 | End-to-end disposable tenant provisioning — **blocked/incomplete, provisioning deferred 2026-07-30**; resume по [deferred plan](../docs/platform-ops/p4-c-deferred-provisioning-plan.md) после доступности Supabase Pro или другой уже оплаченной reviewed organization | Baseline, build, domain, Auth, support/admin invite и smoke suite проходят |
| `P5-A` | 5 | DB migrations и единый `/api/agent.ts`: auth, protocol, batches, rate limits | API contract/idempotency/security/size tests проходят |
| `P5-B` | 5 | Python agent transport, OS credential reference, notify flow и canary | Internal/disposable sync совпадает с LH2 и не использует service-role |
| `P6-A` | 6 | Launcher trust core: manifest, keys, A/B slots, watchdog, rollback | Broken artifact автоматически откатывается на last-known-good |
| `P6-B` | 6 | macOS installer, Keychain, `launchd`, update/repair/uninstall QA | Blind install и update rollback проходят на чистом macOS account |
| `P6-C` | 6 | Windows installer, Credential Manager/DPAPI, Task Scheduler QA | Blind install и update rollback проходят на чистой Windows VM |
| `P7-A` | 7 | Tenant-specific Vercel builds, env scopes, preview isolation и cron slots | Два tenants собираются из одного SHA с разными правильными project refs |
| `P7-B` | 7 | MCP release plan/apply, migrations, canary, fan-out, promotion и drift | Partial failure/resume и canary block проходят end-to-end |
| `P8-A` | 8 | Always-on health, job retries/locks, backups и disposable restore | Alerts работают без owner Mac; restore укладывается в RPO/RTO |
| `P8-B` | 8 | Support expiry/audit, budgets, retention, subprocessors и offboarding | Production-readiness checklist закрыт без unresolved blockers |
| `P9-A` | 9 | Onboarding только первой внешней компании | Admin login, минимум один реальный agent на используемой ОС, sync и alert стабильны |
| `P9-B` | 9 | Два полных sync/update cycles и удаление legacy transport/secrets | Service-role/`notify_secret`/old updater отсутствуют на client machines |
| `P9-C<n>` | 9 | Одна отдельная сессия на каждую следующую компанию | Tenant-specific onboarding checklist и smoke suite закрыты |

`P1-A → P1-B → P1-C → P2 → P3-A → P3-B → P4-A → P4-B → P4-C → P5-A
→ P5-B → P6-A → P6-B/P6-C → P7-A → P7-B → P8-A → P8-B → P9-A → P9-B
→ P9-C<n>` — рекомендуемый критический путь. `P6-B` и `P6-C` можно вести
параллельно только после стабильного `P6-A`; остальные sessions последовательны,
потому что меняют общие contracts или внешнюю инфраструктуру.

Текущий статус на 2026-07-30: `P4-C` остается активной
`blocked/incomplete`-границей. Read-only preflight прошел для provider access,
domain, region/residency, SMTP/DNS, release compatibility, legal review и
pricing, но заблокировал `tier_capacity` и `backup_coverage`, поскольку owner не
может пока оплатить обязательный Supabase Pro. Tenant, deployment и admin invite
не создавались. Нельзя переходить к `P5-A` или `P7-A`, подменять Pro/7-day daily
backups бесплатным профилем или считать P4-C принятой. Условия и точный порядок
возобновления зафиксированы в
[`p4-c-deferred-provisioning-plan.md`](../docs/platform-ops/p4-c-deferred-provisioning-plan.md),
а завершенный локальный scope и незакрытый live gate — в
[`P4-C-pre-provisioning-checkpoint.md`](../docs/implementation-handoffs/P4-C-pre-provisioning-checkpoint.md).

Новая сессия особенно обязательна:

- после `P1-C`: переход от database/security baseline к control plane;
- после `P3-B`: переход от локального core к model-callable MCP tools;
- между `P4-B` и `P4-C`: production-like provider writes должны выполняться в
  чистом контексте после review plan/apply реализации;
- между `P5-A` и `P5-B`: server trust boundary и клиентский Python agent;
- перед `P6-B` и `P6-C`: разные OS, credential stores и schedulers;
- после `P7-B`: дальнейшая работа затрагивает production operations;
- для каждого `P9-C<n>`: данные, credentials и проблемы одного клиента не должны
  попадать в контекст onboarding другого.

В конце каждой session создается handoff в `docs/implementation-handoffs/`:

1. завершенный scope и acceptance gate;
2. измененные files/migrations/schema/protocol versions;
3. выполненные проверки и их результаты;
4. внешние resources/state changes без secret values;
5. оставшиеся blockers/risks;
6. rollback point;
7. готовый краткий prompt для следующей session.

Сессия не закрывается только из-за длины контекста. Если acceptance gate не пройден,
следующая сессия получает статус `blocked/incomplete` и продолжает тот же session
brief; она не начинает следующую фазу.

## Affected files/modules

- `sync-agent/agent.py` — новый ingest transport, enrollment, machine auth,
  protocol-versioned batches, heartbeat и работа под A/B launcher.
- Новый минимальный `sync-agent/launcher.*` или отдельный package — manifest
  verification, inactive-slot installation, watchdog, rollback и root-key rotation.
- `sync-agent/config.example.yaml` — убрать service-role из клиентского template,
  добавить endpoint/machine identity и безопасные defaults.
- `sync-agent/deploy.sh` — заменить overwrite одного `latest` на публикацию immutable
  artifacts и подписанного manifest либо вывести из эксплуатации.
- Новые `sync-agent/install-macos.*` и `sync-agent/install-windows.*` — helper
  installers без встроенных tenant secrets.
- `README.md` и новые документы в `docs/` — platform provisioning, Windows/macOS
  onboarding, release, rotation, diagnostics и offboarding.
- Новый immutable `supabase/tenant-baseline/` artifact и verification metadata —
  итоговая schema без internal seeds/cleanup плюс baseline migration version.
- Отдельный `supabase/seeds/internal/` — internal-only `Web 2 Mob` defaults, которые
  tenant runner никогда не применяет.
- Новые последовательные `supabase/migrations/*` — machine credentials, one-time
  enrollment, ingest batches/rate limits, platform support membership, audit/heartbeat
  records, indexes и service-role-only policies.
- Новый единый `frontend/api/agent.ts` handler — enroll, ingest, config, heartbeat
  и update-check без размножения top-level serverless functions.
- `frontend/api/_lib/auth.ts` — отдельная machine-auth ветка, не смешанная с user JWT,
  cron или MCP secrets.
- `frontend/api/_lib/core.ts` — schema/version reporting и безопасные server-only
  helpers; текущий single-project runtime сохраняется внутри каждого tenant deploy.
- `frontend/api/mcp.ts` — функционально не расширяется; документируется как
  tenant-analytics boundary, отдельная от owner infrastructure MCP.
- `frontend/src/lib/AuthContext.tsx`, `frontend/src/pages/Team.tsx` и
  `frontend/api/pipeline.ts` — bootstrap first admin, видимый `platform_support`,
  support expiry и запрет company-admin изменять platform membership.
- `frontend/vercel.json` и tenant deployment-config template — generated cron slot,
  tenant health sweep, Production/Preview policy и idempotency/locking verification.
- `supabase/migrations/004_agent_bucket.sql` и update-bucket policies — вывод
  agent artifacts из tenant projects.
- `supabase/migrations/042_lead_photos.sql` плюс новая migration и frontend photo
  loading — обязательный private bucket и authenticated/signed photo delivery.
- Новый `ops/` TypeScript package:
  - `ops/src/core/` — plan/apply state machines, schemas, locks и redaction;
  - `ops/src/providers/` — Supabase Management и Vercel adapters;
  - `ops/src/state/` — SQLite registry, migrations и append-only audit;
  - `ops/src/secrets/` — macOS Keychain adapter и no-echo bootstrap CLI без
    MCP secret-return API;
  - `ops/src/mcp/` — owner-only STDIO server и tool schemas;
  - `ops/src/cli/` — thin fallback поверх того же operations core;
  - `ops/test/` — provider fakes, failure injection, idempotency и redaction tests.
- User-global Codex MCP configuration, описанная в setup docs — pinned server command,
  enabled tools, timeouts и `writes` approval policy; без credentials.
- `.gitignore` — запрет локальных registry DB, exports, MCP logs и secret bootstrap
  artifacts.
- `AGENTS.md` — операторский workflow `preflight → plan → approval → apply → verify`
  и явный запрет обходить MCP core сырыми provider-командами при tenant operations.
- Новые `docs/platform-ops*.md` — Keychain bootstrap/rotation, MCP setup, onboarding,
  registry recovery, resume/quarantine, release, backup/restore, data governance и
  manual break-glass deletion runbook.
- Новые `docs/implementation-handoffs/` — короткий проверяемый handoff каждой
  implementation session и готовый prompt следующей session.
- Release/CI configuration — clean-room baseline test, один pinned source SHA,
  отдельные tenant builds, preview-secret isolation, canary/fan-out deploy и
  immutable release metadata.

## Risks & how to verify

- **Компрометация owner MCP дает platform-wide доступ.** MCP доступен только локально
  на доверенном Mac, получает allowlisted tools и не слушает network port. Проверить,
  что remote transport отсутствует, Supabase/Vercel automation использует отдельный
  ops account/boundary, а provider tokens имеют минимально достаточные scopes,
  быстро отзываются и регулярно ротируются.
- **Модель или prompt injection вызывает нежелательный write.** Все write tools
  требуют Codex approval и действующего plan digest; operations core повторно
  валидирует inputs/state. MCP annotations и instructions не считаются security
  boundary.
- **Secret попадает в чат через tool output/error.** Contract tests подставляют
  canary secrets во все provider success/error paths и проверяют отсутствие значений
  в tool results, audit, registry, telemetry, crash reports и logs. Secret может
  кратковременно существовать в process memory provider adapter, но необработанные
  provider responses и secret-read operations наружу не возвращаются.
- **Повторный onboarding создает второй billable project.** Plan фиксирует resource
  names/tags и registry version; apply требует idempotency key, сразу сохраняет
  provider IDs и принимает существующий owner-tagged resource только после проверки.
- **MCP call завершается посередине.** Каждый короткий transition коммитит observed
  state; `operation_get` показывает точку остановки, а resume продолжает с нее.
  Failure injection проверяет остановку после каждого provider side effect.
- **Опасная операция замаскирована под общий tool.** Tool set не содержит raw
  shell/SQL/HTTP/env/DNS и provider delete. Schema review проверяет annotations,
  output allowlists и отсутствие произвольных command/URL/query аргументов.
- **Потеря локального registry.** SQLite registry получает зашифрованный backup;
  provider resources помечаются owner tags, чтобы отдельная read-only reconcile
  процедура могла восстановить observed state без чтения секретных env values.
- **Suspend случайно становится delete.** Integration tests подтверждают только
  обратимые блокировки Auth/machines/jobs. Физический provider deletion отсутствует
  в MCP implementation и выполняется только по ручному break-glass runbook.
- **Tenant baseline приносит внутренние данные.** Clean-room test ищет known internal
  markers (`Web 2 Mob`, `notebook-1`, internal Airtable URLs) и падает при любой
  business row после bootstrap. Schema baseline проходит review отдельно от seeds.
- **Tenant build подключен к чужому Supabase.** Build metadata фиксирует tenant slug,
  Supabase project ref и Git SHA; smoke test проверяет project ref в runtime до
  production promotion. Один static artifact не переиспользуется между tenants.
- **Preview получает production secrets/data.** Vercel env audit проверяет, что
  service-role, Anthropic, SMTP, Slack и Airtable credentials имеют только Production
  scope; external tenant auto-preview/auto-promotion выключены.
- **Auth invite не доставляется.** Onboarding проверяет custom SMTP, Site URL,
  redirect allowlist и test delivery до создания company admin; неуспех оставляет
  tenant quarantined без «успешного» onboarding status.
- **Platform support заменяет последнего company admin.** DB invariant считает
  только активных `member_kind='company'` admins; support membership имеет expiry,
  не редактируется company admin и не используется для обхода company-admin rule.
- **Service-role остается на клиентской машине.** Проверить installation bundle,
  process environment, config и logs; ни один из них не должен содержать Supabase
  secret/service-role. Провести тест с отозванным machine token.
- **Cross-instance запись через подмену payload.** Отправить корректно подписанный
  запрос с чужим `instance_id`; API обязан игнорировать/отклонить его и не изменить БД.
- **Ошибочный release ломает все компании.** Проверить canary gates, version
  compatibility и фактический heartbeat до promotion в stable.
- **Schema drift между отдельными проектами.** Перед каждым deploy собирать migration
  version всех tenants; блокировать несовместимый application/agent rollout и
  поддерживать resumable migration run.
- **Частичная идемпотентность ingest.** Повторить каждый batch после искусственного
  timeout на разных стадиях; business rows, messages и events не должны дублироваться.
- **Ingest превышает Vercel limit или смешивает protocol versions.** Tests генерируют
  большие message bodies, режут batches по serialized bytes, проверяют 413 headroom,
  unknown protocol и resume после каждого sequence. Unknown version не делает write.
- **Неверная RLS/Auth конфигурация нового проекта.** Автоматический smoke suite
  проверяет anonymous, inactive member, member, admin и service operations перед
  выдачей workspace.
- **Секреты попадают в registry, bundle или logs.** Secret scanning и ручная
  проверка artifacts; registry содержит только неопасные IDs/metadata.
- **Один tenant влияет на cron/release других.** Для каждого проекта собственные
  jobs, cron slot, capability budgets и locks; fan-out сохраняет независимый результат
  по tenant, а shared AI provider throttling дает retryable job, не потерю backlog.
- **Публичные lead photos внешних клиентов.** До production onboarding применить
  обязательную private migration; anonymous direct Storage URL должен возвращать
  отказ, а authenticated/signed URL иметь короткий TTL.
- **Новая agent version не запускается.** Launcher test устанавливает намеренно
  broken artifact в inactive slot, наблюдает startup timeout и подтверждает возврат
  к last-known-good без исполнения кода broken version.
- **Owner Mac выключен во время outage.** Tenant-local health sweep и внешний uptime
  check продолжают отправлять alerts; MCP status рассматривается только как
  on-demand диагностика.
- **Backup существует, но не восстанавливается.** Квартальный restore в disposable
  project проверяет DB, Auth configuration, private Storage inventory и выбранные
  RPO/RTO; provider backup без restore rehearsal не считается выполненным DoD.
- **Непрозрачная обработка персональных данных.** До external launch фиксируются
  data region, retention, client export/deletion, subprocessors и AI/Slack/Airtable
  data flows; contractual/legal review является production gate, а не обещанием
  приложения автоматически обеспечить compliance.
- **Agent code извлекается клиентом.** Считать это ожидаемым свойством локального
  исполнения; убедиться, что извлеченный код и installer не содержат publisher
  signing key, Supabase secrets или credentials других tenants.
- **Пользователь не может установить агент по инструкции.** Провести blind onboarding
  test на чистой Windows VM и macOS account без участия разработчика.
- **Рост операционной нагрузки отдельных проектов.** Измерять время provisioning,
  release и incident response. При превышении 10–15 tenants отдельно спроектировать
  полноценный control plane, не перенося данные преждевременно в shared DB.

## Definition of done

- Для каждой подключенной компании существуют отдельные Supabase и Vercel projects
  в аккаунтах владельца и отдельный поддомен.
- Новый tenant создается только из проверенной schema-only baseline; в нем нет
  internal ICP, notebook-specific rows, internal URLs или test data.
- Codex Desktop владельца подключен к локальному STDIO MCP; MCP не имеет remote
  listener и не входит ни в один tenant deployment.
- `tenant_preflight` и `tenant_plan_onboarding` работают read-only и возвращают
  deterministic plan с digest, expiry, pinned revisions и ожидаемыми эффектами.
- Все mutating MCP tools требуют approval, действующий plan/idempotency contract
  и проходят server-side validation; raw shell/SQL/HTTP/env и provider delete tools
  отсутствуют.
- Supabase/Vercel master credentials находятся в macOS Keychain и не появляются в
  Git, Codex prompts/transcripts, MCP arguments/results, registry, audit или logs.
- Keychain/registry recovery и provider-token rotation проверены на replacement Mac;
  секреты вводятся no-echo CLI, а MCP не имеет secret-read tool.
- Прерванный onboarding возобновляется с последнего сохраненного transition без
  дублирования billable resources; failed tenant остается quarantined без admin invite.
- MCP способен подготовить offboarding и обратимо suspend tenant, но технически не
  способен удалить Supabase/Vercel project или выполнить down migration.
- Все tenant deployments работают из одной утвержденной revision приватного
  репозитория, но имеют отдельный tenant build с правильным Supabase project ref;
  release status и drift видны владельцу через MCP status tools.
- External tenant Git auto-promotion выключен; production secrets отсутствуют в
  Preview scope, а production deployment создается только approval-gated release.
- Клиенты не имеют Supabase/Vercel/Git/SQL доступа и не получают secret/service-role
  keys.
- Первый company admin входит через персональное приглашение и может приглашать,
  отключать и менять роль сотрудников только своего проекта.
- Custom SMTP, Site URL, redirect allowlist и email templates проходят delivery
  smoke test до отправки первого company-admin invite.
- Platform support — отдельный видимый membership с reason/expiry; он не считается
  company admin, не редактируется клиентом и отключается MCP.
- Browser anon/publishable key не читает данные без активной membership; Auth и RLS
  smoke tests проходят на каждом новом tenant.
- `lead-photos` private: anonymous URL не читает объект, а dashboard использует
  authenticated или короткоживущую signed delivery.
- Windows и macOS установка документированы и проверены на чистых системах.
- Каждая машина имеет отдельный отзывной credential, привязанный к tenant и instance;
  в БД хранится его hash.
- Агент выполняет dry-run, versioned/chunked ingest, heartbeat, config fetch и update
  без прямого Supabase service-role или общего `NOTIFY_SECRET`.
- Oversized, replayed и unknown-protocol batches имеют детерминированный результат
  без partial writes; фактический Vercel production build проходит route/body limits.
- Повторная синхронизация идемпотентна, а подмена tenant/instance в payload не дает
  записать чужие данные.
- Agent artifacts immutable и подписаны; отдельный launcher проверяет signature,
  hash, expiry, platform/schema compatibility, устанавливает A/B slot и откатывает
  не запускающуюся версию без участия нового agent.
- Rollout проходит `internal → canary → stable`; неуспешный canary не обновляет
  остальные компании.
- Миграции и deployments выполняются по всем tenant projects с preflight, отдельным
  статусом, MCP approval, повторным запуском и отчетом о drift.
- Настроены health/heartbeat alerts, backup policy, credential rotation и
  offboarding runbook; alerts работают при выключенном owner Mac.
- Для каждого tenant зафиксированы region, provider tiers, expected monthly cost,
  RPO/RTO, retention, subprocessors и AI/integration capability budgets.
- Backup успешно восстановлен в disposable project и проверен по DB/Auth/Storage
  checklist в рамках выбранного RPO/RTO.
- Controlled rollout успешно пройден для internal workspace, disposable tenant и
  как минимум одной внешней компании на Windows или macOS; вторая ОС также проходит
  installation и update rehearsal до общего запуска.
