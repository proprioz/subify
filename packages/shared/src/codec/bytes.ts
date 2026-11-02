/**
 * The building blocks of the payload codecs (CONTRIBUTING.md, Conventions: payloads): a writer
 * and a strict reader over a fixed-size buffer. Plain TypeScript over DataView, with no runtime
 * dependency, so the PWA can import the codecs it shares with the server. Numbers are big-endian.
 */

/** A payload that doesn't decode: after a successful AEAD decryption, this is a bug. */
export class CodecError extends Error {
  override readonly name = 'CodecError';
}

/**
 * One kind of payload. `encode` always returns exactly `size` bytes, and `decode` refuses anything
 * else. The first byte is the format version: the server reads every version it knows and writes
 * the latest.
 */
export interface Codec<T> {
  /** Bound into the AEAD associated data, so that a blob can't be read as another kind. */
  readonly kind: number;
  readonly version: number;
  readonly size: number;
  encode(value: T): Uint8Array;
  decode(bytes: Uint8Array): T;
}

export class Writer {
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  private offset = 0;

  constructor(size: number) {
    this.bytes = new Uint8Array(size);
    this.view = new DataView(this.bytes.buffer);
  }

  /** Bytes still free. */
  get room(): number {
    return this.bytes.length - this.offset;
  }

  u8(value: number): this {
    this.check(value, 0xff);
    this.view.setUint8(this.take(1), value);

    return this;
  }

  u16(value: number): this {
    this.check(value, 0xffff);
    this.view.setUint16(this.take(2), value);

    return this;
  }

  u32(value: number): this {
    this.check(value, 0xffffffff);
    this.view.setUint32(this.take(4), value);

    return this;
  }

  raw(value: Uint8Array): this {
    this.bytes.set(value, this.take(value.length));

    return this;
  }

  /** Bytes with a u16 length. */
  blob(value: Uint8Array): this {
    return this.u16(value.length).raw(value);
  }

  /** UTF-8 text with a u8 length: it must fit 255 bytes (see {@link fitUtf8}). */
  text(value: string): this {
    const encoded = utf8(value);

    return this.u8(encoded.length).raw(encoded);
  }

  /** The buffer, padded with zeros to its full size. */
  finish(): Uint8Array {
    return this.bytes;
  }

  private take(length: number): number {
    if (length > this.room) {
      throw new CodecError('Payload too large');
    }

    const at = this.offset;
    this.offset += length;

    return at;
  }

  private check(value: number, max: number): void {
    if (!Number.isInteger(value) || value < 0 || value > max) {
      throw new CodecError('Number out of range');
    }
  }
}

/** Reads what a {@link Writer} wrote, refusing anything out of shape. */
export class Reader {
  private readonly view: DataView;
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  u8(): number {
    return this.view.getUint8(this.take(1));
  }

  u16(): number {
    return this.view.getUint16(this.take(2));
  }

  u32(): number {
    return this.view.getUint32(this.take(4));
  }

  raw(length: number): Uint8Array {
    const at = this.take(length);

    return this.bytes.slice(at, at + length);
  }

  blob(max: number): Uint8Array {
    const length = this.u16();

    if (length > max) {
      throw new CodecError('Length out of range');
    }

    return this.raw(length);
  }

  text(max: number): string {
    const length = this.u8();

    if (length > max) {
      throw new CodecError('Length out of range');
    }

    return fromUtf8(this.raw(length));
  }

  /** A number at most `max`. */
  upTo(value: number, max: number): number {
    if (value > max) {
      throw new CodecError('Number out of range');
    }

    return value;
  }

  /** The rest must be padding: any other byte means a format the decoder doesn't know. */
  end(): void {
    for (let i = this.offset; i < this.bytes.length; i++) {
      if (this.bytes[i] !== 0) {
        throw new CodecError('Trailing bytes');
      }
    }
  }

  private take(length: number): number {
    if (this.offset + length > this.bytes.length) {
      throw new CodecError('Truncated payload');
    }

    const at = this.offset;
    this.offset += length;

    return at;
  }
}

/** Starts a decode: checks the size and the version byte. */
export function reader<T>(codec: Codec<T>, bytes: Uint8Array): Reader {
  if (bytes.length !== codec.size) {
    throw new CodecError('Wrong payload size');
  }

  const read = new Reader(bytes);

  if (read.u8() !== codec.version) {
    throw new CodecError('Unknown format version');
  }

  return read;
}

/** Starts an encode: a buffer of the codec's size, its version byte written. */
export function writer<T>(codec: Codec<T>): Writer {
  return new Writer(codec.size).u8(codec.version);
}

/** Refuses flag bits a decoder doesn't know: they would mean a format it can't read. */
export function flags(value: number, known: number): number {
  if ((value & ~known) !== 0) {
    throw new CodecError('Unknown flag');
  }

  return value;
}

/**
 * The text cut to at most `maxBytes` of UTF-8, at a character (code point) boundary, so that a cut
 * never leaves half an emoji or a broken CJK character.
 */
export function fitUtf8(value: string, maxBytes: number): string {
  let length = 0;
  let end = 0;

  for (const char of value) {
    const size = charSize(char.codePointAt(0)!);

    if (length + size > maxBytes) {
      break;
    }

    length += size;
    end += char.length;
  }

  return value.slice(0, end);
}

/** UTF-8 length in bytes. */
export function utf8Length(value: string): number {
  let length = 0;

  for (const char of value) {
    length += charSize(char.codePointAt(0)!);
  }

  return length;
}

function charSize(code: number): number {
  return code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
}

const encoder = new TextEncoder();
// fatal: overlong forms, surrogates and truncated sequences are refused, never replaced.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** UTF-8 bytes. A lone surrogate becomes U+FFFD. */
export function utf8(value: string): Uint8Array {
  return encoder.encode(value);
}

export function fromUtf8(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new CodecError('Invalid UTF-8');
  }
}

/** Bytes as base64url without padding: how the API carries them in JSON. */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((byte) => (binary += String.fromCharCode(byte)));

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array {
  return Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0));
}
