/**
 * app/components/modal/map-modal.tsx
 *
 * Embeds an OpenStreetMap view for a free-form address query inside a
 * Dialog. Geocodes via the server-side `/geocode` resource route
 * (which proxies Nominatim with a proper User-Agent) so we get a
 * lat/lon to centre the map and drop a marker.
 *
 * Why OSM: keys-free, terms-of-service compatible, and renders without
 * the Google Maps API surface charges. The OSM embed
 *   https://www.openstreetmap.org/export/embed.html?bbox=...&marker=lat,lon
 * needs lat/lon, hence the geocoding step.
 *
 * Falls back to a "View on OpenStreetMap" CTA when Nominatim returns
 * no result for the address (rare for real venues but possible for
 * abbreviated/internal codes like "HQ Boardroom").
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
  LocationOn as LocationOnIcon,
  Directions as DirectionsIcon,
} from "@mui/icons-material";
import { useEffect, useState } from "react";

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

type GeocodeResult = {
  lat: number;
  lon: number;
  displayName: string;
};

type FetcherState = "idle" | "loading" | "loaded" | "error";

/**
 * Build the OSM embed URL for a marker at lat/lon. Uses a small
 * bounding box (~1.4km wide at the equator, narrower at higher
 * latitudes) so the venue stays visible and readable.
 */
function buildEmbedUrl(lat: number, lon: number): string {
  const span = 0.006; // degrees — tweak for zoom level
  const minLon = lon - span;
  const minLat = lat - span / 2;
  const maxLon = lon + span;
  const maxLat = lat + span / 2;
  return (
    `https://www.openstreetmap.org/export/embed.html?bbox=` +
    `${minLon}%2C${minLat}%2C${maxLon}%2C${maxLat}` +
    `&layer=mapnik&marker=${lat}%2C${lon}`
  );
}

function buildOsmDirectionsUrl(query: string): string {
  // OSM has a routing tool but no clean direct URL. We use the search
  // page so the user can hit the routing button from there.
  return `https://www.openstreetmap.org/search?query=${encodeURIComponent(query)}`;
}

function buildOsmViewUrl(query: string): string {
  return `https://www.openstreetmap.org/search?query=${encodeURIComponent(query)}`;
}

export function MapModal({ query, title, caption, onClose }: MapModalProps) {
  const [state, setState] = useState<FetcherState>("idle");
  const [result, setResult] = useState<GeocodeResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const open = query !== null;

  useEffect(() => {
    if (!query) {
      setState("idle");
      setResult(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setState("loading");
    fetch(`/geocode?q=${encodeURIComponent(query)}`, {
      headers: { Accept: "application/json" },
    })
      .then(async (res) => {
        const json = (await res.json().catch(() => ({}))) as Partial<GeocodeResult> & {
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok || typeof json.lat !== "number" || typeof json.lon !== "number") {
          setError(json.error ?? `HTTP ${res.status}`);
          setState("error");
          return;
        }
        setResult({
          lat: json.lat,
          lon: json.lon,
          displayName: json.displayName ?? query,
        });
        setState("loaded");
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setState("error");
        }
      });
    return () => {
      cancelled = true;
    };
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
              Venue · OpenStreetMap
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
              href={buildOsmDirectionsUrl(query)}
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
              Open
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
        {state === "loading" && (
          <Box sx={{ textAlign: "center" }}>
            <CircularProgress sx={{ color: "#f0abfc" }} />
            <Typography
              variant="caption"
              sx={{
                display: "block",
                mt: 1.5,
                color: "rgba(245,243,255,0.6)",
              }}
            >
              Geocoding venue…
            </Typography>
          </Box>
        )}

        {state === "loaded" && result && (
          <iframe
            key={`${result.lat},${result.lon}`}
            src={buildEmbedUrl(result.lat, result.lon)}
            title={title || "Venue map"}
            referrerPolicy="no-referrer-when-downgrade"
            loading="lazy"
            style={{
              width: "100%",
              height: "100%",
              border: "none",
              background: "#0a0a14",
            }}
          />
        )}

        {state === "error" && query && (
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
              We couldn&rsquo;t pin a precise location for{" "}
              <strong>{query}</strong>
              {error ? ` (${error})` : "."}
            </Alert>
            <Button
              variant="contained"
              startIcon={<OpenInNewIcon />}
              href={buildOsmViewUrl(query)}
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
              Search on OpenStreetMap
            </Button>
          </Box>
        )}
      </Box>
    </Dialog>
  );
}
