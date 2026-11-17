export interface Transport {
  connect(): Promise<void>;
  send(frame: Uint8Array): void;
  onMessage(cb: (f: Uint8Array) => void): void;
  onClose(cb: (code: number, reason: string) => void): void;
  close(): void;
}
