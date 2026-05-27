/**
 * Minimal type definitions for Gemini Live API messages.
 * Refs:
 *  - https://ai.google.dev/api/live
 *  - https://ai.google.dev/gemini-api/docs/live-session
 */

export interface LiveSetup {
  setup: {
    model: string;
    generationConfig?: {
      responseModalities?: Array<'TEXT' | 'AUDIO'>;
      temperature?: number;
    };
    systemInstruction?: { parts: Array<{ text: string }> };
    sessionResumption?: { handle?: string };
    contextWindowCompression?: { slidingWindow: object; triggerTokens?: number };
    realtimeInputConfig?: {
      automaticActivityDetection?: { disabled?: boolean; startOfSpeechSensitivity?: string; endOfSpeechSensitivity?: string };
    };
  };
}

export interface RealtimeInput {
  realtimeInput: {
    mediaChunks?: Array<{ mimeType: string; data: string }>;
    audio?: { mimeType: string; data: string };
    video?: { mimeType: string; data: string };
    text?: string;
  };
}

export interface ClientContent {
  clientContent: {
    turns: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }>;
    turnComplete?: boolean;
  };
}

export interface SetupComplete {
  setupComplete: object;
}

export interface ServerContent {
  serverContent: {
    modelTurn?: { parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> };
    turnComplete?: boolean;
    interrupted?: boolean;
  };
}

export interface GoAway {
  goAway: {
    timeLeft?: string;
  };
}

export interface SessionResumptionUpdate {
  sessionResumptionUpdate: {
    newHandle?: string;
    resumable?: boolean;
  };
}

export type ServerMessage = SetupComplete | ServerContent | GoAway | SessionResumptionUpdate;

export type Mode = 'HD_VIDEO' | 'LD_VIDEO' | 'AUDIO_ONLY' | 'PHOTO_MODE';
