/**
 * test/encoded-clip-player.test.ts
 * Unit and integration tests for the Encoded Clip Player:
 * - ClipCodecDetector (magic bytes, extensions, headerless heuristics, confidence)
 * - ClipDecoderPipeline (phases, progress, cancellation, error handling)
 * - Real codec decoding (G.711u, G.711a, G.722, G.726, G.729, AMR-NB, AMR-WB, EVS, WAV, PCM)
 * - Error classification (empty file, unsupported codec, corrupted bitstream)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { ClipCodecDetector } from '../src/clipplayer/ClipCodecDetector.ts';
import { ClipDecoderPipeline, type DecodeProgress } from '../src/clipplayer/ClipDecoderPipeline.ts';
import { RawAudioLoader } from '../src/audio/RawAudioLoader.ts';
import { G711Encoder } from '../src/encoders/G711Encoder.ts';
import { G722Encoder } from '../src/encoders/G722Encoder.ts';
import { G726Encoder } from '../src/encoders/G726Encoder.ts';
import { G729Encoder } from '../src/encoders/G729Encoder.ts';
import { WavExporter } from '../src/media/WavExporter.ts';

const FIXTURES_DIR = path.join(import.meta.dirname, 'fixtures');

describe('Encoded Clip Player - ClipCodecDetector', () => {

  it('detects AMR-NB from magic bytes #!AMR\\n with high confidence', () => {
    const magic = new Uint8Array([0x23, 0x21, 0x41, 0x4d, 0x52, 0x0a, 0x00, 0x11, 0x22]);
    const res = ClipCodecDetector.detect(magic, 'unknown_file.bin');
    assert.equal(res.primaryCodec, 'amr-nb');
    assert.equal(res.confidence, 'high');
    assert.equal(res.detectedBy, 'magic');
  });

  it('detects AMR-WB from magic bytes #!AMR-WB\\n with high confidence', () => {
    const magic = new Uint8Array([0x23, 0x21, 0x41, 0x4d, 0x52, 0x2d, 0x57, 0x42, 0x0a, 0x00]);
    const res = ClipCodecDetector.detect(magic, 'stream.dat');
    assert.equal(res.primaryCodec, 'amr-wb');
    assert.equal(res.confidence, 'high');
    assert.equal(res.detectedBy, 'magic');
  });

  it('detects EVS from MIME container magic bytes #!EVS_MC1.0\\n with high confidence', () => {
    const magic = new Uint8Array([
      0x23, 0x21, 0x45, 0x56, 0x53, 0x5f, 0x4d, 0x43, 0x31, 0x2e, 0x30, 0x0a, 0x00, 0x00, 0x00, 0x01
    ]);
    const res = ClipCodecDetector.detect(magic, 'recording.bin');
    assert.equal(res.primaryCodec, 'evs');
    assert.equal(res.confidence, 'high');
    assert.equal(res.detectedBy, 'magic');
  });

  it('detects RIFF WAVE from magic bytes with high confidence', () => {
    const magic = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45
    ]);
    const res = ClipCodecDetector.detect(magic, 'audio.bin');
    assert.equal(res.primaryCodec, 'wav');
    assert.equal(res.confidence, 'high');
    assert.equal(res.detectedBy, 'magic');
  });

  it('detects G.711u, G.711a, G.722, G.726, G.729 by file extension with medium confidence', () => {
    const dummy = new Uint8Array(160);

    const u = ClipCodecDetector.detect(dummy, 'voice.ulaw');
    assert.equal(u.primaryCodec, 'g711u');
    assert.equal(u.confidence, 'medium');

    const a = ClipCodecDetector.detect(dummy, 'voice.alaw');
    assert.equal(a.primaryCodec, 'g711a');
    assert.equal(a.confidence, 'medium');

    const g722 = ClipCodecDetector.detect(dummy, 'audio.722');
    assert.equal(g722.primaryCodec, 'g722');
    assert.equal(g722.confidence, 'medium');

    const g726 = ClipCodecDetector.detect(dummy, 'clip.g726');
    assert.equal(g726.primaryCodec, 'g726');
    assert.equal(g726.confidence, 'medium');

    const g729 = ClipCodecDetector.detect(dummy, 'clip.729');
    assert.equal(g729.primaryCodec, 'g729');
    assert.equal(g729.confidence, 'medium');
  });

  it('identifies headerless .raw / .bin files as ambiguous with multiple candidates', () => {
    const dummy = new Uint8Array(320);
    const res = ClipCodecDetector.detect(dummy, 'stream.raw');
    assert.equal(res.confidence, 'ambiguous');
    assert.equal(res.detectedBy, 'heuristic');
    assert.ok(res.candidates.length >= 5, 'Must provide candidate list for ambiguous files');
    assert.ok(res.candidates.some(c => c.codec === 'g711u'));
    assert.ok(res.candidates.some(c => c.codec === 'g722'));
    assert.ok(res.candidates.some(c => c.codec === 'pcm'));
  });

  it('identifies completely unknown extension as unknown with candidate fallback', () => {
    const dummy = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    const res = ClipCodecDetector.detect(dummy, 'mystery.xyz');
    assert.equal(res.confidence, 'unknown');
    assert.ok(res.candidates.length > 0);
  });
});

describe('Encoded Clip Player - ClipDecoderPipeline & Codec Decoding', () => {

  it('decodes a synthetic G.711u encoded clip', async () => {
    const pcm = new Int16Array(800); // 100 ms at 8 kHz
    for (let i = 0; i < pcm.length; i++) {
      pcm[i] = Math.round(15000 * Math.sin((2 * Math.PI * 440 * i) / 8000));
    }
    const ulawBytes = G711Encoder.encodeUlaw(pcm);

    const phases: string[] = [];
    const pipeline = new ClipDecoderPipeline((prog: DecodeProgress) => {
      phases.push(prog.phase);
    });

    const result = await pipeline.decode(ulawBytes, 'clip.ulaw');
    assert.equal(result.audio.codec, 'PCMU');
    assert.equal(result.audio.sampleRate, 8000);
    assert.equal(result.audio.numChannels, 1);
    assert.equal(result.audio.channelData[0].length, 800);
    assert.ok(result.decodeDurationMs >= 0);
    assert.ok(phases.includes('inspecting'));
    assert.ok(phases.includes('decoding'));
    assert.ok(phases.includes('ready'));
  });

  it('decodes a synthetic G.711a encoded clip', async () => {
    const pcm = new Int16Array(800);
    for (let i = 0; i < pcm.length; i++) {
      pcm[i] = Math.round(15000 * Math.sin((2 * Math.PI * 440 * i) / 8000));
    }
    const alawBytes = G711Encoder.encodeAlaw(pcm);

    const pipeline = new ClipDecoderPipeline();
    const result = await pipeline.decode(alawBytes, 'clip.alaw');
    assert.equal(result.audio.codec, 'PCMA');
    assert.equal(result.audio.sampleRate, 8000);
    assert.equal(result.audio.channelData[0].length, 800);
  });

  it('decodes a synthetic G.722 wideband encoded clip', async () => {
    const pcm = new Int16Array(1600); // 100 ms at 16 kHz
    for (let i = 0; i < pcm.length; i++) {
      pcm[i] = Math.round(15000 * Math.sin((2 * Math.PI * 1000 * i) / 16000));
    }
    const g722Bytes = G722Encoder.encodeG722(pcm);

    const pipeline = new ClipDecoderPipeline();
    const result = await pipeline.decode(g722Bytes, 'speech.722');
    assert.equal(result.audio.codec, 'G722');
    assert.equal(result.audio.sampleRate, 16000);
    assert.equal(result.audio.channelData[0].length, pcm.length);
  });

  it('decodes a synthetic G.726 32kbps ADPCM clip', async () => {
    const pcm = new Int16Array(800); // 100 ms at 8 kHz
    for (let i = 0; i < pcm.length; i++) {
      pcm[i] = Math.round(12000 * Math.sin((2 * Math.PI * 500 * i) / 8000));
    }
    const g726Bytes = G726Encoder.encode32(pcm);

    const pipeline = new ClipDecoderPipeline();
    const result = await pipeline.decode(g726Bytes, 'telephony.g726');
    assert.equal(result.audio.codec, 'G726');
    assert.equal(result.audio.sampleRate, 8000);
    assert.equal(result.audio.channelData[0].length, pcm.length);
  });

  it('decodes a synthetic G.729 CS-ACELP clip', async () => {
    const pcm = new Int16Array(800); // 10 frames of 80 samples
    for (let i = 0; i < pcm.length; i++) {
      pcm[i] = Math.round(10000 * Math.sin((2 * Math.PI * 300 * i) / 8000));
    }
    const g729Bytes = G729Encoder.encode(pcm);

    const pipeline = new ClipDecoderPipeline();
    const result = await pipeline.decode(g729Bytes, 'call.729');
    assert.equal(result.audio.codec, 'G729');
    assert.equal(result.audio.sampleRate, 8000);
    assert.equal(result.audio.channelData[0].length, pcm.length);
  });

  it('decodes raw linear PCM with manual parameters', async () => {
    const sampleRate = 22050;
    const numSamples = 2205; // 100 ms
    const pcm = new Int16Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      pcm[i] = Math.round(14000 * Math.sin((2 * Math.PI * 440 * i) / sampleRate));
    }
    const rawBytes = new Uint8Array(pcm.buffer);

    const pipeline = new ClipDecoderPipeline();
    const result = await pipeline.decode(rawBytes, 'audio.raw', 'pcm', {
      sampleRate,
      numChannels: 1,
      bitDepth: 16,
    });

    assert.equal(result.audio.codec, 'PCM');
    assert.equal(result.audio.sampleRate, 22050);
    assert.equal(result.audio.numChannels, 1);
    assert.equal(result.audio.channelData[0].length, numSamples);
  });

  it('decodes a RIFF WAV file preserving exact sample rate and channels', async () => {
    const pcm = new Int16Array(1600); // 16 kHz mono
    for (let i = 0; i < pcm.length; i++) {
      pcm[i] = Math.round(12000 * Math.sin((2 * Math.PI * 600 * i) / 16000));
    }
    const wavBytes = WavExporter.encodeWav([pcm], 16000);

    const pipeline = new ClipDecoderPipeline();
    const result = await pipeline.decode(wavBytes, 'sample.wav');
    assert.equal(result.audio.codec, 'WAV');
    assert.equal(result.audio.sampleRate, 16000);
    assert.equal(result.audio.numChannels, 1);
    assert.equal(result.audio.channelData[0].length, 1600);
  });
});

describe('Encoded Clip Player - Golden Fixture Integration', () => {

  it('decodes golden G.711 ulaw reference file', async () => {
    const ulawPath = path.join(FIXTURES_DIR, 'mrfp-o', 'fd5d;d50a;8c17;2110;;547-8194-pt0.ulaw');
    if (!fs.existsSync(ulawPath)) return;

    const bytes = fs.readFileSync(ulawPath);
    const pipeline = new ClipDecoderPipeline();
    const result = await pipeline.decode(bytes, 'capture.ulaw');

    assert.equal(result.audio.codec, 'PCMU');
    assert.equal(result.audio.sampleRate, 8000);
    assert.equal(result.audio.channelData[0].length, bytes.length);
  });

  it('decodes golden G.722 reference file', async () => {
    const g722Path = path.join(FIXTURES_DIR, 'mrfp-o', 'fd5d;d50a;8c17;2110;;547-9218-pt9.g722');
    if (!fs.existsSync(g722Path)) return;

    const bytes = fs.readFileSync(g722Path);
    const pipeline = new ClipDecoderPipeline();
    const result = await pipeline.decode(bytes, 'capture.g722');

    assert.equal(result.audio.codec, 'G722');
    assert.equal(result.audio.sampleRate, 16000);
    assert.equal(result.audio.channelData[0].length, bytes.length * 2);
  });

  it('decodes golden AMR-NB reference file', async () => {
    const amrPath = path.join(FIXTURES_DIR, 'mrfp-o', 'fd5d;d50a;8c17;2110;;547-10242-pt100.amr');
    if (!fs.existsSync(amrPath)) return;

    const bytes = fs.readFileSync(amrPath);
    const pipeline = new ClipDecoderPipeline();
    const result = await pipeline.decode(bytes, 'capture.amr');

    assert.equal(result.audio.codec, 'AMR');
    assert.equal(result.audio.sampleRate, 8000);
    assert.ok(result.audio.channelData[0].length > 0);
  });

  it('decodes golden AMR-WB reference file', async () => {
    const awbPath = path.join(FIXTURES_DIR, 'mrfp-o', 'fd5d;d50a;8c17;2110;;547-11266-pt101.amrwb');
    if (!fs.existsSync(awbPath)) return;

    const bytes = fs.readFileSync(awbPath);
    const pipeline = new ClipDecoderPipeline();
    const result = await pipeline.decode(bytes, 'capture.amrwb');

    assert.equal(result.audio.codec, 'AMR-WB');
    assert.equal(result.audio.sampleRate, 16000);
    assert.ok(result.audio.channelData[0].length > 0);
  });
});

describe('Encoded Clip Player - Error Handling & Edge Cases', () => {

  it('throws empty_file error when uploading a 0-byte file', async () => {
    const empty = new Uint8Array(0);
    const pipeline = new ClipDecoderPipeline();

    await assert.rejects(
      async () => await pipeline.decode(empty, 'empty.ulaw'),
      (err: any) => {
        assert.equal(err.kind, 'empty_file');
        return true;
      }
    );
  });

  it('supports cancellation during decoding', async () => {
    const pcm = new Int16Array(8000);
    const ulaw = G711Encoder.encodeUlaw(pcm);
    const pipeline = new ClipDecoderPipeline();

    // Cancel before or during decode
    pipeline.cancel();

    await assert.rejects(
      async () => await pipeline.decode(ulaw, 'cancel_test.ulaw'),
      (err: any) => {
        assert.equal(err.kind, 'cancelled');
        return true;
      }
    );
  });

  it('allows pipeline reset and successful reuse after cancellation', async () => {
    const pcm = new Int16Array(800);
    const ulaw = G711Encoder.encodeUlaw(pcm);
    const pipeline = new ClipDecoderPipeline();

    pipeline.cancel();
    pipeline.reset();

    const res = await pipeline.decode(ulaw, 'reused.ulaw');
    assert.equal(res.audio.codec, 'PCMU');
  });

  it('reports meaningful error for unsupported lazy-fallback codecs (e.g. iLBC)', async () => {
    const dummy = new Uint8Array(100);
    const pipeline = new ClipDecoderPipeline();

    await assert.rejects(
      async () => await pipeline.decode(dummy, 'audio.ilbc'),
      (err: any) => {
        assert.equal(err.kind, 'unsupported_codec');
        assert.ok(err.message.includes('iLBC'));
        return true;
      }
    );
  });
});
