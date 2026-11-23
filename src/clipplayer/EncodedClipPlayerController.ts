/**
 * EncodedClipPlayerController.ts
 * Main UI controller for the Encoded Clip Player tab.
 * Orchestrates: file upload → codec detection → decoding → waveform → playback.
 * Reuses existing AudioPlayback, RawAudioLoader, WavExporter, and codec infrastructure.
 */

import { ClipCodecDetector, type DetectionResult, type CodecCandidate } from './ClipCodecDetector.ts';
import { ClipDecoderPipeline, type DecodeProgress, type DecodeError } from './ClipDecoderPipeline.ts';
import { AudioPlayback } from '../media/AudioPlayback.ts';
import { WavExporter } from '../media/WavExporter.ts';
import type { LoadedAudio, SupportedRawCodec, RawPcmOptions } from '../audio/RawAudioLoader.ts';

export class EncodedClipPlayerController {
  private static instance: EncodedClipPlayerController | null = null;

  // State
  private fileBytes: Uint8Array | null = null;
  private fileName: string = '';
  private detection: DetectionResult | null = null;
  private decodedAudio: LoadedAudio | null = null;
  private pipeline: ClipDecoderPipeline | null = null;
  private player = new AudioPlayback();
  private waveformPeaks: number[] = [];
  private playbackRate = 1.0;
  private isMuted = false;
  private savedVolume = 0.8;
  private selectedCodec: SupportedRawCodec | null = null;
  private animFrameId: number | null = null;

  // DOM Elements (resolved lazily)
  private els: Record<string, HTMLElement | null> = {};

  private constructor() {
    this.player.onTimeUpdate = (cur, dur) => this.onTimeUpdate(cur, dur);
    this.player.onEnded = () => this.onPlaybackEnded();
  }

  public static getInstance(): EncodedClipPlayerController {
    if (!EncodedClipPlayerController.instance) {
      EncodedClipPlayerController.instance = new EncodedClipPlayerController();
    }
    return EncodedClipPlayerController.instance;
  }

  /** Initialize: bind all event listeners. Call once after DOM is ready. */
  public init(): void {
    this.bindEvents();
  }

  // ─── DOM Helpers ──────────────────────────────────────────────────────

  private el(id: string): HTMLElement | null {
    if (!this.els[id]) {
      this.els[id] = document.getElementById(id);
    }
    return this.els[id];
  }

  private setText(id: string, text: string): void {
    const e = this.el(id);
    if (e) e.textContent = text;
  }

  private setDisplay(id: string, show: boolean, display = 'block'): void {
    const e = this.el(id);
    if (e) e.style.display = show ? display : 'none';
  }

  // ─── Event Binding ────────────────────────────────────────────────────

