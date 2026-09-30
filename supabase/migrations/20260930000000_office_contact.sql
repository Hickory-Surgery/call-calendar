-- Designated practice contact: the account whose email is used as the To/Reply-To of the
-- weekly schedule email (so replies reach a live inbox instead of noreply@), and who is
-- alerted when an email bounces. Stored as a user id, not an address, so it follows the
-- account's email automatically; if the account is deleted it falls back to NULL and the
-- senders revert to their previous behavior (noreply@ / all admins).
alter table company_info
  add column if not exists office_contact_user_id uuid references auth.users(id) on delete set null;
