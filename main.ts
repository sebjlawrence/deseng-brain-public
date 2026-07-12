import {
  App,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  FileSystemAdapter,
  requestUrl,
  debounce,
  MarkdownRenderer,
} from "obsidian";
import { execFile } from "child_process";
import * as path from "path";
import { createHash } from "crypto";

/** Extensions the agent will pick up from Inbox/. Anything else is ignored. */
const SUPPORTED_EXTENSIONS = ["md", "txt", "html", "htm", "pdf", "docx"];
/** Raw extracted text beyond this is truncated for the LLM call (full text is
 * always preserved in attachments/ first, so nothing is lost). */
const MAX_CONDENSE_INPUT_CHARS = 30000;

/** "Ask the vault" retrieval tuning: how many notes to pull in as context,
 * how much of each to include, and an overall budget so a broad question
 * doesn't balloon the prompt. */
const ASK_VAULT_MAX_SOURCES = 8;
const ASK_VAULT_MAX_CHARS_PER_NOTE = 2000;
const ASK_VAULT_MAX_TOTAL_CHARS = 12000;

/** Max external references fetched per note via web search. */
const CITATION_MAX_REFERENCES = 5;

/* ------------------------------------------------------------------ *
 * SETTINGS
 * ------------------------------------------------------------------ */

interface SecondBrainAgentSettings {
  apiKey: string;
  model: string;
  watchInbox: boolean;
  debounceMs: number;
  linkCap: number;
  tagSplitThreshold: number;
  modules: string[];
  retiredModules: string[];
  notifyEmail: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  remoteUrl: string;
  autoPush: boolean;
  defaultBranch: string;
  inboxFolder: string;
  modulesFolder: string;
  mapsFolder: string;
  /** path -> sha1 of the note's own prose (frontmatter, ## Related and
   * ## References excluded) as of the last time it was relinked/cited.
   * Lets "Process Inbox now" detect which existing notes the user has
   * actually edited, without the agent's own writes to those sections
   * looking like a change on the next run. */
  noteHashes: Record<string, string>;
}

// No modules ship by default — add your own via the settings tab
// (e.g. "Mathematics", "History", "Chemistry") on first run.
const DEFAULT_MODULES: string[] = [];

const DEFAULT_SETTINGS: SecondBrainAgentSettings = {
  apiKey: "",
  model: "claude-sonnet-4-5-20250929",
  watchInbox: false,
  debounceMs: 8000,
  linkCap: 6,
  tagSplitThreshold: 20,
  modules: DEFAULT_MODULES,
  retiredModules: [],
  notifyEmail: "",
  smtpHost: "smtp.gmail.com",
  smtpPort: 465,
  smtpUser: "",
  smtpPass: "",
  remoteUrl: "",
  autoPush: true,
  defaultBranch: "main",
  inboxFolder: "Inbox",
  modulesFolder: "Modules",
  mapsFolder: "Maps",
  noteHashes: {},
};

/* ------------------------------------------------------------------ *
 * TYPES
 * ------------------------------------------------------------------ */

interface NoteRecord {
  file: TFile;
  title: string;
  module: string;
  tags: string[];
  summary: string;
}

interface AnalysisResult {
  module: string;
  summary: string;
  tags: string[];
  ambiguous: boolean;
  reason: string;
  suggestedNewModule?: string;
}

/* ------------------------------------------------------------------ *
 * PLUGIN
 * ------------------------------------------------------------------ */

