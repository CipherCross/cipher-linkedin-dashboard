# Neon migration and provider-agnostic multi-tenancy

## Goal

Полностью убрать runtime-зависимость продукта от Supabase и перенести каждый
company workspace в отдельный Neon project, сохранив физическую изоляцию tenants,
существующие данные и уже реализованное operations core. Одновременно нужно
перестроить доступ к данным, identity, Storage и machine ingest вокруг внутренних
контрактов, чтобы следующая смена провайдера не требовала переписывать продукт.

Для двух первых tenants и четырех пользователей допустим плановый downtime,
повторный вход и сброс паролей. Production-контур должен использовать только
GA-компоненты; beta Neon Data API, Neon Auth и Neon Storage не входят в основной
путь миграции.

## Non-goals

- Не возвращаться к старой ветке `feat/multi-team-distribution`.
- Не откатывать `main` к `origin/main` и не вести две долгоживущие реализации
  продукта с последующим большим merge.
- Не превращать два физически изолированных workspace в shared database с
  `tenant_id` во всех бизнес-таблицах.
- Не использовать Neon branches как security boundary между компаниями.
- Не переносить Supabase `service_role` или прямой browser-to-database доступ в
  новую архитектуру.
- Не сохранять активные Supabase sessions или password hashes: для четырех
  пользователей допустим контролируемый reset/re-invite.
- Не обещать zero-downtime cutover. Предусматривается обслуживаемое окно,
  окончательный перенос и последующий catch-up накопившихся LH2 данных.
- Не выбирать beta-компоненты только ради уменьшения первоначального объема
  переписывания.

## Research findings

- Текущая мультитенантная работа — восемь коммитов `54a1304…c8a9d5f` поверх
  `origin/main`. Это не один Supabase feature:
  - `54a1304` задает архитектуру managed company workspaces;
  - `38ed83b`, `24765af`, `afa1157` и значительная часть `bc780bd` реализуют
    provider-neutral contracts, registry, state machines, approval,
    idempotency, recovery и owner MCP;
  - `7931c99` содержит Supabase tenant baseline/private Storage;
  - `c8a9d5f` содержит незавершенный Supabase/Vercel P4-C provider runtime.
  Поэтому перенос всех восьми коммитов в отдельную рабочую ветку выбросит или
  заставит повторно сводить полезное operations core.
- P4-C еще не создавал disposable tenant, внешний Vercel deployment или tenant
  Auth user. Это хорошая точка смены DB/Auth/Storage provider: production data
  пока существует только в текущем внутреннем workspace.
- Tenant baseline содержит 25 tables, 8 views, 13 functions, 12 triggers,
  25 RLS-enabled tables и 50 policies. Бизнес-Postgres в основном переносим,
  но baseline зависит от `auth.users`, `auth.uid()`, Supabase roles,
  `storage.*` и `supabase_migrations`.
- Frontend сейчас напрямую использует Supabase Auth, PostgREST и Storage.
  `DataContext` и несколько UI-компонентов читают таблицы/views из браузера.
  GA-only путь требует перенести эти операции за собственный Vercel API.
- Vercel functions и crons можно сохранить, но их database/auth layer нужно
  заменить. Neon serverless driver версии 1.x имеет GA-статус и рассчитан в том
  числе на Vercel functions.
- Sync agent использует Supabase REST, `service_role`, remote config, object
  uploads и self-update. Перенос этого протокола напрямую на Neon создал бы
  временный привилегированный transport. Правильный путь — сразу реализовать
  уже запланированный tenant-local machine-auth ingest gateway.
- Realtime в приложении не используется, поэтому отдельной Realtime-замены нет.
- `pg_dump`/`pg_restore` подходит для текущего downtime-сценария. Logical
  replication понадобится только если фактический объем или время restore
  окажутся неприемлемыми.
- Database dump не переносит bytes из Supabase Storage, Auth runtime, API keys,
  sessions или signed URLs. Файлы и identity требуют отдельных cutover-процедур.
- Для provider-agnostic identity практичный первоначальный кандидат —
  self-hosted Better Auth за внутренним `IdentityProvider` contract:
  PostgreSQL adapter, email/password, reset и admin capabilities существуют
  независимо от Neon. Окончательное принятие требует отдельного security spike;
  managed Neon Auth не используется в GA-only baseline.
