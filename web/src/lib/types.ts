export type Mode = 'HD_VIDEO' | 'LD_VIDEO' | 'AUDIO_ONLY' | 'PHOTO_MODE';
export type ConnStatus = 'disconnected' | 'connecting' | 'reconnecting' | 'connected' | 'error';

export interface CaptureHint {
  maxFps: number;
  audioOnly: boolean;
  photoMode: boolean;
}

export interface ServerHello {
  type: 'hello';
  sessionId: string;
  mode: Mode;
  capture: CaptureHint;
  resuming: boolean;
}

export interface ServerModeChange {
  type: 'modeChange';
  mode: Mode;
  capture: CaptureHint;
}

export interface ServerPing {
  type: 'ping';
  t: number;
}

export interface ServerUpstreamReady {
  type: 'upstreamReady';
}

export interface ServerUpstreamGaveUp {
  type: 'upstreamGaveUp';
  message: string;
}

export type WrappedServerMessage =
  | ServerHello
  | ServerModeChange
  | ServerPing
  | ServerUpstreamReady
  | ServerUpstreamGaveUp;

export interface GeminiServerContent {
  serverContent: {
    modelTurn?: { parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> };
    turnComplete?: boolean;
    interrupted?: boolean;
  };
}

export interface GeminiGoAway {
  goAway: { timeLeft?: string };
}

export interface GeminiSetupComplete {
  setupComplete: object;
}

export interface GeminiResumption {
  sessionResumptionUpdate: { newHandle?: string; resumable?: boolean };
}

export type GeminiPassthroughMessage =
  | GeminiServerContent
  | GeminiGoAway
  | GeminiSetupComplete
  | GeminiResumption;

export type AnyServerMessage = WrappedServerMessage | GeminiPassthroughMessage;
