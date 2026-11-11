// Saving a picture the app holds as a data: URL. In the Android app, links to data: URLs can't be downloaded, so the
// file goes through the app (window.ZenvqoPDF.saveBytes → Downloads/zenvqo); browsers get a normal download.
export function saveDataUrl(dataUrl: string, name: string): Promise<string> {
  const bridge = (window as unknown as { ZenvqoPDF?: { saveBytes?(id: string, b64: string, name: string): void } }).ZenvqoPDF;
  if (bridge?.saveBytes) {
    return new Promise((resolve, reject) => {
      const id = "save" + Date.now() + Math.random().toString(36).slice(2, 6);
      const prev = window.__zpdf;
      window.__zpdf = (rid, status, data) => {
        if (rid !== id) { prev?.(rid, status, data); return; }
        window.__zpdf = prev;
        if (status === "saved") resolve("Saved to Downloads/zenvqo"); else reject(new Error(data || "Couldn't save the picture."));
      };
      bridge.saveBytes!(id, dataUrl.split(",", 2)[1] || "", name);
    });
  }
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  return Promise.resolve("Downloaded " + name);
}
