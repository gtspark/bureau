import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { BUREAU_SYSTEM_PROMPT, BUREAU_CONTEXT_REFRESH } from '../config/prompts.js';

const BUREAU_DIR = path.join(process.env.HOME || '/tmp', '.bureau');
const SESSION_MAP_FILE = path.join(BUREAU_DIR, 'session-map.json');
const INITIALIZED_SESSIONS_FILE = path.join(BUREAU_DIR, 'initialized-sessions.json');

// Map Bureau session IDs to Claude-specific session IDs to avoid conflicts
function getClaudeSessionId(bureauSessionId: string): string {
  let sessionMap: Record<string, string> = {};
  try {
    if (fs.existsSync(SESSION_MAP_FILE)) {
      sessionMap = JSON.parse(fs.readFileSync(SESSION_MAP_FILE, 'utf-8'));
    }
  } catch {
    // Ignore
  }

  if (!sessionMap[bureauSessionId]) {
    // Generate a deterministic but unique UUID based on Bureau session ID
    // This ensures Bureau sessions don't conflict with manual Claude usage
    const hash = crypto.createHash('md5').update(`bureau-${bureauSessionId}`).digest('hex');
    sessionMap[bureauSessionId] = [
      hash.slice(0, 8),
      hash.slice(8, 12),
      '4' + hash.slice(13, 16),  // Version 4 UUID
      ((parseInt(hash[16], 16) & 0x3) | 0x8).toString(16) + hash.slice(17, 20),  // Variant
      hash.slice(20, 32)
    ].join('-');

    try {
      if (!fs.existsSync(BUREAU_DIR)) {
        fs.mkdirSync(BUREAU_DIR, { recursive: true });
      }
      fs.writeFileSync(SESSION_MAP_FILE, JSON.stringify(sessionMap, null, 2));
    } catch {
      // Ignore
    }
  }

  return sessionMap[bureauSessionId];
}

// Track which Claude sessions have been initialized (first spawn uses --session-id)
// Subsequent spawns use -r/--resume to avoid "session ID already in use" error
function isSessionInitialized(claudeSessionId: string): boolean {
  // First check our tracking file
  try {
    if (fs.existsSync(INITIALIZED_SESSIONS_FILE)) {
      const initialized: string[] = JSON.parse(fs.readFileSync(INITIALIZED_SESSIONS_FILE, 'utf-8'));
      if (initialized.includes(claudeSessionId)) {
        return true;
      }
    }
  } catch {
    // Ignore
  }

  // Fallback: check if Claude has non-empty session files for this ID
  // This handles the case where sessions were created before we started tracking
  // An empty file means the session was created but has no conversation history
  const homeDir = process.env.HOME || '/tmp';
  const claudeProjectsDir = path.join(homeDir, '.claude', 'projects');
  try {
    if (fs.existsSync(claudeProjectsDir)) {
      const projectDirs = fs.readdirSync(claudeProjectsDir);
      for (const projectDir of projectDirs) {
        const sessionFile = path.join(claudeProjectsDir, projectDir, `${claudeSessionId}.jsonl`);
        if (fs.existsSync(sessionFile)) {
          const stats = fs.statSync(sessionFile);
          if (stats.size > 0) {
            // Session exists with content, mark it as initialized for future
            markSessionInitialized(claudeSessionId);
            return true;
          }
        }
      }
    }
  } catch {
    // Ignore
  }

  return false;
}

function markSessionInitialized(claudeSessionId: string): void {
  let initialized: string[] = [];
  try {
    if (fs.existsSync(INITIALIZED_SESSIONS_FILE)) {
      initialized = JSON.parse(fs.readFileSync(INITIALIZED_SESSIONS_FILE, 'utf-8'));
    }
  } catch {
    // Ignore
  }

  if (!initialized.includes(claudeSessionId)) {
    initialized.push(claudeSessionId);
    try {
      if (!fs.existsSync(BUREAU_DIR)) {
        fs.mkdirSync(BUREAU_DIR, { recursive: true });
      }
      fs.writeFileSync(INITIALIZED_SESSIONS_FILE, JSON.stringify(initialized, null, 2));
    } catch {
      // Ignore
    }
  }
}

export class ClaudeProcess extends EventEmitter {
  private process: ChildProcess | null = null;
  private projectRoot: string;
  private sessionId: string;
  private _isRunning: boolean = false;
  private _needsContextRefresh: boolean = false;

  constructor(projectRoot: string, sessionId: string) {
    super();
    this.projectRoot = projectRoot;
    this.sessionId = sessionId;
  }

  get needsContextRefresh(): boolean {
    return this._needsContextRefresh;
  }

  set needsContextRefresh(value: boolean) {
    this._needsContextRefresh = value;
  }

  get isRunning(): boolean {
    return this._isRunning;
  }