- Для файлов нужен отдельный `ObjectStorageProvider` на GA S3-compatible API.
  Neon Storage не используется в baseline.
- Hosting уже привязан к Vercel через file-based API functions, `vercel.json`,
  четыре cron schedules и operations adapter на `@vercel/sdk`. При этом
  application handlers в основном используют Web `Request`/`Response`, поэтому
  hosting boundary можно обобщить без немедленного переноса runtime.
- Замена Vercel одновременно с Supabase добавила бы еще одну независимую
  миграцию: router/server для 12 handlers, streaming/MCP compatibility, scheduler,
  domains, secrets, deployment promotion и новый operations adapter. Для двух
  tenants при нулевой текущей стоимости измеренного Vercel blocker нет.
- Оценка hosting-вариантов: оставить Vercel за provider-neutral contract —
  2–5 дней; перейти на managed Node/container platform — еще 2–4 недели;
  Cloudflare Workers — ориентировочно 3–6 недель из-за Node/MCP и long-running
  AI/cron compatibility.
- Оценка для одного опытного разработчика с проверками:
  - совместимый Neon schema/data PoC: 1–2 недели;
  - рабочий внутренний workspace: 4–6 недель;
  - production-ready два-tenant контур с Auth, Storage, ingest, operations и
    проверенным cutover: 8–14 недель;
  - при двух разработчиках часть frontend/Auth/Storage можно распараллелить,
    но критический путь schema → API contract → ingest → provisioning обычно
    сокращается примерно до 6–10 календарных недель, а не вдвое.

