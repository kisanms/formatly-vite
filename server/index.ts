import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { promises as dns } from "node:dns";
import { createReadStream, existsSync } from "node:fs";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { z } from "zod";

function resolveExecutable(envVar: string | undefined, defaultName: string, candidates: string[]): string {
  if (envVar && existsSync(envVar)) return envVar;
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return defaultName;
}

const userProfile = process.env.USERPROFILE || "";
const localAppData = process.env.LOCALAPPDATA || "";
const appData = process.env.APPDATA || "";

const ytdlp = resolveExecutable(process.env.YTDLP_BIN, "yt-dlp", [
  path.join(appData, "Python", "Python314", "Scripts", "yt-dlp.exe"),
  path.join(localAppData, "Programs", "Python", "Python314", "Scripts", "yt-dlp.exe"),
  "C:\\Python314\\Scripts\\yt-dlp.exe",
  path.join(userProfile, ".local", "bin", "yt-dlp.exe")
]);

const ffmpeg = resolveExecutable(process.env.FFMPEG_BIN, "ffmpeg", [
  path.join(localAppData, "Microsoft", "WinGet", "Packages", "Gyan.FFmpeg.Essentials_Microsoft.Winget.Source_8wekyb3d8bbwe", "ffmpeg-9.0.1-essentials_build", "bin", "ffmpeg.exe"),
  path.join(localAppData, "Microsoft", "WinGet", "Links", "ffmpeg.exe"),
  "C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe",
  "C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe"
]);

// Augment process.env.PATH so child processes can locate ffmpeg and yt-dlp binaries
const extraDirs = [path.dirname(ytdlp), path.dirname(ffmpeg)].filter(d => existsSync(d));
if (extraDirs.length > 0) {
  process.env.PATH = `${extraDirs.join(path.delimiter)}${path.delimiter}${process.env.PATH || ""}`;
}

const app = express();
const port = Number(process.env.API_PORT || 8787);
const maxDuration = Number(process.env.MAX_MEDIA_SECONDS || 7200);
const maxBytes = Number(process.env.MAX_MEDIA_BYTES || 524_288_000);

const supportedHosts = [
  "youtube.com", "youtu.be", "facebook.com", "fb.watch", "instagram.com",
  "twitter.com", "x.com", "tiktok.com", "vimeo.com", "soundcloud.com",
  "dailymotion.com", "twitch.tv", "reddit.com", "threads.net", "bsky.app",
  "pinterest.com", "linkedin.com", "tumblr.com", "streamable.com", "loom.com",
  "bilibili.com", "mixcloud.com", "bandcamp.com"
];

