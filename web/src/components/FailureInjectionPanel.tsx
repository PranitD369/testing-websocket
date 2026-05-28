import type { ConnectionApi } from '../hooks/useConnection.js';

export function FailureInjectionPanel({ api }: { api: ConnectionApi }) {
  return (
    <section className="panel">
      <h2>Failure Injection</h2>
      <div className="row">
        <label>
          <input
            type="checkbox"
            checked={api.inject.dropFrames}
            onChange={(e) => api.setInject('dropFrames', e.target.checked)}
          />{' '}
          drop 50% of outbound frames
        </label>
      </div>
      <div className="row">
        <label>
          <input
            type="checkbox"
            checked={api.inject.stallPongs}
            onChange={(e) => api.setInject('stallPongs', e.target.checked)}
          />{' '}
          stall pongs (kill heartbeat)
        </label>
      </div>
      <div className="row">
        <button onClick={api.killSocket}>Kill socket</button>
        <button onClick={() => api.forceMode('PHOTO_MODE')}>Force photo mode</button>
        <button onClick={() => api.forceMode('HD_VIDEO')}>Force HD</button>
      </div>
    </section>
  );
}
