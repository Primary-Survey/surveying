-- Creates an RPC used by both the web and mobile apps to delete a project and all its points.
-- This is SECURITY DEFINER so it can work even when RLS prevents direct deletes from the client.
--
-- IMPORTANT:
-- - Apply this in Supabase SQL Editor or via supabase CLI migrations.
-- - The function should be owned by a role that can bypass RLS (typically postgres).

create or replace function public.delete_project_cascade(project_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Make sure this function can delete even if row level security is enabled.
  -- (Table owners bypass RLS unless FORCE ROW LEVEL SECURITY is enabled.)

  delete from public.data_points
  where data_points.project_id = delete_project_cascade.project_id;

  delete from public.projects
  where projects.id = delete_project_cascade.project_id;
end;
$$;

-- Allow authenticated clients to call it.
revoke all on function public.delete_project_cascade(uuid) from public;
grant execute on function public.delete_project_cascade(uuid) to authenticated;