export default class SecondBrainAgentPlugin extends Plugin {
  settings: SecondBrainAgentSettings;
  private processing = false;
  private debouncedProcessInbox: () => void;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new SecondBrainAgentSettingTab(this.app, this));

    this.debouncedProcessInbox = debounce(
      () => this.processInbox(),
      this.settings.debounceMs,
      true
    );

    this.addCommand({
      id: "process-inbox-now",
      name: "Process Inbox now (file, tag, link, commit, push)",
      callback: () => this.processInbox(),
    });

    this.addCommand({
      id: "process-current-note",
      name: "Process current note as new inbox item",
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!checking) this.processSingleFile(file);
        return true;
      },
    });

    this.addCommand({
      id: "regenerate-maps-and-home",
      name: "Regenerate Maps/, Home.md and the taxonomy index",
      callback: async () => {
        await this.regenerateAllDerivedFiles();
        new Notice("Maps/, Home.md and _Taxonomy.md regenerated.");
      },
    });

    this.addCommand({
      id: "ask-the-vault",
      name: "Ask the vault a question",
      callback: () => new AskVaultModal(this.app, this).open(),
    });

    this.addCommand({
      id: "force-full-vault-refresh",
      name: "Force full vault refresh (redo all links + citations for every note)",
      callback: async () => {
        this.settings.noteHashes = {};
        await this.saveSettings();
        new Notice(
          "Second Brain Agent: cleared change-tracking — the next 'Process Inbox now' will relink and re-cite every note in the vault. This costs real API usage (see README)."
        );
      },
    });

    this.registerEvent(
      this.app.vault.on("create", (f) => {
        if (this.settings.watchInbox && this.isInInbox(f)) {
          this.debouncedProcessInbox();
        }
      })
    );
    this.registerEvent(
      this.app.vault.on("modify", (f) => {
        if (this.settings.watchInbox && this.isInInbox(f)) {
          this.debouncedProcessInbox();
        }
      })
    );
  }

  onunload() {}

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.debouncedProcessInbox = debounce(
      () => this.processInbox(),
      this.settings.debounceMs,
      true
    );
  }

  private isInInbox(f: { path: string }): boolean {
    if (!f.path.startsWith(this.settings.inboxFolder + "/")) return false;
    const basename = f.path.split("/").pop() ?? "";
    if (this.isReservedInboxFile(basename)) return false;
    const ext = f.path.split(".").pop()?.toLowerCase() ?? "";
    return SUPPORTED_EXTENSIONS.includes(ext);
  }

  /**
   * Files the agent itself writes into Inbox/ (currently just
   * `_needs-review.md`) must never be picked back up as processable notes —
   * otherwise flagForReview()'s own write triggers auto-watch, which tries
   * to file the review log itself, which (if ambiguous) reopens the
   * decision modal mid-pipeline, stacking modals and breaking their
   * rendering. Underscore-prefix matches the vault's existing convention
   * for internal/derived files (e.g. `_Taxonomy.md`).
   */
  private isReservedInboxFile(basename: string): boolean {
    return basename.startsWith("_");
  }

  /** Whether Modules/<moduleName>/ currently exists in the vault. */
  private moduleFolderExists(moduleName: string): boolean {
    return this.app.vault.getAbstractFileByPath(`${this.settings.modulesFolder}/${moduleName}`) instanceof TFolder;
  }

  /* -------------------------------------------------------------- *
   * OPTIONAL HEAVY DEPENDENCIES (lazy-required)
   * -------------------------------------------------------------- *
   * pdf-parse / mammoth / pdfjs-dist are NOT statically imported: a plugin
   * that fails to require() a dependency at load time fails to load AT ALL,
   * which would break even plain .md processing if the user hasn't run
   * `npm install` yet. Requiring them lazily, only when a PDF/DOCX file is
   * actually being processed, means those features degrade gracefully
   * (clear error, that one file is skipped) instead of taking the whole
   * plugin down.
   * -------------------------------------------------------------- */

  private requirePdfParse(): any {
    try {
      // @ts-ignore
      return require("pdf-parse");
    } catch (e) {
      throw new Error(
        "pdf-parse not installed — run `npm install` in the plugin folder to enable PDF import."
      );
    }
  }

  private requireMammoth(): any {
    try {
      // @ts-ignore
      return require("mammoth");
    } catch (e) {
      throw new Error(
        "mammoth not installed — run `npm install` in the plugin folder to enable DOCX import."
      );
    }
  }

  private requirePdfjs(): any {
    try {
      // @ts-ignore
      return require("pdfjs-dist/legacy/build/pdf.js");
    } catch (e) {
      throw new Error(
        "pdfjs-dist not installed — run `npm install` in the plugin folder to enable PDF image extraction."
      );
    }
  }

  private requireNodemailer(): any {
    try {
      // @ts-ignore
      return require("nodemailer");
    } catch (e) {
      console.warn(
        "Second Brain Agent: nodemailer not installed — run `npm install` in the plugin folder to enable email alerts."
      );
      return null;
    }
  }

  /**
   * Best-effort email alert for parsing/processing issues (extraction
   * failures, ambiguous filings, git commit/push failures, etc). Silently
   * no-ops if SMTP credentials aren't configured, and never throws — a
   * failed notification must never break the note-processing pipeline.
   */
  private async notifyIssue(subject: string, details: string): Promise<void> {
    try {
      if (!this.settings.smtpUser || !this.settings.smtpPass || !this.settings.notifyEmail) return;
      const nodemailer = this.requireNodemailer();
      if (!nodemailer) return;
      const transporter = nodemailer.createTransport({
        host: this.settings.smtpHost,
        port: this.settings.smtpPort,
        secure: this.settings.smtpPort === 465,
        auth: { user: this.settings.smtpUser, pass: this.settings.smtpPass },
      });
      await transporter.sendMail({
        from: this.settings.smtpUser,
        to: this.settings.notifyEmail,
        subject: `Second Brain Agent: ${subject}`,
        text: details,
      });
    } catch (e) {
      console.warn("Second Brain Agent: failed to send issue-notification email", e);
    }
  }

  /* -------------------------------------------------------------- *
   * GIT
   * -------------------------------------------------------------- */

  private getBasePath(): string {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) {
      return adapter.getBasePath();
    }
    throw new Error("Vault adapter is not a local filesystem adapter.");
  }

  private runGit(args: string[]): Promise<string> {
    const cwd = this.getBasePath();
    return new Promise((resolve, reject) => {
      execFile("git", args, { cwd, maxBuffer: 1024 * 1024 * 20 }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr?.toString() || err.message));
          return;
        }
        resolve(stdout?.toString() ?? "");
      });
    });
  }

  private async ensureGitRepo(): Promise<void> {
    const gitDirExists = await this.app.vault.adapter.exists(".git");
    if (!gitDirExists) {
      new Notice("Second Brain Agent: initializing git repo in vault…");
      await this.runGit(["init"]);
      await this.runGit(["checkout", "-b", this.settings.defaultBranch]).catch(() => {
        /* branch may already be default */
      });
      try {
        await this.runGit(["remote", "get-url", "origin"]);
      } catch {
        if (this.settings.remoteUrl) {
          await this.runGit(["remote", "add", "origin", this.settings.remoteUrl]);
        }
      }
      await this.runGit(["add", "-A"]);
      try {
        await this.runGit([
          "commit",
          "-m",
          "Initial snapshot of vault before agent-managed edits",
        ]);
      } catch {
        /* nothing to commit */
      }
    }
  }

  /** Safety step 0: snapshot before ANY batch edit. */
  private async gitSnapshotBeforeBatch(label: string): Promise<void> {
    await this.ensureGitRepo();
    try {
      await this.runGit(["add", "-A"]);
      await this.runGit(["commit", "-m", `before ${label}`]);
    } catch {
      /* clean tree, nothing to snapshot — fine */
    }
  }

  /** Commit + push after a note has been filed and linked. */
  private async gitCommitAndPush(addedTitles: string[], linkedCount: number): Promise<void> {
    const timestamp = new Date().toISOString();
    const titleList = addedTitles.join(", ");
    const message = `${timestamp} — Added: ${titleList} (linked to ${linkedCount} existing note${
      linkedCount === 1 ? "" : "s"
    })`;
    try {
      await this.runGit(["add", "-A"]);
      await this.runGit(["commit", "-m", message]);
    } catch (e) {
      new Notice("Second Brain Agent: nothing to commit or commit failed: " + e.message);
      await this.notifyIssue("git commit failed", `Commit failed after filing ${titleList}:\n\n${e.message}`);
      return;
    }
    if (this.settings.autoPush && this.settings.remoteUrl) {
      try {
        await this.runGit(["push", "-u", "origin", this.settings.defaultBranch]);
        new Notice(`Second Brain Agent: pushed — ${titleList}`);
      } catch (e) {
        new Notice(
          "Second Brain Agent: commit ok, but push failed (check remote/auth). " + e.message
        );
        await this.notifyIssue(
          "git push failed",
          `Commit succeeded but push failed after filing ${titleList}:\n\n${e.message}\n\nCheck remote/auth on this machine.`
        );
      }
    }
  }

  /* -------------------------------------------------------------- *
   * VAULT TAXONOMY / CONTEXT
   * -------------------------------------------------------------- */

  private async scanVaultNotes(): Promise<NoteRecord[]> {
    const records: NoteRecord[] = [];
    const modulesRoot = this.app.vault.getAbstractFileByPath(this.settings.modulesFolder);
    if (!(modulesRoot instanceof TFolder)) return records;

    const walk = (folder: TFolder) => {
      for (const child of folder.children) {
        if (child instanceof TFile && child.extension === "md") {
          const cache = this.app.metadataCache.getFileCache(child);
          const fm = cache?.frontmatter;
          records.push({
            file: child,
            title: child.basename,
            module: fm?.module ?? "",
            tags: Array.isArray(fm?.tags) ? fm.tags : [],
            summary: fm?.summary ?? "",
          });
        } else if (child instanceof TFolder) {
          walk(child);
        }
      }
    };
    walk(modulesRoot);
    return records;
  }

  private tagFrequency(records: NoteRecord[]): Map<string, number> {
    const freq = new Map<string, number>();
    for (const r of records) {
      for (const t of r.tags) freq.set(t, (freq.get(t) ?? 0) + 1);
    }
    return freq;
  }

  /**
   * Renders the current taxonomy for the LLM prompt, flagging tags close to
   * the split threshold so the model is nudged to mint a new, more specific
   * tag instead of piling onto an already-broad one — this is how the
   * taxonomy is meant to grow with the vault), rather than staying frozen
   * at whatever tags existed on day one.
   */
  private formatTaxonomyForPrompt(taxonomy: Map<string, number>): string {
    return Array.from(taxonomy.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([tag, n]) =>
        n >= this.settings.tagSplitThreshold - 3
          ? `${tag} (${n}, near split threshold — prefer a new, more specific tag over adding to this one)`
          : `${tag} (${n})`
      )
      .join(", ");
  }

  private duplicateTitles(records: NoteRecord[], candidateTitle: string): boolean {
    return records.filter((r) => r.title === candidateTitle).length > 1 ||
      records.some((r) => r.title === candidateTitle);
  }

  /* -------------------------------------------------------------- *
   * LLM ANALYSIS
   * -------------------------------------------------------------- */

  private async callClaude(
    system: string,
    userMsg: string,
    maxTokens = 1024,
    tools?: Record<string, unknown>[]
  ): Promise<string> {
    if (!this.settings.apiKey) {
      throw new Error("No Claude API key set in Second Brain Agent settings.");
    }
    const res = await requestUrl({
      url: "https://api.anthropic.com/v1/messages",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.settings.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.settings.model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: userMsg }],
        ...(tools ? { tools } : {}),
      }),
    });
    const data = res.json;
    // With tools (e.g. web search) the response can interleave tool_use /
    // tool_result blocks with text blocks — concatenate just the text ones,
    // in order, to get Claude's actual answer.
    const blocks: Array<{ type?: string; text?: string }> = Array.isArray(data?.content) ? data.content : [];
    const text = blocks
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n\n")
      .trim();
    if (!text) throw new Error("Claude API returned no content.");
    return text;
  }

  /** Same as callClaude, but with Anthropic's server-side web search tool
   * enabled so Claude can look things up before answering. */
  private async callClaudeWithWebSearch(
    system: string,
    userMsg: string,
    maxTokens = 1024
  ): Promise<string> {
    return this.callClaude(system, userMsg, maxTokens, [
      { type: "web_search_20250305", name: "web_search", max_uses: CITATION_MAX_REFERENCES },
    ]);
  }

  /* -------------------------------------------------------------- *
   * RAW IMPORT EXTRACTION (PDF / DOCX / OneNote-export HTML / txt)
   * -------------------------------------------------------------- */

  /** Pull the best-effort plain text out of a non-.md Inbox file. */
  private async extractRawText(file: TFile): Promise<string> {
    const ext = file.extension.toLowerCase();
    if (ext === "md" || ext === "txt") {
      return await this.app.vault.read(file);
    }
    if (ext === "html" || ext === "htm") {
      const raw = await this.app.vault.read(file);
      // Strip tags/scripts/styles; keep it simple, the LLM condensation
      // pass does the real cleanup (this just avoids feeding it markup soup).
      return raw
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/\s{2,}/g, " ");
    }
    if (ext === "pdf") {
      const pdfParse = this.requirePdfParse();
      const buf = await this.app.vault.readBinary(file);
      const parsed = await pdfParse(Buffer.from(buf));
      return parsed.text ?? "";
    }
    if (ext === "docx") {
      const mammoth = this.requireMammoth();
      const buf = await this.app.vault.readBinary(file);
      const result = await mammoth.extractRawText({ buffer: Buffer.from(buf) });
      return result.value ?? "";
    }
    throw new Error(`Unsupported file type: .${ext}`);
  }

  private sanitizeFilename(name: string): string {
    return name.replace(/[\\/:*?"<>|#^[\]]/g, "").trim().slice(0, 120);
  }

  /**
   * Save extracted binary image data into attachments/, deduped by content
   * hash (same hash => same filename => idempotent, matches the vault's
   * "deduped by content hash, unique names" convention). Returns the vault
   * path, or null if saving failed (non-fatal to the caller).
   */
  private async saveImageDeduped(
    data: ArrayBuffer,
    ext: string,
    baseName: string
  ): Promise<string | null> {
    try {
      const hash = createHash("sha1").update(Buffer.from(data)).digest("hex").slice(0, 10);
      const cleanExt = (ext || "png").replace(/[^a-z0-9]/gi, "").toLowerCase() || "png";
      const fileName = `${this.sanitizeFilename(baseName)}-img-${hash}.${cleanExt}`;
      const attachPath = `attachments/${fileName}`;
      if (this.app.vault.getAbstractFileByPath(attachPath)) {
        return attachPath; // already saved — dedup by content hash
      }
      await this.app.vault.createBinary(attachPath, data);
      return attachPath;
    } catch (e) {
      console.warn("Second Brain Agent: failed to save an extracted image", e);
      return null;
    }
  }

  /** Convert a pdf.js decoded image object (RGB/RGBA/grayscale) to RGBA. */
  private pdfImageToRgba(img: {
    width: number;
    height: number;
    data: Uint8ClampedArray | Uint8Array;
    kind?: number;
  }): Uint8ClampedArray {
    const { width, height, data, kind } = img;
    const rgba = new Uint8ClampedArray(width * height * 4);
    if (kind === 3) {
      // RGBA_32BPP
      rgba.set(data.slice(0, rgba.length));
    } else if (kind === 1) {
      // GRAYSCALE_1BPP — packed bits
      for (let p = 0; p < width * height; p++) {
        const byte = data[p >> 3] ?? 0;
        const bit = (byte >> (7 - (p % 8))) & 1;
        const v = bit ? 255 : 0;
        rgba[p * 4] = v;
        rgba[p * 4 + 1] = v;
        rgba[p * 4 + 2] = v;
        rgba[p * 4 + 3] = 255;
      }
    } else {
      // Default: assume RGB_24BPP (kind === 2) or unknown 3-channel data.
      for (let i = 0, j = 0; j < rgba.length; i += 3, j += 4) {
        rgba[j] = data[i] ?? 0;
        rgba[j + 1] = data[i + 1] ?? 0;
        rgba[j + 2] = data[i + 2] ?? 0;
        rgba[j + 3] = 255;
      }
    }
    return rgba;
  }

  /** Rasterize RGBA pixel data to a PNG ArrayBuffer via an offscreen canvas
   * (available because Obsidian plugins run inside Electron's renderer, a
   * full Chromium environment — no native canvas dependency needed). */
  private async rgbaToPngBuffer(
    width: number,
    height: number,
    rgba: Uint8ClampedArray
  ): Promise<ArrayBuffer> {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable.");
    const imageData = ctx.createImageData(width, height);
    imageData.data.set(rgba);
    ctx.putImageData(imageData, 0, 0);
    return await new Promise((resolve, reject) => {
      canvas.toBlob(async (blob) => {
        if (!blob) {
          reject(new Error("canvas.toBlob failed"));
          return;
        }
        resolve(await blob.arrayBuffer());
      }, "image/png");
    });
  }

  /**
   * Extract embedded (not whole-page-rasterized) images from a PDF via
   * pdf.js's operator list, decode each to PNG, and save to attachments/.
   * Best-effort: pdf.js's internal object-resolution API has shifted subtly
   * across versions, so every step here is wrapped defensively — a failure
   * here never blocks the note itself from being created, it just means
   * that PDF's images are skipped (logged to console + a Notice).
   */
  private async extractImagesFromPdf(file: TFile, buf: ArrayBuffer): Promise<string[]> {
    const saved: string[] = [];
    try {
      const pdfjsLib = this.requirePdfjs();
      const loadingTask = pdfjsLib.getDocument({ data: buf });
      const pdfDoc = await loadingTask.promise;
      for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
        const page = await pdfDoc.getPage(pageNum);
        const ops = await page.getOperatorList();
        for (let i = 0; i < ops.fnArray.length; i++) {
          if (ops.fnArray[i] !== pdfjsLib.OPS.paintImageXObject) continue;
          const imgName = ops.argsArray[i][0];
          try {
            const img: any = await new Promise((resolve) => {
              const immediate = page.objs.get(imgName, (resolved: any) => resolve(resolved));
              if (immediate !== undefined) resolve(immediate);
            });
            if (!img || !img.data || !img.width || !img.height) continue;
            const rgba = this.pdfImageToRgba(img);
            const pngBuf = await this.rgbaToPngBuffer(img.width, img.height, rgba);
            const savedPath = await this.saveImageDeduped(pngBuf, "png", `${file.basename}-p${pageNum}`);
            if (savedPath) saved.push(savedPath);
          } catch (e) {
            console.warn(`Second Brain Agent: failed to extract an image on page ${pageNum}`, e);
          }
        }
      }
    } catch (e) {
      console.warn("Second Brain Agent: PDF image extraction unavailable for this file", e);
    }
    return saved;
  }

  /** Extract images embedded in a DOCX via mammoth's image callback hook. */
  private async extractImagesFromDocx(file: TFile, buf: ArrayBuffer): Promise<string[]> {
    const saved: string[] = [];
    try {
      const mammoth = this.requireMammoth();
      await mammoth.convertToHtml(
        { buffer: Buffer.from(buf) },
        {
          convertImage: mammoth.images.imgElement(async (image: any) => {
            try {
              const base64 = await image.readAsBase64String();
              const ext = (image.contentType || "image/png").split("/")[1]?.split("+")[0] || "png";
              const bytes = Buffer.from(base64, "base64");
              const savedPath = await this.saveImageDeduped(
                bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
                ext,
                file.basename
              );
              if (savedPath) saved.push(savedPath);
            } catch (e) {
              console.warn("Second Brain Agent: failed to extract a DOCX image", e);
            }
            return { src: "" };
          }),
        }
      );
    } catch (e) {
      console.warn("Second Brain Agent: DOCX image extraction failed", e);
    }
    return saved;
  }

  /** Extract images from an HTML (typically OneNote-export) file: inline
   * base64 data URIs directly, and best-effort resolution of relative-path
   * <img> references against sibling files already sitting in Inbox/. */
  private async extractImagesFromHtml(file: TFile): Promise<string[]> {
    const saved: string[] = [];
    try {
      const raw = await this.app.vault.read(file);
      const dataUriRe = /<img[^>]+src=["']data:(image\/[a-zA-Z0-9.+-]+);base64,([^"']+)["']/gi;
      let m: RegExpExecArray | null;
      while ((m = dataUriRe.exec(raw))) {
        try {
          const ext = m[1].split("/")[1]?.split("+")[0] || "png";
          const bytes = Buffer.from(m[2], "base64");
          const savedPath = await this.saveImageDeduped(
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
            ext,
            file.basename
          );
          if (savedPath) saved.push(savedPath);
        } catch (e) {
          console.warn("Second Brain Agent: failed to extract an inline HTML image", e);
        }
      }
      const relRe = /<img[^>]+src=["'](?!data:)([^"']+)["']/gi;
      while ((m = relRe.exec(raw))) {
        const refName = m[1].split("/").pop();
        if (!refName) continue;
        const sibling = this.app.vault.getAbstractFileByPath(`${this.settings.inboxFolder}/${refName}`);
        if (sibling instanceof TFile) {
          try {
            const bin = await this.app.vault.readBinary(sibling);
            const savedPath = await this.saveImageDeduped(bin, sibling.extension || "png", file.basename);
            if (savedPath) saved.push(savedPath);
          } catch (e) {
            console.warn("Second Brain Agent: failed to copy a referenced HTML image", e);
          }
        }
      }
    } catch (e) {
      console.warn("Second Brain Agent: HTML image extraction failed", e);
    }
    return saved;
  }

  /**
   * For raw imports (PDF/DOCX/HTML/txt) — unlike clean .md drops, these get
   * actively condensed: OCR/export noise stripped, equations repaired to
   * MathJax, structured with headings. Large sources (e.g. a 70-page course
   * PDF) are kept as ONE reference note, not chopped up — condensing means
   * de-noising/reformatting, not summarizing away content. The full raw
   * extract is always saved to attachments/ first so nothing is lost even
   * if the model output gets truncated.
   */
  private async analyzeAndCondense(
    file: TFile,
    rawText: string,
    taxonomy: Map<string, number>
  ): Promise<AnalysisResult & { body: string; title: string }> {
    const taxonomyList = this.formatTaxonomyForPrompt(taxonomy);

    const truncated = rawText.length > MAX_CONDENSE_INPUT_CHARS;
    const inputText = rawText.slice(0, MAX_CONDENSE_INPUT_CHARS);

    const retiredList = this.settings.retiredModules.join(", ");
    const system = `You are the import-processing step of a personal "second brain" \
Obsidian vault, converting a raw import (PDF/OneNote export/plain text) into a clean vault note. \
Modules: ${this.settings.modules.join(", ")}. \
${retiredList ? `Deleted modules — do NOT suggest any of these as "suggestedNewModule" even if the note fits the topic; the user removed them intentionally and must recreate them manually in Settings if wanted, so propose a different, more specific name instead: ${retiredList}. ` : ""}\
Existing concept-tag taxonomy (tag (usage count)): ${taxonomyList || "none yet"}. \
Rules:
1. Clean the extracted text: remove PDF page-break junk, repeated headers/footers, OCR artifacts, \
stray HTML entities like &nbsp;, and OneNote export noise.
2. Repair equations to MathJax: inline $...$, block $$...$$. Fix spelled-out Greek letters (e.g. "S i g m a" -> \\sigma) \
and stray \\star artifacts where they are clearly meant to be math.
3. Reformat into a well-structured note using markdown headings (##) for sub-topics, but DO NOT aggressively \
summarize away content — this is a reformat/de-noise pass, not a compression pass. If this is clearly a large \
multi-topic reference document, keep it as ONE reference note with clear internal headings rather than splitting \
or shrinking it.
4. Images embedded in the source ARE extracted separately by the pipeline and appended under their own "## Images" \
section after your output — do NOT create your own image embeds and do NOT add placeholder text like "(see original \
PDF for diagram)"; just write the surrounding text naturally as if the figure will appear nearby.
5. Creating a new, precise concept tag is encouraged whenever the topic doesn't precisely match an existing one — \
the taxonomy is meant to grow as the vault grows. Don't force-fit into a loosely related existing tag just to reuse \
it, and especially avoid adding to a tag flagged "near split threshold" above; mint a more specific one instead. \
Assign 1-3 concept tags/themes total.
6. Write a one-line plain-language summary (no more than ~20 words) and a clean short title for the note.
7. Pick exactly one module from the list if it genuinely fits. If the note clearly belongs to a topic area none \
of the existing modules cover — not just a poor fit, a genuinely new subject — set "ambiguous": true, explain why in \
"reason", and put your suggested new module name (matching the existing naming style, e.g. "Structural Dynamics") in \
"suggestedNewModule". Never invent a module and file into it directly — new modules always need human approval. If \
the note is unsure between two EXISTING modules instead, also set "ambiguous": true and explain in "reason", leaving \
"suggestedNewModule" empty.
Respond with ONLY minified JSON, no markdown fences, matching exactly:
{"title":"...","module":"...","summary":"...","tags":["...","..."],"body":"...","ambiguous":false,"reason":"","suggestedNewModule":""}
The "body" field is the full condensed markdown note content (do not include frontmatter, an Images section, or a \
Related section — those are added separately).`;

    const userMsg = `Source filename: ${file.basename}.${file.extension}\n${
      truncated
        ? `NOTE: input was truncated to ${MAX_CONDENSE_INPUT_CHARS} chars for this call; a full raw copy is preserved separately, so keep the note focused on what's here.\n`
        : ""
    }\nRaw extracted text:\n${inputText}`;

    const raw = await this.callClaude(system, userMsg, 8192);
    const jsonStart = raw.indexOf("{");
    const jsonEnd = raw.lastIndexOf("}");
    const parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
    return {
      title: this.sanitizeFilename(parsed.title || file.basename),
      module: parsed.module,
      summary: parsed.summary,
      tags: parsed.tags ?? [],
      body: parsed.body ?? "",
      ambiguous: !!parsed.ambiguous,
      reason: parsed.reason ?? "",
      suggestedNewModule: parsed.suggestedNewModule || undefined,
    };
  }

  private async analyzeNote(
    title: string,
    content: string,
    taxonomy: Map<string, number>
  ): Promise<AnalysisResult> {
    const taxonomyList = this.formatTaxonomyForPrompt(taxonomy);

    const retiredList = this.settings.retiredModules.join(", ");
    const system = `You are a filing assistant for a personal "second brain" Obsidian vault. \
Modules: ${this.settings.modules.join(", ")}. \
${retiredList ? `Deleted modules — do NOT suggest any of these as "suggestedNewModule" even if the note fits the topic; the user removed them intentionally and must recreate them manually in Settings if wanted, so propose a different, more specific name instead: ${retiredList}. ` : ""}\
Existing concept-tag taxonomy (tag (usage count)): ${taxonomyList || "none yet"}. \
Rules:
1. Creating a new, precise concept tag is encouraged whenever the topic doesn't precisely match an existing one — \
the taxonomy is meant to grow as the vault grows. Don't force-fit into a loosely related existing tag just to reuse \
it, and especially avoid adding to a tag flagged "near split threshold" above; mint a more specific one instead. \
Only reuse an existing tag when it's a genuine, precise match.
2. Assign 1-3 concept tags/themes that best describe the note's ideas (not just its module), matching the style of the existing taxonomy (lowercase, hyphenated, e.g. "signals-frequency", "deformation", "product-development").
3. Write a one-line plain-language summary (no more than ~20 words).
4. Pick exactly one module from the list if it genuinely fits this note.
5. If the note clearly belongs to a topic area none of the existing modules cover — not just a poor fit, a genuinely \
new subject — set "ambiguous": true, explain why in "reason", and put your suggested new module name (matching the \
existing naming style) in "suggestedNewModule". Never invent a module and file into it directly — new modules always \
need human approval. If instead you're unsure between two EXISTING modules, also set "ambiguous": true and explain \
in "reason", leaving "suggestedNewModule" empty. Otherwise "ambiguous": false, "reason": "", "suggestedNewModule": "".
Respond with ONLY minified JSON, no markdown fences, matching exactly:
{"module":"...","summary":"...","tags":["...","..."],"ambiguous":false,"reason":"","suggestedNewModule":""}`;

    const userMsg = `Note title: ${title}\n\nNote content:\n${content.slice(0, 6000)}`;

    const raw = await this.callClaude(system, userMsg);
    const jsonStart = raw.indexOf("{");
    const jsonEnd = raw.lastIndexOf("}");
    const parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
    return {
      module: parsed.module,
      summary: parsed.summary,
      tags: parsed.tags ?? [],
      ambiguous: !!parsed.ambiguous,
      reason: parsed.reason ?? "",
      suggestedNewModule: parsed.suggestedNewModule || undefined,
    };
  }

  /* -------------------------------------------------------------- *
   * LINKING
   * -------------------------------------------------------------- */

  private linkTarget(record: NoteRecord, allRecords: NoteRecord[]): string {
    const isDuplicateTitle =
      allRecords.filter((r) => r.title === record.title).length > 1;
    if (isDuplicateTitle) {
      const withoutExt = record.file.path.replace(/\.md$/, "");
      return `[[${withoutExt}|${record.title.toLowerCase()}]]`;
    }
    return `[[${record.title}]]`;
  }

  /** Append a wikilink to a note's "## Related" section if not already present. */
  private async appendRelatedLink(
    target: TFile,
    newLink: string,
    cap: number
  ): Promise<boolean> {
    const content = await this.app.vault.read(target);
    if (content.includes(newLink)) return false;

    const relatedHeadingRe = /^## Related\s*$/m;
    const match = content.match(relatedHeadingRe);

    if (match) {
      const idx = (match.index ?? 0) + match[0].length;
      const after = content.slice(idx);
      const existingLinksCount = (after.match(/\[\[.*?\]\]/g) ?? []).length;
      if (existingLinksCount >= cap) return false; // respect hub cap, skip rather than exceed
      const insertion = `\n- ${newLink}`;
      const newContent = content.slice(0, idx) + insertion + content.slice(idx);
      await this.app.vault.modify(target, newContent);
      return true;
    } else {
      const newContent = content.replace(/\s*$/, "") + `\n\n## Related\n- ${newLink}\n`;
      await this.app.vault.modify(target, newContent);
      return true;
    }
  }

  /** Remove a wikilink from a note's "## Related" section if present (used
   * when a relink pass decides a previously-added link no longer earns its
   * place). No-op if the link isn't there, or there's no Related section. */
  private async removeRelatedLinkIfPresent(target: TFile, link: string): Promise<void> {
    const content = await this.app.vault.read(target);
    if (!content.includes(link)) return;
    const lineRe = new RegExp(`\\n- ${link.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`, "g");
    const newContent = content.replace(lineRe, "");
    if (newContent !== content) {
      await this.app.vault.modify(target, newContent);
    }
  }

  /**
   * Splits a note's raw file content into (frontmatter, prose body, related
   * section, references section) so change-detection can hash only what the
   * user actually wrote, ignoring sections the agent itself generates.
   */
  private splitNoteSections(raw: string): {
    frontmatter: string;
    body: string;
    related: string;
    references: string;
  } {
    const fmMatch = raw.match(/^---\n[\s\S]*?\n---\n/);
    const frontmatter = fmMatch ? fmMatch[0] : "";
    let rest = raw.slice(frontmatter.length);

    let related = "";
    const relatedMatch = rest.match(/\n?## Related\s*\n[\s\S]*?(?=\n## |$)/);
    if (relatedMatch) {
      related = relatedMatch[0];
      rest = rest.slice(0, relatedMatch.index) + rest.slice((relatedMatch.index ?? 0) + related.length);
    }

    let references = "";
    const referencesMatch = rest.match(/\n?## References\s*\n[\s\S]*?(?=\n## |$)/);
    if (referencesMatch) {
      references = referencesMatch[0];
      rest = rest.slice(0, referencesMatch.index) + rest.slice((referencesMatch.index ?? 0) + references.length);
    }

    return { frontmatter, body: rest.trim(), related, references };
  }

  /** Hash of just the user's own prose — excludes frontmatter (which the
   * agent rewrites on every relink pass) and the agent-generated Related/
   * References sections, so the agent's own writes never look like a user
   * edit on the next run. This is what "has this note changed since the
   * last manual check" is measured against. */
  private hashNoteBody(raw: string): string {
    const { body } = this.splitNoteSections(raw);
    return createHash("sha1").update(body, "utf8").digest("hex");
  }

  /**
   * Vault-wide change detection for "Process Inbox now": compares each
   * existing Modules/ note's current prose hash against the hash stored the
   * last time it was checked. Only genuinely-edited notes (or notes that
   * have never been checked at all, e.g. on first run after this feature
   * shipped) come back — untouched notes are skipped every time, so repeat
   * runs stay cheap.
   */
  private async detectChangedNotes(): Promise<TFile[]> {
    const records = await this.scanVaultNotes();
    const changed: TFile[] = [];
    for (const r of records) {
      const raw = await this.app.vault.read(r.file);
      const currentHash = this.hashNoteBody(raw);
      const storedHash = this.settings.noteHashes[r.file.path];
      if (storedHash !== currentHash) {
        changed.push(r.file);
      }
    }
    return changed;
  }

  /**
   * The "professor pass + LLM self-review pass" concept-linking judgment,
   * combined into one call per note. Unlike a tag-overlap heuristic, this
   * reads candidate notes' summaries/tags and asks Claude to link only
   * where the underlying CONCEPTS genuinely relate (e.g. tension/compression
   * ↔ beam bending) — explicitly rejecting "noise" links such as two notes
   * merely sharing a generic tag like "introduction". A second, broader step
   * in the same prompt then adds any further links an LLM reader would find
   * genuinely useful for recall/understanding, even if they weren't an
   * obvious professor-style pairing.
   */
  private async getRelevantLinkTargets(
    note: { title: string; module: string; summary: string; tags: string[]; body: string },
    candidates: NoteRecord[],
    cap: number
  ): Promise<NoteRecord[]> {
    if (candidates.length === 0) return [];

    const candidateList = candidates
      .map(
        (c, i) =>
          `${i}. "${c.title}" (module: ${c.module}; tags: ${c.tags.join(", ") || "none"}) — ${c.summary || "no summary"}`
      )
      .join("\n");

    const system = `You are an engineering professor curating cross-references between notes in a student's revision wiki, followed by a second review as an LLM reasoning about what genuinely aids recall.

STEP 1 (professor pass): From the candidate list below, select only notes whose KEY CONCEPTS meaningfully relate to this note's key concepts — the kind of connection a professor would draw explicitly in a lecture (e.g. "tension and compression" linking to "beam bending"). Do NOT select a note just because it shares a generic tag, a generic word like "introduction"/"overview", or the same module — that is noise and provides no real benefit.

STEP 2 (LLM self-review pass): Re-examine the FULL candidate list once more, this time asking "would linking this pair give a student reviewing this note a tangible benefit to recall or understanding?" Add any further notes that pass this bar, even if they weren't an obvious professor-style pairing (e.g. a note that supplies necessary background, or a note this concept is later applied in).

Combine both steps into one final list, deduplicated, ranked by how strong the conceptual connection is, capped at ${cap} entries. Respond with ONLY minified JSON: {"indices":[...]} — the 0-based indices into the candidate list, most relevant first. Empty array if truly nothing qualifies — it's fine to link nothing.`;

    const userMsg = `Note: "${note.title}" (module: ${note.module}; tags: ${note.tags.join(", ") || "none"})
Summary: ${note.summary || "none"}

Note content (may be truncated):
${note.body.slice(0, 4000)}

Candidate notes already in the vault:
${candidateList}`;

    try {
      const raw = await this.callClaude(system, userMsg, 1024);
      const jsonStart = raw.indexOf("{");
      const jsonEnd = raw.lastIndexOf("}");
      const parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
      const indices: number[] = Array.isArray(parsed.indices) ? parsed.indices : [];
      return indices
        .filter((i) => Number.isInteger(i) && i >= 0 && i < candidates.length)
        .slice(0, cap)
        .map((i) => candidates[i]);
    } catch (e) {
      console.warn(`Second Brain Agent: concept-linking failed for '${note.title}', leaving links unchanged`, e);
      return [];
    }
  }

  /**
   * Sets a note's "## Related" section (and mirrors it into frontmatter's
   * `related:` array) to exactly the given target list, and propagates the
   * change bidirectionally: newly-linked notes get this note appended to
   * their own Related section, and previously-linked notes that are no
   * longer in the list have the reverse link removed.
   */
  private async setRelatedSection(
    file: TFile,
    targets: NoteRecord[],
    allRecords: NoteRecord[]
  ): Promise<void> {
    const raw = await this.app.vault.read(file);
    const { frontmatter, body, references } = this.splitNoteSections(raw);
    const cache = this.app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter;
    const module = fm?.module ?? "";
    const summary = fm?.summary ?? "";
    const tags: string[] = Array.isArray(fm?.tags) ? fm.tags : [];
    const title = file.basename;

    const selfIsDuplicateTitle = allRecords.filter((r) => r.title === title).length > 1;
    const previousLinks = new Set(
      (raw.match(/\[\[([^\]]+)\]\]/g) ?? []).filter((l) => {
        // only ones that were inside the old Related section
        const relMatch = raw.match(/## Related\s*\n[\s\S]*/);
        return relMatch ? relMatch[0].includes(l) : false;
      })
    );

    const newLinkStrings = targets.map((t) => this.linkTarget(t, allRecords));
    const newFrontmatter = this.buildFrontmatter(module, summary, tags, targets.map((t) => t.title));
    const relatedSection =
      newLinkStrings.length > 0
        ? `\n\n## Related\n${newLinkStrings.map((l) => `- ${l}`).join("\n")}\n`
        : "\n\n## Related\n";
    const referencesPart = references ? `\n\n${references.trim()}\n` : "";
    const finalContent = newFrontmatter + body + referencesPart + relatedSection;
    await this.app.vault.modify(file, finalContent);

    const selfLink = selfIsDuplicateTitle
      ? `[[${file.path.replace(/\.md$/, "")}|${title.toLowerCase()}]]`
      : `[[${title}]]`;

    // Propagate additions.
    for (const t of targets) {
      await this.appendRelatedLink(t.file, selfLink, this.settings.linkCap);
    }
    // Propagate removals: links that used to be there but aren't anymore.
    const newTargetPaths = new Set(targets.map((t) => t.file.path));
    for (const old of previousLinks) {
      const match = allRecords.find((r) => this.linkTarget(r, allRecords) === old);
      if (match && !newTargetPaths.has(match.file.path)) {
        await this.removeRelatedLinkIfPresent(match.file, selfLink);
      }
    }
  }

  /** Re-runs concept-based linking for a single existing note against the
   * rest of the vault and applies the result bidirectionally. Used both by
   * the vault-wide change-detection refresh and (potentially) at filing
   * time for brand-new notes. */
  private async relinkSingleNoteAndPropagate(file: TFile): Promise<void> {
    const raw = await this.app.vault.read(file);
    const { body } = this.splitNoteSections(raw);
    const cache = this.app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter;
    const allRecords = await this.scanVaultNotes();
    const candidates = allRecords.filter((r) => r.file.path !== file.path);
    const targets = await this.getRelevantLinkTargets(
      {
        title: file.basename,
        module: fm?.module ?? "",
        summary: fm?.summary ?? "",
        tags: Array.isArray(fm?.tags) ? fm.tags : [],
        body,
      },
      candidates,
      this.settings.linkCap
    );
    await this.setRelatedSection(file, targets, allRecords);
  }

  /**
   * Builds a "## References" section for a note by asking Claude (with the
   * server-side web-search tool enabled) to find real external sources that
   * support/relate to what's actually written, and cite them. Returns an
   * empty string (no section) if nothing suitable turns up or the API key
   * isn't configured — this is best-effort and never blocks filing/refresh.
   */
  private async buildReferencesSection(title: string, body: string): Promise<string> {
    if (!this.settings.apiKey) return "";
    const system = `You are helping cite a personal "second brain" note with real external references. Search the web for authoritative sources (textbooks, standards, official documentation, reputable technical references) that support or relate to the specific content of this note. Cite up to ${CITATION_MAX_REFERENCES} sources. Only include a source if it genuinely corresponds to something in the note — do not pad with generic or tangential results. Respond with ONLY a minified JSON array, no markdown fences: [{"title":"...","url":"..."}, ...]. Empty array [] if you can't find genuinely relevant sources.`;
    const userMsg = `Note title: ${title}\n\nNote content:\n${body.slice(0, 5000)}`;
    try {
      const raw = await this.callClaudeWithWebSearch(system, userMsg, 1536);
      const jsonStart = raw.indexOf("[");
      const jsonEnd = raw.lastIndexOf("]");
      if (jsonStart === -1 || jsonEnd === -1) return "";
      const parsed: Array<{ title?: string; url?: string }> = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
      const refs = parsed.filter((r) => r.url && r.title).slice(0, CITATION_MAX_REFERENCES);
      if (refs.length === 0) return "";
      return `\n\n## References\n${refs.map((r) => `- [${r.title}](${r.url})`).join("\n")}\n`;
    } catch (e) {
      console.warn(`Second Brain Agent: reference lookup failed for '${title}', skipping citations`, e);
      return "";
    }
  }

  /** Re-runs the citation lookup for an existing note and replaces its
   * "## References" section (added if missing, replaced if present). */
  private async refreshCitationsForNote(file: TFile): Promise<void> {
    const raw = await this.app.vault.read(file);
    const { frontmatter, body, related } = this.splitNoteSections(raw);
    const referencesSection = await this.buildReferencesSection(file.basename, body);
    const finalContent = frontmatter + body + referencesSection + (related || "\n\n## Related\n");
    if (finalContent !== raw) {
      await this.app.vault.modify(file, finalContent);
    }
  }

  /* -------------------------------------------------------------- *
   * FRONTMATTER / FILE WRITE
   * -------------------------------------------------------------- */

  private buildFrontmatter(
    module: string,
    summary: string,
    tags: string[],
    related: string[]
  ): string {
    const tagsYaml = `[${tags.join(", ")}]`;
    const relatedYaml = `[${related.map((r) => `"${r}"`).join(", ")}]`;
    return [
      "---",
      `module: "${module}"`,
      `summary: "${summary.replace(/"/g, "'")}"`,
      `tags: ${tagsYaml}`,
      `related: ${relatedYaml}`,
      "---",
      "",
    ].join("\n");
  }

  private stripExistingFrontmatter(content: string): string {
    return content.replace(/^---\n[\s\S]*?\n---\n/, "");
  }

  /* -------------------------------------------------------------- *
   * MAPS / HOME / TAXONOMY REGENERATION (derived — never hand-edited)
   * -------------------------------------------------------------- */

  /**
   * Regenerates Maps/_Taxonomy.md: every concept tag, its usage count, the
   * notes that use it, and a split-threshold warning where relevant. This
   * is the vault's documented taxonomy, kept mechanically in sync, so both
   * the user and any LLM reading the vault always see the current, real
   * state of the taxonomy.
   */
  private async regenerateTaxonomyFile(records: NoteRecord[]): Promise<void> {
    const freq = this.tagFrequency(records);
    const byTag = new Map<string, NoteRecord[]>();
    for (const r of records) {
      for (const t of r.tags) {
        if (!byTag.has(t)) byTag.set(t, []);
        byTag.get(t)!.push(r);
      }
    }
    const lines = [
      "# Taxonomy",
      "",
      `_Auto-regenerated: ${new Date().toISOString()}. Derived file — do not hand-edit._`,
      "",
      `${freq.size} concept tags across ${records.length} notes.`,
      "",
    ];
    const sorted = Array.from(freq.entries()).sort((a, b) => b[1] - a[1]);
    for (const [tag, count] of sorted) {
      const flag =
        count >= this.settings.tagSplitThreshold
          ? " ⚠ consider splitting into more specific tags"
          : "";
      lines.push(`## ${tag} (${count})${flag}`);
      const notes = (byTag.get(tag) ?? []).sort((a, b) => a.title.localeCompare(b.title));
      for (const n of notes) lines.push(`- [[${n.title}]]`);
      lines.push("");
    }
    const taxPath = `${this.settings.mapsFolder}/_Taxonomy.md`;
    const existing = this.app.vault.getAbstractFileByPath(taxPath);
    const body = lines.join("\n");
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, body);
    } else {
      await this.app.vault.create(taxPath, body);
    }
  }

  async regenerateAllDerivedFiles(): Promise<void> {
    const records = await this.scanVaultNotes();
    const byModule = new Map<string, NoteRecord[]>();
    for (const m of this.settings.modules) byModule.set(m, []);
    for (const r of records) {
      if (!byModule.has(r.module)) byModule.set(r.module, []);
      byModule.get(r.module)!.push(r);
    }

    for (const [module, notes] of byModule) {
      if (notes.length === 0 && !this.settings.modules.includes(module)) continue;
      const lines = [`# ${module}`, ""];
      for (const n of notes.sort((a, b) => a.title.localeCompare(b.title))) {
        lines.push(`- [[${n.title}]] — ${n.summary || "(no summary)"}`);
      }
      const mapPath = `${this.settings.mapsFolder}/${module}.md`;
      const existing = this.app.vault.getAbstractFileByPath(mapPath);
      const body = lines.join("\n") + "\n";
      if (existing instanceof TFile) {
        await this.app.vault.modify(existing, body);
      } else {
        await this.app.vault.create(mapPath, body);
      }
    }

    const homeLines = ["# Home", "", `_Last regenerated: ${new Date().toISOString()}_`, ""];
    homeLines.push(`**${records.length} notes** across **${byModule.size} modules**.`, "");
    for (const [module, notes] of byModule) {
      homeLines.push(`## [[Maps/${module}|${module}]] (${notes.length})`);
    }
    homeLines.push("", `See [[Maps/_Taxonomy|_Taxonomy]] for the full concept-tag index.`);
    const homeExisting = this.app.vault.getAbstractFileByPath("Home.md");
    const homeBody = homeLines.join("\n") + "\n";
    if (homeExisting instanceof TFile) {
      await this.app.vault.modify(homeExisting, homeBody);
    } else {
      await this.app.vault.create("Home.md", homeBody);
    }

    await this.regenerateTaxonomyFile(records);
  }

  /* -------------------------------------------------------------- *
   * MAIN PIPELINE
   * -------------------------------------------------------------- */

  async processInbox(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      const inboxFolder = this.app.vault.getAbstractFileByPath(this.settings.inboxFolder);
      const files =
        inboxFolder instanceof TFolder
          ? inboxFolder.children.filter(
              (f): f is TFile =>
                f instanceof TFile &&
                !this.isReservedInboxFile(f.name) &&
                SUPPORTED_EXTENSIONS.includes(f.extension.toLowerCase())
            )
          : [];

      const addedTitles: string[] = [];
      let totalLinked = 0;

      if (files.length > 0) {
        await this.gitSnapshotBeforeBatch(`processing ${files.length} inbox note(s)`);
        for (const file of files) {
          const result = await this.processSingleFileInternal(file);
          if (result) {
            addedTitles.push(result.title);
            totalLinked += result.linkedCount;
          }
        }
      }

      // Vault-wide change check: every manual run also looks at every
      // EXISTING note (not just new Inbox items) and refreshes citations +
      // concept links for anything the user has actually edited since it
      // was last checked. On the very first run after this feature ships,
      // no note has a stored hash yet, so everything counts as "changed" —
      // that first run is effectively a full relink + citation pass over
      // the whole vault.
      const changedFiles = await this.detectChangedNotes();
      const updatedTitles: string[] = [];
      if (changedFiles.length > 0) {
        if (files.length === 0) {
          await this.gitSnapshotBeforeBatch(`refreshing ${changedFiles.length} changed note(s)`);
        }
        for (let i = 0; i < changedFiles.length; i++) {
          const file = changedFiles[i];
          new Notice(
            `Second Brain Agent: refreshing ${i + 1}/${changedFiles.length} — ${file.basename}`
          );
          try {
            await this.refreshCitationsForNote(file);
            await this.relinkSingleNoteAndPropagate(file);
            const raw = await this.app.vault.read(file);
            this.settings.noteHashes[file.path] = this.hashNoteBody(raw);
            await this.saveSettings();
            updatedTitles.push(file.basename);
          } catch (e) {
            console.warn(`Second Brain Agent: refresh failed for '${file.basename}'`, e);
            await this.notifyIssue(
              `couldn't refresh links/citations for '${file.basename}'`,
              String(e.message || e)
            );
          }
        }
      }

      if (addedTitles.length > 0 || updatedTitles.length > 0) {
        await this.regenerateAllDerivedFiles();
        const commitTitles = [
          ...addedTitles.map((t) => `${t} (new)`),
          ...updatedTitles.map((t) => `${t} (refreshed)`),
        ];
        await this.gitCommitAndPush(commitTitles, totalLinked);
        new Notice(
          `Second Brain Agent: ${addedTitles.length} new note(s) filed, ${updatedTitles.length} existing note(s) refreshed.`
        );
      } else {
        new Notice("Second Brain Agent: nothing new in Inbox, and no changes detected elsewhere in the vault.");
      }
    } catch (e) {
      new Notice("Second Brain Agent error: " + e.message);
      console.error(e);
      await this.notifyIssue("pipeline error while processing Inbox", String(e.message || e));
    } finally {
      this.processing = false;
    }
  }

  async processSingleFile(file: TFile): Promise<void> {
    if (this.processing) return;
    if (this.isReservedInboxFile(file.name)) {
      new Notice(`Second Brain Agent: '${file.name}' is an internal agent file, not processing it.`);
      return;
    }
    this.processing = true;
    try {
      await this.gitSnapshotBeforeBatch(`processing '${file.basename}'`);
      const result = await this.processSingleFileInternal(file);
      if (result) {
        await this.regenerateAllDerivedFiles();
        await this.gitCommitAndPush([result.title], result.linkedCount);
        new Notice(`Second Brain Agent: filed & linked '${result.title}'.`);
      }
    } catch (e) {
      new Notice("Second Brain Agent error: " + e.message);
      console.error(e);
      await this.notifyIssue(`pipeline error processing '${file.basename}'`, String(e.message || e));
    } finally {
      this.processing = false;
    }
  }

  /**
   * Core per-note pipeline. Returns null if the note was left for manual
   * review (ambiguous filing — the plugin never guesses).
   */
  private async processSingleFileInternal(
    file: TFile
  ): Promise<{ title: string; linkedCount: number } | null> {
    const ext = file.extension.toLowerCase();
    const isMarkdown = ext === "md";
    const records = await this.scanVaultNotes();
    const taxonomy = this.tagFrequency(records);

    let moduleName: string;
    let summary: string;
    let tags: string[];
    let ambiguous: boolean;
    let reason: string;
    let suggestedNewModule: string | undefined;
    let body: string;
    let noteTitle: string;
    let rawBackupPath: string | null = null;

    if (isMarkdown) {
      // Clean note already in vault schema/style — never rewrite the user's
      // own wording, just analyze it for filing/tagging.
      const rawContent = await this.app.vault.read(file);
      const content = this.stripExistingFrontmatter(rawContent);
      let analysis: AnalysisResult;
      try {
        analysis = await this.analyzeNote(file.basename, content, taxonomy);
      } catch (e) {
        new Notice(`Second Brain Agent: analysis failed for '${file.basename}': ${e.message}`);
        await this.notifyIssue(
          `couldn't analyze '${file.basename}'`,
          `Tagging/filing analysis failed for ${file.path}:\n\n${e.message}\n\nThe note was left in Inbox/ untouched.`
        );
        return null;
      }
      moduleName = analysis.module;
      summary = analysis.summary;
      tags = analysis.tags;
      ambiguous = analysis.ambiguous;
      reason = analysis.reason;
      suggestedNewModule = analysis.suggestedNewModule;
      body = content.replace(/\n?## Related[\s\S]*$/, "").trim();
      noteTitle = file.basename;
    } else {
      // Raw import (PDF / DOCX / OneNote-export HTML / txt) — extract text
      // AND images, back up the full raw text, then condense into a
      // vault-style note with the extracted images appended.
      let rawText: string;
      try {
        rawText = await this.extractRawText(file);
      } catch (e) {
        new Notice(`Second Brain Agent: couldn't extract text from '${file.name}': ${e.message}`);
        await this.notifyIssue(
          `couldn't parse '${file.name}'`,
          `Text extraction failed for ${file.path}:\n\n${e.message}\n\nThe file was left in Inbox/ untouched.`
        );
        return null;
      }
      if (!rawText || rawText.trim().length === 0) {
        new Notice(`Second Brain Agent: '${file.name}' produced no extractable text, skipping.`);
        return null;
      }

      // Preserve the full raw extract, unconditionally, before any truncation.
      rawBackupPath = `attachments/${this.sanitizeFilename(file.basename)}-raw-import.md`;
      if (!this.app.vault.getAbstractFileByPath(rawBackupPath)) {
        await this.app.vault.create(
          rawBackupPath,
          `<!-- Raw text extracted from ${file.name} on ${new Date().toISOString()}. Unedited. -->\n\n${rawText}`
        );
      }

      // Extract embedded images (best-effort, non-fatal on failure).
      let imagePaths: string[] = [];
      try {
        if (ext === "pdf") {
          const buf = await this.app.vault.readBinary(file);
          imagePaths = await this.extractImagesFromPdf(file, buf);
        } else if (ext === "docx") {
          const buf = await this.app.vault.readBinary(file);
          imagePaths = await this.extractImagesFromDocx(file, buf);
        } else if (ext === "html" || ext === "htm") {
          imagePaths = await this.extractImagesFromHtml(file);
        }
      } catch (e) {
        console.warn("Second Brain Agent: image extraction failed, continuing without images", e);
      }

      let analysis: AnalysisResult & { body: string; title: string };
      try {
        analysis = await this.analyzeAndCondense(file, rawText, taxonomy);
      } catch (e) {
        new Notice(`Second Brain Agent: condensation failed for '${file.name}': ${e.message}`);
        await this.notifyIssue(
          `couldn't process '${file.name}'`,
          `Condensation/tagging failed for ${file.path}:\n\n${e.message}\n\nThe file was left in Inbox/ untouched (raw text was already backed up to attachments/).`
        );
        return null;
      }
      moduleName = analysis.module;
      summary = analysis.summary;
      tags = analysis.tags;
      ambiguous = analysis.ambiguous;
      reason = analysis.reason;
      suggestedNewModule = analysis.suggestedNewModule;
      body = analysis.body;
      noteTitle = analysis.title || file.basename;

      if (imagePaths.length > 0) {
        const imagesSection = imagePaths
          .map((p) => `![[${p.split("/").pop()}]]`)
          .join("\n\n");
        body += `\n\n## Images\n${imagesSection}\n`;
      }
    }

    // Self-heal: if a module is still in settings.modules but its
    // Modules/<name>/ folder no longer exists in the vault, someone deleted
    // it directly (e.g. via the file explorer) without going through
    // Settings. Don't silently recreate it — retire it and route through
    // the same ambiguous/modal gate a genuinely new module would hit, so a
    // deleted module needs manual recreation.
    if (this.settings.modules.includes(moduleName) && !this.moduleFolderExists(moduleName)) {
      this.settings.modules = this.settings.modules.filter((m) => m !== moduleName);
      if (!this.settings.retiredModules.includes(moduleName)) {
        this.settings.retiredModules.push(moduleName);
      }
      await this.saveSettings();
      ambiguous = true;
      reason =
        reason ||
        `The module "${moduleName}" no longer has a folder in the vault (looks like it was deleted) — select it from the dropdown below to restore it, or file this note somewhere else.`;
    }

    if (ambiguous || !this.settings.modules.includes(moduleName)) {
      const chosen = await this.promptForModule(file.basename, {
        module: moduleName,
        summary,
        tags,
        ambiguous,
        reason,
        suggestedNewModule,
      });
      if (chosen) {
        // If this was a retired module, the modal only lets that through
        // when the user explicitly selected it from the dropdown (not
        // typed) — that deliberate action is what un-retires it here.
        if (this.settings.retiredModules.includes(chosen)) {
          this.settings.retiredModules = this.settings.retiredModules.filter((m) => m !== chosen);
        }
        if (!this.settings.modules.includes(chosen)) {
          this.settings.modules.push(chosen);
          await this.saveSettings();
          new Notice(`Second Brain Agent: added "${chosen}" to Modules — future notes can use it too.`);
        } else {
          await this.saveSettings();
        }
        moduleName = chosen;
      } else {
        await this.flagForReview(file, {
          module: moduleName,
          summary,
          tags,
          ambiguous,
          reason,
          suggestedNewModule,
        });
        return null;
      }
    }

    // Related notes vault-wide (existing notes only, before this note is
    // added) — concept-based (professor pass + LLM self-review pass), not
    // tag-overlap, so brand-new notes get the same link quality bar as the
    // vault-wide relink pass applies to everything else.
    const bodyTrimmedForLinking = body.replace(/\n?## Related[\s\S]*$/, "").trim();
    const relatedRecords = await this.getRelevantLinkTargets(
      { title: noteTitle, module: moduleName, summary, tags, body: bodyTrimmedForLinking },
      records,
      this.settings.linkCap
    );
    const relatedLinksForNewNote = relatedRecords.map((r) => this.linkTarget(r, records));

    // Web-sourced citations for the new note (best-effort; empty section if
    // nothing suitable is found or lookups fail).
    const referencesSection = await this.buildReferencesSection(noteTitle, bodyTrimmedForLinking);

    const frontmatter = this.buildFrontmatter(
      moduleName,
      summary,
      tags,
      relatedRecords.map((r) => r.title)
    );
    const bodyTrimmed = bodyTrimmedForLinking;
    const backupNote = rawBackupPath
      ? `\n\n> Full raw import preserved at [[${rawBackupPath.replace(/\.md$/, "")}|raw import]].`
      : "";
    const relatedSection =
      relatedLinksForNewNote.length > 0
        ? `\n\n## Related\n${relatedLinksForNewNote.map((l) => `- ${l}`).join("\n")}\n`
        : "\n\n## Related\n";
    const finalContent = frontmatter + bodyTrimmed + backupNote + referencesSection + relatedSection;

    // File it: create/move into Modules/<Module>/, flat.
    const destFolder = `${this.settings.modulesFolder}/${moduleName}`;
    if (!(this.app.vault.getAbstractFileByPath(destFolder) instanceof TFolder)) {
      await this.app.vault.createFolder(destFolder);
    }
    const destPath = `${destFolder}/${noteTitle}.md`;

    if (this.app.vault.getAbstractFileByPath(destPath)) {
      new Notice(
        `Second Brain Agent: '${noteTitle}' already exists in ${moduleName}, skipping to avoid overwrite.`
      );
      return null;
    }

    if (isMarkdown) {
      await this.app.vault.modify(file, finalContent);
      await this.app.vault.rename(file, destPath);
    } else {
      await this.app.vault.create(destPath, finalContent);
      await this.app.vault.delete(file); // original raw import is now condensed + backed up
    }

    // Bidirectional: add the new note into each related existing note's Related section too.
    let linkedCount = 0;
    const newNoteIsDuplicateTitle = records.filter((r) => r.title === noteTitle).length > 0;
    const newNoteLink = newNoteIsDuplicateTitle
      ? `[[${destPath.replace(/\.md$/, "")}|${noteTitle.toLowerCase()}]]`
      : `[[${noteTitle}]]`;

    for (const rel of relatedRecords) {
      const added = await this.appendRelatedLink(rel.file, newNoteLink, this.settings.linkCap);
      if (added) linkedCount++;
    }

    // Record this note's prose hash now — it's already fully linked and
    // cited as part of filing, so it shouldn't also get caught by this same
    // run's vault-wide change-detection pass as if it were pre-existing.
    const finalFile = this.app.vault.getAbstractFileByPath(destPath);
    if (finalFile instanceof TFile) {
      const rawFinal = await this.app.vault.read(finalFile);
      this.settings.noteHashes[finalFile.path] = this.hashNoteBody(rawFinal);
      await this.saveSettings();
    }

    return { title: noteTitle, linkedCount };
  }

  /**
   * Interactive gate for ambiguous/unrecognized-module filings: shows a
   * modal with the reason (and any Claude-suggested new module name), lets
   * the user pick an existing module or type a new one, and returns the
   * chosen module name — or null if the user chooses to skip (in which case
   * the caller falls back to the _needs-review.md paper trail).
   */
  private async promptForModule(fileName: string, analysis: AnalysisResult): Promise<string | null> {
    return new Promise((resolve) => {
      new ModuleDecisionModal(
        this.app,
        fileName,
        analysis.reason,
        analysis.suggestedNewModule,
        this.settings.modules,
        this.settings.retiredModules,
        resolve
      ).open();
    });
  }

  private async flagForReview(file: TFile, analysis: AnalysisResult): Promise<void> {
    const reviewPath = `${this.settings.inboxFolder}/_needs-review.md`;
    const entry = analysis.suggestedNewModule
      ? `\n- **${file.basename}** — NEW MODULE SUGGESTED: "${analysis.suggestedNewModule}". ${
          analysis.reason || ""
        } To accept: add "${analysis.suggestedNewModule}" to Modules in plugin settings, then re-run "Process Inbox now".`
      : `\n- **${file.basename}** — ${analysis.reason || "ambiguous filing"} (best-guess module: ${
          analysis.module || "none"
        })`;
    const existing = this.app.vault.getAbstractFileByPath(reviewPath);
    if (existing instanceof TFile) {
      const c = await this.app.vault.read(existing);
      await this.app.vault.modify(existing, c + entry);
    } else {
      await this.app.vault.create(
        reviewPath,
        `# Needs Review\n\nNotes the agent could not confidently file. Resolve manually.\n${entry}`
      );
    }
    new Notice(`Second Brain Agent: '${file.basename}' needs manual review (left in Inbox).`);
    await this.notifyIssue(
      analysis.suggestedNewModule
        ? `'${file.basename}' suggests a new module: "${analysis.suggestedNewModule}"`
        : `'${file.basename}' needs manual review`,
      analysis.suggestedNewModule
        ? `'${file.basename}' doesn't fit any existing module.\n\nSuggested new module: "${analysis.suggestedNewModule}"\n\nReason: ${analysis.reason || "(none given)"}\n\nTo accept: add "${analysis.suggestedNewModule}" to Modules in plugin settings, then re-run "Process Inbox now". See Inbox/_needs-review.md.`
        : `Couldn't confidently file '${file.basename}':\n\n${analysis.reason || "ambiguous filing"}\n\nBest-guess module: ${analysis.module || "none"}\n\nSee Inbox/_needs-review.md.`
    );
  }

  /* -------------------------------------------------------------- *
   * ASK THE VAULT
   * -------------------------------------------------------------- */

  private static readonly STOPWORDS = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "of", "to",
    "in", "on", "for", "and", "or", "what", "how", "why", "when", "where",
    "does", "do", "did", "my", "i", "about", "with", "that", "this", "these",
    "those", "notes", "note", "vault", "explain", "tell", "me", "can", "you",
    "please", "have", "has", "there", "any", "give", "show",
  ]);

  private tokenize(text: string): string[] {
    return (
      text
        .toLowerCase()
        .match(/[a-z0-9][a-z0-9-]{2,}/g)
        ?.filter((w) => !SecondBrainAgentPlugin.STOPWORDS.has(w)) ?? []
    );
  }

  /**
   * Cheap, embedding-free retrieval: score each note by how much its title,
   * tags, and summary overlap with the question's keywords (tags weighted
   * highest since they're curated, precise concept labels). No vector DB or
   * external index needed — the vault's own frontmatter does the work.
   */
  private rankNotesForQuestion(question: string, records: NoteRecord[]): NoteRecord[] {
    const tokens = this.tokenize(question);
    if (tokens.length === 0) return [];

    const scored = records.map((r) => {
      const titleLower = r.title.toLowerCase();
      const summaryLower = r.summary.toLowerCase();
      const tagsLower = r.tags.map((t) => t.toLowerCase());
      let score = 0;
      for (const tok of tokens) {
        if (tagsLower.some((t) => t.includes(tok))) score += 3;
        if (titleLower.includes(tok)) score += 2;
        if (summaryLower.includes(tok)) score += 1;
      }
      return { record: r, score };
    });

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, ASK_VAULT_MAX_SOURCES)
      .map((s) => s.record);
  }

  /**
   * Answers a free-text question grounded in the vault: retrieves the most
   * relevant notes, reads their bodies, and asks Claude to treat that
   * content as the primary source — filling gaps with general knowledge
   * only when the notes don't fully cover the question, and being explicit
   * about which parts of the answer came from the vault versus elsewhere.
   */
  async answerVaultQuestion(question: string): Promise<{ answer: string; sources: NoteRecord[] }> {
    const records = await this.scanVaultNotes();
    const ranked = this.rankNotesForQuestion(question, records);

    const excerpts: string[] = [];
    let totalChars = 0;
    const usedSources: NoteRecord[] = [];
    for (const r of ranked) {
      if (totalChars >= ASK_VAULT_MAX_TOTAL_CHARS) break;
      let content: string;
      try {
        content = this.stripExistingFrontmatter(await this.app.vault.read(r.file));
      } catch {
        continue;
      }
      const excerpt = content.slice(0, ASK_VAULT_MAX_CHARS_PER_NOTE).trim();
      if (!excerpt) continue;
      excerpts.push(
        `### ${r.title}\nModule: ${r.module || "unknown"} | Tags: ${r.tags.join(", ") || "none"}\n\n${excerpt}`
      );
      usedSources.push(r);
      totalChars += excerpt.length;
    }

    const system = `You are answering questions about a personal "second brain" Obsidian vault. \
Below are excerpts from the user's own notes, retrieved as likely relevant to their question. \
Treat these excerpts as your PRIMARY source: if they answer the question, base your answer on them and cite the \
relevant note(s) using its exact title in double brackets like [[Note Title]]. \
If the excerpts only partially cover the question, or don't cover it at all, you MAY supplement with your own \
general knowledge to give a complete, useful answer — but be explicit about the split: clearly signal which parts \
come from the user's notes (cited with [[wikilinks]]) versus which parts are general knowledge added on top (e.g. \
"Your notes cover X. More generally, Y..."). Never present outside knowledge as if it came from the vault. \
Write in prose, focused and concise, not bullet lists, unless the question specifically asks for a list.${
      excerpts.length === 0
        ? "\n\nNo excerpts were found this time — none of the vault's notes matched the question's keywords. Say so plainly, then answer from general knowledge if you can, making clear none of it is vault-sourced."
        : ""
    }`;

    const userMsg =
      excerpts.length > 0
        ? `Question: ${question}\n\nRelevant note excerpts from the vault:\n\n${excerpts.join("\n\n---\n\n")}`
        : `Question: ${question}\n\n(No matching notes were found in the vault for this question.)`;

    const raw = await this.callClaude(system, userMsg, 2048);
    return { answer: raw, sources: usedSources };
  }
}

