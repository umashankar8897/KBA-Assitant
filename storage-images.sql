-- Storage for KBA step screenshots
--
-- Files are laid out as:  <org_id>/<kba_reference>/<filename>
-- The policies below read the first folder in that path and compare it to the
-- caller's organisation, which is what keeps one organisation's screenshots out
-- of another's reach.
--
-- Run once in the SQL editor.

-- Private bucket. Screenshots of internal systems are not something to serve
-- publicly, so files are reached through short-lived signed URLs rather than a
-- permanent public link.
insert into storage.buckets (id, name, public)
values ('kba-images', 'kba-images', false)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------------

drop policy if exists "read org kba images"     on storage.objects;
drop policy if exists "admins upload kba images" on storage.objects;
drop policy if exists "admins delete kba images" on storage.objects;

-- Anyone in the organisation can view its screenshots — analysts need them
-- during a call.
create policy "read org kba images" on storage.objects
  for select using (
    bucket_id = 'kba-images'
    and (storage.foldername(name))[1] = public.current_org_id()::text
  );

-- Only admins add or remove them, matching who can edit KBAs.
create policy "admins upload kba images" on storage.objects
  for insert with check (
    bucket_id = 'kba-images'
    and (storage.foldername(name))[1] = public.current_org_id()::text
    and public.current_user_role() = 'admin'
  );

create policy "admins delete kba images" on storage.objects
  for delete using (
    bucket_id = 'kba-images'
    and (storage.foldername(name))[1] = public.current_org_id()::text
    and public.current_user_role() = 'admin'
  );
