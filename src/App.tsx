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
  status: "preparing" | "transcoding" | "ready" | "error";
  statusMessage: string;
  blobUrl: string | null;
  directUrl: string;
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
      const stored = localStorage.getItem("formatly_recents");
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });

  // Check backend engine health on mount
  useEffect(() => {
    async function checkHealth() {
      try {
        const res = await fetch("/api/health");
        const data = await res.json();
        setHealth(data);
      } catch {
        setHealth({ ready: false, engine: "unavailable", error: "Cannot reach backend service." });
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

  const handleAnalyze = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const cleanUrl = url.trim();
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
      const response = await fetch("/api/info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: cleanUrl, confirmedRights: true })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to inspect media.");
      }

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
      const text = await navigator.clipboard.readText();
      if (text) {
        setUrl(text.trim());
        setError(null);
      }
    } catch {
      showToast("Please paste using Ctrl+V / Cmd+V");
    }
  };

  const cleanFilename = (title: string, ext: string) => {
    const safe = title.replace(/[^\w\s.-]/g, "_").trim().slice(0, 80) || "media";
    return `${safe}.${ext.toLowerCase()}`;
  };

  const startDownload = async (format: MediaFormat) => {
    if (!media) return;

    const filename = cleanFilename(media.title, format.ext);
    const directUrl = `/api/download-direct?url=${encodeURIComponent(url.trim())}&formatId=${encodeURIComponent(format.id)}&title=${encodeURIComponent(media.title)}&kind=${format.kind}&ext=${format.ext.toLowerCase()}&confirmedRights=true`;

    setModalState({
      format,
      status: "preparing",
      statusMessage: "Requesting download ticket...",
      blobUrl: null,
      directUrl,
      filename,
      error: null
    });

    try {
      // Step 1: Request ticket
      const ticketRes = await fetch("/api/ticket", {
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

      const ticketData = await ticketRes.json();
      if (!ticketRes.ok) {
        throw new Error(ticketData.error || "Failed to issue download ticket.");
      }

      // Step 2: Fetch media stream through server (this runs yt-dlp + ffmpeg)
      setModalState(prev => prev ? {
        ...prev,
        status: "transcoding",
        statusMessage: `Transcoding & assembling ${format.ext} stream with FFmpeg...`
      } : null);

      const downloadRes = await fetch(ticketData.downloadPath);
      if (!downloadRes.ok) {
        const errorText = await downloadRes.text();
        throw new Error(errorText || "Server transcoding failed.");
      }

      // Step 3: Stream received as Blob
      setModalState(prev => prev ? {
        ...prev,
        statusMessage: "File received! Saving to your computer..."
      } : null);

      const blob = await downloadRes.blob();
      const objectUrl = URL.createObjectURL(blob);

      // Trigger browser download via object URL (instantaneous, never blocked by popup blockers)
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      setModalState(prev => prev ? {
        ...prev,
        status: "ready",
        statusMessage: "Download ready! File saved to your computer.",
        blobUrl: objectUrl
      } : null);

      showToast(`✓ ${filename} saved!`);

      // Record in recent history
      const newRecent: RecentDownload = {
        id: Math.random().toString(36).substring(2, 9),
        title: media.title,
        ext: format.ext,
        quality: format.quality,
        time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      };
      const updated = [newRecent, ...recentDownloads.slice(0, 9)];
      setRecentDownloads(updated);
      localStorage.setItem("formatly_recents", JSON.stringify(updated));

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Download failed.";
      setModalState(prev => prev ? {
        ...prev,
        status: "error",
        statusMessage: "Download could not be completed.",
        error: msg
      } : null);
    }
  };

  const closeModal = () => {
    if (modalState?.blobUrl) {
      URL.revokeObjectURL(modalState.blobUrl);
    }
    setModalState(null);
  };

  const clearHistory = () => {
    setRecentDownloads([]);
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
                  ? "✓ Download Complete"
                  : modalState.status === "error"
                  ? "⚠️ Download Issue"
                  : "Processing Media Download"}
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
              {modalState.status !== "ready" && modalState.status !== "error" && (
                <div className="progress-track">
                  <div className="progress-bar-animated"></div>
                </div>
              )}
              <div className="progress-step-text">
                {modalState.status === "transcoding" && <span>⚙️</span>}
                {modalState.status === "ready" && <span>✅</span>}
                {modalState.status === "error" && <span>❌</span>}
                <span>{modalState.statusMessage}</span>
              </div>
            </div>

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
              {modalState.blobUrl && (
                <a
                  href={modalState.blobUrl}
                  download={modalState.filename}
                  className="modal-btn-primary"
                >
                  💾 Click to Save Again ({modalState.filename})
                </a>
              )}

              {modalState.status !== "ready" && (
                <a
                  href={modalState.directUrl}
                  download={modalState.filename}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="modal-fallback-link"
                >
                  Or click here to download directly in a new tab
                </a>
              )}

              {modalState.status === "ready" && (
                <button type="button" className="secondary-btn" onClick={closeModal}>
                  Close Window
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <header className="site-header">
        <div className="header-container">
          <div className="brand-group">
            <div className="brand-icon">F</div>
            <div className="brand-text">
              <span className="brand-title">Formatly</span>
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
              <strong>Formatly</strong> — Modern media format inspector & stream transcode engine.
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
            Formatly is designed solely for personal inspection, educational purposes, and downloading media content that you own or have verified legal authorization and explicit licensing rights to retrieve. Ensure adherence to the respective terms of service of each content provider.
          </div>
        </div>
      </footer>
    </div>
  );
}
