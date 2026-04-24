import { useState } from "react";
import { useAppStateContext } from "~/context/app-state.context";

/**
 * RadNet-only footer. Self-conditional: returns null unless the RadNet
 * theme is active. Matches radnet.com's footer layout:
 *   - Left:   Logo + tagline + social icons + Career Opportunities link
 *   - Middle: West Coast + East Coast operations addresses
 *   - Right:  DeepHealth (Digital Health Division) address
 *
 * Address / phone details below are publicly available on radnet.com and
 * are used here to closely mirror their real footer for the themed mock.
 */
export const RadnetFooter = () => {
  const { themeVariant } = useAppStateContext();
  const [logoOk, setLogoOk] = useState(true);
  if (themeVariant !== "radnet") return null;
  return (
    <footer className="rn-footer">
      <div className="rn-footer__inner">
        {/* ─── Left column: logo + tagline + social + careers ─── */}
        <div className="rn-footer__brand">
          <div className="rn-footer__logo-row">
            {logoOk ? (
              <img
                className="rn-footer__logo"
                src="https://www.radnet.com/files/corporate/assets/branding/radnet-tagline-white.webp"
                alt="RadNet"
                onError={() => setLogoOk(false)}
              />
            ) : (
              <svg
                className="rn-footer__logo"
                viewBox="0 0 210 70"
                role="img"
                aria-label="RadNet"
              >
                <defs>
                  <linearGradient
                    id="rn-footer-arc-grad"
                    x1="0%"
                    y1="0%"
                    x2="100%"
                    y2="100%"
                  >
                    <stop offset="0%" stopColor="#2a2a2a" />
                    <stop offset="50%" stopColor="#9a9a9a" />
                    <stop offset="100%" stopColor="#e6e6e6" />
                  </linearGradient>
                </defs>
                <path
                  d="M 46 4 A 31 31 0 1 0 46 66"
                  fill="none"
                  stroke="url(#rn-footer-arc-grad)"
                  strokeWidth="8"
                  strokeLinecap="round"
                />
                <path
                  d="M 42 16 A 19 19 0 1 0 42 54"
                  fill="none"
                  stroke="url(#rn-footer-arc-grad)"
                  strokeWidth="6"
                  strokeLinecap="round"
                />
                <text
                  x="66"
                  y="50"
                  fontFamily="'Open Sans', 'Inter', sans-serif"
                  fontWeight="800"
                  fontSize="38"
                  fill="#c82030"
                >
                  Rad
                </text>
                <text
                  x="128"
                  y="50"
                  fontFamily="'Open Sans', 'Inter', sans-serif"
                  fontWeight="800"
                  fontSize="38"
                  fill="#d1d1d1"
                >
                  Net
                </text>
                <text
                  x="197"
                  y="58"
                  fontFamily="'Open Sans', sans-serif"
                  fontSize="8"
                  fill="#9a9a9a"
                >
                  ®
                </text>
              </svg>
            )}
            {/*
              Only render the separate tagline when we're falling back to
              the SVG (which doesn't include the tagline). The
              radnet-tagline-white.webp asset already has it baked in.
            */}
            {!logoOk && (
              <div className="rn-footer__tagline">
                <span className="rn-footer__tagline-light">
                  Advancing Imaging Through
                </span>
                <span className="rn-footer__tagline-bold">
                  Innovation &amp; Technology
                </span>
              </div>
            )}
          </div>

          <div className="rn-footer__social">
            <a
              href="https://www.facebook.com/RadNetInc"
              className="rn-footer__social-link"
              aria-label="Facebook"
              target="_blank"
              rel="noreferrer noopener"
            >
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
                <path
                  fill="currentColor"
                  d="M13.5 21v-7.5h2.5l.4-3h-2.9V8.7c0-.9.3-1.5 1.6-1.5h1.4V4.6c-.3 0-1.1-.1-2-.1-2 0-3.4 1.2-3.4 3.4v2.1H8.5v3h2.6V21h2.4z"
                />
              </svg>
            </a>
            <a
              href="https://twitter.com/RadNetInc"
              className="rn-footer__social-link"
              aria-label="X (formerly Twitter)"
              target="_blank"
              rel="noreferrer noopener"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
                <path
                  fill="currentColor"
                  d="M18 3h3l-7.2 8.2L22 21h-6.6l-5-6-5.7 6H2l7.7-8.3L2 3h6.7l4.5 5.5L18 3zm-1.2 16h1.5L7.3 5h-1.6l11.1 14z"
                />
              </svg>
            </a>
            <a
              href="https://www.linkedin.com/company/radnet"
              className="rn-footer__social-link"
              aria-label="LinkedIn"
              target="_blank"
              rel="noreferrer noopener"
            >
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
                <path
                  fill="currentColor"
                  d="M4.98 3.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM3 9h4v12H3V9zm7 0h3.8v1.7h.1c.5-.9 1.8-1.9 3.6-1.9 3.9 0 4.5 2.6 4.5 5.9V21h-4v-5.3c0-1.3 0-3-1.8-3s-2.1 1.4-2.1 2.9V21h-4V9z"
                />
              </svg>
            </a>
            <a
              href="https://www.youtube.com/@radnetinc"
              className="rn-footer__social-link"
              aria-label="YouTube"
              target="_blank"
              rel="noreferrer noopener"
            >
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden>
                <path
                  fill="currentColor"
                  d="M21.6 7.2c-.2-1-1-1.8-2-2C17.8 5 12 5 12 5s-5.8 0-7.6.2c-1 .2-1.8 1-2 2C2 9 2 12 2 12s0 3 .4 4.8c.2 1 1 1.8 2 2C6.2 19 12 19 12 19s5.8 0 7.6-.2c1-.2 1.8-1 2-2 .4-1.8.4-4.8.4-4.8s0-3-.4-4.8zM10 15V9l5 3-5 3z"
                />
              </svg>
            </a>
            <a
              href="https://www.instagram.com/radnetinc"
              className="rn-footer__social-link"
              aria-label="Instagram"
              target="_blank"
              rel="noreferrer noopener"
            >
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
                <path
                  fill="currentColor"
                  d="M12 2.2c3.2 0 3.6 0 4.9.1 1.2.1 1.8.3 2.3.4.6.2 1 .5 1.5 1s.8.9 1 1.5c.1.4.3 1 .4 2.3.1 1.3.1 1.7.1 4.9s0 3.6-.1 4.9c-.1 1.2-.3 1.8-.4 2.3-.2.6-.5 1-1 1.5s-.9.8-1.5 1c-.4.1-1 .3-2.3.4-1.3.1-1.7.1-4.9.1s-3.6 0-4.9-.1c-1.2-.1-1.8-.3-2.3-.4-.6-.2-1-.5-1.5-1s-.8-.9-1-1.5c-.1-.4-.3-1-.4-2.3C2.2 15.6 2.2 15.2 2.2 12s0-3.6.1-4.9c.1-1.2.3-1.8.4-2.3.2-.6.5-1 1-1.5s.9-.8 1.5-1c.4-.1 1-.3 2.3-.4C8.4 2.2 8.8 2.2 12 2.2zm0 1.8c-3.1 0-3.5 0-4.7.1-1.1.1-1.7.2-2.1.4-.5.2-.9.4-1.3.8-.4.4-.6.8-.8 1.3-.2.4-.3 1-.4 2.1-.1 1.2-.1 1.6-.1 4.7s0 3.5.1 4.7c.1 1.1.2 1.7.4 2.1.2.5.4.9.8 1.3.4.4.8.6 1.3.8.4.2 1 .3 2.1.4 1.2.1 1.6.1 4.7.1s3.5 0 4.7-.1c1.1-.1 1.7-.2 2.1-.4.5-.2.9-.4 1.3-.8.4-.4.6-.8.8-1.3.2-.4.3-1 .4-2.1.1-1.2.1-1.6.1-4.7s0-3.5-.1-4.7c-.1-1.1-.2-1.7-.4-2.1-.2-.5-.4-.9-.8-1.3-.4-.4-.8-.6-1.3-.8-.4-.2-1-.3-2.1-.4-1.2-.1-1.6-.1-4.7-.1zm0 3.1a4.9 4.9 0 1 1 0 9.8 4.9 4.9 0 0 1 0-9.8zm0 8a3.1 3.1 0 1 0 0-6.2 3.1 3.1 0 0 0 0 6.2zm6.2-8.2a1.1 1.1 0 1 1-2.2 0 1.1 1.1 0 0 1 2.2 0z"
                />
              </svg>
            </a>
          </div>

          <a
            className="rn-footer__careers"
            href="https://careers.radnet.com"
            target="_blank"
            rel="noreferrer noopener"
          >
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
              <path
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M7 17L17 7M9 7h8v8"
              />
            </svg>
            <span>Career Opportunities</span>
          </a>
        </div>

        {/* ─── Middle column: operations addresses ─── */}
        <div className="rn-footer__col">
          <h4 className="rn-footer__heading">West Coast Operations</h4>
          <p className="rn-footer__addr">
            1510 Cotner Avenue
            <br />
            Los Angeles, CA 90025
            <br />
            Phone: 310-445-2800
          </p>

          <h4 className="rn-footer__heading rn-footer__heading--spaced">
            East Coast Operations
          </h4>
          <p className="rn-footer__addr">
            BECO Towers
            <br />
            10461 Mill Run Circle, Suite 1100
            <br />
            Owings Mills, MD 21117
            <br />
            Phone: 443-436-1100
          </p>
        </div>

        {/* ─── Right column: DeepHealth ─── */}
        <div className="rn-footer__col">
          <h4 className="rn-footer__heading">
            DeepHealth (Digital Health Division)
          </h4>
          <p className="rn-footer__addr">
            212 Elm St.
            <br />
            Somerville, MA 01244
          </p>
        </div>
      </div>
    </footer>
  );
};
