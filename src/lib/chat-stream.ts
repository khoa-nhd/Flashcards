/**
 * Reads the server-sent events of one AI reply. A network chunk can end in the
 * middle of an event, so text is kept until a whole line has arrived.
 */
import type { AiStreamChunk } from '../../shared/api.js';

/**
 * How the reply ended: finished, or stopped with the server's reason. A
 * finished reply says why it stopped; `time_limit` means it was cut short at
 * the server's deadline, with what had arrived kept.
 */
export type ChatStreamEnd = { ok: true; finishReason: string | null } | { ok: false; message: string };

export async function readChatStream(
  stream: ReadableStream<Uint8Array>,
  onDelta: (text: string) => void,
): Promise<ChatStreamEnd> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let end: ChatStreamEnd | null = null;

  const handle = (line: string) => {
    if (!line.startsWith('data:')) return;
    let chunk: AiStreamChunk;
    try {
      chunk = JSON.parse(line.slice(5).trim()) as AiStreamChunk;
    } catch {
      return;
    }
    if (chunk.type === 'delta') onDelta(chunk.delta);
    else if (chunk.type === 'done') end = { ok: true, finishReason: chunk.finishReason ?? null };
    else if (chunk.type === 'error') end = { ok: false, message: chunk.message };
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) handle(line.trim());
    }
    buffer += decoder.decode();
    if (buffer.trim() !== '') handle(buffer.trim());
  } finally {
    reader.releaseLock();
  }
  // A stream that stops without saying it is done was cut off.
  return end ?? { ok: false, message: 'The reply was cut off before it finished. Try again.' };
}