/* ------------------------------------------------------------------ *
 * AMBIGUOUS-FILING MODAL
 * ------------------------------------------------------------------ */

class ModuleDecisionModal extends Modal {
  private selectedModule = "";
  private newModuleInput = "";

  constructor(
    app: App,
    private fileName: string,
    private reason: string,
    private suggestedNewModule: string | undefined,
    private existingModules: string[],
    private retiredModules: string[],
    private onResolve: (value: string | null) => void
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: `Ambiguous filing: ${this.fileName}` });
    contentEl.createEl("p", {
      text: this.reason || "The agent wasn't confident how to file this note.",
    });

    if (this.suggestedNewModule) {
      const suggestionIsRetired = this.retiredModules.includes(this.suggestedNewModule);
      contentEl.createEl("p", {
        text: suggestionIsRetired
          ? `Claude's suggestion, "${this.suggestedNewModule}", was previously deleted — select it from the "Existing module" dropdown below (marked "retired") to restore it, or type a different name.`
          : `Claude's suggestion: a new module called "${this.suggestedNewModule}".`,
      });
      if (!suggestionIsRetired) {
        this.newModuleInput = this.suggestedNewModule;
      }
    }

    contentEl.createEl("h3", { text: "File into an existing (or retired) module" });
    new Setting(contentEl).setName("Existing module").addDropdown((d) => {
      d.addOption("", "— none selected —");
      for (const m of this.existingModules) d.addOption(m, m);
      // Retired modules are shown too, clearly marked — selecting one here
      // is the only way to restore it. Typing the same name into the "new
      // module" field below, or retyping it in Settings, does NOT restore
      // it: restoration has to be this explicit, deliberate choice.
      for (const m of this.retiredModules) d.addOption(m, `${m} (retired — select to restore)`);
      d.onChange((v) => (this.selectedModule = v));
    });

    contentEl.createEl("h3", { text: "…or create a new module" });
    contentEl.createEl("p", {
      text: "This note, and any future notes, can be filed into it once added.",
      cls: "setting-item-description",
    });
    new Setting(contentEl).setName("New module name").addText((t) => {
      t.setPlaceholder(this.suggestedNewModule || "e.g. Structural Dynamics");
      if (this.suggestedNewModule && !this.retiredModules.includes(this.suggestedNewModule)) {
        t.setValue(this.suggestedNewModule);
      }
      t.onChange((v) => (this.newModuleInput = v.trim()));
    });

    const buttonRow = contentEl.createDiv({ cls: "modal-button-container" });
    const fileBtn = buttonRow.createEl("button", { text: "File note", cls: "mod-cta" });
    fileBtn.onclick = () => {
      const chosen = this.newModuleInput || this.selectedModule;
      if (!chosen) {
        new Notice("Pick an existing module or type a new one first.");
        return;
      }
      const isRetired = this.retiredModules.includes(chosen);
      const chosenViaDropdown = this.newModuleInput.length === 0 && this.selectedModule === chosen;
      if (isRetired && !chosenViaDropdown) {
        new Notice(
          `"${chosen}" was deleted — select it from the "Existing module" dropdown above to restore it (typing the name doesn't work).`
        );
        return;
      }
      this.onResolve(chosen);
      this.close();
    };
    const skipBtn = buttonRow.createEl("button", { text: "Skip for now (leave in Inbox)" });
    skipBtn.onclick = () => {
      this.onResolve(null);
      this.close();
    };
  }

  onClose() {
    this.contentEl.empty();
  }
}

