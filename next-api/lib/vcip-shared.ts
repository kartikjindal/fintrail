// Shared by the browser pages and the API. Keep in sync with springboot-api VcipController.

export const CONSENT_VERSION = "2026-11-v1";
export const CONSENT_TEXT =
  "I agree to complete video KYC (V-CIP) with a DhanBoost official. I understand that the call is " +
  "recorded with my live location and the date and time, that my photo and a picture of my PAN card " +
  "will be captured, and that this data is stored securely in India as RBI requires.";

// RBI KYC Master Direction s.18(b): what the official must confirm before approving.
export const CHECKLIST: [key: string, label: string][] = [
  ["faceMatchesAadhaar", "Face matches the Aadhaar / OVD photo"],
  ["faceMatchesPan", "Face matches the PAN / e-PAN photo"],
  ["detailsMatch", "Details match what the customer entered"],
  ["livenessPassed", "Customer answered the random prompts live"],
  ["noPrompting", "No one is prompting the customer"],
  ["aadhaarDataFresh", "Aadhaar XML/QR is at most 3 working days old (or DigiLocker / e-KYC)"],
  ["addressConfirmed", "Current address confirmed"],
  ["financialProfileConfirmed", "Economic and financial profile confirmed"],
];
