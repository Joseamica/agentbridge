create table users (
  id uuid primary key default gen_random_uuid(),
  handle text not null unique check (handle ~ '^[a-z0-9][a-z0-9-]{1,31}$'),
  display_name text not null check (length(display_name) between 1 and 80),
  created_at timestamptz not null default now()
);

create table enrollments (
  code_hash text primary key,
  user_id uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz
);

create table devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  name text not null,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table contact_invites (
  code_hash text primary key,
  responder_id uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by uuid references users(id) on delete set null
);

create table grants (
  id uuid primary key default gen_random_uuid(),
  responder_id uuid not null references users(id) on delete cascade,
  asker_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  check (responder_id <> asker_id)
);
create unique index grants_one_active_per_pair on grants (responder_id, asker_id) where revoked_at is null;

create table tickets (
  id uuid primary key default gen_random_uuid(),
  grant_id uuid not null references grants(id) on delete cascade,
  asker_id uuid not null references users(id) on delete cascade,
  responder_id uuid not null references users(id) on delete cascade,
  question text not null,
  status text not null check (status in ('queued', 'dispatched', 'answered', 'expired', 'cancelled')),
  answer text,
  answer_source text,
  answer_confidence text check (answer_confidence in ('seguro', 'creo', 'no_se')),
  created_at timestamptz not null default now(),
  dispatched_at timestamptz,
  answered_at timestamptz,
  expires_at timestamptz not null
);
create index tickets_queue on tickets (responder_id, created_at) where status = 'queued';
create index tickets_pair_created on tickets (asker_id, responder_id, created_at);
create index tickets_created on tickets (created_at);

create table attempts (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references tickets(id) on delete cascade,
  device_id uuid not null references devices(id) on delete cascade,
  code text not null,
  sent_at timestamptz not null default now(),
  deadline_at timestamptz not null,
  closed_at timestamptz,
  outcome text check (outcome in ('answered', 'timeout', 'disconnected', 'cancelled'))
);
create index attempts_open on attempts (deadline_at) where closed_at is null;

create table events (
  id bigserial primary key,
  ticket_id uuid references tickets(id) on delete set null,
  actor_user_id uuid references users(id) on delete set null,
  kind text not null,
  detail jsonb not null default '{}'::jsonb,
  at timestamptz not null default now()
);
create index events_at on events (at);
