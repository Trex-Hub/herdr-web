// Framed mode: [channel u32 LE][kind u8][len u32 LE][payload]

export const HEADER_SIZE = 9;
export const MAX_PAYLOAD = 16 * 1024 * 1024;

export const FrameKind = {
  DATA: 0,
  CREDIT: 1,
  CLOSE: 2,
  RESIZE: 3,
  FOCUS: 4,
  FACTS: 5,
  AUTOMATIC_INPUT: 6,
} as const;

export interface Frame {
  channel: number;
  kind: number;
  payload: Buffer;
}

export class FrameError extends Error {}

export function encodeFrame(channel: number, kind: number, payload: Uint8Array): Buffer {
  if (payload.length > MAX_PAYLOAD) {
    throw new FrameError(`payload of ${payload.length} bytes exceeds ${MAX_PAYLOAD}`);
  }
  const out = Buffer.allocUnsafe(HEADER_SIZE + payload.length);
  out.writeUInt32LE(channel, 0);
  out.writeUInt8(kind, 4);
  out.writeUInt32LE(payload.length, 5);
  out.set(payload, HEADER_SIZE);
  return out;
}

/** CREDIT frame: tells the core how many bytes of `channel` we consumed. */
export function encodeCredit(channel: number, bytes: number): Buffer {
  const payload = Buffer.allocUnsafe(4);
  payload.writeUInt32LE(bytes, 0);
  return encodeFrame(channel, FrameKind.CREDIT, payload);
}

/** Incremental decoder: feed it whatever the socket read gave, get whole frames back. */
export class FrameDecoder {
  private pending: Buffer = Buffer.alloc(0);

  push(chunk: Uint8Array): Frame[] {
    this.pending = this.pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.pending, chunk]);
    const frames: Frame[] = [];
    let offset = 0;
    while (this.pending.length - offset >= HEADER_SIZE) {
      const len = this.pending.readUInt32LE(offset + 5);
      if (len > MAX_PAYLOAD) {
        throw new FrameError(`frame payload of ${len} bytes exceeds ${MAX_PAYLOAD}`);
      }
      if (this.pending.length - offset < HEADER_SIZE + len) break;
      frames.push({
        channel: this.pending.readUInt32LE(offset),
        kind: this.pending.readUInt8(offset + 4),
        // copy: the source buffer is dropped below
        payload: Buffer.from(this.pending.subarray(offset + HEADER_SIZE, offset + HEADER_SIZE + len)),
      });
      offset += HEADER_SIZE + len;
    }
    this.pending = this.pending.subarray(offset);
    return frames;
  }

  /** Bytes buffered towards an incomplete frame. */
  get buffered(): number {
    return this.pending.length;
  }
}
