create table if not exists acp_github_accounts (
  github_id integer primary key,
  github_login text not null,
  account_id text not null,
  created_at integer not null,
  foreign key (account_id) references acp_accounts(account_id)
);

create table if not exists acp_oauth_states (
  state text primary key,
  return_to text not null,
  created_at integer not null
);

create index if not exists acp_oauth_states_expiry_idx
  on acp_oauth_states(created_at);
