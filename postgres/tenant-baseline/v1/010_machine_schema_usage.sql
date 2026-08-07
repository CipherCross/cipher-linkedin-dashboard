-- One schema grant: USAGE on public to app_machine, and nothing else. Apply
-- after 009 in a tenant database that has received the full baseline.
--
-- Why this step exists, stated as the correction it is. Step 009 gave the
-- machine principal table grants, sequence grants, two function grants and nine
-- policies -- and no USAGE on the schema those objects live in. Every one of
-- them is therefore unreachable: PostgreSQL checks schema USAGE before it
-- checks any privilege on an object inside it, so the first statement of the
-- first ingest fails with 42501 "permission denied for schema public" and
-- nothing in step 009 can be exercised at all.
--
-- The omission was invisible to review because the other principals never
-- needed it said out loud. app_runtime and app_readonly receive it in step 002
-- and app_system in step 003, each as one line among many; app_machine was
-- reserved with no grants at all until step 009, so it was the first role to
-- arrive at the schema boundary with nothing behind it. It was found by the
-- live suite on its first run against a real app_machine login, which is
-- exactly the class of defect an offline fake cannot show: a fake has no
-- schemas.
--
-- Why a new step rather than a fix to 009. The ledger is append-only and 009 is
-- applied: its SHA-256 is recorded in app_ledger.applied_migration, pinned in
-- the manifest and asserted by the static assertions, so editing its bytes
-- would put every database that already received it permanently at odds with
-- the ledger. down_migrations.supported is false by contract. A correction to
-- an applied step is a new step; that is the whole shape of the instrument.
--
-- What this step does NOT do. It grants no privilege on any object, adds no
-- policy, creates nothing and touches no other role. USAGE on a schema is the
-- right to *reach* objects in it and is not by itself the right to do anything
-- with one: with this grant and no others, app_machine could still touch
-- nothing, because step 009's grants are what say which objects and which
-- commands. CREATE on the schema is deliberately absent -- the machine
-- principal must never be able to add an object to public.

SET ROLE app_owner;

GRANT USAGE ON SCHEMA public TO app_machine;

RESET ROLE;
