import { audit, CALL_MS, getSession, isCustomer, json, officialFrom, save } from "../../../../../../lib/vcip";

type Ctx = { params: Promise<{ id: string }> };

// Non-trickle WebRTC: the whole signalling is one offer (customer) and one answer (official).
export async function POST(req: Request, { params }: Ctx) {
  const s = getSession((await params).id);
  if (!s) return json({ error: "session not found" }, 404);
  const b = await req.json().catch(() => null);
  if (typeof b?.sdp !== "string" || !b.sdp || b.sdp.length > 20_000) return json({ error: "sdp (string) is required" }, 400);

  const official = officialFrom(req);
  if (official) {
    if (s.status !== "WAITING" || !s.offer) return json({ error: "session is not waiting for an official" }, 409);
    Object.assign(s, { answer: b.sdp, officialId: official, status: "IN_CALL", expiresAt: Date.now() + CALL_MS });
    save(s);
    audit("CALL_STARTED", s.id, official);
    return json({ ok: true });
  }
  if (!isCustomer(req, s)) return json({ error: "unauthorised" }, 401);
  // One offer per session: after a call drop RBI s.18(b)(ii) needs a fresh session.
  if (s.status !== "WAITING" || s.offer) return json({ error: "offer already sent; start a new session" }, 409);
  s.offer = b.sdp;
  return json({ ok: true });
}

// Official fetches the offer; customer polls for the answer. 204 = not there yet.
export async function GET(req: Request, { params }: Ctx) {
  const s = getSession((await params).id);
  if (!s) return json({ error: "session not found" }, 404);
  if (s.status !== "WAITING" && s.status !== "IN_CALL") return json({ error: `session is ${s.status}` }, 410);
  const sdp = officialFrom(req) ? s.offer : isCustomer(req, s) ? s.answer : null;
  if (sdp === null) return json({ error: "unauthorised" }, 401);
  return sdp ? json({ sdp }) : new Response(null, { status: 204 });
}
