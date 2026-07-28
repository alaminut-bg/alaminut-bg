// Admin-only account management. The secret key lives here and nowhere else.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const URL = Deno.env.get('SUPABASE_URL')!
const SECRET = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const EMAIL_DOMAIN = 'alaminut.local'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'content-type': 'application/json' },
  })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const jwt = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!jwt) return json({ error: 'Липсва вход.' }, 401)

  const admin = createClient(URL, SECRET, { auth: { persistSession: false } })

  // 1. Who is calling?
  const { data: caller, error: whoErr } = await admin.auth.getUser(jwt)
  if (whoErr || !caller?.user) return json({ error: 'Невалиден вход.' }, 401)

  // 2. Are they an active admin? Checked server-side, never trusted from the body.
  const { data: prof } = await admin
    .from('profiles')
    .select('role, active')
    .eq('id', caller.user.id)
    .single()

  if (!prof || prof.role !== 'admin' || !prof.active) {
    return json({ error: 'Само за администратори.' }, 403)
  }

  const body = await req.json().catch(() => ({}))
  const { action } = body

  try {
    if (action === 'create') {
      const username = String(body.username ?? '').trim().toLowerCase()
      const displayName = String(body.display_name ?? '').trim()
      const password = String(body.password ?? '')
      const role = body.role === 'admin' ? 'admin' : 'user'

      if (!/^[a-z0-9._-]{2,32}$/.test(username)) {
        return json({ error: 'Потребителското име трябва да е на латиница, 2–32 знака.' }, 400)
      }
      if (displayName.length < 2) {
        return json({ error: 'Въведи звание и фамилия.' }, 400)
      }
      if (password.length < 6) {
        return json({ error: 'Паролата трябва да е поне 6 знака.' }, 400)
      }

      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email: `${username}@${EMAIL_DOMAIN}`,
        password,
        email_confirm: true,
      })
      if (createErr) {
        const taken = createErr.message.toLowerCase().includes('already')
        return json(
          { error: taken ? 'Това потребителско име вече съществува.' : createErr.message },
          400,
        )
      }

      const { error: profErr } = await admin.from('profiles').insert({
        id: created.user.id,
        username,
        display_name: displayName,
        role,
      })
      if (profErr) {
        // Never leave an auth user without a profile.
        await admin.auth.admin.deleteUser(created.user.id)
        const taken = profErr.message.toLowerCase().includes('duplicate')
        return json({ error: taken ? 'Това потребителско име вече съществува.' : profErr.message }, 400)
      }

      return json({ ok: true, id: created.user.id })
    }

    if (action === 'reset-password') {
      const password = String(body.password ?? '')
      if (password.length < 6) {
        return json({ error: 'Паролата трябва да е поне 6 знака.' }, 400)
      }
      const { error } = await admin.auth.admin.updateUserById(body.id, { password })
      if (error) return json({ error: error.message }, 400)
      return json({ ok: true })
    }

    if (action === 'set-active') {
      const active = Boolean(body.active)
      if (body.id === caller.user.id && !active) {
        return json({ error: 'Не можеш да деактивираш себе си.' }, 400)
      }
      const { error } = await admin.from('profiles').update({ active }).eq('id', body.id)
      if (error) return json({ error: error.message }, 400)
      return json({ ok: true })
    }

    if (action === 'set-role') {
      const role = body.role === 'admin' ? 'admin' : 'user'
      if (body.id === caller.user.id && role !== 'admin') {
        return json({ error: 'Не можеш да свалиш собствените си права.' }, 400)
      }
      const { error } = await admin.from('profiles').update({ role }).eq('id', body.id)
      if (error) return json({ error: error.message }, 400)
      return json({ ok: true })
    }

    if (action === 'delete') {
      if (body.id === caller.user.id) {
        return json({ error: 'Не можеш да изтриеш себе си.' }, 400)
      }
      const { error } = await admin.auth.admin.deleteUser(body.id)
      if (error) return json({ error: error.message }, 400)
      return json({ ok: true })
    }

    return json({ error: 'Непознато действие.' }, 400)
  } catch (e) {
    return json({ error: String(e) }, 500)
  }
})
