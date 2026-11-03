import type { AudioTransport, SocketLike } from './AudioTransport.js';

/**
 * Text transport: drives the orchestrator from a CLI, a WebSocket demo page, tests and
 * the eval harness. `deliver()` injects a patient utterance; everything the agent says
 * is captured in `spoken`.
 */
export class TextTransport implements AudioTransport {
  readonly kind = 'text' as const;

  readonly spoken: string[] = [];
  private utteranceHandlers: ((text: string) => void)[] = [];
  private speechStartHandlers: (() => void)[] = [];
  private connectedHandlers: (() => void)[] = [];
  private disconnectedHandlers: ((reason?: string) => void)[] = [];
  private speaking = false;
  private interrupted = false;

  constructor(private readonly sink?: (line: string) => void) {}

  onUtterance(handler: (text: string) => void): void {
    this.utteranceHandlers.push(handler);
  }

  onSpeechStart(handler: () => void): void {
    this.speechStartHandlers.push(handler);
  }

  onConnected(handler: () => void): void {
    this.connectedHandlers.push(handler);
    handler();
  }

  onDisconnected(handler: (reason?: string) => void): void {
    this.disconnectedHandlers.push(handler);
  }

  /** Test/CLI entry point: patient says something. */
  deliver(text: string): void {
    if (this.speaking) {
      this.interrupted = true;
      for (const handler of this.speechStartHandlers) handler();
    }
    for (const handler of this.utteranceHandlers) handler(text);
  }

  async speak(text: string): Promise<void> {
    this.speaking = true;
    this.interrupted = false;
    this.spoken.push(text);
    this.sink?.(text);
    this.speaking = false;
  }

  async stopSpeaking(): Promise<void> {
    if (this.speaking) this.interrupted = true;
    this.speaking = false;
  }

  get interruptedDuringSpeech(): boolean {
    return this.interrupted;
  }

  async close(reason?: string): Promise<void> {
    for (const handler of this.disconnectedHandlers) handler(reason);
  }

  /** Attach to a browser WebSocket carrying JSON `{type:'text', text}` messages. */
  static bindSocket(socket: SocketLike, transport: TextTransport): void {
    transport.onUtterance((text) => socket.send(JSON.stringify({ type: 'agent_text', text })));
    transport.onDisconnected((reason) => socket.send(JSON.stringify({ type: 'ended', reason })));
  }
}
