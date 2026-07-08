import { useState, MouseEvent, useCallback } from "react";
import { useNavigate, useNavigation } from "@remix-run/react";
import { useAppStateContext } from "~/context/app-state.context";
import { useCurrentUser } from "~/hooks/use-current-user.hook";

export const useHeader = () => {
  const navigate = useNavigate();
  const { isAnotherModalOpen, themeVariant, setThemeVariant } =
    useAppStateContext();
  const user = useCurrentUser();
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const open = Boolean(anchorEl);
  const navigation = useNavigation();

  const handleClick = useCallback((event: MouseEvent<HTMLElement>) => {
    setAnchorEl(event.currentTarget);
  }, []);

  const handleClose = useCallback(() => {
    setAnchorEl(null);
  }, []);

  const handleLogout = useCallback(() => {
    navigate("/signout");
  }, [navigate]);

  return {
    user,
    anchorEl,
    open,
    isAnotherModalOpen,
    themeVariant,
    navigationState: navigation.state,
    handleClick,
    handleClose,
    handleLogout,
    setThemeVariant,
    navigate,
  };
};
