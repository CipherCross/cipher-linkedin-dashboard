\set ON_ERROR_STOP on

-- Exercise the Storage policy as the provider roles, not as postgres/service.
-- Everything is rolled back so the clean-room empty-data invariant remains true.
begin;

insert into auth.users (id)
values
  ('10000000-0000-0000-0000-000000000001'),
  ('10000000-0000-0000-0000-000000000002');

insert into public.team_members (name, active, auth_user_id, email, role)
values
  (
    'P1-C active member',
    true,
    '10000000-0000-0000-0000-000000000001',
    'p1c-active@example.invalid',
    'member'
  ),
  (
    'P1-C inactive member',
    false,
    '10000000-0000-0000-0000-000000000002',
    'p1c-inactive@example.invalid',
    'member'
  );

insert into storage.objects (bucket_id, name)
values ('lead-photos', 'p1c/avatar.jpg');

set local "request.jwt.claim.sub" = '10000000-0000-0000-0000-000000000001';
set local role authenticated;
select count(*) as active_photo_count
from storage.objects
where bucket_id = 'lead-photos'
\gset
\if :active_photo_count
\else
  \echo 'active authenticated member cannot read lead photo'
  \quit 1
\endif

reset role;
set local "request.jwt.claim.sub" = '10000000-0000-0000-0000-000000000002';
set local role authenticated;
select count(*) as inactive_photo_count
from storage.objects
where bucket_id = 'lead-photos'
\gset
\if :inactive_photo_count
  \echo 'inactive authenticated member can read lead photo'
  \quit 1
\endif

reset role;
set local "request.jwt.claim.sub" = '';
set local role anon;
select count(*) as anonymous_photo_count
from storage.objects
where bucket_id = 'lead-photos'
\gset
\if :anonymous_photo_count
  \echo 'anonymous role can read lead photo'
  \quit 1
\endif

reset role;
rollback;