/* ------------------------------------------------------------------ *
 * ASK THE VAULT MODAL
 * ------------------------------------------------------------------ */

class AskVaultModal extends Modal {
  private questionInput = "";
  private answerEl: HTMLElement;
  private askBtn: HTMLButtonElement;

  constructor(app: App, private plugin: SecondBrainAgentPlugin) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Ask the vault" });
    contentEl.createEl("p", {
      text: "Answers prioritize your own notes — relevant excerpts are pulled in first. Claude will fill gaps with general knowledge only when your notes don't fully cover it, and will say which is which.",
      cls: "setting-item-description",
    });

    const inputEl = contentEl.createEl("textarea", {
      attr: { rows: "3", placeholder: "e.g. What have I covered on eigenvalues?" },
    });
    inputEl.style.width = "100%";
    inputEl.addEventListener("input", () => (this.questionInput = inputEl.value));
    inputEl.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter" && (evt.metaKey || evt.ctrlKey)) {
        evt.preventDefault();
        this.ask();
      }
    });

    const buttonRow = contentEl.createDiv({ cls: "modal-button-container" });
    this.askBtn = buttonRow.createEl("button", { text: "Ask", cls: "mod-cta" });
    this.askBtn.onclick = () => this.ask();

    this.answerEl = contentEl.createDiv();
    this.answerEl.style.marginTop = "1em";

    inputEl.focus();
  }

  private async ask() {
    const question = this.questionInput.trim();
    if (!question) {
      new Notice("Type a question first.");
      return;
    }
    this.askBtn.disabled = true;
    this.answerEl.empty();
    this.answerEl.createEl("p", { text: "Searching the vault…", cls: "setting-item-description" });

    try {
      const { answer, sources } = await this.plugin.answerVaultQuestion(question);
      this.answerEl.empty();

      const answerBody = this.answerEl.createDiv();
      try {
        await MarkdownRenderer.render(this.app, answer, answerBody, "", this.plugin);
      } catch {
        answerBody.setText(answer);
      }

      if (sources.length > 0) {
        this.answerEl.createEl("h4", { text: "Notes used as sources" });
        const list = this.answerEl.createEl("ul");
        for (const s of sources) {
          const li = list.createEl("li");
          const link = li.createEl("a", { text: s.title, href: "#" });
          link.onclick = (evt) => {
            evt.preventDefault();
            this.app.workspace.openLinkText(s.title, "", false);
            this.close();
          };
        }
      }
    } catch (e) {
      this.answerEl.empty();
      this.answerEl.createEl("p", { text: `Couldn't get an answer: ${e.message}` });
    } finally {
      this.askBtn.disabled = false;
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

/* ------------------------------------------------------------------ *
 * SETTINGS TAB
 * ------------------------------------------------------------------ */

class SecondBrainAgentSettingTab extends PluginSettingTab {
  plugin: SecondBrainAgentPlugin;

  constructor(app: App, plugin: SecondBrainAgentPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Second Brain Agent" });

    new Setting(containerEl)
      .setName("Claude API key")
      .setDesc("Used to analyze and tag new notes. Stored locally in the vault's plugin data.")
      .addText((t) =>
        t
          .setPlaceholder("sk-ant-...")
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (v) => {
            this.plugin.settings.apiKey = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Model")
      .addText((t) =>
        t.setValue(this.plugin.settings.model).onChange(async (v) => {
          this.plugin.settings.model = v.trim();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Modules")
      .setDesc(
        "One module per line. This is the full, authoritative list the agent files into — new topics never get auto-created; when a note doesn't fit any of these, it's flagged in Inbox/_needs-review.md with a suggested addition. Add a line here and re-run to accept it. Removing a line retires that module — retired modules can only be restored by selecting them from the dropdown in the ambiguous-filing dialog, not by retyping the name here."
      )
      .addTextArea((t) => {
        t.inputEl.rows = 6;
        t.inputEl.style.width = "100%";
        t.setValue(this.plugin.settings.modules.join("\n")).onChange(async (v) => {
          const requestedList = v
            .split("\n")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
          const oldList = this.plugin.settings.modules;
          const removed = oldList.filter((m) => !requestedList.includes(m));
          for (const m of removed) {
            if (!this.plugin.settings.retiredModules.includes(m)) {
              this.plugin.settings.retiredModules.push(m);
            }
          }
          // Retired modules can only be restored via the ambiguous-filing
          // modal's dropdown (a deliberate selection) — typing the name
          // back in here is silently ignored rather than un-retiring it.
          const blocked = requestedList.filter((m) => this.plugin.settings.retiredModules.includes(m));
          const newList = requestedList.filter((m) => !this.plugin.settings.retiredModules.includes(m));
          if (blocked.length > 0) {
            new Notice(
              `Retired module${blocked.length === 1 ? "" : "s"} "${blocked.join(
                '", "'
              )}" can't be re-added here — restore ${blocked.length === 1 ? "it" : "them"} from the dropdown in the ambiguous-filing dialog instead.`
            );
          }
          this.plugin.settings.modules = newList;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Auto-watch Inbox/")
      .setDesc("Process notes automatically shortly after they're saved in Inbox/. Off = manual command only.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.watchInbox).onChange(async (v) => {
          this.plugin.settings.watchInbox = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Debounce (ms)")
      .setDesc("Delay after a save before auto-processing runs.")
      .addText((t) =>
        t.setValue(String(this.plugin.settings.debounceMs)).onChange(async (v) => {
          const n = parseInt(v, 10);
          if (!isNaN(n)) {
            this.plugin.settings.debounceMs = n;
            await this.plugin.saveSettings();
          }
        })
      );

    new Setting(containerEl)
      .setName("Link cap per note")
      .setDesc("Max concept-links added per note (default: 6).")
      .addText((t) =>
        t.setValue(String(this.plugin.settings.linkCap)).onChange(async (v) => {
          const n = parseInt(v, 10);
          if (!isNaN(n)) {
            this.plugin.settings.linkCap = n;
            await this.plugin.saveSettings();
          }
        })
      );

    new Setting(containerEl)
      .setName("Tag split threshold")
      .setDesc(
        "When a concept tag reaches this many notes, _Taxonomy.md flags it for splitting and the LLM is nudged to mint a new, more specific tag instead of adding to it."
      )
      .addText((t) =>
        t.setValue(String(this.plugin.settings.tagSplitThreshold)).onChange(async (v) => {
          const n = parseInt(v, 10);
          if (!isNaN(n)) {
            this.plugin.settings.tagSplitThreshold = n;
            await this.plugin.saveSettings();
          }
        })
      );

    containerEl.createEl("h3", { text: "Email alerts" });

    new Setting(containerEl)
      .setName("Notify email")
      .setDesc("Where to send alerts when a file can't be parsed/processed, filing is ambiguous, or git fails.")
      .addText((t) =>
        t.setValue(this.plugin.settings.notifyEmail).onChange(async (v) => {
          this.plugin.settings.notifyEmail = v.trim();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("SMTP host / port")
      .setDesc("Defaults work for Gmail. Leave SMTP user/password blank to disable email alerts entirely.")
      .addText((t) =>
        t
          .setPlaceholder("smtp.gmail.com")
          .setValue(this.plugin.settings.smtpHost)
          .onChange(async (v) => {
            this.plugin.settings.smtpHost = v.trim();
            await this.plugin.saveSettings();
          })
      )
      .addText((t) =>
        t.setValue(String(this.plugin.settings.smtpPort)).onChange(async (v) => {
          const n = parseInt(v, 10);
          if (!isNaN(n)) {
            this.plugin.settings.smtpPort = n;
            await this.plugin.saveSettings();
          }
        })
      );

    new Setting(containerEl)
      .setName("SMTP user")
      .setDesc("The sending account's address (e.g. a Gmail address with an App Password — not your normal password).")
      .addText((t) =>
        t.setValue(this.plugin.settings.smtpUser).onChange(async (v) => {
          this.plugin.settings.smtpUser = v.trim();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("SMTP password / app password")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setValue(this.plugin.settings.smtpPass).onChange(async (v) => {
          this.plugin.settings.smtpPass = v.trim();
          await this.plugin.saveSettings();
        });
      });

    containerEl.createEl("h3", { text: "Git" });

    new Setting(containerEl)
      .setName("Remote URL")
      .setDesc("Pushed to after each batch of notes is filed and linked.")
      .addText((t) =>
        t.setValue(this.plugin.settings.remoteUrl).onChange(async (v) => {
          this.plugin.settings.remoteUrl = v.trim();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Branch")
      .addText((t) =>
        t.setValue(this.plugin.settings.defaultBranch).onChange(async (v) => {
          this.plugin.settings.defaultBranch = v.trim();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Auto-push after each batch")
      .setDesc("Uses your machine's existing git credentials (same as terminal git push).")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoPush).onChange(async (v) => {
          this.plugin.settings.autoPush = v;
          await this.plugin.saveSettings();
        })
      );
  }
}
