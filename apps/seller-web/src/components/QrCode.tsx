import { encodeQr, qrPath } from "../lib/qr";

/** Inline SVG QR for TOTP enrolment, generated locally: the secret never goes to a third-party QR service. */
export function QrCode({ text, label }: { text: string; label: string }) {
  const m = encodeQr(text);
  if (m === null) return null;
  const { d, viewBox } = qrPath(m);
  return (
    <svg className="zm-qr" viewBox={`0 0 ${viewBox} ${viewBox}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={viewBox} height={viewBox} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}
