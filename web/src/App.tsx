import { useConnection } from './hooks/useConnection.js';
import { useMediaCapture } from './hooks/useMediaCapture.js';
import { StatusBar } from './components/StatusBar.js';
import { SessionPanel } from './components/SessionPanel.js';
import { LiveStreamPanel } from './components/LiveStreamPanel.js';
import { PhotoFallbackPanel } from './components/PhotoFallbackPanel.js';
import { FailureInjectionPanel } from './components/FailureInjectionPanel.js';
import { LogPanel } from './components/LogPanel.js';
import { useRegisterSW } from 'virtual:pwa-register/react';

export function App() {
  const api = useConnection();
  const media = useMediaCapture({ capture: api.state.capture, send: api.send });

  // Manage the service-worker lifecycle. `needRefresh` flips true when a new SW
  // version is waiting; `offlineReady` flips true the first time the shell is
  // precached so subsequent loads work offline.
  const {
    needRefresh: [refreshReady, setRefreshReady],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(url) {
      console.log('pwa.sw.registered', url);
    },
  });

  return (
    <div className="app">
      <header>
        <h1>Gemini Live Lab (PWA)</h1>
        <StatusBar
          status={api.state.status}
          mode={api.state.mode}
          rttMs={api.state.rttMs}
          sessionId={api.state.sessionId}
          resuming={api.state.resuming}
        />
      </header>

      {refreshReady && (
        <div className="banner">
          New version available.{' '}
          <button
            onClick={() => {
              setRefreshReady(false);
              void updateServiceWorker(true);
            }}
          >
            Reload
          </button>
        </div>
      )}
      {offlineReady && (
        <div className="banner">
          App shell is cached for offline use.{' '}
          <button onClick={() => setOfflineReady(false)}>dismiss</button>
        </div>
      )}

      <main>
        <SessionPanel api={api} />
        <LiveStreamPanel api={api} media={media} />
        <PhotoFallbackPanel api={api} media={media} />
        <FailureInjectionPanel api={api} />
        <LogPanel log={api.state.log} />
      </main>
    </div>
  );
}
