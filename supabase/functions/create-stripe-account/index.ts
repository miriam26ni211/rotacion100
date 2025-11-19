import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@14?target=deno&no-check'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2023-10-16',
})

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const siteUrl = Deno.env.get('SITE_URL') || 'http://localhost:3000'

Deno.serve(async (req: Request) => {
  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: 'No autorizado' }), { status: 401 })
  }
  const token = authHeader.split(' ')[1]

  const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey)
  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token)
  if (authError || !user || !user.email) {
    return new Response(JSON.stringify({ error: 'Usuario no válido' }), { status: 401 })
  }

  const payload = await req.json().catch(() => ({}))
  const { full_name, phone, address } = payload

  const { data: usuario } = await supabaseAdmin
    .from('usuarios')
    .select('stripe_account_id, nombre, telefono, direccion')
    .eq('id', user.id)
    .single()

  let accountId: string

  if (usuario?.stripe_account_id) {
    accountId = usuario.stripe_account_id
    const account = await stripe.accounts.retrieve(accountId)

    if (full_name || phone || address) {
      await supabaseAdmin
        .from('usuarios')
        .update({
          nombre: full_name || usuario.nombre,
          telefono: phone || usuario.telefono,
          direccion: address ? JSON.stringify(address) : usuario.direccion,
        })
        .eq('id', user.id)
    }

    if (!account.charges_enabled || !account.payouts_enabled) {
      const link = await stripe.accountLinks.create({
        account: accountId,
        refresh_url: `${siteUrl}/dashboard`,
        return_url: `${siteUrl}/dashboard`,
        type: 'account_onboarding',
      })
      return Response.json({ onboardingUrl: link.url })
    }

    return Response.json({ alreadyConnected: true })
  }

  const account = await stripe.accounts.create({
    type: 'express',
    country: 'US',
    email: user.email,
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
    },
  })

  accountId = account.id

  await supabaseAdmin
    .from('usuarios')
    .update({
      stripe_account_id: accountId,
      nombre: full_name || user.user_metadata.full_name || 'Pendiente',
      telefono: phone || 'Pendiente',
      direccion: address ? JSON.stringify(address) : null,
    })
    .eq('id', user.id)

  const link = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: `${siteUrl}/dashboard`,
    return_url: `${siteUrl}/dashboard`,
    type: 'account_onboarding',
  })

  return Response.json({ onboardingUrl: link.url })
})
