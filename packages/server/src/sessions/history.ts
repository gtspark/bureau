import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { OutputEntry } from './types.js';

const BUREAU_DIR = path.join(process.env.HOME || '/tmp', '.bureau');
const HISTORY_DIR = path.join(BUREAU_DIR, 'history');
const MAX_HISTORY_LINES = 10000;

// Ensure directories exist
function ensureDirs(): void {
  if (!fs.existsSync(BUREAU_DIR)) {
    fs.mkdirSync(BUREAU_DIR, { recursive: true });
  }
  if (!fs.existsSync(HISTORY_DIR)) {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
  }
}

function getHistoryPath(sessionId: string): string {
  return path.join(HISTORY_DIR, `${sessionId}.jsonl`);
}

export class HistoryManager {
  private filePath: string;
  private lineCount: number = 0;

  constructor(sessionId: string) {
    ensureDirs();
    this.filePath = getHistoryPath(sessionId);
    this.lineCount = this.countLines();
  }

  private countLines(): number {
    try {
      if (!fs.existsSync(this.filePath)) return 0;
      const content = fs.readFileSync(this.filePath, 'utf-8');
      return content.split('\n').filter(line => line.trim()).length;
    } catch {
      return 0;
    }
  }

  // Append an entry to history
  append(entry: OutputEntry): void {
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(this.filePath, line);
    this.lineCount++;

    // Trim if too large
    if (this.lineCount > MAX_HISTORY_LINES * 1.5) {
      this.trim();
    }
  }

  // Load last N entries (default: all up to MAX)
  async load(limit: number = MAX_HISTORY_LINES): Promise<OutputEntry[]> {
    if (!fs.existsSync(this.filePath)) return [];

    const entries: OutputEntry[] = [];
    const fileStream = fs.createReadStream(this.filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (line.trim()) {
        try {
          entries.push(JSON.parse(line));
        } catch {
          // Skip invalid lines
        }
      }
    }

    // Return last N entries
    return entries.slice(-limit);
  }

  // Trim history to MAX_HISTORY_LINES
  private trim(): void {
    try {
      const content = fs.readFileSync(this.filePath, 'utf-8');
      const lines = content.split('\n').filter(line => line.trim());
      const trimmed = lines.slice(-MAX_HISTORY_LINES);
      fs.writeFileSync(this.filePath, trimmed.join('\n') + '\n');
      this.lineCount = trimmed.length;
    } catch (error) {
      console.error('Failed to trim history:', error);
    }
  }

  // Clear all history for this session
  clear(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        fs.unlinkSync(this.filePath);
      }
      this.lineCount = 0;
    } catch (error) {
      console.error('Failed to clear history:', error);
    }
  }

  // Delete history file (for session deletion)
  static delete(sessionId: string): void {
    const filePath = getHistoryPath(sessionId);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (error) {
      console.error('Failed to delete history file:', error);
    }
  }
}

export function getBureauDir(): string {
  ensureDirs();
  return BUREAU_DIR;
}
