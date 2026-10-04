/**
 * Reads a Server-Sent Events response body and calls `onData` with the
 * payload of every `data:` event. Return `false` from `onData` to stop early.
 */
export async function readSse(response, onData) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const flush = (block) => {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    return data ? onData(data) : undefined;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // A "\r" split from its "\n" across chunks is rejoined here before normalizing.
      buffer = buffer.replace(/\r\n/g, "\n");
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (flush(block) === false) return;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) flush(buffer.replace(/\r/g, ""));
  } finally {
    reader.releaseLock?.();
  }
}

export async function readErrorMessage(response, fallback) {
  const raw = await response.text().catch(() => "");
  try {
    const parsed = JSON.parse(raw);
    const payload = Array.isArray(parsed) ? parsed[0] : parsed;
    const message = payload?.error?.message || payload?.error || payload?.message;
    if (typeof message === "string" && message) return message;
  } catch {
    // Not JSON; fall through.
  }
  return raw.trim().slice(0, 300) || fallback;
}
