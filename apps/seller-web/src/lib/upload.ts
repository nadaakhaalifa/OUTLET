/** Browser-side helpers for direct-to-storage uploads through signed URLs (XMLHttpRequest gives progress events). */

export async function sha256Hex(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type PutOutcome = "ok" | "failed" | "network" | "aborted";

/** PUTs the file to a signed URL. No cookies or auth headers are sent: the URL itself is the capability. */
export function putWithProgress(
  url: string, headers: Readonly<Record<string, string>>, file: Blob, onProgress: (loaded: number, total: number) => void, signal?: AbortSignal,
): Promise<PutOutcome> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() !== "host" && k.toLowerCase() !== "content-length") xhr.setRequestHeader(k, v);
    }
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded, e.total);
    };
    xhr.onload = () => resolve(xhr.status >= 200 && xhr.status < 300 ? "ok" : "failed");
    xhr.onerror = () => resolve("network");
    xhr.onabort = () => resolve("aborted");
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}
