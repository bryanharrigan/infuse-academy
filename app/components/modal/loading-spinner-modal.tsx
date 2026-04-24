import React from "react";
import { Dialog, CircularProgress, DialogContent, Box } from "@mui/material";

type LoadingModalProps = {
  open: boolean;
};

export const LoadingModal: React.FC<LoadingModalProps> = ({ open }) => {
  return (
    <Dialog
      open={open}
      PaperProps={{
        className: "bg-transparent shadow-none",
      }}
      disableEscapeKeyDown
      maxWidth="xs"
      fullWidth
    >
      <DialogContent>
        <Box className="flex justify-center items-center min-h-[150px]">
          <CircularProgress />
        </Box>
      </DialogContent>
    </Dialog>
  );
};
