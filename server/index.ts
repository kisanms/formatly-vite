import express from 'express';
import { z } from 'zod';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import dns from 'dns/promises';
import net from 'net';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = Number(process.env.PORT) || 8787;
const MAX_INFO_MS = 120_000;
const MAX_DOWNLOAD_MS = 15 * 60_000;
const TICKET_TTL_MS = 5 * 60_000;

app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const InfoSchema = z.object({ url: z.string().url(), confirmedRights: z.literal(true) });
const TicketSchema = z.object({
  url: z.string().url(), confirmedRights: z.literal(true),
  formatId: z.string().min(1).max(100),
  title: z.string().max(500).optional(),
  kind: z.enum(['video', 'audio']),
  ext: z.enum(['mp4', 'webm', 'mp3', 'm4a', 'wav'])
});
type Ticket = z.infer<typeof TicketSchema> & { expiresAt: number };
const tickets = new Map<string, Ticket>();

function isPrivateIp(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (net.isIPv6(address)) {
    const normalized = address.toLowerCase();
    return normalized === '::1' || normalized === '::' || normalized.startsWith('fc') ||
      normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') ||
      normalized.startsWith('fea') || normalized.startsWith('feb') || normalized.startsWith('::ffff:127.') ||
      normalized.startsWith('::ffff:10.') || normalized.startsWith('::ffff:192.168.');
  }
  return true;
}

async function validateMediaUrl(raw: string): Promise<boolean> {
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return false;
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
    if (net.isIP(host)) return !isPrivateIp(host);
    const addresses = await dns.lookup(host, { all: true, verbatim: true });
    return addresses.length > 0 && addresses.every(({ address }) => !isPrivateIp(address));
  } catch {
    return false;
  }
}

function getYtDlpArgs(url: string, mode: 'info' | 'download'): string[] {
  const args = ['--no-warnings', '--no-playlist', '--no-cache-dir', '--js-runtimes', 'node'];
  // Modern YouTube extraction needs the EJS challenge solver; use the installed
  // Node runtime and allow yt-dlp to retrieve its official solver component.
  args.push('--remote-components', 'ejs:github');
  args.push('--extractor-args', 'youtube:player_client=android,ios,web');
  if (mode === 'info') args.push('--dump-single-json', '--skip-download');
  args.push(url);
  return args;
}

function runYtDlp(args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim() || (code === null ? 'Media operation timed out.' : `yt-dlp exited with code ${code}.`)));
    });
  });
}