const directMediaPattern = /\.(mp4|webm|mov|m4v|mp3|m4a|wav|ogg)(?:$|[?#])/i;

const requestSchema = z.object({
  url: z.string().url().max(2048),
  confirmedRights: z.literal(true)
});

const ticketSchema = requestSchema.extend({
  formatId: z.string().min(1).max(100).regex(/^[a-zA-Z0-9._:+-]+$/),
  title: z.string().max(300).optional(),
  kind: z.enum(["video", "audio"]).optional(),
  ext: z.string().max(10).optional()
});

type Ticket = {
  url: string;
  formatId: string;
  title?: string;
  kind?: "video" | "audio";
  ext?: string;
  expiresAt: number;
};

const tickets = new Map<string, Ticket>();
let activeDownloads = 0;

app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const rateWindows = new Map<string, { started: number; count: number }>();
app.use("/api", (req, res, next) => {
  const key = req.ip || "unknown";
  const now = Date.now();
  const current = rateWindows.get(key);
  const window = !current || now - current.started > 10 * 60_000
    ? { started: now, count: 0 }
    : current;
  window.count += 1;
  rateWindows.set(key, window);
  if (window.count > 120) return res.status(429).json({ error: "Too many requests. Please wait a moment." });
  next();
});

function isPrivateIp(address: string) {
  const value = address.toLowerCase();
  if (value === "::1" || value === "0:0:0:0:0:0:0:1" || value.startsWith("fe80:") || value.startsWith("fc") || value.startsWith("fd")) return true;
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some(Number.isNaN)) return false;
  const [a, b] = parts;
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

async function validateMediaUrl(input: string) {
  const url = new URL(input);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Only public HTTP or HTTPS links are accepted.");
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const knownPlatform = supportedHosts.some(domain => host === domain || host.endsWith(`.${domain}`));
  if (!knownPlatform && !directMediaPattern.test(url.pathname)) {
    throw new Error("This source is not supported. Use a supported platform (YouTube, Vimeo, SoundCloud, TikTok, etc.) or a direct media file URL.");
  }
  const records = await dns.lookup(host, { all: true, verbatim: true });
  if (!records.length || records.some(record => isPrivateIp(record.address))) {
    throw new Error("Local and private network addresses are not allowed.");
  }
  return url.toString();
}

function runProcess(command: string, args: string[], timeoutMs: number) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
    }, timeoutMs);
    child.stdout.on("data", chunk => { if (stdout.length < 10_000_000) stdout += chunk; });
    child.stderr.on("data", chunk => { if (stderr.length < 200_000) stderr += chunk; });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim().split("\n").slice(-2).join(" ") || `Media tool exited with code ${code}.`));
    });
  });
}

