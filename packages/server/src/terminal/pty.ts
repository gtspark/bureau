import * as pty from 'node-pty';
import { EventEmitter } from 'events';

export interface PtyTerminal {
  id: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

// Regex to match OSC 7 escape sequence: ESC ] 7 ; file://hostname/path BEL or ST
// Format: \x1b]7;file://hostname/path\x07 or \x1b]7;file://hostname/path\x1b\\
const OSC7_REGEX = /\x1b\]7;file:\/\/[^\/]*([^\x07\x1b]+)(?:\x07|\x1b\\)/g;

export class PtyManager extends EventEmitter {
  private terminals: Map<string, pty.IPty> = new Map();
  private terminalCwds: Map<string, string> = new Map();
  private projectRoot: string;
  private terminalCounter = 0;

  constructor(projectRoot: string) {
    super();
    this.projectRoot = projectRoot;
  }

  spawn(cols: number = 80, rows: number = 24, cwd?: string): string {
    const id = `pty-${++this.terminalCounter}`;
    const startCwd = cwd || this.projectRoot;

    const shell = process.env.SHELL || '/bin/bash';

    // Inject PROMPT_COMMAND to emit OSC 7 after each command
    // This makes bash report its cwd after every command
    const existingPromptCommand = process.env.PROMPT_COMMAND || '';
    const osc7Command = 'printf "\\e]7;file://%s%s\\e\\\\" "$(hostname)" "$(pwd)"';
    const promptCommand = existingPromptCommand
      ? `${existingPromptCommand}; ${osc7Command}`
      : osc7Command;

    const terminal = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: startCwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        PROMPT_COMMAND: promptCommand,
      },
    });

    // Track initial cwd
    this.terminalCwds.set(id, startCwd);

    terminal.onData((data) => {
      // Parse for OSC 7 sequences to track cwd changes
      this.parseOsc7(id, data);
      this.emit('data', { id, data });
    });

    terminal.onExit(({ exitCode, signal }) => {
      this.terminals.delete(id);
      this.terminalCwds.delete(id);
      this.emit('exit', { id, exitCode, signal });
    });

    this.terminals.set(id, terminal);
    this.emit('spawned', { id, cwd: startCwd });

    return id;
  }

  // Parse OSC 7 escape sequences to detect cwd changes
  private parseOsc7(id: string, data: string): void {
    let match;
    let lastCwd: string | null = null;

    // Find all OSC 7 sequences in the data
    while ((match = OSC7_REGEX.exec(data)) !== null) {
      // Decode URI-encoded path
      try {
        lastCwd = decodeURIComponent(match[1]);
      } catch {
        lastCwd = match[1];
      }
    }

    // Only emit if cwd changed
    if (lastCwd && lastCwd !== this.terminalCwds.get(id)) {
      this.terminalCwds.set(id, lastCwd);
      this.emit('cwd', { id, cwd: lastCwd });
    }
  }

  // Get current cwd for a terminal
  getCwd(id: string): string | undefined {
    return this.terminalCwds.get(id);
  }

  write(id: string, data: string): boolean {
    const terminal = this.terminals.get(id);
    if (terminal) {
      terminal.write(data);
      return true;
    }
    return false;
  }

  resize(id: string, cols: number, rows: number): boolean {
    const terminal = this.terminals.get(id);
    if (terminal) {
      terminal.resize(cols, rows);
      return true;
    }
    return false;
  }

  kill(id: string): boolean {
    const terminal = this.terminals.get(id);
    if (terminal) {
      terminal.kill();
      this.terminals.delete(id);
      return true;
    }
    return false;
  }

  killAll(): void {
    for (const [id, terminal] of this.terminals) {
      terminal.kill();
      this.terminals.delete(id);
    }
  }

  getTerminalIds(): string[] {
    return Array.from(this.terminals.keys());
  }
}

let ptyManager: PtyManager | null = null;

export function getPtyManager(projectRoot: string): PtyManager {
  if (!ptyManager) {
    ptyManager = new PtyManager(projectRoot);
  }
  return ptyManager;
}

export function shutdownPtyManager(): void {
  if (ptyManager) {
    ptyManager.killAll();
    ptyManager = null;
  }
}
