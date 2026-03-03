-- Workflow Studio catalog tables (Supabase/Postgres)
-- Apply in your Supabase SQL editor before enabling SUPABASE_* env vars.

create table if not exists public.workflow_sites (
  id uuid primary key,
  key text not null unique,
  name text not null,
  description text,
  status text not null default 'draft',
  domains text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.workflow_tools (
  id uuid primary key,
  site_id uuid not null references public.workflow_sites(id) on delete cascade,
  key text not null,
  name text not null,
  description text,
  group_key text not null default 'listing_crud',
  status text not null default 'draft',
  workflow_key text not null,
  operation text not null,
  stage_plan text[] not null default '{navigate,fill_data,confirm,complete,verify}',
  required_fields text[] not null default '{}',
  allowed_fields text[] not null default '{}',
  prompt_template text not null,
  selector_hints jsonb,
  preset_code text,
  version integer not null default 1,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(site_id, key)
);

create index if not exists workflow_tools_site_idx on public.workflow_tools(site_id);
create index if not exists workflow_tools_status_idx on public.workflow_tools(status);