function humanBytes(value?: number | null) {
  if (!value || value < 1) return null;
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function safeName(value: string) {
  return value
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/[\\/:*?"<>|;`'’]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100) || "media";
}

app.get("/api/health", async (_req, res) => {
  try {
    const [toolVersion, ffmpegVersion] = await Promise.all([
      runProcess(ytdlp, ["--version"], 8_000),
      runProcess(ffmpeg, ["-version"], 8_000)
    ]);
    res.json({
      ready: true,
      engine: "available",
      ytdlp: toolVersion.trim().split("\n")[0],
      ffmpeg: ffmpegVersion.trim().split("\n")[0]
    });
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    res.status(503).json({ ready: false, error: "The media conversion engine is not installed or available on the server.", detail });
  }
});

app.post("/api/info", async (req, res, next) => {
  try {
    const body = requestSchema.parse(req.body);
    const url = await validateMediaUrl(body.url);
    const raw = await runProcess(ytdlp, [
      "--dump-single-json", "--no-playlist", "--skip-download", "--no-warnings",
      "--socket-timeout", "15", "--ffmpeg-location", ffmpeg, url
    ], 120_000);
    const firstBrace = raw.indexOf("{");
    const lastBrace = raw.lastIndexOf("}");
    if (firstBrace === -1 || lastBrace === -1) {
      throw new Error("Unable to parse media details from source.");
    }
    const media = JSON.parse(raw.slice(firstBrace, lastBrace + 1));
    const duration = Number(media.duration || 0);
    if (duration > maxDuration) throw new Error(`Media longer than ${Math.floor(maxDuration / 60)} minutes is not accepted.`);

    const nativeFormats = (Array.isArray(media.formats) ? media.formats : [])
      .filter((format: Record<string, unknown>) => format.format_id && format.ext)
      .map((format: Record<string, unknown>) => {
        const video = format.vcodec && format.vcodec !== "none";
        const audio = format.acodec && format.acodec !== "none";
        const height = Number(format.height || 0);
        const fps = Number(format.fps || 0);
        const size = Number(format.filesize || format.filesize_approx || 0);
        return {
          id: String(format.format_id),
          ext: String(format.ext).toUpperCase(),
          kind: video ? "video" : "audio",
          quality: video
            ? `${height ? `${height}p` : String(format.format_note || "video")}${fps > 30 ? ` · ${fps}fps` : ""}`
            : String(format.format_note || format.abr ? `${Math.round(Number(format.abr || 0))} kbps` : "audio"),
          codecs: [video ? format.vcodec : null, audio ? format.acodec : null].filter(Boolean).join(" + "),
          size: humanBytes(size),
          hasAudio: Boolean(audio),
          hasVideo: Boolean(video)
        };
      })
      .filter((format: { kind: string; quality: string; ext: string }, index: number, list: Array<{ kind: string; quality: string; ext: string }>) =>
        index === list.findIndex(candidate => candidate.kind === format.kind && candidate.quality === format.quality && candidate.ext === format.ext)
      )
      .slice(0, 48);

    const conversions = [
      { id: "convert:mp4", ext: "MP4", kind: "video", quality: "Best compatible", codecs: "H.264 + AAC", size: null, hasAudio: true, hasVideo: true },
      { id: "convert:webm", ext: "WEBM", kind: "video", quality: "Best available", codecs: "VP9/AV1 + Opus", size: null, hasAudio: true, hasVideo: true },
      { id: "convert:mp3", ext: "MP3", kind: "audio", quality: "High quality 320k", codecs: "MP3", size: null, hasAudio: true, hasVideo: false },
      { id: "convert:m4a", ext: "M4A", kind: "audio", quality: "High quality AAC", codecs: "AAC", size: null, hasAudio: true, hasVideo: false },
      { id: "convert:wav", ext: "WAV", kind: "audio", quality: "Lossless PCM", codecs: "PCM", size: null, hasAudio: true, hasVideo: false }
    ];

    res.json({
      title: safeName(String(media.title || "Untitled media")),
      thumbnail: typeof media.thumbnail === "string" ? media.thumbnail : null,
      source: String(media.extractor_key || media.extractor || "Direct media"),
      duration,
      author: String(media.uploader || media.channel || "Unknown creator"),
      formats: [...conversions, ...nativeFormats]
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/ticket", async (req, res, next) => {
  try {
    const body = ticketSchema.parse(req.body);
    const url = await validateMediaUrl(body.url);
    const token = crypto.randomBytes(24).toString("base64url");
    tickets.set(token, {
      url,
      formatId: body.formatId,
      title: body.title,
      kind: body.kind,
      ext: body.ext,
      expiresAt: Date.now() + 5 * 60_000
    });
    res.json({ downloadPath: `/api/download/${token}` });
  } catch (error) {
    next(error);
  }
});

async function handleDownloadExecution(
  res: express.Response,
  next: express.NextFunction,
  options: { url: string; formatId: string; title?: string; kind?: "video" | "audio"; ext?: string }
) {
  if (activeDownloads >= 4) {
    return res.status(503).send("The converter is currently busy processing other downloads. Please try again shortly.");
  }

  activeDownloads += 1;
  let directory = "";
  let handedToResponse = false;
  try {
    directory = await mkdtemp(path.join(os.tmpdir(), "streamshift-"));
    const template = path.join(directory, "media.%(ext)s");
    const baseArgs = [
      "--no-playlist", "--no-warnings", "--restrict-filenames", "--socket-timeout", "20",
      "--max-filesize", String(maxBytes), "--ffmpeg-location", ffmpeg, "-o", template
    ];
    const selection = options.formatId;
    const formatArgs = selection === "convert:mp3"
      ? ["-x", "--audio-format", "mp3", "--audio-quality", "0"]
      : selection === "convert:m4a"
        ? ["-x", "--audio-format", "m4a", "--audio-quality", "0"]
        : selection === "convert:wav"
          ? ["-x", "--audio-format", "wav"]
          : selection === "convert:mp4"
            ? ["-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best", "--merge-output-format", "mp4"]
            : selection === "convert:webm"
              ? ["-f", "bestvideo[ext=webm]+bestaudio[ext=webm]/best[ext=webm]/best", "--merge-output-format", "webm"]
              : options.kind === "video"
                ? ["-f", `${selection}+bestaudio/best`, "--merge-output-format", (options.ext || "mp4").toLowerCase()]
                : ["-f", selection];

    await runProcess(ytdlp, [...baseArgs, ...formatArgs, options.url], 15 * 60_000);
    const files = (await readdir(directory)).filter(file => !file.endsWith(".part") && !file.endsWith(".ytdl"));
    if (!files.length) throw new Error("The source did not return a downloadable file.");
    const ranked = await Promise.all(files.map(async file => ({ file, size: (await stat(path.join(directory, file))).size })));
    ranked.sort((a, b) => b.size - a.size);
    const chosen = ranked[0];
    if (chosen.size > maxBytes) throw new Error("The converted file exceeds the server size limit.");

    const chosenExt = path.extname(chosen.file) || (options.ext ? `.${options.ext.toLowerCase()}` : ".mp4");
    const downloadName = options.title
      ? `${safeName(options.title)}${chosenExt}`
      : safeName(chosen.file);

    handedToResponse = true;
    res.download(path.join(directory, chosen.file), downloadName, async error => {
      activeDownloads = Math.max(0, activeDownloads - 1);
      await rm(directory, { recursive: true, force: true });
      if (error && !res.headersSent) next(error);
    });
  } catch (error) {
    if (!handedToResponse) activeDownloads = Math.max(0, activeDownloads - 1);
    if (directory) await rm(directory, { recursive: true, force: true });
    next(error);
  }
}

app.get("/api/download/:token", async (req, res, next) => {
  const ticket = tickets.get(req.params.token);
  if (!ticket || ticket.expiresAt < Date.now()) {
    tickets.delete(req.params.token);
    return res.status(410).send("This download link has expired. Analyze the media again.");
  }
  tickets.delete(req.params.token);
  await handleDownloadExecution(res, next, ticket);
});

app.get("/api/download-direct", async (req, res, next) => {
  try {
    const rawUrl = String(req.query.url || "");
    const formatId = String(req.query.formatId || "convert:mp4");
    const title = req.query.title ? String(req.query.title) : undefined;
    const kind = req.query.kind === "audio" || req.query.kind === "video" ? req.query.kind : undefined;
    const ext = req.query.ext ? String(req.query.ext) : undefined;
    const confirmedRights = req.query.confirmedRights === "true" || req.query.confirmedRights === "1";

    if (!confirmedRights) {
      return res.status(400).send("Rights confirmation is required.");
    }
    const validatedUrl = await validateMediaUrl(rawUrl);
    await handleDownloadExecution(res, next, { url: validatedUrl, formatId, title, kind, ext });
  } catch (error) {
    next(error);
  }
});

setInterval(() => {
  const now = Date.now();
  for (const [token, ticket] of tickets) if (ticket.expiresAt < now) tickets.delete(token);
  for (const [key, window] of rateWindows) if (now - window.started > 10 * 60_000) rateWindows.delete(key);
}, 60_000).unref();

if (process.env.NODE_ENV === "production") {
  const dist = path.resolve("dist");
  app.use(express.static(dist, { index: false, maxAge: "1h" }));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof z.ZodError) {
    return res.status(400).json({ error: "Please enter a valid public media link and confirm that you have rights to download it." });
  }
  const message = error instanceof Error ? error.message : "The request could not be completed.";
  const safeMessage = /not supported|not accepted|not allowed|longer than|exceeds|downloadable file|HTTP or HTTPS/i.test(message)
    ? message
    : /sign in|login|private|cookies|members-only|age-restricted/i.test(message)
      ? "This media requires authentication, sign-in, or is restricted by the platform."
      : /ENOENT|not found|spawn/i.test(message)
        ? "The media engine executable could not be launched on the server."
        : `Could not retrieve media: ${message}`;
  res.status(400).json({ error: safeMessage });
});

app.listen(port, "0.0.0.0", () => {
  console.log(`StreamShift API listening on port ${port}`);
  console.log(`yt-dlp binary resolved: ${ytdlp}`);
  console.log(`ffmpeg binary resolved: ${ffmpeg}`);
});
