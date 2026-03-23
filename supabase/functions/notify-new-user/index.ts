import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import nodemailer from 'npm:nodemailer'

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  // Verify caller is a real authenticated user
  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader.startsWith('Bearer ')) {
    return new Response('Unauthorized', { status: 401 })
  }

  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const { data: { user }, error: authError } = await sb.auth.getUser(
    authHeader.slice(7),
  )
  if (authError || !user?.email) {
    return new Response('Unauthorized', { status: 401 })
  }

  // Idempotency: only notify once per user
  const { data: existing } = await sb
    .from('pending_users')
    .select('notified_at')
    .eq('id', user.id)
    .maybeSingle()

  if (existing?.notified_at) {
    return new Response('Already notified', { status: 200 })
  }

  // Record the pending user
  await sb.from('pending_users').upsert({ id: user.id, email: user.email })

  // Collect admin emails via admin API
  const { data: adminProfiles } = await sb
    .from('profiles')
    .select('id')
    .eq('role', 'admin')

  if (!adminProfiles?.length) {
    return new Response('No admins found', { status: 200 })
  }

  const adminEmails: string[] = []
  for (const { id } of adminProfiles) {
    const { data: { user: adminUser } } = await sb.auth.admin.getUserById(id)
    if (adminUser?.email) adminEmails.push(adminUser.email)
  }

  if (!adminEmails.length) {
    return new Response('No admin emails found', { status: 200 })
  }

  // Send via Gmail SMTP
  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: {
      user: Deno.env.get('SMTP_USER'),
      pass: Deno.env.get('SMTP_PASS'),
    },
  })

  await transporter.sendMail({
    from: `"Call Calendar" <${Deno.env.get('SMTP_USER')}>`,
    to: adminEmails.join(', '),
    subject: 'New user requesting access — Call Calendar',
    text: [
      `A new user signed in and is waiting for access:`,
      ``,
      `  ${user.email}`,
      ``,
      `Log in and go to Settings → Users to approve them.`,
    ].join('\n'),
    html: `
      <p>A new user signed in and is waiting for access:</p>
      <p style="font-size:1.1em;font-weight:bold">${user.email}</p>
      <p>Log in and go to <strong>Settings → Users</strong> to approve them.</p>
    `,
  })

  // Mark notified
  await sb
    .from('pending_users')
    .update({ notified_at: new Date().toISOString() })
    .eq('id', user.id)

  return new Response('OK', { status: 200 })
})
