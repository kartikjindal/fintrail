"use client";
import { useRef, useState } from "react";
import { API, errorText, gatheredSdp, ICE } from "../../lib/rtc";
import { CONSENT_TEXT, CONSENT_VERSION } from "../../lib/vcip-shared";

const video = { width: "100%", maxWidth: 480, background: "#000", borderRadius: 8 } as const;

export default function CustomerVcip() {
  const self = useRef<HTMLVideoElement>(null);
  const remote = useRef<HTMLVideoElement>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  async function start() {
    setBusy(true);
    let stream: MediaStream | null = null;
    try {
      setStatus("Allow camera, microphone and location…");
      stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: true });
      self.current!.srcObject = stream;
      const pos = await new Promise<GeolocationPosition>((ok, fail) =>
        navigator.geolocation.getCurrentPosition(ok, fail, { enableHighAccuracy: true, timeout: 20000 }),
      );
      const res = await fetch(`${API}/api/vcip/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          consent: true,
          consentVersion: CONSENT_VERSION,
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracyM: pos.coords.accuracy,
          cameraLabel: stream.getVideoTracks()[0]?.label ?? "",
        }),
      });
      if (!res.ok) throw new Error(await errorText(res));
      const { id, customerToken } = await res.json();
      const headers = { "Content-Type": "application/json", "X-Customer-Token": customerToken };

      const pc = new RTCPeerConnection({ iceServers: ICE });
      const media = stream;
      media.getTracks().forEach((t) => pc.addTrack(t, media));
      pc.ontrack = (e) => (remote.current!.srcObject = e.streams[0]);
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "connected") setStatus("Connected. Follow the officer's instructions.");
        if (pc.connectionState === "failed" || pc.connectionState === "closed") {
          // RBI s.18(b)(ii): after a call drop the customer starts a fresh session.
          setStatus("The call ended. If it dropped, please start again.");
          media.getTracks().forEach((t) => t.stop());
          pc.close();
          setBusy(false);
        }
      };
      await pc.setLocalDescription(await pc.createOffer());
      const sent = await fetch(`${API}/api/vcip/sessions/${id}/signal`, { method: "POST", headers, body: JSON.stringify({ sdp: await gatheredSdp(pc) }) });
      if (!sent.ok) throw new Error(await errorText(sent));

      setStatus("Waiting for a verification officer…");
      // ponytail: 2 s polling for the single answer; move to SSE if the waiting room gets busy.
      for (;;) {
        await new Promise((r) => setTimeout(r, 2000));
        const a = await fetch(`${API}/api/vcip/sessions/${id}/signal`, { headers });
        if (a.status === 200) {
          await pc.setRemoteDescription({ type: "answer", sdp: (await a.json()).sdp });
          setStatus("Connecting…");
          break;
        }
        if (a.status !== 204) throw new Error("The session expired. Please start again.");
      }
    } catch (e) {
      stream?.getTracks().forEach((t) => t.stop());
      setStatus(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>Video KYC</h1>
      <p>Keep your original PAN card (or e-PAN) ready. Sit in a well-lit place, alone, and keep this tab open.</p>
      <label style={{ display: "flex", gap: 8, alignItems: "flex-start", maxWidth: 640 }}>
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} disabled={busy} />
        <span>{CONSENT_TEXT}</span>
      </label>
      <p>
        <button onClick={start} disabled={!consent || busy} style={{ padding: "10px 20px", fontSize: 16 }}>
          Start video KYC
        </button>
      </p>
      <p role="status" aria-live="polite"><b>{status}</b></p>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <video ref={remote} autoPlay playsInline style={video} aria-label="Verification officer" />
        <video ref={self} autoPlay playsInline muted style={{ ...video, maxWidth: 240, transform: "scaleX(-1)" }} aria-label="Your camera" />
      </div>
    </main>
  );
}
