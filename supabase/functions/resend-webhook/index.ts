import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { escapeHtml } from '../_shared/html.ts'
import { verifySvixSignature } from '../_shared/svix.ts'

// Receives Resend webhook events and, on a bounce, emails the office contact (or all admins
// when no contact is set, or when the contact isn't an admin and so may not be able to fix
// it) saying which address bounced and how to fix it in the app. Every email this app sends
// goes through the same Resend account, so this covers weekly, change, coverage and
// new-user emails alike.
//
// Public endpoint (verify_jwt = false) — authenticated solely by the Svix signature.

const ALERT_SUBJECT_PREFIX = 'Bounced email:'

function fmtWhen(iso: string | undefined): string {
  if (!iso) return 'unknown time'
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  })
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  const secret = Deno.env.get('RESEND_WEBHOOK_SECRET')
  if (!secret) {
    console.error('RESEND_WEBHOOK_SECRET is not set')
    return new Response('Not configured', { status: 500 })
  }

  // Signature is computed over the exact raw body, so read it as text before parsing.
  const rawBody = await req.text()
  const valid = await verifySvixSignature(secret, {
    id: req.headers.get('svix-id'),
    timestamp: req.headers.get('svix-timestamp'),
    signature: req.headers.get('svix-signature'),
  }, rawBody)
  if (!valid) return new Response('Invalid signature', { status: 401 })

  let event: {
    type?: string
    data?: {
      to?: string[]; subject?: string; created_at?: string
      bounce?: { type?: string; subType?: string; message?: string }
    }
  }
  try { event = JSON.parse(rawBody) } catch { return new Response('Bad JSON', { status: 400 }) }

  if (event.type !== 'email.bounced') return new Response('Ignored', { status: 200 })

  const data = event.data ?? {}
  // An alert that itself bounced must not trigger another alert.
  if ((data.subject ?? '').startsWith(ALERT_SUBJECT_PREFIX)) return new Response('Ignored alert bounce', { status: 200 })

  const bounced = (data.to ?? []).filter(Boolean)
  if (!bounced.length) return new Response('No recipients in event', { status: 200 })
  const bouncedLower = new Set(bounced.map(a => a.toLowerCase()))

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  // ── Who to alert ────────────────────────────────────────────────────────
  const { data: profiles } = await sb.from('profiles').select('id, email, role')
  const { data: co } = await sb.from('company_info').select('office_contact_user_id').eq('id', 1).maybeSingle()
  const contact = co?.office_contact_user_id ? (profiles ?? []).find(p => p.id === co.office_contact_user_id) ?? null : null
  const admins = (profiles ?? []).filter(p => p.role === 'admin').map(p => p.email).filter(Boolean) as string[]

  const contactBounced = !!contact?.email && bouncedLower.has(contact.email.toLowerCase())
  let contactCanFix = false
  let recipients: string[]
  if (contact?.email && !contactBounced) {
    contactCanFix = contact.role === 'admin'
    recipients = contactCanFix ? [contact.email] : [contact.email, ...admins]
  } else {
    // No contact, or the contact's own address is the one bouncing — alert the admins.
    recipients = admins
  }
  recipients = [...new Set(recipients)].filter(a => !bouncedLower.has(a.toLowerCase()))
  if (!recipients.length) {
    console.error('Bounce alert has nobody to send to', bounced)
    return new Response('No alert recipients', { status: 200 })
  }
  const adminsCopied = !!contact?.email && !contactBounced && !contactCanFix

  // ── Where does each bounced address live in the app? ────────────────────
  const { data: recipientRows } = await sb.from('email_recipients').select('email')
  const { data: staffRows } = await sb.from('staff').select('short_name, email')

  function stepsFor(addr: string): string[] {
    const a = addr.toLowerCase()
    const steps: string[] = []
    if ((recipientRows ?? []).some(r => r.email?.toLowerCase() === a)) {
      steps.push('It is on the weekly email list: open Settings (the gear icon) → Data → Weekly Email Settings. Remove this address from the list (×), then add the correct one.')
    }
    for (const s of (staffRows ?? []).filter(s => s.email?.toLowerCase() === a)) {
      steps.push(`It is the notification email for ${s.short_name}: open Settings → Staff, click the ⋯ beside ${s.short_name}, and correct the address under Account (or pick their login account instead).`)
    }
    if ((profiles ?? []).some(p => p.email?.toLowerCase() === a)) {
      steps.push('It is the sign-in address of an account listed under Settings → Users. If it is wrong, remove that user there and add the correct address.')
      if (contact?.email?.toLowerCase() === a) {
        steps.push('It is also the Office contact: after fixing the account, check Settings → Practice → Office contact email.')
      }
    }
    if (!steps.length) {
      steps.push('This address was not found anywhere in the app, so it may come from another source. The Resend dashboard (resend.com → Emails) shows which message it was sent with.')
    }
    return steps
  }

  const b = data.bounce ?? {}
  const permanent = b.type === 'Permanent'
  const meaning = permanent
    ? 'The address was permanently rejected, so it will keep failing until it is corrected.'
    : b.type === 'Transient'
      ? 'This looks like a temporary problem (for example a full mailbox). It may clear up on its own; act only if it happens again.'
      : 'The cause could not be determined.'
  const suppressedNote = b.subType === 'Suppressed'
    ? '<p style="font-size:0.85rem;color:#37474F">Resend has blocked this address because of earlier bounces. If the address is actually correct, it must also be removed from the suppression list in the Resend dashboard before mail will go through.</p>'
    : ''

  const blocks = bounced.map(addr => `
    <div style="border:1px solid #ECEFF1;border-radius:6px;padding:12px 14px;margin-bottom:12px">
      <div style="font-weight:700;font-size:0.95rem">${escapeHtml(addr)}</div>
      <div style="font-size:0.85rem;color:#37474F;margin:6px 0 4px"><strong>What to do</strong></div>
      <ul style="margin:0;padding-left:18px;font-size:0.85rem;color:#37474F">
        ${stepsFor(addr).map(s => `<li style="margin-bottom:4px">${escapeHtml(s)}</li>`).join('')}
      </ul>
    </div>`).join('')

  const accessNote = adminsCopied
    ? `<p style="font-size:0.85rem;color:#E65100">Fixing this needs an admin account. The admins have been copied on this message.</p>`
    : contactBounced
      ? `<p style="font-size:0.85rem;color:#E65100">The bounced address is the office contact's own, so this alert went to the admins instead.</p>`
      : ''

  const html = `<!DOCTYPE html>
<html><body style="font-family:system-ui,sans-serif;color:#37474F;max-width:650px;margin:0 auto;padding:24px">
  <h2 style="font-size:1.1rem;font-weight:700;margin-bottom:4px">An email could not be delivered</h2>
  <p style="font-size:0.9rem;color:#607D8B;margin-top:0;margin-bottom:16px">
    The address${bounced.length > 1 ? 'es' : ''} below did not receive "${escapeHtml(data.subject ?? 'an email')}", sent ${escapeHtml(fmtWhen(data.created_at))}.
  </p>
  ${accessNote}
  <p style="font-size:0.85rem"><strong>Reason:</strong> ${escapeHtml(b.message ?? 'No detail was provided.')}<br>${escapeHtml(meaning)}</p>
  ${suppressedNote}
  ${blocks}
  <p style="font-size:0.78rem;color:#90A4AE;margin-top:20px">You are receiving this because you are the practice's office contact or an admin of the Call Calendar.</p>
</body></html>`

  const text = [
    `An email could not be delivered: "${data.subject ?? 'an email'}" (sent ${fmtWhen(data.created_at)})`,
    `Reason: ${b.message ?? 'No detail was provided.'} ${meaning}`,
    ...(b.subType === 'Suppressed' ? ['Resend has blocked this address because of earlier bounces; if the address is correct, also remove it from the suppression list in the Resend dashboard.'] : []),
    ...(adminsCopied ? ['Fixing this needs an admin account; the admins have been copied.'] : []),
    '',
    ...bounced.flatMap(addr => [addr, ...stepsFor(addr).map(s => `  - ${s}`), '']),
  ].join('\n')

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${Deno.env.get('RESEND_API_KEY')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Call Calendar <noreply@ssrounds.com>',
      to: recipients,
      subject: `${ALERT_SUBJECT_PREFIX} ${bounced.join(', ')}`,
      html, text,
    }),
  })
  if (!res.ok) {
    console.error('Alert send failed', res.status, await res.text())
    // Non-2xx makes Resend retry the webhook, which is what we want for a failed alert.
    return new Response('Alert failed', { status: 500 })
  }
  return new Response('OK', { status: 200 })
})
