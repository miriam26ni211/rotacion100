import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } }
);

// fetch with timeout helper
async function fetchWithTimeout(input: RequestInfo, init?: RequestInit, timeout = Number(Deno.env.get("FETCH_TIMEOUT_MS") || 15000)) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

Deno.serve(async (req: Request) => {
  try {
    // ------------------------------
    // Auth: only internal caller with secret
    // ------------------------------
    const auth = req.headers.get("authorization") || req.headers.get("Authorization");
    if (auth !== `Bearer ${Deno.env.get("INTERNAL_FUNCTION_SECRET")}`) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    }

    // ------------------------------
    // Parse body and validate
    // ------------------------------
    const body = await req.json().catch(() => ({}));
    const user_id = body?.user_id;
    const amount = Number(body?.amount ?? 100);
    const currency = (body?.currency || "USD").toString().toUpperCase();
    if (!user_id) {
      return new Response(JSON.stringify({ error: "user_id required" }), { status: 400 });
    }
    if (!amount || amount <= 0) {
      return new Response(JSON.stringify({ error: "invalid amount" }), { status: 400 });
    }

    // ------------------------------
    // Idempotency check: succeeded already?
    // ------------------------------
    const { data: prev } = await supabase
      .from("payouts_log")
      .select("*")
      .eq("user_id", user_id)
      .eq("status", "succeeded")
      .eq("amount", amount)
      .limit(1)
      .maybeSingle();
    if (prev) {
      return new Response(JSON.stringify({ success: true, already: true, transfer_id: prev.wise_transfer_id }), { status: 200 });
    }

    // ------------------------------
    // Get recipient info (must be verified)
    // ------------------------------
    const { data: payoutInfo, error: piErr } = await supabase
      .from("payout_info")
      .select("recipient_id, account_holder_name, currency, verified")
      .eq("user_id", user_id)
      .eq("verified", true)
      .maybeSingle();
    if (piErr || !payoutInfo?.recipient_id) {
      await supabase.from("payouts_log").insert({
        user_id,
        status: "donated",
        amount,
        currency,
        created_at: new Date().toISOString()
      });
      return new Response(JSON.stringify({ error: "No verified recipient" }), { status: 400 });
    }

    // ------------------------------
    // Prevent concurrent payouts
    // ------------------------------
    const { data: pending } = await supabase
      .from("payouts_log")
      .select("id")
      .eq("user_id", user_id)
      .eq("status", "pending")
      .limit(1)
      .maybeSingle();
    if (pending) {
      return new Response(JSON.stringify({ error: "Payout already pending" }), { status: 409 });
    }

    // Create pending log
    const insertRes = await supabase.from("payouts_log").insert({
      user_id,
      status: "pending",
      recipient_id: payoutInfo.recipient_id,
      amount,
      currency,
      created_at: new Date().toISOString()
    }).select().maybeSingle();
    const logId = insertRes?.data?.id ?? null;

    // ------------------------------
    // Create quote
    // ------------------------------
    const PROFILE_ID = Deno.env.get("WISE_PROFILE_ID")!;
    const WISE_KEY = Deno.env.get("WISE_API_KEY")!;

    let quoteRes;
    try {
      quoteRes = await fetchWithTimeout(`https://api.transferwise.com/v3/profiles/${PROFILE_ID}/quotes`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${WISE_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          profile: PROFILE_ID,
          source: currency,
          target: payoutInfo.currency || currency,
          sourceAmount: amount
        })
      });
    } catch (err: any) {
      await supabase.from("payouts_log").update({ status: "failed", error: { network: String(err?.message || err) } }).eq("id", logId);
      return new Response(JSON.stringify({ error: "Network error creating quote", details: String(err?.message || err) }), { status: 502 });
    }

    const quoteJson = await quoteRes.json().catch(() => ({}));
    if (!quoteRes.ok) {
      await supabase.from("payouts_log").update({ status: "failed", error: quoteJson }).eq("id", logId);
      return new Response(JSON.stringify({ error: "Quote creation failed", details: quoteJson }), { status: 500 });
    }

    // ------------------------------
    // Create transfer
    // ------------------------------
    const customerTransactionId = `ROT100-${user_id}-${Date.now()}`;
    let transferRes;
    try {
      transferRes = await fetchWithTimeout(`https://api.transferwise.com/v3/profiles/${PROFILE_ID}/transfers`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${WISE_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          targetAccount: payoutInfo.recipient_id,
          quoteUuid: quoteJson.id || quoteJson.quoteUuid || quoteJson.id,
          customerTransactionId,
          details: {
            reference: "Bono Rotacion100 - ¡Llegaste al puesto #100!"
          }
        })
      });
    } catch (err: any) {
      await supabase.from("payouts_log").update({ status: { network: String(err?.message || err) } }).eq("id", logId);
      return new Response(JSON.stringify({ error: "Network error creating transfer", details: String(err?.message || err) }), { status: 502 });
    }

    const transferJson = await transferRes.json().catch(() => ({}));
    if (!transferRes.ok) {
      await supabase.from("payouts_log").update({ status: "failed", error: transferJson }).eq("id", logId);
      return new Response(JSON.stringify({ error: "Transfer creation failed", details: transferJson }), { status: 500 });
    }

    // ------------------------------
    // Mark succeeded + bono record
    // ------------------------------
    await supabase.from("payouts_log").update({
      status: "succeeded",
      wise_transfer_id: transferJson.id,
      processed_at: new Date().toISOString()
    }).eq("id", logId);

    await supabase.from("bonos").insert({
      usuario_id: user_id,
      monto: amount,
      metodo_pago: "wise",
      estado: "pagado",
      procesado_at: new Date().toISOString()
    });

    return new Response(JSON.stringify({ success: true, transfer_id: transferJson.id }), { status: 200 });

  } catch (err: any) {
    console.error("sendWisePayout error:", err);
    return new Response(JSON.stringify({ error: "Internal server error", details: err?.message || String(err) }), { status: 500 });
  }
});
