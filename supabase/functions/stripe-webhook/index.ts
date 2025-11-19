import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@14?target=deno&no-check'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, { apiVersion: '2023-10-16' })
const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET')!

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

Deno.serve(async (req: Request) => {
  const signature = req.headers.get('stripe-signature')!
  const body = await req.text()
  let event

  try {
    event = stripe.webhooks.constructEvent(body, signature, webhookSecret)
  } catch (err: any) {
    console.error('Webhook error:', err.message)
    return new Response(`Webhook Error: ${err.message}`, { status: 400 })
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as any

    const montoMinimo = Number(Deno.env.get('MONTO_MINIMO_CENTAVOS') || '1000')
    if (session.amount_total !== montoMinimo || session.payment_status !== 'paid') {
      return new Response('OK', { status: 200 })
    }

    const userId = session.client_reference_id
    if (!userId) {
      console.error('Falta client_reference_id')
      return new Response('OK', { status: 200 })
    }

    const { data, error } = await supabase.rpc('registrar_pago_con_celebracion', {
      p_usuario_id: userId,
      p_monto: montoMinimo / 100,
      p_metodo: 'stripe',
    })

    if (error) {
      console.error('Error en rotación:', error)
    } else if (data === 'USUARIO_100') {
      console.log('🎉 ¡Alguien llegó a la posición 100! Listo para payout.')
    }
  }

  if (event.type === 'account.updated') {
    const account = event.data.object as any
    if (account.charges_enabled && account.payouts_enabled) {
      const { data: usuario } = await supabase
        .from('usuarios')
        .select('id')
        .eq('stripe_account_id', account.id)
        .maybeSingle()
      if (usuario) {
        await supabase
          .from('usuarios')
          .update({
            charges_enabled: true,
            payouts_enabled: true,
            account_status: 'complete'
          })
          .eq('id', usuario.id)
        console.log(`Usuario ${usuario.id} completó onboarding Stripe Express`)
      }
    }
  }

  return new Response('OK', { status: 200 })
})
