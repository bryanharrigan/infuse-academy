import React, { useEffect } from "react";
import {
  Snackbar,
  Alert,
  CircularProgress,
  Box,
  IconButton,
  Typography,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import { useAppStateContext } from "~/context/app-state.context";

type ToastProps = {
  open: boolean;
  title: string;
  onClose?: () => void;
  loading?: boolean;
};

export const EnrollmentToast: React.FC<ToastProps> = ({
  open,
  title,
  onClose,
  loading,
}) => {
  const { setModalOpen } = useAppStateContext();

  useEffect(() => {
    setModalOpen(open);
    return () => setModalOpen(false);
  }, [open, setModalOpen]);

  return (
    <Snackbar
      open={open}
      autoHideDuration={loading ? null : 3000}
      anchorOrigin={{ vertical: "top", horizontal: "center" }}
      onClose={onClose}
    >
      <Alert
        variant="filled"
        severity={loading ? "info" : "success"}
        icon={loading ? <CircularProgress size={20} /> : undefined}
        action={
          <IconButton
            size="small"
            aria-label="close"
            color="inherit"
            onClick={onClose}
            className="ml-2"
          >
            <CloseIcon fontSize="small" />
          </IconButton>
        }
        className="flex items-center rounded-lg shadow-md"
      >
        <Box className="flex items-center">
          <Typography className="font-bold">
            {loading ? "Processing..." : title}
          </Typography>
          {loading && (
            <Box className="ml-4">
              <CircularProgress size={16} />
            </Box>
          )}
        </Box>
      </Alert>
    </Snackbar>
  );
};
