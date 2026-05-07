create table if not exists acp_remote_session_bindings (
  account_id text not null,
  client_device_id text not null,
  session_id text not null,
  host_id text not null,
  agent_json text,
  workspace_roots_json text,
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp,
  primary key (account_id, client_device_id, session_id),
  foreign key (account_id) references acp_accounts(account_id),
  foreign key (account_id, client_device_id)
    references acp_client_devices(account_id, client_device_id),
  foreign key (account_id, host_id) references acp_hosts(account_id, host_id)
);

create index if not exists acp_remote_session_bindings_host_idx
  on acp_remote_session_bindings(account_id, host_id);
