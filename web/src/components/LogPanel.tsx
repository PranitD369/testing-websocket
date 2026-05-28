import type { ConnectionState } from '../hooks/useConnection.js';

export function LogPanel({ log }: { log: ConnectionState['log'] }) {
  return (
    <section className="panel">
      <h2>Log</h2>
      <pre className="log">
        {log
          .map((e) => {
            const data = e.data === undefined ? '' : ' ' + (typeof e.data === 'string' ? e.data : JSON.stringify(e.data));
            return `[${e.ts}] ${e.msg}${data}`;
          })
          .join('\n')}
      </pre>
    </section>
  );
}
