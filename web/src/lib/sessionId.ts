const KEY = 'sessionId';

export function loadSessionId(): string {
  return localStorage.getItem(KEY) ?? '';
}

export function saveSessionId(id: string): void {
  localStorage.setItem(KEY, id);
}

export function clearSessionId(): void {
  localStorage.removeItem(KEY);
}

export function mintSessionId(): string {
  return `c_${Math.random().toString(36).slice(2, 14)}`;
}
