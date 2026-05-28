import { useCallback, useEffect, useRef, useState } from 'react';
import type { CaptureHint } from '../lib/types.js';
import { bytesToBase64 } from '../lib/base64.js';

export interface MediaCaptureApi {
  videoRef: React.RefObject<HTMLVideoElement>;
  active: boolean;
  listening: boolean;
  captureLabel: string;
  startMedia: () => Promise<void>;
  stopMedia: () => void;
  snapPhoto: () => Promise<Blob | null>;
}

interface UseMediaCaptureOpts {
  capture: CaptureHint;
  send: (obj: object) => void;
  /** Called once with the live video element when capture starts (used by snapPhoto). */
}

export function useMediaCapture({ capture, send }: UseMediaCaptureOpts): MediaCaptureApi {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const mediaRef = useRef<MediaStream | null>(null);
  const frameTimer = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const audioProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const frameNum = useRef(0);
  const [active, setActive] = useState(false);
  const [listening, setListening] = useState(false);
  const [captureLabel, setCaptureLabel] = useState('idle');

  const stopAudio = useCallback(() => {
    if (audioProcessorRef.current) {
      audioProcessorRef.current.disconnect();
      audioProcessorRef.current.onaudioprocess = null;
    }
    audioSourceRef.current?.disconnect();
    void audioCtxRef.current?.close();
    audioProcessorRef.current = null;
    audioSourceRef.current = null;
    audioCtxRef.current = null;
    setListening(false);
  }, []);

  const startAudio = useCallback(() => {
    if (audioCtxRef.current || !mediaRef.current) return;
    const track = mediaRef.current.getAudioTracks()[0];
    if (!track) return;
    const audioStream = new MediaStream([track]);
    // Gemini Live requires 16kHz mono PCM16; constructing AudioContext at 16000 forces resample.
    const ctx = new AudioContext({ sampleRate: 16000 });
    const source = ctx.createMediaStreamSource(audioStream);
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (ev) => {
      const input = ev.inputBuffer.getChannelData(0);
      const pcm = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]!));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      const base64 = bytesToBase64(new Uint8Array(pcm.buffer));
      send({
        type: 'realtimeInput',
        payload: { audio: { mimeType: 'audio/pcm;rate=16000', data: base64 } },
      });
    };
    source.connect(processor);
    processor.connect(ctx.destination);
    audioCtxRef.current = ctx;
    audioSourceRef.current = source;
    audioProcessorRef.current = processor;
    setListening(true);
  }, [send]);

  const captureFrame = useCallback(() => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 240;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.6);
    const base64 = dataUrl.split(',')[1] ?? '';
    const frameId = `f${frameNum.current++}`;
    send({
      type: 'realtimeInput',
      payload: {
        __meta: { frameId },
        video: { mimeType: 'image/jpeg', data: base64 },
      },
    });
    setTimeout(() => send({ type: 'frameAck', id: frameId }), 0);
  }, [send]);

  const stopMedia = useCallback(() => {
    if (frameTimer.current) {
      clearInterval(frameTimer.current);
      frameTimer.current = null;
    }
    stopAudio();
    mediaRef.current?.getTracks().forEach((t) => t.stop());
    mediaRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setActive(false);
    setCaptureLabel('idle');
  }, [stopAudio]);

  const startMedia = useCallback(async () => {
    try {
      mediaRef.current = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: 'environment' },
        audio: true,
      });
    } catch (err) {
      console.warn('media error', err);
      return;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = mediaRef.current;
    }
    setActive(true);
  }, []);

  // Apply the latest capture hint whenever the upstream changes mode (or when media starts).
  useEffect(() => {
    if (!active) return;
    if (frameTimer.current) {
      clearInterval(frameTimer.current);
      frameTimer.current = null;
    }
    if (capture.photoMode) {
      stopAudio();
      setCaptureLabel('photo mode (use Snap & ask)');
      return;
    }
    startAudio();
    if (capture.audioOnly || capture.maxFps <= 0) {
      setCaptureLabel('audio only');
      return;
    }
    const intervalMs = Math.max(200, Math.round(1000 / capture.maxFps));
    setCaptureLabel(`${capture.maxFps} fps (every ${intervalMs}ms)`);
    frameTimer.current = window.setInterval(captureFrame, intervalMs);
  }, [active, capture, captureFrame, startAudio, stopAudio]);

  const snapPhoto = useCallback(async (): Promise<Blob | null> => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return null;
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 480;
    canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.85),
    );
  }, []);

  useEffect(() => {
    return () => stopMedia();
  }, [stopMedia]);

  return { videoRef, active, listening, captureLabel, startMedia, stopMedia, snapPhoto };
}
