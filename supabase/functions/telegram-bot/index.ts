// supabase/functions/telegram-bot/index.ts
//
// Telegram webhook handler for Open Brain.
// - Saves any plain message as a new thought
// - /search <query> or ?<query>  -> searches thoughts (ilike) and returns top 5
// - /recent                      -> returns the last 5 thoughts
//
// This function uses the SERVICE ROLE key to talk to the database, which
// bypasses Row Level Security entirely. Because of that, every insert and
// every query below manually filters by OWNER_USER_ID - if you forget that
// on a new query later, it will silently return/save data with no owner,
// invisible to the logged-in app.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const OWNER_USER_ID = Deno.env.get("OWNER_USER_ID")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function sendMessage(chatId: number | string, text: string) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch (err) {
    console.error("Failed to send Telegram message:", err);
  }
}

async function handleSearch(chatId: number | string, query: string) {
  const { data, error } = await admin
    .from("thoughts")
    .select("id, content, created_at")
    .eq("user_id", OWNER_USER_ID)
    .ilike("content", `%${query}%`)
    .order("created_at", { ascending: false })
    .limit(5);

  if (error) {
    console.error("Search error:", error);
    await sendMessage(chatId, "Something went wrong searching your brain.");
    return;
  }

  if (!data || data.length === 0) {
    await sendMessage(chatId, `No thoughts found matching "${query}".`);
    return;
  }

  const lines = data.map((t, i) => `${i + 1}. ${t.content.slice(0, 200)}`);
  await sendMessage(chatId, `Found ${data.length} result(s):\n\n${lines.join("\n\n")}`);
}

async function handleRecent(chatId: number | string) {
  const { data, error } = await admin
    .from("thoughts")
    .select("id, content, created_at")
    .eq("user_id", OWNER_USER_ID)
    .order("created_at", { ascending: false })
    .limit(5);

  if (error) {
    console.error("Recent error:", error);
    await sendMessage(chatId, "Something went wrong fetching your recent thoughts.");
    return;
  }

  if (!data || data.length === 0) {
    await sendMessage(chatId, "You don't have any thoughts saved yet.");
    return;
  }

  const lines = data.map((t, i) => `${i + 1}. ${t.content.slice(0, 200)}`);
  await sendMessage(chatId, `Your last ${data.length} thought(s):\n\n${lines.join("\n\n")}`);
}

async function handleSave(chatId: number | string, text: string) {
  const { error } = await admin.from("thoughts").insert({
    user_id: OWNER_USER_ID,
    content: `💬 Telegram: ${text}`,
    metadata: { source: "telegram" },
  });

  if (error) {
    console.error("Insert error:", error);
    await sendMessage(chatId, "Something went wrong saving that thought.");
    return;
  }

  await sendMessage(chatId, "Saved to your brain.");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const update = await req.json();
    const message = update?.message;
    const chatId = message?.chat?.id;
    const text: string | undefined = message?.text;

    if (!chatId || !text) {
      // Nothing useful to do (e.g. non-text message). Still return 200.
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      });
    }

    const trimmed = text.trim();

    if (trimmed.startsWith("/search ") || trimmed.startsWith("?")) {
      const query = trimmed.startsWith("/search ")
        ? trimmed.slice("/search ".length).trim()
        : trimmed.slice(1).trim();

      if (!query) {
        await sendMessage(chatId, "Type /search followed by what you're looking for.");
      } else {
        await handleSearch(chatId, query);
      }
    } else if (trimmed.startsWith("/recent")) {
      await handleRecent(chatId);
    } else {
      await handleSave(chatId, trimmed);
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (err) {
    console.error("Unhandled error:", err);
    // Always return 200 so Telegram does not retry the same update forever.
    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  }
});
