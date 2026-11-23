/**
 * ClipCodecDetector.ts
 * Enhanced codec detection for the Encoded Clip Player.
 * Wraps RawAudioLoader.detectCodec() with confidence levels and
 * multi-candidate results for ambiguous headerless files.
 */

import { RawAudioLoader, type SupportedRawCodec } from '../audio/RawAudioLoader.ts';

export type DetectionConfidence = 'high' | 'medium' | 'low' | 'ambiguous' | 'unknown';

export interface CodecCandidate {
  codec: SupportedRawCodec;
  label: string;
  sampleRate: number;
  channels: number;
  description: string;
}

export interface DetectionResult {
  primaryCodec: SupportedRawCodec;
  confidence: DetectionConfidence;
  candidates: CodecCandidate[];
  detectedBy: 'magic' | 'extension' | 'heuristic' | 'manual';
  fileSize: number;
  fileName: string;
}

/** Pre-defined metadata entries for each supported codec */
const CODEC_INFO: Record<string, { label: string; sampleRate: number; channels: number; description: string }> = {
  'g711u':     { label: 'G.711 µ-law (PCMU)', sampleRate: 8000,  channels: 1, description: 'ITU-T G.711 µ-law companded PCM, 64 kbps' },
  'g711a':     { label: 'G.711 A-law (PCMA)', sampleRate: 8000,  channels: 1, description: 'ITU-T G.711 A-law companded PCM, 64 kbps' },
  'g722':      { label: 'G.722 SB-ADPCM',     sampleRate: 16000, channels: 1, description: 'ITU-T G.722 Sub-Band ADPCM, 64 kbps wideband' },
  'g726':      { label: 'G.726 ADPCM',         sampleRate: 8000,  channels: 1, description: 'ITU-T G.726 32 kbps ADPCM narrowband' },
  'g729':      { label: 'G.729 CS-ACELP',      sampleRate: 8000,  channels: 1, description: 'ITU-T G.729 / G.729A, 8 kbps' },
  'amr-nb':    { label: 'AMR-NB',              sampleRate: 8000,  channels: 1, description: '3GPP AMR Narrowband, 4.75–12.2 kbps' },
  'amr-wb':    { label: 'AMR-WB (G.722.2)',    sampleRate: 16000, channels: 1, description: '3GPP AMR Wideband, 6.6–23.85 kbps' },
  'evs':       { label: 'EVS',                 sampleRate: 16000, channels: 1, description: '3GPP Enhanced Voice Services, 5.9–128 kbps' },
  'opus':      { label: 'Opus',                sampleRate: 48000, channels: 1, description: 'Opus interactive audio codec (RFC 6716)' },
  'wav':       { label: 'WAV (RIFF)',           sampleRate: 0,     channels: 0, description: 'Microsoft RIFF WAVE container' },
  'pcm':       { label: 'Raw PCM',             sampleRate: 16000, channels: 1, description: 'Uncompressed linear PCM audio' },
  'container': { label: 'Audio Container',     sampleRate: 0,     channels: 0, description: 'MP3, AAC, FLAC, OGG, or other browser-decodable container' },
  'ilbc':      { label: 'iLBC',                sampleRate: 8000,  channels: 1, description: 'Internet Low Bitrate Codec (not fully supported)' },
  'speex':     { label: 'Speex',               sampleRate: 16000, channels: 1, description: 'Speex CELP codec (not fully supported)' },
};

/** Headerless codecs that could be ambiguous for .raw / .bin / unknown files */
const HEADERLESS_CANDIDATES: SupportedRawCodec[] = ['g711u', 'g711a', 'g722', 'g726', 'g729', 'pcm'];

