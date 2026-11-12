// Format check only (AAAAA9999A). Whether the PAN exists needs Protean / the IT department.
const PAN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (typeof body?.pan !== "string") {
    return Response.json({ error: "pan (string) is required" }, { status: 400 });
  }
  const pan = body.pan.trim().toUpperCase();
  return Response.json({ pan, validFormat: PAN.test(pan) });
}
