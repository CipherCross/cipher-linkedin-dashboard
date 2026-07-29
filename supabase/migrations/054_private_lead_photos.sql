-- Private lead-photo delivery.
--
-- The v053 tenant baseline already creates this bucket as private. The existing
-- internal project was created by migration 042 with public = true, so this
-- shared delta deliberately converges both starting states on the same result.
-- The sync agent keeps uploading with service_role (and therefore bypasses
-- Storage RLS); dashboard users can only mint/download signed URLs while their
-- authenticated identity is linked to an active team member.

insert into storage.buckets (id, name, public)
values ('lead-photos', 'lead-photos', false)
on conflict (id) do update
set name = excluded.name,
    public = false;

drop policy if exists "active members can read lead photos"
  on storage.objects;

create policy "active members can read lead photos"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'lead-photos'
    and public.is_active_team_member()
  );