  private bindEvents(): void {
    // Dropzone
    const dropzone = this.el('cp-dropzone');
    if (dropzone) {
      dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        (e.currentTarget as HTMLElement).style.borderColor = 'var(--accent)';
        (e.currentTarget as HTMLElement).style.background = 'rgba(122,162,247,0.06)';
      });
      dropzone.addEventListener('dragleave', (e) => {
        (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)';
        (e.currentTarget as HTMLElement).style.background = 'transparent';
      });
      dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)';
        (e.currentTarget as HTMLElement).style.background = 'transparent';
        const file = (e as DragEvent).dataTransfer?.files[0];
        if (file) this.handleFile(file);
      });
      dropzone.addEventListener('click', () => {
        (this.el('cp-file-input') as HTMLInputElement | null)?.click();
      });
    }

    // Browse button
    this.el('cp-btn-browse')?.addEventListener('click', (e) => {
      e.stopPropagation();
      (this.el('cp-file-input') as HTMLInputElement | null)?.click();
    });

    // File input
    (this.el('cp-file-input') as HTMLInputElement | null)?.addEventListener('change', (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) this.handleFile(file);
    });

    // Remove file
    this.el('cp-btn-remove')?.addEventListener('click', () => this.resetAll());

    // Reset
    this.el('cp-btn-reset')?.addEventListener('click', () => this.resetAll());

    // Cancel decode
    this.el('cp-btn-cancel')?.addEventListener('click', () => {
      this.pipeline?.cancel();
    });

    // Codec dialog confirm/cancel
    this.el('cp-btn-codec-confirm')?.addEventListener('click', () => this.onCodecConfirmed());
    this.el('cp-btn-codec-cancel')?.addEventListener('click', () => this.resetAll());

    // Transport controls
    this.el('cp-btn-play')?.addEventListener('click', () => this.playAudio());
    this.el('cp-btn-pause')?.addEventListener('click', () => this.pauseAudio());
    this.el('cp-btn-stop')?.addEventListener('click', () => this.stopAudio());
    this.el('cp-btn-replay')?.addEventListener('click', () => {
      this.player.seek(0);
      this.playAudio();
    });

    // Seek bar
    (this.el('cp-seek-bar') as HTMLInputElement | null)?.addEventListener('input', (e) => {
      const val = Number((e.target as HTMLInputElement).value);
      const dur = this.player.getDuration();
      this.player.seek((val / 1000) * dur);
    });

    // Volume
    (this.el('cp-volume-slider') as HTMLInputElement | null)?.addEventListener('input', (e) => {
      const vol = Number((e.target as HTMLInputElement).value) / 100;
      this.savedVolume = vol;
      this.isMuted = false;
      this.player.setVolume(vol);
      this.setText('cp-btn-mute', vol === 0 ? '🔇' : '🔊');
    });

    // Mute toggle
    this.el('cp-btn-mute')?.addEventListener('click', () => {
      this.isMuted = !this.isMuted;
      if (this.isMuted) {
        this.player.setVolume(0);
        this.setText('cp-btn-mute', '🔇');
      } else {
        this.player.setVolume(this.savedVolume);
        this.setText('cp-btn-mute', '🔊');
      }
    });

    // Speed
    (this.el('cp-speed-select') as HTMLSelectElement | null)?.addEventListener('change', (e) => {
      this.playbackRate = Number((e.target as HTMLSelectElement).value);
      // Web Audio playbackRate is set on the source node — restart playback to apply
      if (this.player.isPlayingNow()) {
        const cur = this.player.getCurrentTime();
        this.stopAudio();
        this.player.seek(cur);
        this.playAudio();
      }
    });

    // Download WAV
    this.el('cp-btn-download')?.addEventListener('click', () => this.downloadWav());

    // Waveform click to seek
    const canvas = this.el('cp-waveform-canvas') as HTMLCanvasElement | null;
    canvas?.addEventListener('click', (e) => {
      if (!this.decodedAudio) return;
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const pct = x / rect.width;
      this.player.seek(pct * this.player.getDuration());
      this.drawWaveform();
    });

    // Set initial volume
    this.player.setVolume(this.savedVolume);
  }

  // ─── File Handling ────────────────────────────────────────────────────

  private async handleFile(file: File): Promise<void> {
    this.resetState();

    this.fileName = file.name;
    const buffer = await file.arrayBuffer();
    this.fileBytes = new Uint8Array(buffer);

    // Show file info
    this.setText('cp-file-name', file.name);
    this.setText('cp-file-size', this.formatFileSize(file.size));
    this.setDisplay('cp-file-info', true);
    this.setDisplay('cp-btn-reset', true);
    this.setDisplay('cp-error-panel', false);

    // Detect codec
    this.detection = ClipCodecDetector.detect(this.fileBytes, this.fileName);

    if (this.detection.confidence === 'high' || this.detection.confidence === 'medium') {
      // Auto-decode
      await this.startDecode(this.detection.primaryCodec);
    } else {
      // Show codec selection dialog
      this.showCodecDialog(this.detection);
    }
  }

  // ─── Codec Selection Dialog ───────────────────────────────────────────

  private showCodecDialog(detection: DetectionResult): void {
    this.setDisplay('cp-codec-dialog', true);
    this.selectedCodec = null;

    const optionsContainer = this.el('cp-codec-options');
    if (!optionsContainer) return;
    optionsContainer.innerHTML = '';

    // Set description
    const desc = this.el('cp-codec-dialog-desc');
    if (desc) {
      if (detection.confidence === 'ambiguous') {
        desc.textContent = 'The uploaded file appears to be a headerless raw bitstream. Please select the correct codec:';
      } else {
        desc.textContent = 'Unable to automatically identify the codec. Please select the encoding format:';
      }
    }

    detection.candidates.forEach((candidate: CodecCandidate) => {
      const btn = document.createElement('button');
      btn.className = 'btn btn-sm btn-ctrl-sec cp-codec-option';
      btn.style.cssText = 'text-align: left; padding: 8px 14px; display: flex; justify-content: space-between; align-items: center;';
      btn.innerHTML = `
        <span style="font-weight: 600; font-size: 13px;">${candidate.label}</span>
        <span style="font-size: 11px; color: var(--text-dim);">${candidate.description}</span>
      `;
      btn.addEventListener('click', () => {
        // Deselect all
        optionsContainer.querySelectorAll('.cp-codec-option').forEach(b => {
          (b as HTMLElement).style.borderColor = 'var(--border)';
          (b as HTMLElement).style.background = 'transparent';
        });
        // Select this one
        btn.style.borderColor = 'var(--accent)';
        btn.style.background = 'rgba(122,162,247,0.1)';
        this.selectedCodec = candidate.codec;
        // Show PCM config if PCM selected
        this.setDisplay('cp-pcm-config', candidate.codec === 'pcm');
        // Enable confirm button
        const confirmBtn = this.el('cp-btn-codec-confirm') as HTMLButtonElement | null;
        if (confirmBtn) confirmBtn.disabled = false;
      });
      optionsContainer.appendChild(btn);
    });

    // Disable confirm button initially
    const confirmBtn = this.el('cp-btn-codec-confirm') as HTMLButtonElement | null;
    if (confirmBtn) confirmBtn.disabled = true;
    this.setDisplay('cp-pcm-config', false);
  }

  private async onCodecConfirmed(): Promise<void> {
    if (!this.selectedCodec) return;
    this.setDisplay('cp-codec-dialog', false);

    let pcmOptions: RawPcmOptions | undefined;
    if (this.selectedCodec === 'pcm') {
      const sr = Number((this.el('cp-pcm-samplerate') as HTMLSelectElement)?.value || '16000');
      const bd = Number((this.el('cp-pcm-bitdepth') as HTMLSelectElement)?.value || '16');
      const ch = Number((this.el('cp-pcm-channels') as HTMLSelectElement)?.value || '1');
      pcmOptions = {
        sampleRate: sr,
        numChannels: ch,
        bitDepth: bd as 8 | 16 | 24 | 32,
      };
    }

    await this.startDecode(this.selectedCodec, pcmOptions);
  }

  // ─── Decoding ─────────────────────────────────────────────────────────

  private async startDecode(codec: SupportedRawCodec, pcmOptions?: RawPcmOptions): Promise<void> {
    if (!this.fileBytes) return;

    this.setDisplay('cp-status-bar', true);
    this.setDisplay('cp-btn-cancel', true, 'inline-block');
    this.setDisplay('cp-error-panel', false);
    this.setDisplay('cp-metadata-panel', false);
    this.setDisplay('cp-player-panel', false);

    this.pipeline = new ClipDecoderPipeline((progress: DecodeProgress) => {
      this.onDecodeProgress(progress);
    });

    try {
      const result = await this.pipeline.decode(this.fileBytes, this.fileName, codec, pcmOptions);
      this.decodedAudio = result.audio;

      // Hide status bar
      this.setDisplay('cp-status-bar', false);

      // Show metadata
      this.showMetadata(result.audio, result.decodeDurationMs);

      // Setup waveform and player
      this.setupPlayer(result.audio);

    } catch (err) {
      this.setDisplay('cp-status-bar', false);
      this.showError(err as DecodeError);
    }
  }

  private onDecodeProgress(progress: DecodeProgress): void {
    this.setText('cp-status-text', progress.message);
    const bar = this.el('cp-progress-bar') as HTMLElement | null;
    if (bar && progress.percent !== undefined) {
      bar.style.width = `${progress.percent}%`;
    } else if (bar) {
      // Indeterminate — pulse animation via CSS
      bar.style.width = '30%';
    }
    this.setText('cp-status-detail', progress.phase);
  }

  // ─── Error Display ────────────────────────────────────────────────────

  private showError(err: DecodeError | unknown): void {
    this.setDisplay('cp-error-panel', true);
    if (err && typeof err === 'object' && 'kind' in err) {
      const de = err as DecodeError;
      const titles: Record<string, string> = {
        unsupported_codec: 'Unsupported Codec',
        unknown_format: 'Unknown File Format',
        invalid_header: 'Invalid File Header',
        corrupted_bitstream: 'Corrupted Bitstream',
        decoder_init_failure: 'Decoder Initialization Failed',
        decode_failure: 'Decoding Failed',
        empty_file: 'Empty File',
        wasm_missing: 'WebAssembly Module Missing',
        browser_limitation: 'Browser Limitation',
        cancelled: 'Cancelled',
      };
      this.setText('cp-error-title', titles[de.kind] || 'Error');
      this.setText('cp-error-message', de.message);
    } else {
      this.setText('cp-error-title', 'Unexpected Error');
      this.setText('cp-error-message', err instanceof Error ? err.message : String(err));
    }
  }

  // ─── Metadata Panel ──────────────────────────────────────────────────

  private showMetadata(audio: LoadedAudio, decodeDurationMs: number): void {
    this.setDisplay('cp-metadata-panel', true);
    const tbody = this.el('cp-metadata-tbody');
    if (!tbody) return;

    const rows: [string, string][] = [
      ['File Name', audio.fileName],
      ['Codec', audio.codec],
      ['Format', audio.formatName],
      ['Sample Rate', `${audio.sampleRate.toLocaleString()} Hz`],
      ['Channels', audio.numChannels === 1 ? 'Mono' : audio.numChannels === 2 ? 'Stereo' : `${audio.numChannels} channels`],
      ['Duration', this.formatTime(audio.durationSec)],
      ['Samples', audio.channelData[0].length.toLocaleString()],
      ['Decode Time', `${decodeDurationMs.toFixed(1)} ms`],
    ];

    if (audio.isContainerDecoded) {
      rows.push(['Note', 'Decoded by browser — sample rate may differ from original']);
    }

    tbody.innerHTML = rows.map(([key, val]) =>
      `<tr><td style="font-weight: 600; color: var(--text-dim); padding: 4px 12px 4px 0; white-space: nowrap;">${key}</td><td style="padding: 4px 0; color: var(--text-main);">${val}</td></tr>`
    ).join('');
  }

  // ─── Player Setup ─────────────────────────────────────────────────────

  private setupPlayer(audio: LoadedAudio): void {
    this.setDisplay('cp-player-panel', true);

    // Convert Float32 → Int16 for AudioPlayback.loadPcm16()
    const ch0 = audio.channelData[0];
    const pcm16 = new Int16Array(ch0.length);
    for (let i = 0; i < ch0.length; i++) {
      pcm16[i] = Math.max(-32768, Math.min(32767, Math.round(ch0[i] * 32768)));
    }

    if (audio.numChannels >= 2) {
      const ch1 = audio.channelData[1];
      const right = new Int16Array(ch1.length);
      for (let i = 0; i < ch1.length; i++) {
        right[i] = Math.max(-32768, Math.min(32767, Math.round(ch1[i] * 32768)));
      }
      this.player.loadStereoPcm16(pcm16, right, audio.sampleRate);
    } else {
      this.player.loadPcm16(pcm16, audio.sampleRate);
    }

    // Generate waveform peaks
    this.waveformPeaks = AudioPlayback.generateWaveformPeaks(pcm16, 500);

    // Set time display
    this.setText('cp-time-total', this.formatTime(audio.durationSec));
    this.setText('cp-time-current', '0:00.00');
    (this.el('cp-seek-bar') as HTMLInputElement).value = '0';

    // Show play button, hide pause
    this.setDisplay('cp-btn-play', true, 'inline-block');
    this.setDisplay('cp-btn-pause', false);

    // Draw waveform
    this.drawWaveform();
  }

  // ─── Audio Playback Controls ──────────────────────────────────────────

  private playAudio(): void {
    this.player.play();
    this.setDisplay('cp-btn-play', false);
    this.setDisplay('cp-btn-pause', true, 'inline-block');
    this.startWaveformAnimation();
  }

  private pauseAudio(): void {
    this.player.pause();
    this.setDisplay('cp-btn-play', true, 'inline-block');
    this.setDisplay('cp-btn-pause', false);
    this.stopWaveformAnimation();
    this.drawWaveform();
  }

  private stopAudio(): void {
    this.player.stop();
    this.setDisplay('cp-btn-play', true, 'inline-block');
    this.setDisplay('cp-btn-pause', false);
    this.stopWaveformAnimation();
    this.setText('cp-time-current', '0:00.00');
    (this.el('cp-seek-bar') as HTMLInputElement).value = '0';
    this.drawWaveform();
  }

  private onPlaybackEnded(): void {
    this.setDisplay('cp-btn-play', true, 'inline-block');
    this.setDisplay('cp-btn-pause', false);
    this.stopWaveformAnimation();
    this.drawWaveform();
  }

  private onTimeUpdate(currentSec: number, durationSec: number): void {
    this.setText('cp-time-current', this.formatTime(currentSec));
    const seekBar = this.el('cp-seek-bar') as HTMLInputElement | null;
    if (seekBar && durationSec > 0) {
      seekBar.value = String(Math.round((currentSec / durationSec) * 1000));
    }
  }

  // ─── Waveform Rendering ───────────────────────────────────────────────

  private drawWaveform(): void {
    const canvas = this.el('cp-waveform-canvas') as HTMLCanvasElement | null;
    if (!canvas || this.waveformPeaks.length === 0) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    canvas.width = w * dpr;
    canvas.height = h * dpr;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    // Background
    ctx.fillStyle = '#16161e';
    ctx.fillRect(0, 0, w, h);

    // Center line
    const midY = h / 2;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(w, midY);
    ctx.stroke();

    // Compute playback progress
    const duration = this.player.getDuration();
    const currentTime = this.player.getCurrentTime();
    const progressPct = duration > 0 ? currentTime / duration : 0;
    const progressX = progressPct * w;

    // Draw waveform bars
    const numPeaks = this.waveformPeaks.length;
    const barWidth = w / numPeaks;
    const ampScale = (h / 2) * 0.9;

    // Auto-boost for quiet clips
    let maxPeak = 0;
    for (const p of this.waveformPeaks) {
      if (p > maxPeak) maxPeak = p;
    }
    const normFactor = maxPeak >= 0.05 ? 1.0 : (maxPeak > 0.00001 ? 0.25 / maxPeak : 1.0);

    for (let i = 0; i < numPeaks; i++) {
      const x = i * barWidth;
      const peak = Math.min(1.0, this.waveformPeaks[i] * normFactor);
      const barH = peak * ampScale;

      if (x < progressX) {
        ctx.fillStyle = '#7aa2f7';  // played portion
      } else {
        ctx.fillStyle = 'rgba(122, 162, 247, 0.35)';  // unplayed portion
      }

      ctx.fillRect(x, midY - barH, Math.max(1, barWidth - 0.5), barH * 2);
    }

    // Playhead needle
    if (duration > 0) {
      ctx.strokeStyle = '#f7768e';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(progressX, 0);
      ctx.lineTo(progressX, h);
      ctx.stroke();
    }

    // Time overlay
    const timeEl = this.el('cp-waveform-time');
    if (timeEl) {
      timeEl.textContent = `${this.formatTime(currentTime)} / ${this.formatTime(duration)}`;
    }
  }

  private startWaveformAnimation(): void {
    this.stopWaveformAnimation();
    const tick = () => {
      this.drawWaveform();
      if (this.player.isPlayingNow()) {
        this.animFrameId = requestAnimationFrame(tick);
      }
    };
    this.animFrameId = requestAnimationFrame(tick);
  }

  private stopWaveformAnimation(): void {
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
  }

  // ─── WAV Download ─────────────────────────────────────────────────────

  private downloadWav(): void {
    if (!this.decodedAudio) return;
    const audio = this.decodedAudio;

    // Convert Float32 channels → Int16 channels for WavExporter
    const int16Channels: Int16Array[] = audio.channelData.map(ch => {
      const pcm = new Int16Array(ch.length);
      for (let i = 0; i < ch.length; i++) {
        pcm[i] = Math.max(-32768, Math.min(32767, Math.round(ch[i] * 32768)));
      }
      return pcm;
    });

    const wavBytes = WavExporter.encodeWav(int16Channels, audio.sampleRate, 16);
    const blob = new Blob([wavBytes], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    const baseName = this.fileName.replace(/\.[^.]+$/, '');
    a.href = url;
    a.download = `${baseName}_decoded.wav`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ─── Reset ────────────────────────────────────────────────────────────

  public resetAll(): void {
    this.player.stop();
    this.stopWaveformAnimation();
    this.resetState();
    this.resetUI();
  }

  private resetState(): void {
    this.pipeline?.cancel();
    this.pipeline = null;
    this.fileBytes = null;
    this.fileName = '';
    this.detection = null;
    this.decodedAudio = null;
    this.waveformPeaks = [];
    this.selectedCodec = null;
  }

  private resetUI(): void {
    this.setDisplay('cp-file-info', false);
    this.setDisplay('cp-status-bar', false);
    this.setDisplay('cp-error-panel', false);
    this.setDisplay('cp-codec-dialog', false);
    this.setDisplay('cp-metadata-panel', false);
    this.setDisplay('cp-player-panel', false);
    this.setDisplay('cp-btn-reset', false);
    this.setDisplay('cp-btn-cancel', false);
    this.setText('cp-time-current', '0:00.00');
    this.setText('cp-time-total', '0:00.00');

    // Reset file input
    const fileInput = this.el('cp-file-input') as HTMLInputElement | null;
    if (fileInput) fileInput.value = '';

    // Clear canvas
    const canvas = this.el('cp-waveform-canvas') as HTMLCanvasElement | null;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    }
  }

  /** Stop audio playback when switching away from this tab */
  public deactivate(): void {
    this.player.stop();
    this.stopWaveformAnimation();
    this.setDisplay('cp-btn-play', true, 'inline-block');
    this.setDisplay('cp-btn-pause', false);
  }

  // ─── Formatting Utilities ─────────────────────────────────────────────

  private formatTime(seconds: number): string {
    if (!isFinite(seconds) || seconds < 0) return '0:00.00';
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toFixed(2).padStart(5, '0')}`;
  }

  private formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(2)} MB`;
  }
}
