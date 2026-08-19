import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BaseSandbox, type ExecuteResponse, type FileDownloadResponse, type FileOperationError, type FileUploadResponse } from "deepagents";
import {
  ModalClient,
  SandboxFilesystemIsADirectoryError,
  SandboxFilesystemNotFoundError,
  SandboxFilesystemPermissionError,
  type Sandbox,
} from "modal";
import type { PredictorEvalConfig } from "./config.js";

const APP_NAME = "sprint-manager-predictor-evaluation";

/**
 * Custom deepagents sandbox backend over Modal — deepagents only ships a
 * first-party backend for LangSmith Sandbox, not Modal, so this class
 * implements the three abstract methods BaseSandbox requires (execute,
 * uploadFiles, downloadFiles); ls/read/etc. come free from the base class,
 * built on top of execute().
 *
 * NOTE: the "modal" npm package name has a confusing history — versions
 * 1.0.0+ belong to an unrelated, abandoned browser dialog library
 * (bengourley/modal.js) that previously owned the name. package.json pins
 * the exact version "0.9.0" (Modal Labs, modal-labs/modal-client) — never
 * loosen that to a "^"/"latest" range.
 */
export class ModalSandbox extends BaseSandbox {
  readonly id: string;

  private constructor(
    private readonly sandbox: Sandbox,
  ) {
    super();
    this.id = sandbox.sandboxId;
  }

  static async create(config: PredictorEvalConfig["modal"]): Promise<ModalSandbox> {
    const client = new ModalClient({ tokenId: config.tokenId, tokenSecret: config.tokenSecret });
    const app = await client.apps.fromName(APP_NAME, { createIfMissing: true });
    // scikit-learn/xgboost/lightgbm/pandas baked into the image once (cached by
    // Modal across runs) so the agent never needs to `pip install` per session.
    const image = client.images
      .fromRegistry("python:3.12-slim")
      .dockerfileCommands(["RUN pip install --no-cache-dir scikit-learn xgboost lightgbm pandas numpy"]);
    const sandbox = await client.sandboxes.create(app, image);
    return new ModalSandbox(sandbox);
  }

  async execute(command: string): Promise<ExecuteResponse> {
    const process = await this.sandbox.exec(["sh", "-c", command], { mode: "text" });
    const [stdout, stderr, exitCode] = await Promise.all([
      readStream(process.stdout),
      readStream(process.stderr),
      process.wait(),
    ]);
    const output = [stdout, stderr].filter(Boolean).join("\n");
    return { output, exitCode, truncated: false };
  }

  async uploadFiles(files: Array<[string, Uint8Array]>): Promise<FileUploadResponse[]> {
    const scratchDir = await mkdtemp(path.join(tmpdir(), "predictor-eval-upload-"));
    try {
      const results: FileUploadResponse[] = [];
      for (const [remotePath, content] of files) {
        const localPath = path.join(scratchDir, randomUUID());
        try {
          await writeFile(localPath, content);
          await this.sandbox.filesystem.copyFromLocal(localPath, remotePath);
          results.push({ path: remotePath, error: null });
        } catch (err) {
          results.push({ path: remotePath, error: classifyFileError(err) });
          console.error(`[predictor-evaluation] upload failed for ${remotePath}:`, err);
        }
      }
      return results;
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  }

  async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    const results: FileDownloadResponse[] = [];
    for (const remotePath of paths) {
      try {
        const content = await this.sandbox.filesystem.readBytes(remotePath);
        results.push({ path: remotePath, content, error: null });
      } catch (err) {
        results.push({ path: remotePath, content: null, error: classifyFileError(err) });
        console.error(`[predictor-evaluation] download failed for ${remotePath}:`, err);
      }
    }
    return results;
  }

  /** Downloads a single file straight to a local path — used for the winning model artifact. */
  async downloadToLocal(remotePath: string, localPath: string): Promise<void> {
    await this.sandbox.filesystem.copyToLocal(remotePath, localPath);
  }

  async terminate(): Promise<void> {
    await this.sandbox.terminate();
  }
}

function classifyFileError(err: unknown): FileOperationError {
  if (err instanceof SandboxFilesystemNotFoundError) return "file_not_found";
  if (err instanceof SandboxFilesystemPermissionError) return "permission_denied";
  if (err instanceof SandboxFilesystemIsADirectoryError) return "is_directory";
  return "invalid_path";
}

async function readStream(stream: ReadableStream<string>): Promise<string> {
  const reader = stream.getReader();
  let output = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    output += value;
  }
  return output;
}
