// Browser-side helpers shared by the customer and official pages.

// Empty = same origin (this Next app). Set to http://localhost:8080 to use the Spring Boot backend.
export const API = process.env.NEXT_PUBLIC_VCIP_API ?? "";

// Add a TURN server for customers behind strict NATs (self-hosted coturn keeps media on your infra).
export const ICE: RTCIceServer[] = JSON.parse(process.env.NEXT_PUBLIC_ICE_SERVERS || '[{"urls":"stun:stun.l.google.com:19302"}]');

// Non-trickle ICE: wait for candidate gathering (max 3 s, it can hang) and send one complete SDP.
export async function gatheredSdp(pc: RTCPeerConnection) {
  if (pc.iceGatheringState !== "complete") {
    await new Promise<void>((done) => {
      const t = setTimeout(done, 3000);
      pc.addEventListener("icegatheringstatechange", () => {
        if (pc.iceGatheringState === "complete") {
          clearTimeout(t);
          done();
        }
      });
    });
  }
  return pc.localDescription!.sdp;
}

export async function errorText(res: Response) {
  const b = await res.json().catch(() => ({}));
  return [b.error ?? `HTTP ${res.status}`, b.missing?.length && `missing: ${b.missing.join(", ")}`, b.needEvidence?.length && `evidence: ${b.needEvidence.join(", ")}`]
    .filter(Boolean)
    .join(" · ");
}
