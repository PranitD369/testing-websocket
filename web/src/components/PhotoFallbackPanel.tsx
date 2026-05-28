import { useState } from 'react';
import type { ConnectionApi } from '../hooks/useConnection.js';
import type { MediaCaptureApi } from '../hooks/useMediaCapture.js';

export function PhotoFallbackPanel({
  api,
  media,
}: {
  api: ConnectionApi;
  media: MediaCaptureApi;
}) {
  const [question, setQuestion] = useState('What is this?');
  const [reply, setReply] = useState('');
  const [pending, setPending] = useState(false);

  const snap = async () => {
    setReply('');
    const blob = await media.snapPhoto();
    if (!blob) {
      setReply('error: no media stream; click Start camera + mic first');
      return;
    }
    const form = new FormData();
    form.append('photo', blob, 'snap.jpg');
    form.append('text', question || 'What is this?');
    if (api.state.sessionId) form.append('sessionId', api.state.sessionId);

    setPending(true);
    setReply('… thinking …');
    try {
      const resp = await fetch('/fallback/photo', { method: 'POST', body: form });
      const json = (await resp.json()) as { text?: string; error?: string };
      if (!resp.ok) {
        setReply(`error: ${json.error ?? resp.status}`);
        return;
      }
      setReply(json.text ?? '');
      if ('speechSynthesis' in window && json.text) {
        window.speechSynthesis.speak(new SpeechSynthesisUtterance(json.text));
      }
    } catch (err) {
      setReply(`error: ${(err as Error).message}`);
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="panel">
      <h2>Photo Fallback</h2>
      <p className="hint">
        One photo + text question to <code>POST /fallback/photo</code>. The server injects the
        cached transcript summary so the answer is continuous with the live conversation.
      </p>
      <div className="row">
        <button onClick={() => void snap()} disabled={pending}>
          Snap &amp; ask
        </button>
        <input
          type="text"
          placeholder="What is this?"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
        />
      </div>
      {reply && <div className="reply">{reply}</div>}
    </section>
  );
}
