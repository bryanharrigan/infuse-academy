/**
 * app/components/modal/map-modal.tsx
 *
 * Embeds a Google Maps view for a free-form address query inside a
 * Dialog. Uses Google's no-key embed URL
 *   https://maps.google.com/maps?q={address}&output=embed
 * which is iframe-friendly and renders a pannable/zoomable map without
 * requiring an API key. The same address gets a "Get directions" CTA
 * that links out to the full Google Maps web app.
 *
 * Falls back gracefully when the iframe is blocked (rare for Google
 * Maps but the watchdog covers strict CSP environments anyway).
 */

import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogTitle,
  IconButton,
  Typography,
} from "@mui/material";
import {
  Close as CloseIcon,
  OpenInNew as OpenInNewIcon,
  LocationOn as LocationOnIcon,
  Directions as DirectionsIcon,
} from "@mui/icons-material";
import { useEffect, useRef, useState } from "react";

type MapModalProps = {
  /** Free-form address query; non-null while the modal should be open. */
  query: string | null;
  /** Optional title — typically the venue or session name. */
  title?: string;
  /** Optional helper detail under the title (full address). */
  caption?: string;
  /** Fired when the modal is closed. */
  onClose: () => void;
};

const IFRAME_LOAD_TIMEOUT_MS = 8_000;

function buildEmbedUrl(query: string): string {
  return `https://maps.google.com/maps?q=${encodeURIComponent(query)}&hl=en&z=15&output=embed`;
}

function buildDirectionsUrl(query: string): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(
    query
  )}`;
}

function buildSearchUrl(query: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

export function MapModal({ query, title, caption, onClose }: MapModalProps) {
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const [iframeBlocked, setIframeBlocked] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const open = query !== null;
  const embedUrl = query ? buildEmbedUrl(query) : null;

  useEffect(() => {
    if (!query) {
      setIframeLoaded(false);
      setIframeBlocked(false);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      return;
    }
    setIframeLoaded(false);
    setIframeBlocked(false);
    timeoutRef.current = setTimeout(() => {
      setIframeBlocked((blocked) => (blocked ? blocked : !iframeLoaded));
    }, IFRAME_LOAD_TIMEOUT_MS);
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth={false}
      PaperProps={{
        sx: {
          width: "min(94vw, 900px)",
          height: "min(85vh, 680px)",
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
                "linear-gradient(135deg, rgba(240,171,252,0.22), rgba(94,234,212,0.22))",
              border: "1px solid rgba(240,171,252,0.45)",
              color: "#f0abfc",
              flexShrink: 0,
            }}
          >
            <LocationOnIcon fontSize="small" />
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
              Venue
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
              {title || query || "Location"}
            </Typography>
            {caption && (
              <Typography
                variant="caption"
                sx={{
                  color: "rgba(245,243,255,0.55)",
                  fontSize: "0.78rem",
                  display: "block",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  maxWidth: "60ch",
                }}
              >
                {caption}
              </Typography>
            )}
          </Box>
        </Box>
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, flexShrink: 0 }}>
          {query && (
            <Button
              size="small"
              variant="outlined"
              href={buildDirectionsUrl(query)}
              target="_blank"
              rel="noreferrer noopener"
              startIcon={<DirectionsIcon fontSize="small" />}
              sx={{
                color: "rgba(245,243,255,0.85)",
                borderColor: "rgba(255,255,255,0.25)",
                textTransform: "none",
                fontWeight: 600,
                fontSize: "0.78rem",
                "&:hover": {
                  borderColor: "#5eead4",
                  background: "rgba(94,234,212,0.08)",
                },
              }}
            >
              Directions
            </Button>
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
          background: "#0a0a14",
        }}
      >
        {embedUrl && !iframeBlocked && (
          <iframe
            key={embedUrl}
            src={embedUrl}
            title={title || "Map"}
            referrerPolicy="no-referrer-when-downgrade"
            loading="lazy"
            style={{
              width: "100%",
              height: "100%",
              border: "none",
              background: "#0a0a14",
            }}
            onLoad={() => setIframeLoaded(true)}
            onError={() => setIframeBlocked(true)}
          />
        )}

        {iframeBlocked && query && (
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
              The embedded map didn&rsquo;t load. Open it in Google Maps
              directly.
            </Alert>
            <Button
              variant="contained"
              startIcon={<OpenInNewIcon />}
              href={buildSearchUrl(query)}
              target="_blank"
              rel="noreferrer noopener"
              sx={{
                background:
                  "linear-gradient(135deg, #f0abfc 0%, #a78bfa 50%, #5eead4 100%)",
                color: "#06061a",
                fontWeight: 700,
                textTransform: "none",
                borderRadius: 999,
                px: 3,
                "&:hover": {
                  background:
                    "linear-gradient(135deg, #f0abfc 0%, #a78bfa 50%, #5eead4 100%)",
                  filter: "brightness(1.08)",
                },
              }}
            >
              Open in Google Maps
            </Button>
          </Box>
        )}
      </Box>
    </Dialog>
  );
}
