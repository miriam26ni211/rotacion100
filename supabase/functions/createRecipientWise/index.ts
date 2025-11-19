import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

Deno.serve(async (req: Request) => {
  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) return new Response('Unauthorized', { status: 401 })
    const token = authHeader.split(' ')[1]
    const { data: { user } } = await supabase.auth.getUser(token)
    if (!user) return new Response('Invalid token', { status: 401 })

    // IDEMPOTENCIA CH: si ya existe verificado, devolverlo
    const { data: existing } = await supabase.from('payout_info').select('recipient_id').eq('user_id', user.id).eq('verified', true).maybeSingle()
    if (existing?.recipient_id) {
      return new Response(JSON.stringify({ success: true, recipient_id: existing.recipient_id, already: true }))
    }

    const body = await req.json()
    const { account_holder_name, account_number, routing_number, country = 'US', currency = 'USD' } = body

    if (!account_holder_name || !account_number || (country === 'US' && !routing_number)) {
      return new Response(JSON.stringify({ error: 'Faltan campos' }), { status: 400 })
    }

    const payload: any = {
      profile: Deno.env.get('WISE_PROFILE_ID'),
      accountHolderName: account_holder_name.trim(),
      currency: currency.toUpperCase(),
      type: country === 'US' ? 'us_ach' : 'iban',
      details: country === 'US' ? {
        accountNumber: account_number,
        routingNumber: routing_number
      } : {
        iban: account_number
      }
    }

    const wiseRes = await fetch(`https://api.wise.com/v3/profiles/${Deno.env.get('WISE_PROFILE_ID')}/recipients`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${Deno.env.get('WISE_API_KEY')}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    })

    const data = await wiseRes.json()

    if (!wiseRes.ok) {
      await supabase.from('payout_info').upsert({ user_id: user.id, validation_error: data, verified: false })
      return new Response(JSON.stringify({ error: 'Datos inválidos', details: data }), { status: 400 })
    }

    await supabase.from('payout_info').upsert({
      user_id: user.id,
      recipient_id: data.id,
      account_holder_name,
      account_number,
      routing_number: country === 'US' ? routing_number : null,
      country,
      currency: currency.toUpperCase(),
      verified: true
    })

    return new Response(JSON.stringify({ success: true, recipient_id: data.id }))

  } catch (err: any) {
    console.error('createRecipientWise error:', err)
    return new Response(JSON.stringify({ error: 'Error interno' }), { status: 500 })
  }
})
