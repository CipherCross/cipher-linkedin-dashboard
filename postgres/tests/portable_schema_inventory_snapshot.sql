\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on
\pset footer off
\pset border 0

-- Deterministic, provider-neutral inventory snapshot of a tenant database.
--
-- The output is one sorted line per catalogued object property, so two
-- snapshots can be compared with a plain textual diff. It is used twice:
--
--   * between two independent clean applies, to prove the baseline set is
--     reproducible;
--   * between the pre-dump source and the post-restore target, to prove
--     pg_dump/pg_restore carried everything that matters.
--
-- It covers schemas, extensions and their member objects, tables, columns,
-- views, indexes, constraints, sequences and identity definitions, functions,
-- triggers, policies, RLS flags, ownership, table grants, column-level grants,
-- default privileges, the application roles and their memberships.
--
-- Deliberately excluded because they are legitimately volatile and would make
-- every diff fail for no reason: OIDs, sequence last_value, row data, planner
-- statistics, and the timestamps inside the migration ledger. Sequence values
-- and ledger rows are reconciled separately in
-- portable_restore_reconciliation.sql, which is the only place they must match.
--
-- Long expressions (view, function, policy and default bodies) are reduced to
-- an md5 digest so a line stays readable while still failing on any change.
--
-- Every ACL is rendered as its EFFECTIVE, sorted privilege set: a NULL catalog
-- ACL is expanded through acldefault() and the items are ordered. Without this,
-- two databases that grant exactly the same privileges still differ textually,
-- because PostgreSQL stores a never-touched ACL as NULL and preserves the
-- historical order of grants. Normalising here keeps the diff meaningful; a
-- privilege that genuinely changed still shows up.

