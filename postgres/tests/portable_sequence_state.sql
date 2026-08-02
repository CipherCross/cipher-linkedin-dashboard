\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on
\pset footer off
\pset border 0

-- Sequence and identity state, emitted as sorted diffable lines.
--
-- Kept out of the schema inventory snapshot on purpose: two independent clean
-- applies legitimately differ here, because one of them may have been seeded.
-- Between a pre-dump source and its post-restore target they must match exactly
-- — an identity sequence that comes back at its start value hands out primary
-- keys that already exist.

-- Business tables are read through the owner capability: RLS would otherwise
-- hide every row from a principal with no actor, and this file is counting
-- rows, not testing authorization.
SET ROLE app_owner;

SELECT line FROM (
    SELECT format('sequence_value|%s.%s|last_value=%s',
                  s.schemaname, s.sequencename,
                  coalesce(s.last_value::text, '<unused>')) AS line
    FROM pg_sequences s
    WHERE s.schemaname IN ('public', 'app_ledger')

    UNION ALL
    -- The row counts the sequences are supposed to be consistent with.
    SELECT format('row_count|%s|%s', relname, n_live)
    FROM (
        SELECT 'users' AS relname, (SELECT count(*) FROM public.users) AS n_live
        UNION ALL SELECT 'user_identities', (SELECT count(*) FROM public.user_identities)
        UNION ALL SELECT 'team_members', (SELECT count(*) FROM public.team_members)
        UNION ALL SELECT 'instances', (SELECT count(*) FROM public.instances)
        UNION ALL SELECT 'campaigns', (SELECT count(*) FROM public.campaigns)
        UNION ALL SELECT 'leads', (SELECT count(*) FROM public.leads)
        UNION ALL SELECT 'messages', (SELECT count(*) FROM public.messages)
        UNION ALL SELECT 'playbook', (SELECT count(*) FROM public.playbook)
        UNION ALL SELECT 'applied_migration', (SELECT count(*) FROM app_ledger.applied_migration)
        UNION ALL SELECT 'role_bootstrap', (SELECT count(*) FROM app_ledger.role_bootstrap)
    ) counts

    UNION ALL
    -- The ledger itself, without its timestamps.
    SELECT format('ledger|%s|%s|%s|%s/%s|seq=%s',
                  step, artifact, sha256, apply_principal, apply_role, applied_seq)
    FROM app_ledger.applied_migration
) all_lines
ORDER BY line;
