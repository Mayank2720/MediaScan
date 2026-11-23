/**
 * ClipDecoderPipeline.ts
 * Orchestrates codec decoding for the Encoded Clip Player,
 * wrapping RawAudioLoader.load() with progress callbacks,
 * cancellation support, and classified error messages.
 */

import { RawAudioLoader, type LoadedAudio, type SupportedRawCodec, type RawPcmOptions } from '../audio/RawAudioLoader.ts';

export type DecodePhase =
  | 'idle'
  | 'inspecting'
  | 'detecting'
  | 'awaiting_selection'
  | 'initializing_decoder'
  | 'decoding'
  | 'preparing_playback'
  | 'ready'
  | 'error';

export type DecodeErrorKind =
  | 'unsupported_codec'
  | 'unknown_format'
  | 'invalid_header'
  | 'corrupted_bitstream'
  | 'decoder_init_failure'
  | 'decode_failure'
  | 'empty_file'
  | 'wasm_missing'
  | 'browser_limitation'
  | 'cancelled';

export interface DecodeError {
  kind: DecodeErrorKind;
  message: string;
  codec?: string;
}

export interface DecodeProgress {
  phase: DecodePhase;
  message: string;
  percent?: number;
}

export interface DecodeResult {
  audio: LoadedAudio;
  decodeDurationMs: number;
}

export class ClipDecoderPipeline {
  private cancelled = false;

  constructor(
    private onProgress?: (progress: DecodeProgress) => void,
  ) {}

  /** Cancel any in-progress decode */
  public cancel(): void {
    this.cancelled = true;
  }

  /** Reset the pipeline for a new decode */
  public reset(): void {
    this.cancelled = false;
  }

  /**
   * Decode an encoded audio clip file into playable PCM.
   */
  public async decode(
    bytes: Uint8Array,
    fileName: string,
    forcedCodec: SupportedRawCodec = 'auto',
    pcmOptions?: RawPcmOptions,
  ): Promise<DecodeResult> {
    this.cancelled = false;
    const startMs = performance.now();

    // Phase 1: Inspecting
    this.report({ phase: 'inspecting', message: 'Inspecting file contents...' });
    if (bytes.byteLength === 0) {
      throw this.makeError('empty_file', 'The uploaded file is empty (0 bytes).');
    }
    this.checkCancel();

    // Phase 2: Detecting
    this.report({ phase: 'detecting', message: 'Detecting codec encoding...' });
    await this.yieldFrame();
    this.checkCancel();

    // Phase 3: Initializing decoder
    const codecLabel = forcedCodec === 'auto' ? 'auto-detected' : forcedCodec;
    this.report({ phase: 'initializing_decoder', message: `Initializing ${codecLabel} decoder...` });
    await this.yieldFrame();
    this.checkCancel();

    // Phase 4: Decoding
    this.report({ phase: 'decoding', message: 'Decoding audio frames...', percent: 0 });

    try {
      const audio = await RawAudioLoader.load(bytes, fileName, forcedCodec, pcmOptions);
      this.checkCancel();

      // Check for lazy fallback (unsupported codecs like iLBC, Speex)
      if (audio.requiresLazyFallback) {
        throw this.makeError(
          'unsupported_codec',
          audio.lazyFallbackReason || `Codec '${audio.codec}' is not fully supported.`,
          audio.codec
        );
      }

      // Validate decoded output has actual samples
      if (!audio.channelData || audio.channelData.length === 0 || audio.channelData[0].length === 0) {
        throw this.makeError('decode_failure', 'Decoder produced no audio samples.', audio.codec);
      }

      this.report({ phase: 'decoding', message: 'Decoding complete.', percent: 100 });

      // Phase 5: Preparing playback
      this.report({ phase: 'preparing_playback', message: 'Preparing audio for playback...' });
      await this.yieldFrame();

      this.report({ phase: 'ready', message: 'Ready to play.' });

      return {
        audio,
        decodeDurationMs: performance.now() - startMs,
      };
    } catch (err) {
      if (this.cancelled) {
        throw this.makeError('cancelled', 'Decoding was cancelled by user.');
      }

      // Re-throw if already a DecodeError
      if (err && typeof err === 'object' && 'kind' in err) {
        throw err;
      }

      const msg = err instanceof Error ? err.message : String(err);

      // Classify error by message content
      if (msg.includes('WASM') || msg.includes('wasm') || msg.includes('WebAssembly')) {
        throw this.makeError('wasm_missing', `WebAssembly decoder module failed to load: ${msg}`);
      }
      if (msg.includes('AudioContext') || msg.includes('decodeAudioData')) {
        throw this.makeError('browser_limitation', `Browser audio API limitation: ${msg}`);
      }
      if (msg.includes('header') || msg.includes('magic') || msg.includes('RIFF')) {
        throw this.makeError('invalid_header', `Invalid file header: ${msg}`);
      }
      if (msg.includes('frame') || msg.includes('bitstream') || msg.includes('corrupt')) {
        throw this.makeError('corrupted_bitstream', `Corrupted audio bitstream: ${msg}`);
      }

      throw this.makeError('decode_failure', msg);
    }
  }

  private report(progress: DecodeProgress): void {
    this.onProgress?.(progress);
  }

  private makeError(kind: DecodeErrorKind, message: string, codec?: string): DecodeError {
    return { kind, message, codec };
  }

  private checkCancel(): void {
    if (this.cancelled) {
      throw this.makeError('cancelled', 'Decoding was cancelled by user.');
    }
  }

  private yieldFrame(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0));
  }
}
