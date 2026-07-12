const SPOKEN_SUFFIX = /\bMr\. President[.!?]?$/u;

export class VoiceSuffixEnforcer {
  readonly #fallback: Buffer;
  readonly #tailBytes: number;
  #buffer = Buffer.alloc(0);
  #interrupted = false;
  #transcript = '';

  public constructor(fallback: Buffer, tailBytes = 36_000) {
    if (fallback.length === 0)
      throw new Error('voice suffix fallback is empty');
    if (!Number.isInteger(tailBytes) || tailBytes < 1) {
      throw new RangeError('voice suffix tail must be a positive integer');
    }
    this.#fallback = fallback;
    this.#tailBytes = tailBytes;
  }

  public push(audio: Buffer): Buffer[] {
    if (this.#interrupted) return [];
    this.#buffer = Buffer.concat([this.#buffer, audio]);
    if (this.#buffer.length <= this.#tailBytes) return [];
    const flushBytes = this.#buffer.length - this.#tailBytes;
    const flushed = this.#buffer.subarray(0, flushBytes);
    this.#buffer = this.#buffer.subarray(flushBytes);
    return [flushed];
  }

  public addTranscript(delta: string): void {
    if (!this.#interrupted) this.#transcript += delta;
  }

  public interrupt(): void {
    this.#interrupted = true;
    this.#buffer = Buffer.alloc(0);
  }

  public complete(): Buffer[] {
    if (this.#interrupted) return [];
    const output: Buffer[] = [this.#buffer];
    if (!SPOKEN_SUFFIX.test(this.#transcript.trim()))
      output.push(this.#fallback);
    this.#buffer = Buffer.alloc(0);
    return output;
  }
}