Официальные основания: Neon документирует
[`pg_dump`/`pg_restore` и logical replication](https://neon.com/docs/import/migrate-intro),
а [`@neondatabase/serverless` 1.x имеет GA-статус](https://neon.com/docs/serverless/serverless-driver).
Supabase описывает себя как набор Postgres, Auth, PostgREST, Realtime и Storage,
поэтому перенос одной БД не является полным backend cutover:
[`Supabase architecture`](https://supabase.com/docs/guides/getting-started/architecture).

## Decisions

- **Полнота миграции:** полный отказ от Supabase: database, Auth, Storage,
  PostgREST, service-role и provisioning APIs.
- **Tenant isolation:** отдельный Neon project и отдельные credentials на каждую
  компанию. Первоначально два tenants: внутренний и одна внешняя компания.
- **Maturity policy:** production использует GA-only components. Beta Data API,
  managed Neon Auth и Neon Storage могут исследоваться отдельно, но не входят в
  обязательный runtime.
- **Identity portability:** бизнес-модель пользователя и membership принадлежит
  приложению; auth implementation подключается через внутренний provider
  contract. Нельзя разносить provider-specific user IDs по бизнес-таблицам.
- **User migration:** пользователей всего четыре; допустим re-invite/password
  reset и завершение всех старых sessions.
- **Downtime:** допустимо обслуживаемое окно. После переключения sync agents
  должны идемпотентно догнать действия, накопившиеся в LH2. Manual-only данные
  переносятся полным DB dump и не зависят от повторного sync.
- **Git:** восемь последних мультитенантных коммитов остаются в актуальной
  истории. Создается только safety checkpoint текущего Supabase P4-C состояния,
  затем работа идет короткими интегрируемыми ветками от текущего `main`.
- **Hosting:** Vercel остается первым временным hosting adapter. Сейчас
  обобщается deployment contract, но фактический перенос hosting не входит в
  Neon cutover. Решение пересматривается только по измеренным cost, reliability
  или runtime-limit данным после стабилизации Neon.
- **Region/residency:** region остается обычным явным provisioning input без
  заранее заданного требования по размещению.
- **Неопределенность размера:** фактические размеры database и Storage нужно
  снять до выбора cutover window. Для текущего разрешенного downtime default —
  dump/restore; решение меняется только по результатам rehearsal.
- **N0 checkpoint:** неизменяемый Supabase P4-C runtime checkpoint —
  `c8a9d5f35694dd6e8f7f35643967c8ed9808ced5`, локальный annotated tag
  `supabase-p4c-checkpoint-c8a9d5f`. Это только архив/reference; новый
  Supabase-specific provisioning path не возобновляется.
- **Neon tier:** временный initial adapter — Neon Free. Это осознанный
  cost-first выбор для двух измеренных небольших БД, а не production SLA;
  upgrade до Launch рассматривается только после измерения capacity, recovery
  или support blocker. Neon Data API, managed Neon Auth и Neon Storage не
  выбираются.
- **Neon region:** AWS Europe (Frankfurt), выбранный по latency/cost preference,
  без добавления несуществующего residency requirement.
- **Recovery objectives:** RPO не более 24 часов для полного recovery surface,
  RTO не более 8 business hours и maintenance window до 90 минут. Free-tier
  restore history не заменяет portable export/object/identity recovery evidence.
- **Identity:** self-hosted Better Auth — initial `IdentityProvider` adapter;
  это application-hosted MIT component, не managed Auth service. Канонические
  users/memberships остаются application-owned. S16/G3 обязан подтвердить или
  заменить candidate security spike.
- **Object storage:** Cloudflare R2 Standard — initial
  `ObjectStorageProvider` adapter: private bucket per tenant и отдельно
  scoped bucket для agent artifacts. Object bytes не хранятся в PostgreSQL;
  AWS S3 остается portable fallback. S19/S20 обязаны доказать isolation,
  signed access и copy/reconciliation.
- **G0:** принят владельцем 2026-07-31. Полная матрица доказательств,
  alternatives, security/cost assumptions и review triggers находится в
  [`neon-provider-decisions.md`](../docs/platform-ops/neon-provider-decisions.md).

## N0 session status

- **S01 — complete:** source measurements recorded in
  `docs/platform-ops/neon-migration-source-measurements.md`, commit `794875d`.
- **S02 — complete:** S01 fast-forward integrated into `main`; the P4-C archive
  tag and G0 decisions above were recorded on the S02 documentation branch.
- **S03:** not started. It may start only from the accepted G0 boundary and owns
  only `DataStore` contracts, fakes and tests.

## Approach

### 1. Provider-neutral application boundary

Frontend больше не получает database credential и не обращается к таблицам
напрямую. В Vercel API вводятся три внутренних слоя:

- `DataStore`/repositories для business reads, writes, RPC-equivalent
  transactions и pagination;
- `IdentityProvider` для sign-in, session verification, invite/reset/disable,
  плюс canonical application-owned `users` и `team_members`;
- `ObjectStorageProvider` для upload, read и short-lived signed download URLs.

Первоначальные adapters: Neon/PostgreSQL через GA serverless driver,
self-hosted auth candidate после security spike, GA S3-compatible object storage
и Vercel hosting. Provider-specific IDs остаются только в identity mapping и
operations registry.

### 2. Portable tenant schema

Текущий v053 baseline становится источником инвентаря, но не переносится как
неизменяемый Supabase artifact. Создается новый PostgreSQL baseline:

- business tables/views/functions/triggers сохраняются;
- `auth.users`, `auth.uid()` и Supabase roles заменяются application identity
  schema и request-scoped actor context;
- Storage policies отделяются от database schema;
- migration ledger становится provider-neutral;
- owner, migration и runtime roles разделяются; runtime role не имеет
  `BYPASSRLS`;
- `ai_execute_sql` сохраняет SELECT-only/timeout behavior, но получает
  переносимую модель ownership и grants.

Для каждого tenant применяется один и тот же immutable baseline и последующие
общие migrations.

### 3. Server-owned data API

Все browser `.from()`, `.rpc()`, `.auth()` и `.storage()` вызовы заменяются
versioned application endpoints. Сначала переносится один read-only vertical
slice, затем `DataContext`, conversations/notes/follow-ups, manual import,
configuration и admin writes. SQL не собирается из пользовательских identifiers;
filters и pagination имеют allowlisted contract.

RLS остается defense in depth, но authorization также выполняется на API
boundary. API устанавливает actor/team context в транзакции и использует
non-owner runtime role.

### 4. Identity replacement

Auth spike проверяет email/password, reset, invite-only signup, session cookies,
CSRF, admin disable/ban, membership lookup и Vercel deployment behavior.
Canonical `users.id` принадлежит приложению; auth accounts связываются через
`user_id + provider + provider_subject`.

Четыре текущих пользователя создаются/re-invite в новом provider. Старые
Supabase sessions после cutover считаются недействительными. Team UI работает
через внутренний admin API, а не через SDK конкретного identity provider.

### 5. Storage replacement

`lead-photos` и agent release artifacts разделяются на два назначения и два
набора прав. Object bytes копируются отдельно от database dump, затем
проверяются по count, size и checksum. В database хранятся application object
keys, а не Supabase bucket URLs. Signed URLs создаются только server-side.

### 6. Machine ingest and release transport

Sync agent получает tenant endpoint и machine credential вместо database
service credential. `/api/agent/ingest` проверяет tenant/machine scope,
валидирует payload и выполняет идемпотентные server-side transactions.
Remote config и release download переводятся на отдельные authenticated API
paths. Сначала поддерживается dual endpoint configuration для controlled
cutover, затем Supabase transport удаляется.

### 7. Operations provider

Сохраняются существующие `preflight → plan → owner approval → apply/resume →
verify`, digest, idempotency, registry и recovery contracts. Supabase-specific
P4-C runtime остается checkpoint/reference, а новый Neon adapter реализует:

- project/branch/role/database readiness;
- immutable schema apply;
- Vercel environment binding и build;
- identity bootstrap/re-invite;
- object storage configuration;
- smoke tests, backup/restore profile и drift detection.

Provisioning внешней компании разрешается только после успешного disposable
tenant и восстановления из backup.

### 8. Hosting portability without hosting migration

Текущий `VercelControlPlanePort` обобщается до `HostingControlPlanePort`.
Canonical contract описывает capabilities, а не Vercel resources:

- создать tenant deployment;
- привязать server/public environment values без возврата secrets;
- собрать pinned application revision;
- назначить domain;
- зарегистрировать schedules;
- promote/rollback deployment;
- проверить runtime, schedules, domain и build metadata.

Vercel-specific project IDs, function metadata, cron registration и deployment
promotion остаются внутри Vercel adapter. `frontend/api` handlers продолжают
использовать Web `Request`/`Response`; Vercel file routing изолируется тонким
entrypoint layer. `frontend/vercel.json` остается активным deployment manifest,
но больше не является canonical описанием hosting capabilities.

Отдельный hosting migration не запускается во время Neon cutover. После 30–60
дней эксплуатации двух tenants собираются фактические cost, duration, memory,
cron reliability и incident данные. Если появляется измеренный blocker, первым
escape spike рассматривается managed Node/container platform; Render — текущий
наиболее прямой кандидат, но не заранее выбранный второй vendor.

### 9. Cutover

Для внутреннего workspace:

1. создать Neon project, identity schema и object buckets;
2. провести минимум один rehearsal полного dump/restore и измерить время;
3. остановить UI writes, crons и старые sync schedules;
4. снять финальный dump, восстановить business/manual data и скопировать objects;
5. сверить schema inventory, row counts, milestone aggregates, messages,
   annotations, object counts/sizes/checksums;
6. переключить Vercel env и четыре user accounts;
7. перевести sync agents на ingest gateway и запустить catch-up;
8. проверить funnel totals, conversation history, new reply notify, briefing,
   Team admin и signed photos;
9. сохранить Supabase workspace read-only на ограниченный rollback window.

После приемки внутреннего workspace тот же provider-neutral onboarding создает
чистый второй tenant; данные между tenant projects не клонируются.

## Implementation phases

1. **Phase N0 — Measurements, ADR and checkpoint (S, 2–4 дня).**
   Снять DB/Storage size, growth/write profile и extension inventory; сохранить
   `c8a9d5f` как архивный Supabase P4-C checkpoint; утвердить Neon region/tier,
   RPO/RTO, object storage и auth candidate. Зафиксировать Vercel как временный
   adapter без обязательного срока замены.

2. **Phase N1 — Portable contracts and clean-room schema (M, 1–2 недели).**
   Ввести provider-neutral env/contracts, собрать Neon baseline, roles,
   migration ledger и clean-room assertions. Пройти inventory всех tables,
   views, functions, triggers, policies и extensions.

3. **Phase N2 — Read-only vertical slice (M, 3–5 дней).**
   Подключить GA Neon serverless driver за Vercel API и перенести один
   representative dashboard flow с pagination/RLS/actor-context. Это go/no-go
   gate до массового переписывания frontend. Одновременно выделить canonical
   hosting capabilities из Vercel control-plane types.

4. **Phase N3 — Application data API (L, 2–4 недели).**
   Перенести `DataContext`, component-local reads, writes, imports, configuration,
   AI/API SQL operations и admin endpoints за внутренний API. Добавить contract,
   authorization и regression tests.

5. **Phase N4 — Provider-agnostic identity (L, 2–3 недели).**
   Реализовать и проверить `IdentityProvider`, sessions, invite/reset/disable,
   Team admin и application-owned user mapping; re-invite четырех пользователей.
   Может частично идти параллельно с N3 после стабилизации API boundary.

6. **Phase N5 — Object storage (M, 1–2 недели).**
   Реализовать S3-compatible adapter, private access, signed URLs, object-copy
   inventory и agent release separation.

7. **Phase N6 — Machine ingest gateway (L, 2–3 недели).**
   Перевести sync agent, config, uploads, notify trigger и release download с
   service-role REST на scoped machine API; проверить replay/idempotency/revoke.

8. **Phase N7 — Neon operations provider and disposable tenant (L, 2–4 недели).**
   Адаптировать catalogs/plans/provider runtime, Vercel bindings, smoke,
   backup/restore и drift; пройти полный approved disposable onboarding.

9. **Phase N8 — Internal cutover and second tenant (M, 1–2 недели).**
   Провести rehearsal, финальный dump/object copy, write freeze, switch,
   catch-up, reconciliation и rollback check; затем создать чистый внешний
   tenant тем же путем.

Размеры фаз не складываются линейно из-за частичного параллелизма. Для одного
разработчика плановый диапазон остается 8–14 недель. Отдельный milestone через
4–6 недель — внутренний workspace на Neon, но еще без полностью принятого
автоматизированного onboarding второй компании.

Рекомендуемая Git-последовательность:

1. архивный checkpoint `archive/supabase-p4c-c8a9d5f` от текущего `main`;
2. короткая `codex/neon-adr-schema-spike`;
3. `codex/backend-contract`;
4. `codex/neon-schema-data`;
5. `codex/identity-provider`;
6. `codex/object-storage-provider`;
7. `codex/machine-ingest`;
8. `codex/ops-neon-provider`;
9. `codex/neon-cutover`.

Каждая ветка сливается после собственных contract/clean-room tests. Следующая
ветка может временно базироваться на предыдущей, но не должна месяцами расходиться
с `main`. Полный перенос восьми последних коммитов в отдельную branch и reset
`main` к `5adb6f6` не рекомендуется.

### Codex session protocol

Реализация разбивается на 28 последовательных Codex-сессий. Это execution units,
а не новые долгоживущие фазы или ветки. Каждая сессия:

1. начинается от актуального `main` либо от явно указанной еще не слитой
   dependency branch;
2. читает только `AGENTS.md`, эту master spec, handoff непосредственной
   dependency и файлы своего ownership;
3. использует ветку `codex/neon-sNN-<slug>`;
4. не расширяет ownership на соседнюю DB/Auth/Storage/ingest/ops область;
5. выполняет указанные проверки и просматривает полный diff;
6. заканчивается одним или несколькими логическими commits;
7. создает `docs/implementation-handoffs/N-SNN.md` и фиксирует:
   - commit hash и base SHA;
   - измененные файлы;
   - выполненные проверки и их результаты;
   - созданные external resource IDs без secrets;
   - известные ограничения;
   - точную стартовую точку следующей сессии;
8. после merge не оставляет рабочую ветку второй линией продукта.

Если acceptance check не проходит, сессия останавливается в своей области и не
начинает следующую. Старый provider path не удаляется, пока replacement не прошел
свой gate. Live provisioning, secrets, tenant creation, production promotion,
downtime и decommission всегда требуют отдельного owner approval.

### Codex session map

| Session | Phase | Ограниченная цель и ownership | Зависит от | Проверка и точка остановки |
|---|---|---|---|---|
| `S01` | N0 | Read-only DB/Storage/write measurements; только measurement artifacts и handoff | — | Повторяемые sizes/counts/extensions без secrets; зафиксирован downtime input |
| `S02` | N0 | Checkpoint `c8a9d5f`, ADR и provider decision matrix; только docs/checkpoint | S01 | Checkpoint разрешается в точный SHA, ссылки валидны; **G0: owner утверждает Neon tier/region, RPO/RTO, Auth и Storage candidate** |
| `S03` | N1 | `DataStore` query/transaction/pagination/actor contracts, fakes и tests; без adapter/UI | G0 | Contract tests покрывают UTC, pagination, authorization context и rollback |
| `S04` | N1 | Machine-readable inventory текущего v053 и Supabase-only dependency list | S02 | Сверены 25 tables, 8 views, functions, triggers, indexes, policies, extensions |
| `S05` | N1 | Portable business tables/indexes/views/constraints baseline; без identity/RLS | S04 | Clean apply в пустой Postgres и business inventory assertions |
| `S06` | N1 | Canonical users/provider mappings, runtime roles, actor context и RLS SQL | S05 | Runtime non-owner/non-`BYPASSRLS`; valid actor allow, anonymous/cross-user deny |
| `S07` | N1 | Portable functions/triggers и SELECT-only AI SQL guard | S06 | Milestone fixtures совпадают; mutation/timeout/ownership tests fail closed |
| `S08` | N1 | Clean-room schema, migration ledger и dump/restore/reconciliation harness | S07 | Два clean applies и restore с совпадающим inventory; **G1: disposable Neon approval и dump/restore go/no-go** |
| `S09` | N1 | `HostingControlPlanePort`, fake adapter и canonical capability tests | S02 | Canonical plans не содержат Vercel IDs/SDK types |
| `S10` | N1 | Перевести concrete Vercel adapter на S09 и новые env names | S09, S03, S06 | Ops suite и parity pinned build/env/domain/four schedules; hosting не меняется |
| `S11` | N2 | Neon driver, connection lifecycle и actor-scoped transaction wrapper | S03, S08 | DataStore contract suite на disposable Neon, rollback failure injection |
| `S12` | N2 | Один read-only dashboard slice browser → API → Neon | S11 | Old/new parity, >1000 pagination, UTC, auth deny, build; **G2: mass DataContext migration go/no-go** |
| `S13` | N3 | `DataContext` и component-local reads через application API | G2 | Inbound full pagination, outbound 90-day window, frontend build/tests; writes не трогаются |
| `S14` | N3 | Non-AI writes: import/config/pipeline/messages/notes/follow-ups | S13 | Authorization, atomicity, dedup, manual edit/delete и lock tests |
| `S15` | N3 | AI/server handlers: core/tools/briefing/classify/coach/notify/MCP | S11, S14, S07 | AI guard, job fixtures, notify concurrency, streaming/build; Supabase data client отсутствует |
| `S16` | N4 | Изолированный identity security spike; без product integration | G0, S06 | Cookies, CSRF, invite/reset/disable, mapping и Vercel smoke; **G3: accept/change Auth candidate** |
| `S17` | N4 | Production `IdentityProvider` и server session/admin endpoints | G3, S06 | Fake + adapter contract, rotation/revocation/CSRF/admin denial |
| `S18` | N4 | Frontend `AuthContext`, route gates и Team admin | S17, S13 | Sign-in/out/reset/invite/disable/expired-session build/tests; SMTP config — external gate |
| `S19` | N5 | `ObjectStorageProvider`, signed operations и tenant key isolation | G0, S17 | Allow/deny/missing/expiry/type/size tests; production bytes не копируются |
| `S20` | N5 | Lead photos UI/API и deterministic object manifest/copy/checksum tooling | S19 | Fixture count/size/checksum, signed rendering, forbidden-key tests; bucket creation — owner gate |
| `S21` | N6 | Tenant/machine-scoped `/api/agent/ingest`, credential/revoke/replay | S11, S14, S17 | Repeated payload идемпотентен, wrong tenant/revoked denied, partial write rolls back |
| `S22` | N6 | `agent.py` dual Supabase/ingest endpoint и rollout flags | S21 | `py_compile`, extraction parity, gateway dry-run/replay; старый transport сохранен |
| `S23` | N6 | Agent config/upload/notify/release через authenticated APIs | S22, S19, S20 | Signed release hash, revoke/expiry, upload isolation, non-fatal notify failure |
| `S24` | N7 | Provider-neutral ops catalogs/plans/JSON Schemas/registry migration | S08–S10, S17, S19, S21 | Fake onboarding end-to-end, version compatibility, stable digest/idempotency |
| `S25` | N7 | Neon/Identity/Storage/Hosting ops adapters и runtime wiring; без live apply | S24, S08, S10, S17, S19 | Mock/API contracts, redaction, ownership markers, resume-safe action IDs |
| `S26` | N7 | Approved disposable onboarding и restore drill | S25, S15, S18, S20, S23 | Full preflight/plan/apply/resume/verify, schema/smoke/restore/isolation; **G4: exact plan digest + registry version + idempotency key** |
| `S27` | N8 | Rehearsal и production cutover внутреннего workspace | S26 и все app migrations | Freeze, dump/object copy, reconciliation, four users, catch-up, smoke, rollback; **G5: owner approves downtime/env/agents/re-invites** |
| `S28` | N8 | Создать второй tenant, доказать repeatability и подготовить decommission | Принятый S27 + observation window | Separate resources/same baseline/SHA, isolation, no runtime Supabase; **G6: external tenant apply; Supabase deletion — отдельная break-glass session** |

### Context and sequencing rules

- `S04–S08` владеют только database artifacts; `S16–S18` — identity;
  `S19–S20` — Storage; `S21–S23` — agent/ingest; `S24–S26` — operations;
  `S27–S28` — execution evidence и cutover.
- `S13–S15` выполняются последовательно: это самая большая зона конфликтов в
  frontend/API. Параллелить их можно только после явного разделения ownership
  конкретных handlers.
- `S09–S10` можно выполнять параллельно с `S04–S08`, потому что они не меняют
  database baseline. `S16` и `S19` можно начинать после стабилизации их schema
  contracts, не редактируя `DataContext` или ops.
- `S26+` не исправляют найденные product defects внутри live provisioning
  сессии: каждый defect получает отдельную узкую repair-session/commit, затем
  `S26` продолжается по тому же idempotency contract.
- `S27` и `S28` всегда остаются разными сессиями, даже если observation window
  сокращен.
- Удаление Supabase SDK, dual transport и старых resources выполняется только
  после acceptance `S27`; физическое удаление Supabase остается отдельным
  явно одобренным break-glass действием после `S28`.

## Affected files/modules

- `frontend/src/lib/supabase.ts` — заменить provider-neutral browser client/API.
- `frontend/src/lib/AuthContext.tsx` — новый session/identity lifecycle.
- `frontend/src/lib/DataContext.tsx` — перенос прямых reads за application API.
- `frontend/src/lib/leadPhotos.ts` — object storage API вместо Supabase Storage.
- `frontend/src/components/ConversationDrawer.tsx`,
  `FollowUpPanel.tsx`, `LeadNotesPanel.tsx` — убрать component-local PostgREST.
- `frontend/api/_lib/core.ts`, `auth.ts`, `tools.ts` — database driver,
  actor context, authorization и transaction boundary.
- `frontend/api/pipeline.ts`, `import.ts`, `config.ts`, `classify.ts`,
  `briefing.ts`, `notify-replies.ts`, `mcp.ts` и прочие handlers с
  `.from()`/`.rpc()` — repository/API migration.
- Новые `frontend/api/_lib/data/`, `identity/`, `storage/` contracts и adapters.
- `sync-agent/agent.py`, `config.example.yaml`, `deploy.sh` — machine ingest,
  config и release transport.
- `supabase/tenant-baseline/v053/` и `supabase/migrations/` — источник migration
  inventory, позже historical archive, но не runtime catalog.
- Новый provider-neutral каталог schema migrations, точное расположение
  фиксируется в N0/N1.
- `ops/src/providers/interfaces.ts`, `adapters.ts`, `p4c-sdk.ts`,
  `runtime/p4c-runtime.ts` — Neon/hosting/identity/storage provider ports;
  Vercel остается concrete hosting adapter.
- `ops/src/core/onboarding-*`, `provider-preflight.ts`, `catalogs.ts` —
  provider-neutral plan effects и catalogs.
- `docs/platform-ops/contracts/`, runbooks, handoffs и
  `specs/2026-07-29-managed-company-workspaces.md` — новые provider names,
  capabilities, recovery и status после одобрения этой спецификации.
- `docs/implementation-handoffs/N-SNN.md` — обязательный ограниченный context
  packet каждой Codex-сессии; создается только соответствующей сессией.
- `frontend/vercel.json` и environment documentation — новые server-only
  database/auth/storage/machine secrets; manifest остается Vercel-specific
  adapter input, а не canonical hosting contract.

## Risks & how to verify

- **Скрытые Supabase schema dependencies.** Проверить clean-room apply в пустом
  Neon project и автоматически сравнить полный inventory tables/views/functions/
  triggers/indexes/RLS policies с утвержденным manifest.
- **RLS обходится owner role.** Runtime использует отдельную non-owner,
  non-`BYPASSRLS` role; negative tests доказывают cross-user и anonymous denial.
- **Frontend migration меняет поведение pagination/date filtering.** Contract
  tests сравнивают old/new responses на фиксированном dump, включая >1000 rows,
  UTC ranges и inbound/outbound asymmetry.
- **Auth library становится новым lock-in.** Business tables ссылаются только на
  canonical `users.id`; provider subject хранится в mapping table; Team UI и API
  тестируются через `IdentityProvider` fake и production adapter.
- **Потеря manual messages/annotations.** Они обязательно входят в dump/restore;
  post-cutover reconciliation сравнивает row counts, hashes и milestone totals,
  а не полагается на LH2 catch-up.
- **Потеря Storage bytes.** Object copy имеет manifest с key, size и checksum;
  signed read проверяется для выборки и отсутствующих/запрещенных keys.
- **Дубликаты при catch-up.** Повторный ingest одного payload и повторный запуск
  агента не меняют totals; проверяются existing unique keys и dedup normalized
  body + direction для messages.
- **Serverless transaction semantics.** Multi-statement writes используют
  transaction-capable driver path; failure injection подтверждает atomicity.
- **AI SQL runner получает лишние права.** Сохраняются SELECT/WITH-only guard,
  timeout, NOLOGIN/least-privilege ownership и service-only access; mutation and
  timeout tests обязаны падать безопасно.
- **Operations core смешан с Supabase provider.** Fake-provider suite продолжает
  проходить без Neon credentials; provider-specific catalogs не проникают в
  canonical plan schema без version bump.
- **Hosting abstraction становится абстракцией только по названию.** Fake hosting
  adapter и contract tests должны планировать deployment/domain/env/schedules
  без Vercel IDs или SDK types. Concrete Vercel adapter отдельно доказывает
  соответствие canonical result.
- **Одновременный hosting cutover маскирует DB/Auth ошибки.** Во время Neon
  migration production hosting остается Vercel; non-Vercel spike не является
  зависимостью ни одной фазы до post-cutover observation window.
- **Неизвестный объем увеличит downtime.** Два rehearsal измеряют dump, restore,
  object copy и catch-up. Если окно превышено, только тогда план повышается до
  logical replication/dual-readiness.
- **Две долгоживущие ветки расходятся.** Merge queue допускает небольшие slices;
  checkpoint branch остается read-only и никогда не становится второй линией
  продукта.

Проверки каждой фазы включают frontend build/tests, API authorization tests,
sync-agent dry-run/replay tests, ops test suite, clean-room schema apply,
disposable tenant provisioning и документированный restore rehearsal.

## Definition of done

- В production source/runtime нет Supabase SDK, URL, anon/service-role keys,
  PostgREST, Supabase Auth или Supabase Storage dependency.
- Внутренний workspace работает на отдельном Neon project; второй company
  workspace создается в другом Neon project из того же baseline и pinned app SHA.
- Все browser data access проходит через authenticated application API.
- Canonical users/memberships не зависят от identity-provider subject; invite,
  sign-in, reset, sign-out, disable и admin flows проверены.
- Все четыре пользователя получили новый доступ; старые Supabase sessions не
  принимаются.
- Private lead photos и agent artifacts находятся в утвержденном object storage;
  signed access и negative authorization tests проходят.
- Sync agents используют tenant-scoped machine credentials, умеют replay/catch-up
  и не имеют database owner/service credentials.
- Schema inventory, row counts, milestone metrics, messages, annotations и object
  manifests совпадают до/после внутреннего cutover в пределах объяснимых
  post-freeze arrivals.
- Disposable tenant проходит `preflight → plan → approval → apply/resume →
  verify`; backup успешно восстановлен в rehearsal environment.
- Vercel работает через provider-neutral hosting contract; canonical operations
  schemas, registry и application handlers не содержат `@vercel/sdk` types.
- Два tenants собираются и проверяются через Vercel adapter, а fake hosting
  adapter проходит тот же contract suite без внешнего provider.
- Один tenant не может читать данные, secrets, builds или backups другого.
- Supabase P4-C checkpoint и rollback window документированы; после приемки
  Supabase переводится в read-only, затем удаляется только отдельным явно
  одобренным break-glass действием.
- Все короткие migration branches слиты; нет отдельной расходящейся ветки
  «мультитенантность потом».
