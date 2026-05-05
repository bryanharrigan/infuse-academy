import { Logout } from "@mui/icons-material";
import {
  Avatar,
  Divider,
  IconButton,
  ListItemIcon,
  Menu,
  MenuItem,
  Tooltip,
  Button,
  Box,
  FormControl,
  InputLabel,
  Select,
  SelectChangeEvent,
} from "@mui/material";
import { NavLink } from "@remix-run/react";
import { useState } from "react";
import { AbsorbLogo } from "../logo/logo.component";
import { LoadingModal } from "../modal/loading-spinner-modal";
import { useHeader } from "./use-header.hook";
import type { ThemeVariant } from "~/context/app-state.context";

const RADNET_CORPORATE_NAV: ReadonlyArray<readonly [string, string]> = [
  ["Solutions", "https://www.radnet.com/solutions"],
  ["Artificial Intelligence", "https://www.radnet.com/artificial-intelligence"],
  ["Imaging Centers", "https://www.radnet.com/imaging-centers"],
  ["Our Services", "https://www.radnet.com/our-services"],
  ["Who We Serve", "https://www.radnet.com/who-we-serve"],
  ["About RadNet", "https://www.radnet.com/about"],
];

export const Header = () => {
  const {
    user,
    anchorEl,
    open,
    isAnotherModalOpen,
    themeVariant,
    navigationState,
    handleClick,
    handleClose,
    handleLogout,
    setThemeVariant,
  } = useHeader();

  // "Branded" covers any variant that should use the IA layout (IA, RadNet,
  // or Experimental). Experimental is included so /catalog and /my-courses
  // inherit the IA chrome when the experimental theme is active — the
  // experimental hub itself ships its own layout via the dedicated route.
  const isBranded =
    themeVariant === "infuse-academy" ||
    themeVariant === "radnet" ||
    themeVariant === "experimental";
  // Alias kept so existing conditionals keep working.
  const isIA = isBranded;
  const isRadNet = themeVariant === "radnet";
  const isExperimental = themeVariant === "experimental";

  // The Learning Hub link routes to the dedicated experimental page when
  // the Experimental theme is active. Other variants keep the standard
  // /learning-hub route.
  const learningHubPath = isExperimental
    ? "/learning-hub-experimental"
    : "/learning-hub";

  const handleThemeChange = (e: SelectChangeEvent<ThemeVariant>) => {
    setThemeVariant(e.target.value as ThemeVariant);
  };

  // RadNet logo: prefer a real PNG dropped at /public/radnet-logo.png, fall
  // back to the inline SVG when the file is missing.
  const [radnetImgOk, setRadnetImgOk] = useState(true);

  // Shared nav link renderer that respects the active theme.
  const renderNavLink = (to: string, label: string) => (
    <NavLink
      key={to}
      to={to}
      className={({ isActive }) => {
        if (isIA) {
          return `ia-header__nav-link ${
            isActive ? "ia-header__nav-link--active" : ""
          }`;
        }
        return isActive
          ? "text-blue-600 font-semibold"
          : "text-gray-600 hover:text-blue-600";
      }}
    >
      {isIA ? label : <Button color="inherit">{label}</Button>}
    </NavLink>
  );

  /* ------------------------------------------------------------------
   * Reusable pieces (used in multiple layout branches below)
   * ---------------------------------------------------------------- */

  const appNavLinks = (
    <>
      {renderNavLink("/my-courses", "My Courses")}
      {renderNavLink("/catalog", "Catalog")}
      {renderNavLink(learningHubPath, "Learning Hub")}
    </>
  );

  const themeSelect = (
    <FormControl
      size="small"
      sx={{
        minWidth: 160,
        "& .MuiInputLabel-root": {
          color: isIA ? "var(--ia-text-muted)" : undefined,
          fontSize: "0.75rem",
        },
        "& .MuiOutlinedInput-root": { fontSize: "0.85rem" },
      }}
    >
      <InputLabel id="theme-variant-select-label">Theme</InputLabel>
      <Select<ThemeVariant>
        labelId="theme-variant-select-label"
        id="theme-variant-select"
        value={themeVariant}
        label="Theme"
        onChange={handleThemeChange}
      >
        <MenuItem value="default">Default</MenuItem>
        <MenuItem value="infuse-academy">Infuse Academy</MenuItem>
        <MenuItem value="radnet">RadNet</MenuItem>
        <MenuItem value="experimental">Experimental</MenuItem>
      </Select>
    </FormControl>
  );

  const accountAvatar = (
    <Tooltip title="Account settings">
      <IconButton
        onClick={handleClick}
        size="small"
        className="ml-2"
        aria-controls={open ? "account-menu" : undefined}
        aria-haspopup="true"
        aria-expanded={open ? "true" : undefined}
        sx={
          isIA
            ? {
                "&:hover": {
                  boxShadow: isRadNet
                    ? "0 0 0 3px rgba(14,120,190,0.25)"
                    : "0 0 0 3px rgba(108,99,255,0.25)",
                },
              }
            : undefined
        }
      >
        <Avatar
          alt="Profile"
          /* Under RadNet we skip Absorb's red-B avatar image and render a
             sky-blue circle with the learner's initial instead. */
          src={
            isRadNet
              ? undefined
              : user.avatarUrl || "https://picsum.photos/300"
          }
          className={
            isIA
              ? "w-10 h-10"
              : "w-10 h-10 border-2 border-gray-400 bg-gray-100"
          }
          sx={
            isIA
              ? {
                  border: isRadNet
                    ? "2px solid rgba(14,120,190,0.55)"
                    : "2px solid rgba(108,99,255,0.35)",
                  backgroundColor: isRadNet
                    ? "#197ec1"
                    : "var(--ia-surface-2)",
                  color: isRadNet ? "#ffffff" : undefined,
                  fontWeight: isRadNet ? 700 : undefined,
                  fontFamily: isRadNet
                    ? "'Open Sans', 'Inter', sans-serif"
                    : undefined,
                }
              : undefined
          }
        >
          {isRadNet
            ? (user.firstName?.charAt(0)?.toUpperCase() ?? "")
            : null}
        </Avatar>
      </IconButton>
    </Tooltip>
  );

  const radnetLogo = (
    <NavLink
      to="/"
      className="ia-header__logo ia-header__logo--image"
      aria-label="RadNet"
    >
      {radnetImgOk && (
        <img
          className="ia-header__logo-img"
          src="https://www.radnet.com/files/corporate/assets/branding/radnet-logo-no-tagline.webp"
          alt="RadNet"
          onError={() => setRadnetImgOk(false)}
        />
      )}
      {!radnetImgOk && (
        <svg
          className="ia-header__logo-radnet-svg"
          viewBox="0 0 210 70"
          role="img"
          aria-hidden
        >
          <defs>
            <linearGradient
              id="rn-arc-grad"
              x1="0%"
              y1="0%"
              x2="100%"
              y2="100%"
            >
              <stop offset="0%" stopColor="#1b1b1b" />
              <stop offset="50%" stopColor="#6b6b6b" />
              <stop offset="100%" stopColor="#d1d1d1" />
            </linearGradient>
          </defs>
          <path
            d="M 46 4 A 31 31 0 1 0 46 66"
            fill="none"
            stroke="url(#rn-arc-grad)"
            strokeWidth="8"
            strokeLinecap="round"
          />
          <path
            d="M 42 16 A 19 19 0 1 0 42 54"
            fill="none"
            stroke="url(#rn-arc-grad)"
            strokeWidth="6"
            strokeLinecap="round"
          />
          <text
            x="66"
            y="50"
            fontFamily="'Open Sans', 'Inter', sans-serif"
            fontWeight="800"
            fontSize="38"
            fill="#851f1e"
          >
            Rad
          </text>
          <text
            x="128"
            y="50"
            fontFamily="'Open Sans', 'Inter', sans-serif"
            fontWeight="800"
            fontSize="38"
            fill="#706f70"
          >
            Net
          </text>
          <text
            x="197"
            y="58"
            fontFamily="'Open Sans', sans-serif"
            fontSize="8"
            fill="#706f70"
          >
            ®
          </text>
        </svg>
      )}
    </NavLink>
  );

  /* ------------------------------------------------------------------
   * Layout
   * ---------------------------------------------------------------- */

  return (
    <Box
      className={
        isIA
          ? "ia-header fixed top-0 left-0 right-0 z-10"
          : "fixed top-0 left-0 right-0 bg-white bg-opacity-95 backdrop-blur-sm z-10 border-b"
      }
    >
      {isRadNet ? (
        <>
          {/*
            RadNet two-tier header (matches radnet.com).
            Top band: light-gray full-width strip carrying the app nav +
                      theme picker + avatar.
            Bottom band: white full-width strip carrying the logo + the
                         corporate nav links.
          */}
          <div
            className="ia-header__band ia-header__band--top"
            style={{
              background: "rgba(0,0,0,0.04)",
              borderBottom: "1px solid rgba(0,0,0,0.06)",
            }}
          >
            <div className="max-w-[1280px] mx-auto px-6 h-[48px] flex justify-between items-center">
              <div className="flex items-center gap-6">{appNavLinks}</div>
              <div className="flex items-center gap-3">
                {themeSelect}
                {accountAvatar}
              </div>
            </div>
          </div>
          <div className="ia-header__band ia-header__band--bottom">
            <div className="max-w-[1280px] mx-auto px-6 h-[96px] flex justify-between items-center">
              {radnetLogo}
              <nav className="flex items-center gap-7">
                {RADNET_CORPORATE_NAV.map(([label, href]) => (
                  <a
                    key={href}
                    href={href}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="ia-header__nav-link ia-header__nav-link--external"
                  >
                    {label}
                  </a>
                ))}
              </nav>
            </div>
          </div>
        </>
      ) : isExperimental ? (
        /* Experimental — left: iX brand mark + wordmark only. Right:
           nav links + theme select + avatar grouped together so the
           layout matches the experimental hub's in-page topbar. */
        <div className="max-w-[1280px] mx-auto px-6">
          <div className="flex justify-between items-center h-[72px]">
            <NavLink to="/" className="ia-header__logo ia-header__logo--exp">
              <span className="ia-header__logo-mark">iX</span>
              <span className="ia-text-gradient">Infuse · Experimental</span>
            </NavLink>
            <div className="flex items-center gap-4">
              {appNavLinks}
              {themeSelect}
              {accountAvatar}
            </div>
          </div>
        </div>
      ) : (
        /* Default + Infuse Academy keep the original single-row layout. */
        <div className={isIA ? "max-w-[1280px] mx-auto px-6" : ""}>
          <div
            className={
              isIA
                ? "flex justify-between items-center h-[72px]"
                : "flex justify-between items-center p-3"
            }
          >
            <div
              className={
                isIA ? "flex items-center gap-6" : "flex items-center gap-4"
              }
            >
              {isBranded ? (
                <NavLink to="/" className="ia-header__logo">
                  <span className="ia-header__logo-mark">iA</span>
                  <span className="ia-text-gradient">Infuse Academy</span>
                </NavLink>
              ) : (
                <AbsorbLogo />
              )}
              {appNavLinks}
            </div>
            <div className="flex items-center gap-3">
              {themeSelect}
              {accountAvatar}
            </div>
          </div>
        </div>
      )}

      <Menu
        anchorEl={anchorEl}
        id="account-menu"
        open={open}
        onClose={handleClose}
        onClick={handleClose}
        transformOrigin={{ horizontal: "right", vertical: "top" }}
        anchorOrigin={{ horizontal: "right", vertical: "bottom" }}
      >
        <MenuItem onClick={handleClose}>
          {user.firstName} {user.lastName}
        </MenuItem>
        <Divider />
        <MenuItem onClick={handleLogout}>
          <ListItemIcon>
            <Logout fontSize="small" />
          </ListItemIcon>
          Logout
        </MenuItem>
      </Menu>
      {!isAnotherModalOpen && (
        <LoadingModal open={navigationState === "loading"} />
      )}
    </Box>
  );
};
