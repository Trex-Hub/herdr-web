import { describe, expect, it } from "vitest";
import { encodeCredit, encodeFrame, FrameDecoder, FrameError, FrameKind, MAX_PAYLOAD } from "../src/frame.js";

describe("encodeFrame", () => {
  it("writes [channel u32 LE][kind u8][len u32 LE][payload]", () => {
    const out = encodeFrame(0x01020304, FrameKind.DATA, Buffer.from("hi"));
    expect([...out]).toEqual([0x04, 0x03, 0x02, 0x01, 0, 2, 0, 0, 0, 0x68, 0x69]);
  });

  it("encodes an empty payload", () => {
    const out = encodeFrame(7, FrameKind.CLOSE, new Uint8Array());
    expect([...out]).toEqual([7, 0, 0, 0, 2, 0, 0, 0, 0]);
  });

  it("refuses payloads over 16 MiB", () => {
    expect(() => encodeFrame(0, 0, new Uint8Array(MAX_PAYLOAD + 1))).toThrow(FrameError);
  });

  it("encodes CREDIT as a u32 LE byte count", () => {
    const out = encodeCredit(3, 0x0102);
    expect([...out]).toEqual([3, 0, 0, 0, 1, 4, 0, 0, 0, 0x02, 0x01, 0, 0]);
  });
});

describe("FrameDecoder", () => {
  const a = encodeFrame(0, FrameKind.DATA, Buffer.from('{"id":2}'));
  const b = encodeFrame(1, FrameKind.DATA, Buffer.from("event line\n"));

  it("decodes one frame", () => {
    const frames = new FrameDecoder().push(a);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ channel: 0, kind: FrameKind.DATA });
    expect(frames[0]?.payload.toString()).toBe('{"id":2}');
  });

  it("decodes a frame split across reads, at every split point", () => {
    for (let cut = 1; cut < a.length; cut++) {
      const d = new FrameDecoder();
      expect(d.push(a.subarray(0, cut))).toEqual([]);
      expect(d.buffered).toBe(cut);
      const frames = d.push(a.subarray(cut));
      expect(frames).toHaveLength(1);
      expect(frames[0]?.payload.toString()).toBe('{"id":2}');
      expect(d.buffered).toBe(0);
    }
  });

  it("decodes a frame delivered one byte at a time", () => {
    const d = new FrameDecoder();
    const frames = [...b].flatMap((byte) => d.push(Buffer.from([byte])));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ channel: 1, kind: FrameKind.DATA });
  });

  it("decodes two frames in one read", () => {
    const frames = new FrameDecoder().push(Buffer.concat([a, b]));
    expect(frames.map((f) => [f.channel, f.payload.toString()])).toEqual([
      [0, '{"id":2}'],
      [1, "event line\n"],
    ]);
  });

  it("decodes a whole frame plus the start of the next, then the rest", () => {
    const d = new FrameDecoder();
    const both = Buffer.concat([a, b]);
    const first = d.push(both.subarray(0, a.length + 4));
    expect(first).toHaveLength(1);
    const second = d.push(both.subarray(a.length + 4));
    expect(second).toHaveLength(1);
    expect(second[0]?.channel).toBe(1);
  });

  it("decodes an empty-payload frame", () => {
    const frames = new FrameDecoder().push(encodeFrame(5, FrameKind.CLOSE, new Uint8Array()));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ channel: 5, kind: FrameKind.CLOSE });
    expect(frames[0]?.payload.length).toBe(0);
  });

  it("rejects a header announcing more than 16 MiB", () => {
    const header = Buffer.alloc(9);
    header.writeUInt32LE(MAX_PAYLOAD + 1, 5);
    expect(() => new FrameDecoder().push(header)).toThrow(FrameError);
  });
});
