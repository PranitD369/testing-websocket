import type { ConnectionApi } from '../hooks/useConnection.js';
import type { MediaCaptureApi } from '../hooks/useMediaCapture.js';

export function LiveStreamPanel({
  api,
  media,
}: {
  api: ConnectionApi;
  media: MediaCaptureApi;
}) {
  return (
    <section className="panel">
      <h2>Live Stream</h2>
      <video ref={media.videoRef} autoPlay muted playsInline />
      <div className="row">
        <button onClick={() => void media.startMedia()} disabled={media.active}>
          Start camera + mic
        </button>
        <button onClick={media.stopMedia} disabled={!media.active}>
          Stop
        </button>
      </div>
      <div className="row capture-info">capture: {media.captureLabel}</div>
      <div className="row">
        <button onClick={() => api.player.interrupt()} disabled={!media.active}>
          Interrupt model
        </button>
        <span className={`badge ${media.listening ? 'ok' : ''}`}>
          listening: {media.listening ? 'on' : 'off'}
        </span>
      </div>
    </section>
  );
}
