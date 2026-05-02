/**
 * app/components/modal/webinar-modal.tsx
 *
 * Embeds a webinar (Zoom, Microsoft Teams, Webex, generic) in a Dialog.
 * Tries to iframe the meeting; if the host blocks framing (X-Frame-
 * Options / CSP frame-ancestors) the watchdog falls back to an "Open in
 * new window" CTA so the learner can still join.
 *
 * Zoom URL conversion: standard `https://zoom.us/j/MEETING_ID` URLs
 * trigger the Zoom desktop app rather than the browser. We rewrite to
 * `https://zoom.us/wc/MEETING_ID/join` (the Zoom Web Client) which
 * loads in-browser and is iframe-friendly. Other vendors are passed
 * through unchanged.
 */

import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogTitle,
  IconButton,
  Typography,
} from "@mui/material";
import {
  Close as CloseIcon,
  OpenInNew as OpenInNewIcon,
  Videocam as VideocamIcon,
} from "@mui/icons-material";
import { useEffect, useRef, useState } from "react";

type WebinarModalProps = {
  /** Webinar URL; non-null while the modal should be open. */
  url: string | null;
  /** Optional title — typically the session or course name. */
  title?: string;
  /** Optional helper detail (timezone, dial-in, etc.) shown above the iframe. */
  caption?: string;
  /** Fired when the modal is closed. */
  onClose: () => void;
};

const IFRAME_LOAD_TIMEOUT_MS = 8_000;

/**
 * Rewrite known meeting URLs to their iframe-friendly variants.
 *
 *   Zoom:  https://zoom.us/j/123?pwd=abc  →  https://zoom.us/wc/123/join?pwd=abc
 *          https://*.zoom.us/j/123        →  https://*.zoom.us/wc/123/join
 *   Teams: passthrough (Teams web link is already iframe-friendly enough)
 *   Webex: passthrough
 *   Other: passthrough
 */
function toEmbedUrl(input: string): string {
  try {
    const u = new URL(input);
    // Zoom: convert /j/ → /wc/.../join while preserving query (pwd, tk, etc.)
    if (
      /(^|\.)zoom\.us$/i.test(u.hostname) ||
      /(^|\.)zoomgov\.com$/i.test(u.hostname)
    ) {
      const m = u.pathname.match(/^\/j\/(\d+)/i);
      if (m) {
        u.pathname = `/wc/${m[1]}/join`;
        return u.toString();
      }
    }
    return input;
  } catch {
    return input;
  }
}

function detectVendor(input: string): string {
  try {
    const host = new URL(input).hostname.toLowerCase();
    if (host.endsWith("zoom.us") || host.endsWith("zoomgov.com")) return "Zoom";
    if (host.includes("teams.microsoft.com") || host.includes("teams.live.com"))
      return "Microsoft Teams";
    if (host.endsWith("webex.com")) return "Webex";
    if (host.includes("gotomeeting.com")) return "GoToMeeting";
    if (host.includes("meet.google.com")) return "Google Meet";
    return "Webinar";
  } catch {
    return "Webinar";
  }
}

