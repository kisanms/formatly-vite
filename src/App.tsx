import React, { useState, useEffect, useMemo } from "react";

interface MediaFormat {
  id: string;
  ext: string;
  kind: "video" | "audio";
  quality: string;
  codecs: string;
  size: string | null;
  hasAudio: boolean;
  hasVideo: boolean;
}

interface MediaInfo {
  title: string;
  thumbnail: string | null;
  source: string;
  duration: number;
  author: string;
  formats: MediaFormat[];
}

interface EngineHealth {
  ready: boolean;
  engine: string;
  ytdlp?: string;
  ffmpeg?: string;
  error?: string;
}

interface RecentDownload {
  id: string;
  title: string;
  ext: string;
  quality: string;
  time: string;
}

interface DownloadModalState {
  format: MediaFormat;
  status: "preparing" | "downloading" | "ready" | "error";
  statusMessage: string;
  downloadHref: string | null;
  filename: string;
  error: string | null;
}

const SAMPLE_LINKS = [
  { label: "Me at the zoo (YouTube)", url: "https://www.youtube.com/watch?v=jNQXAC9IVRw" },
  { label: "Big Buck Bunny 720p", url: "https://archive.org/download/BigBuckBunny_124/Content/big_buck_bunny_720p_surround.mp4" },
  { label: "SoundCloud Audio", url: "https://soundcloud.com/forss/flickermood" }
];

const SUPPORTED_PLATFORMS = [
  { name: "YouTube", match: /youtube\.com|youtu\.be/i },
  { name: "SoundCloud", match: /soundcloud\.com/i },
  { name: "Vimeo", match: /vimeo\.com/i },
  { name: "TikTok", match: /tiktok\.com/i },
  { name: "Instagram", match: /instagram\.com/i },
  { name: "Twitter / X", match: /twitter\.com|x\.com/i },
  { name: "Facebook", match: /facebook\.com|fb\.watch/i },
  { name: "Twitch", match: /twitch\.tv/i },
  { name: "Direct Media", match: /\.(mp4|webm|mov|m4v|mp3|m4a|wav|ogg)/i }
];

const API_BASE = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/+$/, "");

async function apiFetch<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const targetUrl = `${API_BASE}${endpoint}`;
  let res: Response;
  try {
    res = await fetch(targetUrl, options);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : "Network unreachable";
    throw new Error(`Cannot reach media engine (${errorMsg}). If using Vercel, the backend service must be deployed and configured in VITE_API_BASE_URL.`);
  }

  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    const text = await res.text();
    if (res.status === 404) {
      throw new Error(
        "Backend API not found (404). Vercel only hosts static frontends by default. The StreamShift backend (yt-dlp + FFmpeg) must be hosted on a container host like Render, Railway, or local server."
      );
    }
    throw new Error(`API error (HTTP ${res.status}): ${text.slice(0, 150) || "Empty response"}`);
  }

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `Server returned error (${res.status})`);
  }
  return data as T;
}

