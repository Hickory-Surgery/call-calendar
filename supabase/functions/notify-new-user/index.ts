import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS })
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: CORS })
  }

  console.log('notify-new-user invoked')

  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader.startsWith('Bearer ')) {
    console.log('Missing auth header')
    return new Response('Unauthorized', { status: 401, headers: CORS })
  }

  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const { data: { user }, error: authError } = await sb.auth.getUser(
    authHeader.slice(7),
  )
  if (authError || !user?.email) {
    console.log('Auth error:', authError?.message)
    return new Response('Unauthorized', { status: 401, headers: CORS })
  }
  console.log('New user:', user.email)

  // Idempotency: only notify once per user
  const { data: existing } = await sb
    .from('pending_users')
    .select('notified_at')
    .eq('id', user.id)
    .maybeSingle()

  if (existing?.notified_at) {
    console.log('Already notified')
    return new Response('Already notified', { status: 200, headers: CORS })
  }

  await sb.from('pending_users').upsert({ id: user.id, email: user.email })

  // Collect admin emails
  const { data: adminProfiles } = await sb
    .from('profiles')
    .select('id')
    .eq('role', 'admin')

  console.log('Admins found:', adminProfiles?.length ?? 0)

  if (!adminProfiles?.length) {
    return new Response('No admins found', { status: 200, headers: CORS })
  }

  const adminEmails: string[] = []
  for (const { id } of adminProfiles) {
    const { data: { user: adminUser } } = await sb.auth.admin.getUserById(id)
    if (adminUser?.email) adminEmails.push(adminUser.email)
  }

  console.log('Admin emails:', adminEmails)

  if (!adminEmails.length) {
    return new Response('No admin emails found', { status: 200, headers: CORS })
  }

  // Send via Resend
  const resendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${Deno.env.get('RESEND_API_KEY')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Call Calendar <onboarding@resend.dev>',
      to: [adminEmails[0]], // resend.dev sandbox: can only send to the Resend account owner
      subject: 'New user requesting access — Call Calendar',
      text: `A new user signed in and is waiting for access:\n\n  ${user.email}\n\nLog in and go to Settings → Users to approve them.`,
      html: `<p>A new user signed in and is waiting for access:</p><p style="font-size:1.1em;font-weight:bold">${user.email}</p><p>Log in and go to <strong>Settings → Users</strong> to approve them.</p>`,
    }),
  })

  const resendBody = await resendRes.json()
  console.log('Resend response:', resendRes.status, JSON.stringify(resendBody))

  if (!resendRes.ok) {
    return new Response('Email failed', { status: 500, headers: CORS })
  }

  // Mark notified
  await sb
    .from('pending_users')
    .update({ notified_at: new Date().toISOString() })
    .eq('id', user.id)

  return new Response('OK', { status: 200, headers: CORS })
})
