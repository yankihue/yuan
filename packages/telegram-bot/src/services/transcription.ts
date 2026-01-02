import OpenAI from 'openai';
import { spawn } from 'child_process';
import { writeFile, unlink, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1000;

export type TranscriptionProvider = 'openai' | 'local';

export interface TranscriptionConfig {
  provider: TranscriptionProvider;
  openaiApiKey?: string;
  whisperModelPath?: string;  // Path to whisper.cpp model file
  whisperBinaryPath?: string; // Path to whisper.cpp binary (default: 'whisper')
}

export interface TranscriptionService {
  transcribe(audioBuffer: Buffer, format: 'ogg' | 'mp3'): Promise<string>;
}

/**
 * Creates a transcription service based on config
 */
export function createTranscriptionService(config: TranscriptionConfig): TranscriptionService {
  if (config.provider === 'local') {
    return new LocalWhisperService(config);
  }

  if (!config.openaiApiKey) {
    throw new Error('OpenAI API key required for openai provider');
  }
  return new OpenAITranscriptionService(config.openaiApiKey);
}

/**
 * OpenAI Whisper API transcription
 */
class OpenAITranscriptionService implements TranscriptionService {
  private openai: OpenAI;

  constructor(apiKey: string) {
    this.openai = new OpenAI({ apiKey });
  }

  async transcribe(audioBuffer: Buffer, format: 'ogg' | 'mp3' = 'ogg'): Promise<string> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const file = new File(
          [audioBuffer],
          `audio.${format}`,
          { type: format === 'ogg' ? 'audio/ogg' : 'audio/mpeg' }
        );

        const response = await this.openai.audio.transcriptions.create({
          file,
          model: 'whisper-1',
          response_format: 'text',
        });

        return response;
      } catch (error) {
        lastError = error as Error;
        console.error(`Transcription attempt ${attempt + 1} failed:`, error);

        if (attempt < MAX_RETRIES) {
          await this.delay(RETRY_DELAY_MS * (attempt + 1));
        }
      }
    }

    throw new Error(`Transcription failed after ${MAX_RETRIES + 1} attempts: ${lastError?.message}`);
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Local Whisper.cpp transcription
 *
 * Requires whisper.cpp to be installed:
 *   git clone https://github.com/ggerganov/whisper.cpp
 *   cd whisper.cpp && make
 *   ./models/download-ggml-model.sh base.en
 *
 * Or use faster-whisper (Python):
 *   pip install faster-whisper
 */
class LocalWhisperService implements TranscriptionService {
  private modelPath: string;
  private binaryPath: string;
  private tempDir: string;

  constructor(config: TranscriptionConfig) {
    this.modelPath = config.whisperModelPath || '/opt/whisper.cpp/models/ggml-base.en.bin';
    this.binaryPath = config.whisperBinaryPath || 'whisper';
    this.tempDir = join(tmpdir(), 'whisper-transcriptions');
  }

  async transcribe(audioBuffer: Buffer, format: 'ogg' | 'mp3' = 'ogg'): Promise<string> {
    // Ensure temp directory exists
    await mkdir(this.tempDir, { recursive: true });

    const inputFile = join(this.tempDir, `${randomUUID()}.${format}`);
    const wavFile = join(this.tempDir, `${randomUUID()}.wav`);

    try {
      // Write audio buffer to temp file
      await writeFile(inputFile, audioBuffer);

      // Convert to WAV (whisper.cpp requires WAV format)
      await this.convertToWav(inputFile, wavFile);

      // Run whisper.cpp
      const transcription = await this.runWhisper(wavFile);

      return transcription.trim();
    } finally {
      // Cleanup temp files
      await unlink(inputFile).catch(() => {});
      await unlink(wavFile).catch(() => {});
    }
  }

  private convertToWav(inputFile: string, outputFile: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // Use ffmpeg to convert to 16kHz mono WAV (required by whisper)
      const ffmpeg = spawn('ffmpeg', [
        '-i', inputFile,
        '-ar', '16000',
        '-ac', '1',
        '-c:a', 'pcm_s16le',
        '-y',
        outputFile
      ], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stderr = '';
      ffmpeg.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      ffmpeg.on('error', (error) => {
        reject(new Error(`ffmpeg not found. Install with: apt install ffmpeg\n${error.message}`));
      });

      ffmpeg.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`ffmpeg conversion failed: ${stderr}`));
        }
      });
    });
  }

  private runWhisper(wavFile: string): Promise<string> {
    return new Promise((resolve, reject) => {
      // Try whisper.cpp first, fall back to faster-whisper
      this.runWhisperCpp(wavFile)
        .then(resolve)
        .catch(() => {
          // Fall back to faster-whisper (Python)
          this.runFasterWhisper(wavFile)
            .then(resolve)
            .catch(reject);
        });
    });
  }

  private runWhisperCpp(wavFile: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = [
        '-m', this.modelPath,
        '-f', wavFile,
        '-np',        // No prints
        '-nt',        // No timestamps
        '--output-txt'
      ];

      const whisper = spawn(this.binaryPath, args, {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      whisper.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      whisper.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      whisper.on('error', (error) => {
        reject(new Error(`whisper.cpp not found: ${error.message}`));
      });

      whisper.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`whisper.cpp failed: ${stderr}`));
        }
      });
    });
  }

  private runFasterWhisper(wavFile: string): Promise<string> {
    return new Promise((resolve, reject) => {
      // Use faster-whisper via Python one-liner
      const pythonScript = `
import sys
from faster_whisper import WhisperModel
model = WhisperModel("base.en", device="cpu", compute_type="int8")
segments, _ = model.transcribe("${wavFile}")
print(" ".join(s.text for s in segments))
`;

      const python = spawn('python3', ['-c', pythonScript], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      python.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      python.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      python.on('error', (error) => {
        reject(new Error(`Python/faster-whisper not found: ${error.message}`));
      });

      python.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`faster-whisper failed: ${stderr}`));
        }
      });
    });
  }
}

// Export classes for direct use if needed
export { OpenAITranscriptionService, LocalWhisperService };