function sourceName(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'Media'; }
}
function prettySize(bytes?: number): string | null {
  if (!bytes || !Number.isFinite(bytes)) return null;
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}
function safeFilename(value: string): string {
  return value.replace(/[\\/\?%*:|"<>\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 140) || 'media';
}

app.get('/api/health', (_req, res) => {
  const ytdlp = spawn('yt-dlp', ['--version']);
  let version = '';
  ytdlp.stdout.on('data', chunk => { version += chunk.toString(); });
  ytdlp.on('close', code => {
    const ffmpeg = spawn('ffmpeg', ['-version']);
    let ffmpegVersion = '';
    ffmpeg.stdout.on('data', chunk => { ffmpegVersion += chunk.toString(); });
    ffmpeg.on('close', ffmpegCode => {
      const ready = code === 0 && ffmpegCode === 0;
      res.status(ready ? 200 : 503).json({ ready, engine: ready ? 'available' : 'unavailable', ytdlp: version.trim(), ffmpeg: ffmpegVersion.split('\n')[0] || '', ...(ready ? {} : { error: 'yt-dlp or FFmpeg is unavailable.' }) });
    });
    ffmpeg.on('error', () => res.status(503).json({ ready: false, engine: 'unavailable', error: 'FFmpeg is not installed.' }));
  });
  ytdlp.on('error', () => res.status(503).json({ ready: false, engine: 'unavailable', error: 'yt-dlp is not installed.' }));
});

// API path used by the attached React frontend.
app.post('/api/info', async (req, res) => {
  const parsed = InfoSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Please enter a valid public media link and confirm that you have rights to download it.' });
  const { url } = parsed.data;
  if (!await validateMediaUrl(url)) return res.status(400).json({ error: 'Blocked or unsupported URL destination.' });
  try {
    const { stdout } = await runYtDlp(getYtDlpArgs(url, 'info'), MAX_INFO_MS);
    const info = JSON.parse(stdout.trim());
    const formats: Array<Record<string, unknown>> = [
      { id: 'convert:mp4_best', ext: 'MP4', kind: 'video', quality: 'Best available · video + audio', codecs: 'Automatic merge', size: null, hasAudio: true, hasVideo: true },
      { id: 'convert:webm_best', ext: 'WEBM', kind: 'video', quality: 'Best available · video + audio', codecs: 'Automatic merge', size: null, hasAudio: true, hasVideo: true },
      { id: 'convert:mp3_320', ext: 'MP3', kind: 'audio', quality: 'Best quality', codecs: 'MP3', size: null, hasAudio: true, hasVideo: false },
      { id: 'convert:m4a', ext: 'M4A', kind: 'audio', quality: 'Best quality', codecs: 'AAC', size: null, hasAudio: true, hasVideo: false },
      { id: 'convert:wav', ext: 'WAV', kind: 'audio', quality: 'Lossless PCM', codecs: 'PCM', size: null, hasAudio: true, hasVideo: false }
    ];
    const seen = new Set<string>();
    for (const f of (Array.isArray(info.formats) ? info.formats : [])) {
      const id = String(f.format_id || '');
      const hasVideo = Boolean(f.vcodec && f.vcodec !== 'none');
      const hasAudio = Boolean(f.acodec && f.acodec !== 'none');
      if (!id || (!hasVideo && !hasAudio) || seen.has(id)) continue;
      seen.add(id);
      const height = Number(f.height) || 0;
      formats.push({
        id, ext: String(f.ext || 'mp4').toUpperCase(), kind: hasVideo ? 'video' : 'audio',
        quality: height ? `${height}p${f.fps ? ` · ${f.fps} fps` : ''}` : String(f.format_note || 'Audio'),
        codecs: [f.vcodec && f.vcodec !== 'none' ? f.vcodec : '', f.acodec && f.acodec !== 'none' ? f.acodec : ''].filter(Boolean).join(' / '),
        size: prettySize(Number(f.filesize || f.filesize_approx)), hasAudio, hasVideo
      });
    }
    res.json({ title: info.title || 'Untitled media', thumbnail: info.thumbnail || null, source: sourceName(url), duration: Number(info.duration) || 0, author: info.uploader || info.channel || 'Creator', formats });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not retrieve media.';
    console.error('Media info failed:', message);
    res.status(502).json({ error: `Could not retrieve media: ${message.slice(0, 700)}` });
  }
});

app.post('/api/ticket', async (req, res) => {
  const parsed = TicketSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid download request. Confirm you have rights and choose a supported format.' });
  if (!await validateMediaUrl(parsed.data.url)) return res.status(400).json({ error: 'Blocked or unsupported URL destination.' });
  const ticketId = crypto.randomBytes(24).toString('hex');
  tickets.set(ticketId, { ...parsed.data, expiresAt: Date.now() + TICKET_TTL_MS });
  res.json({ downloadPath: `/api/download/${ticketId}` });
});

app.get('/api/download/:ticketId', async (req, res) => {
  const ticketId = req.params.ticketId;
  const ticket = tickets.get(ticketId);
  if (!ticket || ticket.expiresAt < Date.now()) {
    tickets.delete(ticketId);
    return res.status(410).send('Download link expired. Please start the download again.');
  }
  tickets.delete(ticketId); // one-time ticket
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'streamshift-'));
  const outTemplate = path.join(tempDir, '%(title).120B.%(ext)s');
  const args = ['--no-warnings', '--no-playlist', '--no-cache-dir', '--js-runtimes', 'node', '--remote-components', 'ejs:github', '--extractor-args', 'youtube:player_client=android,ios,web', '-o', outTemplate];
  const audioOnly = ticket.kind === 'audio' || ['mp3', 'm4a', 'wav'].includes(ticket.ext);
  if (audioOnly) {
    args.push('-x', '--audio-format', ticket.ext, '--audio-quality', '0');
    if (ticket.formatId.startsWith('convert:')) args.push('-f', 'bestaudio/best');
    else args.push('-f', ticket.formatId);
  } else {
    const container = ticket.ext === 'webm' ? 'webm' : 'mp4';
    let selector = 'bestvideo*+bestaudio/best';
    if (!ticket.formatId.startsWith('convert:')) selector = `${ticket.formatId}+bestaudio/${ticket.formatId}/best`;
    args.push('-f', selector, '--merge-output-format', container);
  }
  args.push(ticket.url);

  let settled = false;
  const cleanup = () => { if (!settled) { settled = true; void fs.promises.rm(tempDir, { recursive: true, force: true }); } };
  let child;
  try {
    child = spawn('yt-dlp', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch {
    cleanup();
    return res.status(500).send('Unable to start yt-dlp.');
  }
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const timer = setTimeout(() => child.kill('SIGTERM'), MAX_DOWNLOAD_MS);
  res.on('close', () => {
    if (!res.writableEnded && child.exitCode === null) child.kill('SIGTERM');
  });
  child.on('error', error => {
    clearTimeout(timer); cleanup();
    if (!res.headersSent) res.status(500).send(`Could not start media engine: ${error.message}`);
  });
  child.on('close', async code => {
    clearTimeout(timer);
    if (code !== 0) {
      cleanup();
      if (!res.headersSent) res.status(502).send(`Download failed: ${(stderr.trim() || 'Media extraction failed.').slice(-900)}`);
      return;
    }
    try {
      const files = (await fs.promises.readdir(tempDir)).filter(name => !name.endsWith('.part') && !name.endsWith('.ytdl'));
      if (!files.length) throw new Error('No output file was created.');
      const fileName = files[0];
      const filePath = path.join(tempDir, fileName);
      res.download(filePath, `${safeFilename(ticket.title || path.parse(fileName).name)}.${ticket.ext}`, error => {
        cleanup();
        if (error && !res.headersSent) res.status(500).end('Failed to send the completed download.');
      });
    } catch (error) {
      cleanup();
      if (!res.headersSent) res.status(500).send(error instanceof Error ? error.message : 'Failed to serve downloaded media.');
    }
  });
});

const distPath = path.resolve(__dirname, '../dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

app.listen(PORT, '0.0.0.0', () => console.log(`StreamShift backend listening on port ${PORT}`));