export default function App() {
  const [url, setUrl] = useState("");
  const [confirmedRights, setConfirmedRights] = useState(true);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [media, setMedia] = useState<MediaInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"recommended" | "video" | "audio" | "all">("recommended");
  const [searchFilter, setSearchFilter] = useState("");
  const [health, setHealth] = useState<EngineHealth | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [modalState, setModalState] = useState<DownloadModalState | null>(null);

  const [recentDownloads, setRecentDownloads] = useState<RecentDownload[]>(() => {
    try {
      const stored = localStorage.getItem("streamshift_recents") || localStorage.getItem("formatly_recents");
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });

  // Check backend engine health on mount
  useEffect(() => {
    async function checkHealth() {
      try {
        const data = await apiFetch<EngineHealth>("/api/health");
        setHealth(data);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Cannot reach backend service.";
        setHealth({ ready: false, engine: "unavailable", error: msg });
      }
    }
    checkHealth();
  }, []);

  const showToast = (text: string) => {
    setToast(text);
    setTimeout(() => setToast(null), 3500);
  };

  const detectedPlatform = useMemo(() => {
    if (!url.trim()) return null;
    return SUPPORTED_PLATFORMS.find(p => p.match.test(url))?.name || null;
  }, [url]);

  const formatDuration = (seconds: number) => {
    if (!seconds || seconds <= 0) return "Direct Stream";
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    if (hrs > 0) {
      return `${hrs}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
    }
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const handleAnalyze = async (e?: React.FormEvent, targetUrl?: string) => {
    if (e) e.preventDefault();
    const cleanUrl = (targetUrl ?? url).trim();
    if (!cleanUrl) {
      setError("Please paste a valid media URL to inspect.");
      return;
    }
    if (!confirmedRights) {
      setError("Please confirm that you have rights or permission to download this media.");
      return;
    }

    setError(null);
    setIsAnalyzing(true);
    setMedia(null);

    try {
      const data = await apiFetch<MediaInfo>("/api/info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: cleanUrl, confirmedRights: true })
      });

      setMedia(data);
      setActiveTab("recommended");
      showToast("Media analyzed successfully!");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "An unexpected error occurred.";
      setError(msg);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handlePasteClipboard = async () => {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (text) {
        setUrl(text);
        setError(null);
        // Inspect as soon as clipboard paste completes. The user still chooses
        // the format and explicitly starts the download from the results.
        void handleAnalyze(undefined, text);
      }
    } catch {
      showToast("Please paste using Ctrl+V / Cmd+V");
    }
  };

  const handleInputPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData("text").trim();
    if (!pasted) return;
    e.preventDefault();
    setUrl(pasted);
    setError(null);
    void handleAnalyze(undefined, pasted);
  };

  const cleanFilename = (title: string, ext: string) => {
    const safe = title.replace(/[^\w\s.-]/g, "_").trim().slice(0, 80) || "media";
    return `${safe}.${ext.toLowerCase()}`;
  };

  const startDownload = async (format: MediaFormat) => {
    if (!media) return;

    const filename = cleanFilename(media.title, format.ext);

    // Show modal in "preparing" state while ticket is issued
    setModalState({
      format,
      status: "preparing",
      statusMessage: "Connecting to media server...",
      downloadHref: null,
      filename,
      error: null
    });

    try {
      // Step 1: Request a short-lived download ticket from the server
      const ticketData = await apiFetch<{ downloadPath: string }>("/api/ticket", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: url.trim(),
          confirmedRights: true,
          formatId: format.id,
          title: media.title,
          kind: format.kind,
          ext: format.ext.toLowerCase()
        })
      });

      const downloadHref = `${API_BASE}${ticketData.downloadPath}`;

      // Step 2: Trigger a true native browser download by navigating an <a download> tag.
      // This makes the download appear in the browser's native download bar (bottom tray)
      // rather than silently downloading inside JavaScript.
      const a = document.createElement("a");
      a.href = downloadHref;
      a.download = filename;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      // Step 3: Update modal — server is now transcoding. The browser shows the file
      // downloading in its own download bar. We just inform the user.
      setModalState(prev => prev ? {
        ...prev,
        status: "downloading",
        statusMessage: `Transcoding ${format.ext} with FFmpeg on the server — check your browser's download bar for progress.`,
        downloadHref
      } : null);

      // Record in history immediately (server processes in background)
      const newRecent: RecentDownload = {
        id: Math.random().toString(36).substring(2, 9),
        title: media.title,
        ext: format.ext,
        quality: format.quality,
        time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      };
      const updated = [newRecent, ...recentDownloads.slice(0, 9)];
      setRecentDownloads(updated);
      localStorage.setItem("streamshift_recents", JSON.stringify(updated));

      // Auto-close modal after a few seconds
      setTimeout(() => {
        setModalState(prev => {
          if (prev?.status === "downloading") {
            return { ...prev, status: "ready", statusMessage: "Your file is downloading in the background. Check the browser download bar below!" };
          }
          return prev;
        });
      }, 4000);

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Download failed.";
      setModalState(prev => prev ? {
        ...prev,
        status: "error",
        statusMessage: "Download could not be started.",
        error: msg
      } : null);
    }
  };

  const closeModal = () => {
    setModalState(null);
  };

  const clearHistory = () => {
    setRecentDownloads([]);
    localStorage.removeItem("streamshift_recents");
    localStorage.removeItem("formatly_recents");
    showToast("History cleared.");
  };

  // Filtered formats
  const filteredFormats = useMemo(() => {
    if (!media) return [];
    let list = media.formats;

    if (activeTab === "recommended") {
      list = list.filter(f => f.id.startsWith("convert:"));
    } else if (activeTab === "video") {
      list = list.filter(f => f.kind === "video");
    } else if (activeTab === "audio") {
      list = list.filter(f => f.kind === "audio");
    }

    if (searchFilter.trim()) {
      const q = searchFilter.toLowerCase();
      list = list.filter(
        f =>
          f.ext.toLowerCase().includes(q) ||
          f.quality.toLowerCase().includes(q) ||
          f.codecs.toLowerCase().includes(q) ||
          (f.size && f.size.toLowerCase().includes(q))
      );
    }

    return list;
  }, [media, activeTab, searchFilter]);

  const recommendedCount = useMemo(() => {
    return media?.formats.filter(f => f.id.startsWith("convert:")).length || 0;
  }, [media]);

  const videoCount = useMemo(() => {
    return media?.formats.filter(f => f.kind === "video").length || 0;
  }, [media]);

  const audioCount = useMemo(() => {
    return media?.formats.filter(f => f.kind === "audio").length || 0;
  }, [media]);

  return (
    <div className="app-wrapper">
      {/* Toast Notification */}
      {toast && <div className="toast">{toast}</div>}

      {/* Download Modal */}
      {modalState && (
        <div className="modal-backdrop" onClick={closeModal}>
          <div className="modal-card" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">
                {modalState.status === "ready"
                  ? "✓ Download Started"
                  : modalState.status === "error"
                    ? "⚠️ Download Failed"
                    : modalState.status === "downloading"
                      ? "⬇ Downloading..."
                      : "⏳ Preparing Download"}
              </h3>
              <button type="button" className="modal-close-btn" onClick={closeModal} title="Close">
                ✕
              </button>
            </div>

            {media && (
              <div className="modal-media-preview">
                {media.thumbnail && (
                  <img src={media.thumbnail} alt={media.title} className="modal-thumb" />
                )}
                <div className="modal-media-meta">
                  <div className="modal-media-title">{media.title}</div>
                  <div className="modal-media-format-tag">
                    {modalState.format.ext} · {modalState.format.quality}
                  </div>
                </div>
              </div>
            )}

            {/* Progress / Status display */}
            <div className="modal-progress-container">
              {(modalState.status === "preparing" || modalState.status === "downloading") && (
                <div className="progress-track">
                  <div className="progress-bar-animated"></div>
                </div>
              )}
              <div className="progress-step-text">
                {modalState.status === "preparing" && <span>🔄</span>}
                {modalState.status === "downloading" && <span>⬇️</span>}
                {modalState.status === "ready" && <span>✅</span>}
                {modalState.status === "error" && <span>❌</span>}
                <span>{modalState.statusMessage}</span>
              </div>
            </div>

            {/* Callout when downloading — point user to browser download bar */}
            {modalState.status === "downloading" && (
              <div style={{
                background: "rgba(16, 185, 129, 0.08)",
                border: "1px solid rgba(16, 185, 129, 0.3)",
                borderRadius: "var(--radius-md)",
                padding: "0.9rem 1.1rem",
                fontSize: "0.88rem",
                color: "#a7f3d0",
                lineHeight: 1.6
              }}>
                <strong>👀 Look at the bottom of your browser window</strong> — the file is transcoding on the server and will appear in your browser's download tray automatically when ready. This usually takes 10–60 seconds depending on the video length.
              </div>
            )}

            {/* Success callout */}
            {modalState.status === "ready" && (
              <div style={{
                background: "rgba(16, 185, 129, 0.1)",
                border: "1px solid rgba(16, 185, 129, 0.35)",
                borderRadius: "var(--radius-md)",
                padding: "0.9rem 1.1rem",
                fontSize: "0.88rem",
                color: "#a7f3d0",
                lineHeight: 1.6
              }}>
                🎉 Your download should now appear in your <strong>browser's download bar</strong>. Check the bottom or corner of your browser window!
              </div>
            )}

            {/* Error explanation */}
            {modalState.error && (
              <div className="error-banner" style={{ margin: 0 }}>
                <span className="error-icon">⚠️</span>
                <div>
                  <div className="error-title">Conversion failed</div>
                  <div className="error-desc">{modalState.error}</div>
                </div>
              </div>
            )}

            {/* Modal Actions */}
            <div className="modal-actions">
              {/* Retry / re-download link once href is known */}
              {modalState.downloadHref && (
                <a
                  href={modalState.downloadHref}
                  download={modalState.filename}
                  className="modal-btn-primary"
                  onClick={closeModal}
                >
                  ⬇ Click to Download Again
                </a>
              )}

              <button type="button" className="secondary-btn" onClick={closeModal}>
                {modalState.status === "ready" ? "Close" : "Dismiss"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <header className="site-header">
        <div className="header-container">
          <div className="brand-group">
            <div className="brand-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 7c-2.5-3-7-3-7 1.5 0 5 8 3.5 8 8.5 0 4.5-4.5 4.5-7 1.5" />
                <polyline points="15 4 19 7 15 10" />
                <path d="M6 17c2.5 3 7 3 7-1.5 0-5-8-3.5-8-8.5 0-4.5 4.5-4.5 7-1.5" opacity="0.4" />
              </svg>
            </div>
            <div className="brand-text">
              <span className="brand-title">StreamShift</span>
              <span className="brand-subtitle">Media format & stream desk</span>
            </div>
          </div>

          <div className="header-actions">
            <div
              className={`engine-status-pill ${health?.ready ? "" : "offline"}`}
              title={health?.error || `yt-dlp ${health?.ytdlp || ""} | FFmpeg ${health?.ffmpeg ? "Ready" : ""}`}
            >
              <span className="status-dot"></span>
              <span>{health?.ready ? "Engine Ready" : "Engine Offline"}</span>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="main-content">
        {/* Hero Section */}
        <section className="hero-section">
          <div className="hero-badge">⚡ Instant Media Inspection & Direct Transcode</div>
          <h1 className="hero-title">
            Extract, Transcode & Save <br />
            <span className="gradient-text">Any Authorized Media Stream</span>
          </h1>
          <p className="hero-subtitle">
            Inspect stream bitrates, extract lossless audio, or transcode directly to universal formats across YouTube, SoundCloud, Vimeo, and more.
          </p>
        </section>

        {/* Input Card */}
        <section className="input-card">
          <form className="input-form" onSubmit={handleAnalyze}>
            <div className="input-row">
              <div className="url-input-container">
                <span className="url-input-icon">🔗</span>
                <input
                  type="url"
                  className="url-input"
                  placeholder="Paste media link (e.g. YouTube, SoundCloud, Vimeo, or direct video file)..."
                  value={url}
                  onChange={e => {
                    setUrl(e.target.value);
                    if (error) setError(null);
                  }}
                  required
                  onPaste={handleInputPaste}
                />
                <div className="input-inline-actions">
                  {url && (
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => setUrl("")}
                      title="Clear URL"
                    >
                      ✕
                    </button>
                  )}
                  <button
                    type="button"
                    className="paste-quick-btn"
                    onClick={handlePasteClipboard}
                    title="Paste from clipboard"
                  >
                    Paste
                  </button>
                </div>
              </div>

              <button
                type="submit"
                className="submit-btn"
                disabled={isAnalyzing || !url.trim()}
              >
                {isAnalyzing ? (
                  <>
                    <span className="spinner" style={{ width: 18, height: 18, borderWidth: 2 }}></span>
                    Analyzing...
                  </>
                ) : (
                  <>
                    <span>Inspect Media</span>
                    <span>→</span>
                  </>
                )}
              </button>
            </div>

            {/* Options Bar */}
            <div className="options-bar">
              <label className="rights-label">
                <input
                  type="checkbox"
                  className="rights-checkbox"
                  checked={confirmedRights}
                  onChange={e => setConfirmedRights(e.target.checked)}
                />
                <span>I confirm I own this media or have explicit permission to inspect & download it.</span>
              </label>

              {detectedPlatform && (
                <span className="platform-pill active">
                  Detected: <strong>{detectedPlatform}</strong>
                </span>
              )}
            </div>

            {/* Sample Links */}
            <div className="sample-links-row">
              <span className="sample-label">Try sample:</span>
              {SAMPLE_LINKS.map(sample => (
                <button
                  key={sample.label}
                  type="button"
                  className="sample-chip"
                  onClick={() => {
                    setUrl(sample.url);
                    setError(null);
                  }}
                >
                  {sample.label}
                </button>
              ))}
            </div>
          </form>
        </section>

        {/* Supported Platforms ticker */}
        <div className="supported-platforms-bar">
          <span>Supported sources:</span>
          {SUPPORTED_PLATFORMS.map(p => (
            <div
              key={p.name}
              className={`platform-pill ${detectedPlatform === p.name ? "active" : ""}`}
            >
              {p.name}
            </div>
          ))}
        </div>

        {/* Error Banner */}
        {error && (
          <div className="error-banner">
            <span className="error-icon">⚠️</span>
            <div>
              <div className="error-title">Could not complete request</div>
              <div className="error-desc">{error}</div>
            </div>
          </div>
        )}

        {/* Analyzing Skeleton State */}
        {isAnalyzing && (
          <div className="loading-container">
            <div className="spinner"></div>
            <div className="loading-title">Analyzing media streams...</div>
            <div className="loading-step">
              <span>⚡</span> Resolving audio/video stream manifests and calculating bitrates
            </div>
          </div>
        )}

        {/* Media Overview Card */}
        {media && !isAnalyzing && (
          <section className="media-card">
            <div className="media-thumbnail-wrapper">
              {media.thumbnail ? (
                <img
                  src={media.thumbnail}
                  alt={media.title}
                  className="media-thumbnail"
                />
              ) : (
                <div style={{ color: "#64748b", fontSize: "3rem" }}>🎬</div>
              )}
              <span className="media-duration-badge">
                {formatDuration(media.duration)}
              </span>
            </div>

            <div className="media-info-body">
              <div className="media-header">
                <div className="media-meta-row">
                  <span className="source-badge">{media.source}</span>
                  <span className="author-badge">👤 {media.author}</span>
                </div>
                <h2 className="media-title">{media.title}</h2>
              </div>

              <div className="media-actions-bar">
                <button
                  type="button"
                  className="secondary-btn"
                  onClick={() => {
                    navigator.clipboard.writeText(media.title);
                    showToast("Title copied to clipboard!");
                  }}
                >
                  📋 Copy Title
                </button>
                <button
                  type="button"
                  className="secondary-btn"
                  onClick={() => {
                    setUrl("");
                    setMedia(null);
                  }}
                >
                  🔄 Inspect Another Link
                </button>
              </div>
            </div>
          </section>
        )}

        {/* Formats Desk */}
        {media && !isAnalyzing && (
          <section className="formats-section">
            <div className="formats-header">
              <div className="formats-title-group">
                <h3 className="formats-title">Available Stream Formats</h3>
                <span className="formats-count-pill">{filteredFormats.length} options</span>
              </div>

              {/* Tabs */}
              <div className="tabs-nav">
                <button
                  type="button"
                  className={`tab-btn ${activeTab === "recommended" ? "active" : ""}`}
                  onClick={() => setActiveTab("recommended")}
                >
                  ⚡ Recommended ({recommendedCount})
                </button>
                <button
                  type="button"
                  className={`tab-btn ${activeTab === "video" ? "active" : ""}`}
                  onClick={() => setActiveTab("video")}
                >
                  🎬 Video ({videoCount})
                </button>
                <button
                  type="button"
                  className={`tab-btn ${activeTab === "audio" ? "active" : ""}`}
                  onClick={() => setActiveTab("audio")}
                >
                  🎵 Audio ({audioCount})
                </button>
                <button
                  type="button"
                  className={`tab-btn ${activeTab === "all" ? "active" : ""}`}
                  onClick={() => setActiveTab("all")}
                >
                  📋 All ({media.formats.length})
                </button>
              </div>
            </div>

            {/* Filter Input */}
            <div className="format-filter-bar">
              <input
                type="text"
                className="filter-input"
                placeholder="Filter by resolution, codec, extension (e.g. 1080p, mp3)..."
                value={searchFilter}
                onChange={e => setSearchFilter(e.target.value)}
              />
            </div>

            {/* Formats Grid */}
            <div className="formats-grid">
              {filteredFormats.map(fmt => {
                const isRecommended = fmt.id.startsWith("convert:");
                const isDownloadingThis = modalState?.format.id === fmt.id;
                const extLower = fmt.ext.toLowerCase();

                return (
                  <div
                    key={fmt.id}
                    className={`format-card ${isRecommended ? "is-recommended" : ""}`}
                  >
                    <div className="format-card-top">
                      <div>
                        <span className={`format-ext-badge ${extLower}`}>
                          {fmt.ext}
                        </span>
                        <div className="format-quality-label">{fmt.quality}</div>
                      </div>

                      <div className="format-meta-badges">
                        {fmt.hasVideo && <span className="meta-pill">Video</span>}
                        {fmt.hasAudio && <span className="meta-pill">Audio</span>}
                        {fmt.size && <span className="meta-pill">{fmt.size}</span>}
                      </div>
                    </div>

                    <div className="format-details-row">
                      {fmt.codecs && (
                        <div className="format-codecs" title={fmt.codecs}>
                          Codec: {fmt.codecs}
                        </div>
                      )}
                    </div>

                    <button
                      type="button"
                      className={`download-action-btn ${isDownloadingThis ? "active-downloading" : ""}`}
                      onClick={() => startDownload(fmt)}
                    >
                      <span>⬇ Download {fmt.ext}</span>
                    </button>
                  </div>
                );
              })}
            </div>

            {filteredFormats.length === 0 && (
              <div style={{ textAlign: "center", padding: "2.5rem 1rem", color: "#64748b" }}>
                No stream formats match "{searchFilter}".
              </div>
            )}
          </section>
        )}

        {/* Recent Downloads History */}
        {recentDownloads.length > 0 && (
          <section className="history-card">
            <div className="history-header">
              <h4 className="history-title">
                <span>🕒</span> Recent Downloads
              </h4>
              <button type="button" className="clear-btn" onClick={clearHistory}>
                Clear history
              </button>
            </div>

            <div className="history-list">
              {recentDownloads.map(item => (
                <div key={item.id} className="history-item">
                  <div className="history-item-title">{item.title}</div>
                  <div className="history-item-right">
                    <span className="meta-pill">{item.ext}</span>
                    <span className="meta-pill">{item.quality}</span>
                    <span>{item.time}</span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </main>

      {/* Footer */}
      <footer className="site-footer">
        <div className="footer-container">
          <div className="footer-top">
            <div>
              <strong>StreamShift</strong> — Modern media format inspector & stream transcode engine.
            </div>
            <div>
              {health?.ready ? (
                <span style={{ color: "#34d399" }}>
                  ● Transcoder active · {health.ytdlp} · FFmpeg 9.0
                </span>
              ) : (
                <span style={{ color: "#fb7185" }}>● Transcoder disconnected</span>
              )}
            </div>
          </div>

          <div className="footer-disclaimer">
            StreamShift is designed solely for personal inspection, educational purposes, and downloading media content that you own or have verified legal authorization and explicit licensing rights to retrieve. Ensure adherence to the respective terms of service of each content provider.
          </div>
        </div>
      </footer>
    </div>
  );
}