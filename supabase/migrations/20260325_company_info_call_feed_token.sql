-- Add a practice-level feed token for the On Call & Bari Call iCal feed.
-- A random UUID is generated automatically for any existing row.

alter table company_info
  add column if not exists call_feed_token text default gen_random_uuid()::text;

-- Back-fill existing row in case default didn't apply (idempotent).
update company_info set call_feed_token = gen_random_uuid()::text where call_feed_token is null;
