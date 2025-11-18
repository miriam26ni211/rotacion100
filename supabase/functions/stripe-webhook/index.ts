import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@14?target=deno&no-check'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, { apiVersion: '2023-10-16' })

Deno.serve(async (req) => {
  const sig = req.headers.get('stripe-signature')!
  const body = await req.text()

  let event
  try {
    event = stripe.webhooks.constructEvent(body, sig, Deno.env.get('STRIPE_WEBHOOK_SECRET')!)
  } catch (err) {
    return new Response(`Webhook Error: ${err.message}`, { status: 400 })
  }

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  if (event.type === 'account.updated') {
    const account = event.data.object
    const accountId = account.id

    const { data: profile } = await supabase
      .from('profiles')
      .select('id')
      .eq('stripe_account_id', accountId)
      .single()

    if (profile) {
      await supabase.from('profiles').update({
        charges_enabled: account.charges_enabled,
        payouts_enabled: account.payouts_enabled,
        account_status: account.charges_enabled ? 'complete' : 'restricted',
      }).eq('id', profile.id)

      // BONO AUTOMÁTICO POSICIÓN 100
      if (account.charges_enabled && account.payouts_enabled) {
        const { data: ranking } = await supabase
          .from('user_rankings')
          .select('position')
          .eq('user_id', profile.id)
          .single()

        if (ranking?.position === 100) {
          // Transfer $100 al balance de la cuenta Express
          await stripe.transfers.create({
            amount: 10000, // $100.00
            currency: 'usd',
            destination: accountId,
            description: 'Bono por llegar a posición 100',
          })

          // Registrar en payouts_log
          await supabase.from('payouts_log').insert({
            user_id: profile.id,
            type: 'stripe',
            amount_cents: 10000,
            currency: 'usd',
            status: 'succeeded',
            metadata: { reason: 'position_100_bonus' }
          })
        }
      }
    }
  }

  return new Response('OK', { status: 200 })
})
