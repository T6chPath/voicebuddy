import { useEffect, useState } from "react";
import { canSaveFile, openPdf, pdfName, sharePdf } from "../pdf/pdf";
import { pdfStore } from "../pdf/store";
import { Icon } from "./Icon";

function usePdf(id: string) {
  const [, force] = useState(0);
  useEffect(() => pdfStore.subscribe(() => force((n) => n + 1)), []);
  return pdfStore.get(id);
}

/** "Save as PDF" in a reply's action row */
export function PdfButton({ id, text, request }: { id: string; text: string; request?: string }) {
  const s = usePdf(id);
  return (
    <button type="button" className="icon-btn" aria-label="Save as PDF" title="Save as PDF" disabled={s?.status === "making"}
            onClick={() => void pdfStore.make(id, text, request)}>
      <Icon name="pdf" size={16} />
    </button>
  );
}

/** The file card under a reply that was turned into a PDF */
export function PdfCard({ id, text, request }: { id: string; text: string; request?: string }) {
  const s = usePdf(id);
  if (!s) return null;
  const name = s.result?.name || pdfName(s.title);
  return (
    <div className={`pdf-card ${s.status}`} role="status">
      <span className="pdf-icon" aria-hidden="true"><Icon name="pdf" size={22} /></span>
      <div className="pdf-info">
        <strong>{name}</strong>
        <span className="muted small-text">
          {s.status === "making" ? "Creating the PDF…"
            : s.status === "saved" ? `Saved to ${s.result?.where || "Downloads/zenvqo"}`
            : s.status === "error" ? s.error
            : canSaveFile() ? "Opened the Save as PDF screen" : "Ready — choose “Save as PDF” in the print window"}
        </span>
      </div>
      <div className="pdf-actions">
        {s.status === "saved" && s.result && <>
          <button type="button" className="btn small primary" onClick={() => openPdf(s.result!.id)}>Open</button>
          <button type="button" className="btn small" onClick={() => sharePdf(s.result!.id)}>Share</button>
        </>}
        {(s.status === "ready" || s.status === "error") && (
          <button type="button" className="btn small primary" onClick={() => void pdfStore.make(id, text, request)}>
            {s.status === "error" ? "Try again" : "Save PDF"}
          </button>
        )}
      </div>
    </div>
  );
}
