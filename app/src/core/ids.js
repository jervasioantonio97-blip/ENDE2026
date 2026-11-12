// IDs. crypto.randomUUID só existe em contexto seguro (https, localhost).
// A WebView de um APK a abrir ficheiros locais pode não o ter: fallback obrigatório.

export function uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();

  const b = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(b);
  } else {
    for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  }

  b[6] = (b[6] & 0x0f) | 0x40; // versão 4
  b[8] = (b[8] & 0x3f) | 0x80; // variante RFC 4122

  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
