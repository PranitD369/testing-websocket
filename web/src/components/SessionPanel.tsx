import { useState } from 'react';
import type { ConnectionApi } from '../hooks/useConnection.js';

export function SessionPanel({ api }: { api: ConnectionApi }) {
  const [draft, setDraft] = useState(api.state.sessionId);
  const isConnected = api.state.status === 'connected' || api.state.status === 'connecting';

  // Keep the input synced when the auto-mint flow writes a fresh id.
  if (draft === '' && api.state.sessionId) setDraft(api.state.sessionId);

  return (
    <section className="panel">
      <h2>Session</h2>
      <div className="row">
        <button onClick={() => api.connect(draft)} disabled={isConnected}>
          Connect
        </button>
        <button onClick={api.disconnect} disabled={!isConnected}>
          Disconnect
        </button>
        <button
          onClick={() => {
            api.resetSession();
            setDraft('');
          }}
        >
          New session
        </button>
      </div>
      <div className="row">
        <label>
          Session ID:{' '}
          <input
            type="text"
            placeholder="(auto)"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              api.setSessionId(e.target.value);
            }}
          />
        </label>
      </div>
    </section>
  );
}
