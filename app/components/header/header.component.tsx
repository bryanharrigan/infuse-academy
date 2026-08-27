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
import { AbsorbLogo } from "../logo/logo.component";
import { LoadingModal } from "../modal/loading-spinner-modal";
import { useHeader } from "./use-header.hook";
import type { ThemeVariant } from "~/context/app-state.context";

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
    navigate,
  } = useHeader();

  const isBranded =
    themeVariant === "infuse-academy" || themeVariant === "experimental";
  const isIA = isBranded;
  const isExperimental = themeVariant === "experimental";

  const learningHubPath = isExperimental
    ? "/learning-hub-experimental"
    : "/learning-hub";

  const handleThemeChange = (e: SelectChangeEvent<ThemeVariant>) => {
    const next = e.target.value as ThemeVariant;
    setThemeVariant(next);
    if (next === "experimental") {
      navigate("/learning-hub-experimental");
    } else {
      navigate("/learning-hub");
    }
  };

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
   * Reusable pieces
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
        <MenuItem value="infuse-academy">Infuse Academy</MenuItem>
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
                  boxShadow: "0 0 0 3px rgba(108,99,255,0.25)",
                },
              }
            : undefined
        }
      >
        <Avatar
          alt="Profile"
          src={user.avatarUrl || "https://picsum.photos/300"}
          className={
            isIA
              ? "w-10 h-10"
              : "w-10 h-10 border-2 border-gray-400 bg-gray-100"
          }
          sx={
            isIA
              ? {
                  border: "2px solid rgba(108,99,255,0.35)",
                  backgroundColor: "var(--ia-surface-2)",
                }
              : undefined
          }
        />
      </IconButton>
    </Tooltip>
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
      {isExperimental ? (
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
        /* Infuse Academy single-row layout. */
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