  spawn(): void {
    if (this.process) {
      throw new Error('Claude process already running');
    }

    try {
      // Get a unique Claude session ID derived from Bureau session ID
      // This avoids conflicts with manual Claude Code usage which might use the same UUIDs
      const claudeSessionId = getClaudeSessionId(this.sessionId);
      const alreadyInitialized = isSessionInitialized(claudeSessionId);

      console.log(`Bureau session ${this.sessionId} -> Claude session ${claudeSessionId} (initialized: ${alreadyInitialized})`);

      // Build args: use --session-id for first spawn, -r/--resume for subsequent
      // This avoids "session ID already in use" error on server restart
      const args = [
        '-p',
        '--verbose',  // Required for stream-json output format
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
        '--dangerously-skip-permissions',  // Skip permission prompts for web UI
        '--system-prompt', BUREAU_SYSTEM_PROMPT  // Bureau IDE context
      ];

      if (alreadyInitialized) {
        // Resume existing session
        args.push('-r', claudeSessionId);
      } else {
        // Create new session
        args.push('--session-id', claudeSessionId);
      }

      // Use print mode with streaming JSON for bidirectional communication
      this.process = spawn('claude', args, {
        cwd: this.projectRoot,
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this._isRunning = true;

      // Track the session ID so we can mark it initialized after first message
      const sessionIdToMark = alreadyInitialized ? null : claudeSessionId;

      // Handle stdout - JSON lines only
      let lineBuffer = '';
      let hasReceivedMessage = false;
      this.process.stdout?.on('data', (data: Buffer) => {
        lineBuffer += data.toString();

        // Process complete lines
        const lines = lineBuffer.split('\n');
        // Keep the last incomplete line in the buffer
        lineBuffer = lines.pop() || '';

        for (const line of lines) {
          if (line.trim()) {
            try {
              const parsed = JSON.parse(line);
              console.log('Claude message:', parsed.type, JSON.stringify(parsed).substring(0, 500));

              // Mark session as initialized after receiving first real message
              // This ensures -r will work on subsequent spawns
              if (!hasReceivedMessage && sessionIdToMark) {
                hasReceivedMessage = true;
                markSessionInitialized(sessionIdToMark);
                console.log(`Marked session as initialized: ${sessionIdToMark}`);
              }

              // Detect context compaction
              if (parsed.type === 'system' && parsed.subtype === 'compact_boundary') {
                console.log('Context compaction detected:', parsed.compact_metadata);
                this._needsContextRefresh = true;
                this.emit('compacted', {
                  trigger: parsed.compact_metadata?.trigger || 'unknown',
                  preTokens: parsed.compact_metadata?.pre_tokens || 0,
                });
              }

              this.emit('message', parsed);
            } catch {
              // Shouldn't happen in stream-json mode, log for debugging
              console.error('Failed to parse Claude output:', line.substring(0, 100));
            }
          }
        }
      });

      // Handle stderr
      this.process.stderr?.on('data', (data: Buffer) => {
        console.error('Claude stderr:', data.toString());
        this.emit('error', new Error(data.toString()));
      });

      this.process.on('exit', (code) => {
        console.log('Claude process exited with code:', code);
        this._isRunning = false;
        this.process = null;
        this.emit('exit', code);
      });

      this.process.on('error', (error) => {
        console.error('Claude process error:', error);
        this._isRunning = false;
        this.emit('error', error);
      });

    } catch (error) {
      this._isRunning = false;
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  // Send a user message to Claude
  sendMessage(text: string): void {
    if (!this.process?.stdin) {
      throw new Error('Claude process not running');
    }

    // If context was compacted, prepend the context refresh
    let messageText = text;
    if (this._needsContextRefresh) {
      messageText = BUREAU_CONTEXT_REFRESH + '\n\n' + text;
      this._needsContextRefresh = false;
      console.log('Prepending context refresh after compaction');
    }

    // Format as stream-json input
    const message = {
      type: 'user',
      message: {
        role: 'user',
        content: messageText,
      },
    };

    console.log('Sending to Claude:', message);
    this.process.stdin.write(JSON.stringify(message) + '\n');
  }

  kill(): void {
    if (this.process) {
      this.process.kill();
      this.process = null;
      this._isRunning = false;
    }
  }

  respawn(): void {
    this.kill();
    this.spawn();
  }
}

// Singleton instance for the main Claude process (legacy, sessions use SessionManager now)
let mainProcess: ClaudeProcess | null = null;

export function getClaudeProcess(projectRoot: string, sessionId: string): ClaudeProcess {
  if (!mainProcess) {
    mainProcess = new ClaudeProcess(projectRoot, sessionId);
  }
  return mainProcess;
}

export function shutdownClaude(): void {
  if (mainProcess) {
    mainProcess.kill();
    mainProcess = null;
  }
}

// Clean shutdown on process exit
process.on('exit', shutdownClaude);
process.on('SIGINT', () => {
  shutdownClaude();
  process.exit(0);
});
process.on('SIGTERM', () => {
  shutdownClaude();
  process.exit(0);
});
