import { readFileSync } from "node:fs";
import { join } from "node:path";

// data/pincodes.csv is a small sample (pincode,lat,lng). Replace with the full
// All India Pincode Directory from data.gov.in for real use.
const PINCODES = readFileSync(join(process.cwd(), "data", "pincodes.csv"), "utf8")
  .trim()
  .split(/\r?\n/)
  .slice(1)
  .map((line) => {
    const [pincode, lat, lng] = line.split(",");
    return { pincode, lat: Number(lat), lng: Number(lng) };
  });

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number) {
  const r = (d: number) => (d * Math.PI) / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lng2 - lng1) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const { lat, lng, pincode } = body ?? {};
  if (typeof lat !== "number" || typeof lng !== "number" || Math.abs(lat) > 90 || Math.abs(lng) > 180 || !/^\d{6}$/.test(String(pincode ?? ""))) {
    return Response.json({ error: "lat, lng (numbers) and 6-digit pincode are required" }, { status: 400 });
  }
  // ponytail: linear scan over ~19k rows is fine; add a spatial index if it shows up in latency.
  let nearest = PINCODES[0];
  let best = Infinity;
  for (const p of PINCODES) {
    const d = haversineKm(lat, lng, p.lat, p.lng);
    if (d < best) [best, nearest] = [d, p];
  }
  return Response.json({
    declaredPincode: String(pincode),
    nearestPincode: nearest.pincode,
    distanceKm: Math.round(best * 10) / 10,
    match: nearest.pincode === String(pincode),
  });
}
