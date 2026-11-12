import { getSession, isCustomer, json, officialFrom, view } from "../../../../../lib/vcip";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = getSession((await params).id);
  if (!s) return json({ error: "session not found" }, 404);
  if (officialFrom(req)) return json(view(s));
  // The customer never sees the questions: they must not be known in advance.
  if (isCustomer(req, s)) return json({ id: s.id, status: s.status, expiresAt: s.expiresAt });
  return json({ error: "unauthorised" }, 401);
}
