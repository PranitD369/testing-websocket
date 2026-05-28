import type { ConnStatus, Mode } from '../lib/types.js';

const statusClass: Record<ConnStatus, string> = {
  disconnected: 'badge err',
  connecting: 'badge warn',
  reconnecting: 'badge warn',
  connected: 'badge ok',
  error: 'badge err',
};

const modeClass: Record<Mode, string> = {
  HD_VIDEO: 'badge ok',
  LD_VIDEO: 'badge ok',
  AUDIO_ONLY: 'badge warn',
  PHOTO_MODE: 'badge err',
};

interface Props {
  status: ConnStatus;
  mode: Mode;
  rttMs: number | null;
  sessionId: string;
  resuming: boolean;
}

export function StatusBar({ status, mode, rttMs, sessionId, resuming }: Props) {
  const shortId = sessionId ? sessionId.slice(0, 14) : 'no session';
  return (
    <div className="status-bar">
      <span className={statusClass[status]}>{status}</span>
      <span className={modeClass[mode]}>{mode}</span>
      <span className="badge">rtt {rttMs == null ? '--' : `${rttMs}ms`}</span>
      <span className="badge" title={sessionId}>
        {shortId}
        {resuming && <span className="resumed"> · resumed</span>}
      </span>
    </div>
  );
}