export class ClipCodecDetector {
  /**
   * Detect codec from file bytes and name, returning confidence and candidates.
   */
  public static detect(bytes: Uint8Array, fileName: string): DetectionResult {
    const baseResult = RawAudioLoader.detectCodec(bytes, fileName);
    const ext = fileName.toLowerCase().split('.').pop() || '';
    const fileSize = bytes.byteLength;

    // Case 1: Magic-byte detected codecs are HIGH confidence
    const magicCodec = this.detectByMagic(bytes);
    if (magicCodec !== 'auto') {
      const info = CODEC_INFO[magicCodec] || { label: magicCodec, sampleRate: 0, channels: 1, description: '' };
      return {
        primaryCodec: magicCodec,
        confidence: 'high',
        candidates: [{ codec: magicCodec, ...info }],
        detectedBy: 'magic',
        fileSize,
        fileName,
      };
    }

    // Case 2: Known codec-specific extensions are MEDIUM confidence
    if (baseResult !== 'auto' && baseResult !== 'pcm') {
      const info = CODEC_INFO[baseResult] || { label: baseResult, sampleRate: 0, channels: 1, description: '' };
      return {
        primaryCodec: baseResult,
        confidence: baseResult === 'wav' || baseResult === 'container' ? 'high' : 'medium',
        candidates: [{ codec: baseResult, ...info }],
        detectedBy: 'extension',
        fileSize,
        fileName,
      };
    }

    // Case 3: Raw/PCM/bin/unknown — ambiguous, offer candidates
    if (ext === 'raw' || ext === 'bin' || ext === 'pcm' || baseResult === 'pcm') {
      return {
        primaryCodec: 'pcm',
        confidence: 'ambiguous',
        candidates: HEADERLESS_CANDIDATES.map(c => ({
          codec: c,
          ...(CODEC_INFO[c] || { label: c, sampleRate: 0, channels: 1, description: '' }),
        })),
        detectedBy: 'heuristic',
        fileSize,
        fileName,
      };
    }

    // Case 4: Completely unknown extension
    return {
      primaryCodec: 'auto',
      confidence: 'unknown',
      candidates: [
        ...HEADERLESS_CANDIDATES.map(c => ({
          codec: c,
          ...(CODEC_INFO[c] || { label: c, sampleRate: 0, channels: 1, description: '' }),
        })),
        { codec: 'evs',    ...CODEC_INFO['evs'] },
        { codec: 'amr-nb', ...CODEC_INFO['amr-nb'] },
        { codec: 'amr-wb', ...CODEC_INFO['amr-wb'] },
      ],
      detectedBy: 'heuristic',
      fileSize,
      fileName,
    };
  }

  /** Get human-readable label for a codec */
  public static getCodecLabel(codec: SupportedRawCodec | string): string {
    return CODEC_INFO[codec]?.label || codec.toUpperCase();
  }

  /** Get the full info for a codec */
  public static getCodecInfo(codec: string) {
    return CODEC_INFO[codec] || null;
  }

  /** Pure magic-byte detection (no extension fallback) */
  private static detectByMagic(bytes: Uint8Array): SupportedRawCodec | 'auto' {
    if (bytes.length >= 9 && bytes[0] === 0x23 && bytes[1] === 0x21 && bytes[2] === 0x41 &&
        bytes[3] === 0x4d && bytes[4] === 0x52 && bytes[5] === 0x2d && bytes[6] === 0x57 &&
        bytes[7] === 0x42 && bytes[8] === 0x0a) return 'amr-wb';
    if (bytes.length >= 6 && bytes[0] === 0x23 && bytes[1] === 0x21 && bytes[2] === 0x41 &&
        bytes[3] === 0x4d && bytes[4] === 0x52 && bytes[5] === 0x0a) return 'amr-nb';
    if (bytes.length >= 13 && bytes[0] === 0x23 && bytes[1] === 0x21 && bytes[2] === 0x45 &&
        bytes[3] === 0x56 && bytes[4] === 0x53 && bytes[5] === 0x5f && bytes[6] === 0x4d &&
        bytes[7] === 0x43 && bytes[8] === 0x31 && bytes[9] === 0x2e && bytes[10] === 0x30 &&
        bytes[11] === 0x0a) return 'evs';
    if (bytes.length >= 4 && bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 &&
        bytes[3] === 0x53) return 'opus';
    if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 &&
        bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 &&
        bytes[11] === 0x45) return 'wav';
    if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x46 && bytes[2] === 0x36 &&
        bytes[3] === 0x34 && bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 &&
        bytes[11] === 0x45) return 'wav';
    if (bytes.length >= 4 && bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 &&
        bytes[3] === 0x43) return 'container';
    if (bytes.length >= 3 && ((bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) ||
        (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0))) return 'container';
    return 'auto';
  }
}
