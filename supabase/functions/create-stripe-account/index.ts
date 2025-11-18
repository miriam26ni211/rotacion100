import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@14?target=deno&no-check'


const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') as string, {
  apiVersion: '2023-10-16',
})


Deno.serve(async (req: Request) => {
  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response('Unauthorized', { status: 401 })
  }
  const jwt = authHeader.split(' ')[1]


  // Cliente anónimo solo para validar el JWT
  const supabaseAnon = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: `Bearer ${jwt}` } } }
  )


  const { data: { user }, error: authError } = await supabaseAnon.auth.getUser()
  if (authError || !user) return new Response('Unauthorized', { status: 401 })
  if (!user.email) return new Response('User missing email', { status: 400 })


  // Cliente admin (service_role) → omite RLS
  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )


  // 1. Buscar perfil existente
  let { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('stripe_account_id, charges_enabled, payouts_enabled, account_status')
    .eq('id', user.id)
    .maybeSingle()


  // 2. Si ya tiene cuenta Stripe → sincronizar con la verdad absoluta de Stripe
  if (profile?.stripe_account_id) {
    const stripeAccount = await stripe.accounts.retrieve(profile.stripe_account_id)


    // Actualizamos la DB con lo que realmente dice Stripe
    await supabaseAdmin.from('profiles').update({
      charges_enabled: stripeAccount.charges_enabled,
      payouts_enabled: stripeAccount.payouts_enabled,
      account_status: stripeAccount.requirements.disabled_reason 
        ? 'restricted' 
        : stripeAccount.restricted_soon 
          ? 'restricted_soon' 
          : 'complete',
    }).eq('id', user.id)


    // Si está rechazada o restringida
    if (stripeAccount.requirements.disabled_reason) {
      return Response.json({ error: 'Tu cuenta Stripe fue rechazada o restringida. Contacta soporte.' }, { status: 400 })
    }


    // Si aún no terminó el onboarding
    if (!stripeAccount.charges_enabled || !stripeAccount.payouts_enabled) {
      const accountLink = await stripe.accountLinks.create({
        account: profile.stripe_account_id,
        refresh_url: `${Deno.env.get('SITE_URL')}/dashboard`,
        return_url: `${Deno.env.get('SITE_URL')}/dashboard`,
        type: 'account_onboarding',
      })
      return Response.json({ onboardingUrl: accountLink.url })
    }


    // Todo perfecto
    return Response.json({ alreadyConnected: true })
  }


  // 3. Crear nueva cuenta Express + guardar estado inicial real
  const account = await stripe.accounts.create({
    type: 'express',
    country: 'US',
    email: user.email,
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
    },
  })


  const accountLink = await stripe.accountLinks.create({
    account: account.id,
    refresh_url: `${Deno.env.get('SITE_URL')}/dashboard`,
    return_url: `${Deno.env.get('SITE_URL')}/dashboard`,
    type: 'account_onboarding',
  })


  // Guardamos con los valores reales de Stripe (aunque al crear siempre son false)
  await supabaseAdmin.from('profiles').upsert({
    id: user.id,
    email: user.email,
    stripe_account_id: account.id,
    account_status: 'pending',
    charges_enabled: account.charges_enabled,
    payouts_enabled: account.payouts_enabled,
  })


  return Response.json({ onboardingUrl: accountLink.url })
})