WITH app_schemas AS (
    SELECT oid, nspname FROM pg_namespace WHERE nspname IN ('public', 'app_ledger')
),
extension_members AS (
    SELECT objid, classid FROM pg_depend WHERE deptype = 'e'
)
SELECT line FROM (

    -- Schemas: ownership and the ACL that closes anonymous access.
    SELECT format('schema|%s|owner=%s|acl=%s',
                  n.nspname,
                  pg_get_userbyid(n.nspowner),
                  (SELECT coalesce(string_agg(ai::text, ',' ORDER BY ai::text), '<none>')
                     FROM unnest(coalesce(n.nspacl, acldefault('n', n.nspowner))) AS ai)) AS line
    FROM pg_namespace n
    JOIN app_schemas s ON s.oid = n.oid

    UNION ALL
    -- The database-level grant the baseline needs for the trusted extension.
    -- datacl carries role names, not the database name, so a differently named
    -- restore target still compares equal.
    SELECT format('database|acl=%s', (SELECT coalesce(string_agg(ai::text, ',' ORDER BY ai::text), '<none>')
                     FROM unnest(coalesce(d.datacl, acldefault('d', d.datdba))) AS ai))
    FROM pg_database d
    WHERE d.datname = current_database()

    UNION ALL
    -- Extensions. pgcrypto must stay installed in public.
    SELECT format('extension|%s|owner=%s|schema=%s|version=%s|relocatable=%s',
                  e.extname,
                  pg_get_userbyid(e.extowner),
                  n.nspname,
                  e.extversion,
                  e.extrelocatable)
    FROM pg_extension e
    JOIN pg_namespace n ON n.oid = e.extnamespace

    UNION ALL
    -- How many catalog objects belong to an extension. The portable function
    -- inventory must never absorb pgcrypto's functions, so this count is
    -- asserted rather than assumed.
    SELECT format('extension_member_count|%s', count(*)::text)
    FROM extension_members

    UNION ALL
    -- Tables, ordinary and otherwise, with both RLS flags. Restoring RLS as
    -- FORCE when the source was not FORCE would silently change who can read
    -- what, so relforcerowsecurity is part of the snapshot.
    SELECT format('table|%s.%s|owner=%s|kind=%s|persistence=%s|rls=%s|force_rls=%s|acl=%s',
                  n.nspname, c.relname,
                  pg_get_userbyid(c.relowner),
                  c.relkind,
                  c.relpersistence,
                  c.relrowsecurity,
                  c.relforcerowsecurity,
                  (SELECT coalesce(string_agg(ai::text, ',' ORDER BY ai::text), '<none>')
                     FROM unnest(coalesce(c.relacl, acldefault('r', c.relowner))) AS ai))
    FROM pg_class c
    JOIN app_schemas n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p')
      AND NOT EXISTS (SELECT 1 FROM extension_members m
                      WHERE m.classid = 'pg_class'::regclass AND m.objid = c.oid)

    UNION ALL
    -- Columns, including identity definitions and column-level grants. The AI
    -- sandbox is column-scoped on team_members and instances, and that scoping
    -- is invisible in a table-level ACL.
    SELECT format('column|%s.%s.%s|num=%s|type=%s|notnull=%s|default=%s|identity=%s|generated=%s|collation=%s|acl=%s',
                  n.nspname, c.relname, a.attname,
                  a.attnum,
                  format_type(a.atttypid, a.atttypmod),
                  a.attnotnull,
                  coalesce(pg_get_expr(ad.adbin, ad.adrelid), '<none>'),
                  coalesce(nullif(a.attidentity::text, ''), '<none>'),
                  coalesce(nullif(a.attgenerated::text, ''), '<none>'),
                  coalesce((SELECT co.collname FROM pg_collation co WHERE co.oid = a.attcollation), '<none>'),
                  (SELECT coalesce(string_agg(ai::text, ',' ORDER BY ai::text), '<none>')
                     FROM unnest(coalesce(a.attacl, acldefault('c', c.relowner))) AS ai))
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN app_schemas n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
    WHERE a.attnum > 0
      AND NOT a.attisdropped
      AND c.relkind IN ('r', 'p', 'v')
      AND NOT EXISTS (SELECT 1 FROM extension_members m
                      WHERE m.classid = 'pg_class'::regclass AND m.objid = c.oid)

    UNION ALL
    -- Views, with the security_invoker reloption spelled out. A view that comes
    -- back as security_definer would run with the owner's rights and quietly
    -- bypass RLS for every reader.
    SELECT format('view|%s.%s|owner=%s|security_invoker=%s|security_barrier=%s|acl=%s|defmd5=%s',
                  n.nspname, c.relname,
                  pg_get_userbyid(c.relowner),
                  coalesce((SELECT option_value FROM pg_options_to_table(c.reloptions)
                             WHERE option_name = 'security_invoker'), 'false'),
                  coalesce((SELECT option_value FROM pg_options_to_table(c.reloptions)
                             WHERE option_name = 'security_barrier'), 'false'),
                  (SELECT coalesce(string_agg(ai::text, ',' ORDER BY ai::text), '<none>')
                     FROM unnest(coalesce(c.relacl, acldefault('r', c.relowner))) AS ai),
                  md5(pg_get_viewdef(c.oid, true)))
    FROM pg_class c
    JOIN app_schemas n ON n.oid = c.relnamespace
    WHERE c.relkind = 'v'

    UNION ALL
    SELECT format('index|%s.%s|%s|unique=%s|primary=%s|def=%s',
                  n.nspname, t.relname, i.relname,
                  x.indisunique, x.indisprimary,
                  pg_get_indexdef(i.oid))
    FROM pg_index x
    JOIN pg_class i ON i.oid = x.indexrelid
    JOIN pg_class t ON t.oid = x.indrelid
    JOIN app_schemas n ON n.oid = t.relnamespace
    WHERE NOT EXISTS (SELECT 1 FROM extension_members m
                      WHERE m.classid = 'pg_class'::regclass AND m.objid = t.oid)

    UNION ALL
    SELECT format('constraint|%s.%s|%s|type=%s|deferrable=%s|validated=%s|def=%s',
                  n.nspname, c.relname, con.conname,
                  con.contype, con.condeferrable, con.convalidated,
                  pg_get_constraintdef(con.oid))
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN app_schemas n ON n.oid = c.relnamespace
    WHERE NOT EXISTS (SELECT 1 FROM extension_members m
                      WHERE m.classid = 'pg_class'::regclass AND m.objid = c.oid)

    UNION ALL
    -- Sequence shape and the identity column it is attached to. Current values
    -- are excluded here on purpose and reconciled separately.
    SELECT format('sequence|%s.%s|owner=%s|type=%s|start=%s|increment=%s|min=%s|max=%s|cycle=%s|ownedby=%s|acl=%s',
                  n.nspname, c.relname,
                  pg_get_userbyid(c.relowner),
                  format_type(s.seqtypid, NULL),
                  s.seqstart, s.seqincrement, s.seqmin, s.seqmax, s.seqcycle,
                  coalesce((SELECT format('%s.%s', dn.nspname, dc.relname || '.' || da.attname)
                              FROM pg_depend d
                              JOIN pg_class dc ON dc.oid = d.refobjid
                              JOIN pg_namespace dn ON dn.oid = dc.relnamespace
                              JOIN pg_attribute da ON da.attrelid = d.refobjid AND da.attnum = d.refobjsubid
                             WHERE d.classid = 'pg_class'::regclass
                               AND d.objid = c.oid
                               AND d.deptype IN ('a', 'i')
                             LIMIT 1), '<none>'),
                  (SELECT coalesce(string_agg(ai::text, ',' ORDER BY ai::text), '<none>')
                     FROM unnest(coalesce(c.relacl, acldefault('s', c.relowner))) AS ai))
    FROM pg_class c
    JOIN app_schemas n ON n.oid = c.relnamespace
    JOIN pg_sequence s ON s.seqrelid = c.oid
    WHERE c.relkind = 'S'

    UNION ALL
    -- Functions, excluding extension members. SECURITY DEFINER and the pinned
    -- search_path are part of the line: both are load-bearing for the AI guard
    -- and for every SECURITY DEFINER RPC.
    SELECT format('function|%s.%s|owner=%s|lang=%s|secdef=%s|volatile=%s|leakproof=%s|config=%s|acl=%s|srcmd5=%s',
                  n.nspname,
                  p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
                  pg_get_userbyid(p.proowner),
                  l.lanname,
                  p.prosecdef,
                  p.provolatile,
                  p.proleakproof,
                  coalesce(array_to_string(p.proconfig, ','), '<none>'),
                  (SELECT coalesce(string_agg(ai::text, ',' ORDER BY ai::text), '<none>')
                     FROM unnest(coalesce(p.proacl, acldefault('f', p.proowner))) AS ai),
                  md5(coalesce(p.prosrc, '')))
    FROM pg_proc p
    JOIN app_schemas n ON n.oid = p.pronamespace
    JOIN pg_language l ON l.oid = p.prolang
    WHERE NOT EXISTS (SELECT 1 FROM extension_members m
                      WHERE m.classid = 'pg_proc'::regclass AND m.objid = p.oid)

    UNION ALL
    SELECT format('trigger|%s.%s|%s|enabled=%s|def=%s',
                  n.nspname, c.relname, t.tgname,
                  t.tgenabled,
                  pg_get_triggerdef(t.oid))
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN app_schemas n ON n.oid = c.relnamespace
    WHERE NOT t.tgisinternal

    UNION ALL
    SELECT format('policy|%s.%s|%s|cmd=%s|permissive=%s|roles=%s|usingmd5=%s|checkmd5=%s',
                  n.nspname, c.relname, pol.polname,
                  pol.polcmd,
                  pol.polpermissive,
                  coalesce((SELECT string_agg(pg_get_userbyid(r), ',' ORDER BY pg_get_userbyid(r))
                              FROM unnest(pol.polroles) AS r), '<public>'),
                  coalesce(md5(pg_get_expr(pol.polqual, pol.polrelid)), '<none>'),
                  coalesce(md5(pg_get_expr(pol.polwithcheck, pol.polrelid)), '<none>'))
    FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN app_schemas n ON n.oid = c.relnamespace

    UNION ALL
    -- Application roles. Cluster-level and never carried by pg_dump, so a
    -- matching line here proves the restore target was prepared by the same
    -- control-plane bootstrap rather than by a role dump.
    SELECT format('role|%s|super=%s|login=%s|bypassrls=%s|inherit=%s|createrole=%s|createdb=%s|replication=%s',
                  r.rolname, r.rolsuper, r.rolcanlogin, r.rolbypassrls,
                  r.rolinherit, r.rolcreaterole, r.rolcreatedb, r.rolreplication)
    FROM pg_roles r
    WHERE r.rolname LIKE 'app\_%'

    UNION ALL
    SELECT format('rolemember|%s|of=%s|admin=%s',
                  m.rolname, g.rolname, am.admin_option)
    FROM pg_auth_members am
    JOIN pg_roles m ON m.oid = am.member
    JOIN pg_roles g ON g.oid = am.roleid
    WHERE m.rolname LIKE 'app\_%' OR g.rolname LIKE 'app\_%'

    UNION ALL
    SELECT format('defaultacl|%s|%s|%s|acl=%s',
                  pg_get_userbyid(d.defaclrole),
                  coalesce((SELECT nspname FROM pg_namespace WHERE oid = d.defaclnamespace), '<global>'),
                  d.defaclobjtype,
                  (SELECT coalesce(string_agg(ai::text, ',' ORDER BY ai::text), '<none>')
                     FROM unnest(coalesce(d.defaclacl, acldefault(d.defaclobjtype, d.defaclrole))) AS ai))
    FROM pg_default_acl d

    UNION ALL
    -- Aggregate counts. A diff of the detail lines already catches any change,
    -- but the counts make a truncated or partially restored database obvious at
    -- a glance instead of buried in a long diff.
    SELECT format('count|%s|%s', label, value::text)
    FROM (
        SELECT 'business_tables' AS label,
               (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = 'public' AND c.relkind = 'r') AS value
        UNION ALL SELECT 'views',
               (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = 'public' AND c.relkind = 'v')
        UNION ALL SELECT 'rls_tables',
               (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity)
        UNION ALL SELECT 'policies',
               (SELECT count(*) FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
                 JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public')
        UNION ALL SELECT 'functions',
               (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'public'
                   AND NOT EXISTS (SELECT 1 FROM pg_depend d
                                    WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'))
        UNION ALL SELECT 'triggers',
               (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = 'public' AND NOT t.tgisinternal)
        UNION ALL SELECT 'indexes',
               (SELECT count(*) FROM pg_index x JOIN pg_class t ON t.oid = x.indrelid
                 JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = 'public')
        UNION ALL SELECT 'constraints',
               (SELECT count(*) FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
                 JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public')
        UNION ALL SELECT 'security_definer_functions',
               (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'public' AND p.prosecdef
                   AND NOT EXISTS (SELECT 1 FROM pg_depend d
                                    WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'))
        UNION ALL SELECT 'identity_columns',
               (SELECT count(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = 'public' AND a.attidentity <> '' AND NOT a.attisdropped)
    ) counts

) all_lines
ORDER BY line;