export function WebinarModal({ url, title, caption, onClose }: WebinarModalProps) {
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const [iframeBlocked, setIframeBlocked] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const open = url !== null;
  const embedUrl = url ? toEmbedUrl(url) : null;
  const vendor = url ? detectVendor(url) : "Webinar";

  // Reset on open/close.
  useEffect(() => {
    if (!url) {
      setIframeLoaded(false);
      setIframeBlocked(false);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      return;
    }
    setIframeLoaded(false);
    setIframeBlocked(false);
    timeoutRef.current = setTimeout(() => {
      setIframeBlocked((blocked) => (blocked ? blocked : true));
    }, IFRAME_LOAD_TIMEOUT_MS);
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [url]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth={false}
      PaperProps={{
        sx: {
          width: "min(94vw, 1100px)",
          height: "min(90vh, 760px)",
          maxWidth: "94vw",
          maxHeight: "90vh",
          m: 2,
          display: "flex",
          flexDirection: "column",
          borderRadius: 4,
          background: "rgba(20, 20, 36, 0.95)",
          backdropFilter: "blur(28px) saturate(160%)",
          WebkitBackdropFilter: "blur(28px) saturate(160%)",
          border: "1px solid rgba(255, 255, 255, 0.18)",
          color: "#f5f3ff",
        },
      }}
    >
      <DialogTitle
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 2,
          py: 1.25,
          px: 2,
          borderBottom: "1px solid rgba(255,255,255,0.1)",
          flexShrink: 0,
        }}
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 1.25, minWidth: 0 }}>
          <Box
            sx={{
              width: 32,
              height: 32,
              borderRadius: "50%",
              display: "grid",
              placeItems: "center",
              background:
                "linear-gradient(135deg, rgba(94,234,212,0.2), rgba(167,139,250,0.2))",
              border: "1px solid rgba(94,234,212,0.4)",
              color: "#5eead4",
              flexShrink: 0,
            }}
          >
            <VideocamIcon fontSize="small" />
          </Box>
          <Box sx={{ minWidth: 0 }}>
            <Typography
              variant="caption"
              sx={{
                color: "rgba(245,243,255,0.6)",
                textTransform: "uppercase",
                letterSpacing: "0.16em",
                fontWeight: 700,
                fontSize: "0.65rem",
                display: "block",
              }}
            >
              Live · {vendor}
            </Typography>
            <Typography
              variant="subtitle1"
              sx={{
                fontFamily: "'Space Grotesk', sans-serif",
                fontWeight: 700,
                lineHeight: 1.2,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                color: "#f5f3ff",
              }}
            >
              {title || "Webinar"}
            </Typography>
            {caption && (
              <Typography
                variant="caption"
                sx={{ color: "rgba(245,243,255,0.55)", fontSize: "0.78rem" }}
              >
                {caption}
              </Typography>
            )}
          </Box>
        </Box>
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, flexShrink: 0 }}>
          {url && (
            <IconButton
              size="small"
              href={url}
              target="_blank"
              rel="noreferrer noopener"
              title="Open in new tab"
              sx={{ color: "rgba(245,243,255,0.7)" }}
            >
              <OpenInNewIcon fontSize="small" />
            </IconButton>
          )}
          <IconButton
            size="small"
            onClick={onClose}
            title="Close"
            sx={{ color: "rgba(245,243,255,0.7)" }}
          >
            <CloseIcon fontSize="small" />
          </IconButton>
        </Box>
      </DialogTitle>

      <Box
        sx={{
          flex: 1,
          position: "relative",
          display: "grid",
          placeItems: "center",
          minHeight: 0,
          background: "#000",
        }}
      >
        {!iframeLoaded && !iframeBlocked && embedUrl && (
          <Box
            sx={{
              position: "absolute",
              inset: 0,
              display: "grid",
              placeItems: "center",
              pointerEvents: "none",
            }}
          >
            <Box sx={{ textAlign: "center" }}>
              <CircularProgress sx={{ color: "#5eead4" }} />
              <Typography
                variant="caption"
                sx={{
                  display: "block",
                  mt: 1.5,
                  color: "rgba(245,243,255,0.6)",
                }}
              >
                Connecting to {vendor}…
              </Typography>
            </Box>
          </Box>
        )}

        {embedUrl && !iframeBlocked && (
          <iframe
            key={embedUrl}
            src={embedUrl}
            title={title || "Webinar"}
            allow="camera; microphone; fullscreen; autoplay; display-capture; clipboard-read; clipboard-write"
            allowFullScreen
            style={{
              width: "100%",
              height: "100%",
              border: "none",
              background: "#000",
            }}
            onLoad={() => setIframeLoaded(true)}
            onError={() => setIframeBlocked(true)}
          />
        )}

        {iframeBlocked && url && (
          <Box
            sx={{
              p: 4,
              maxWidth: 520,
              textAlign: "center",
              display: "flex",
              flexDirection: "column",
              gap: 2,
              alignItems: "center",
            }}
          >
            <Alert severity="info" sx={{ borderRadius: 2 }}>
              {vendor} is blocking the embed in this view. Open it in a new
              window to join.
            </Alert>
            <Button
              variant="contained"
              startIcon={<OpenInNewIcon />}
              href={url}
              target="_blank"
              rel="noreferrer noopener"
              sx={{
                background:
                  "linear-gradient(135deg, #5eead4 0%, #22d3ee 50%, #a78bfa 100%)",
                color: "#06061a",
                fontWeight: 700,
                textTransform: "none",
                borderRadius: 999,
                px: 3,
                "&:hover": {
                  background:
                    "linear-gradient(135deg, #5eead4 0%, #22d3ee 50%, #a78bfa 100%)",
                  filter: "brightness(1.08)",
                },
              }}
            >
              Join {vendor}
            </Button>
          </Box>
        )}
      </Box>
    </Dialog>
  );
}
