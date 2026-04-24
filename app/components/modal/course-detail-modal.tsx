import React, { useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogActions,
  Button,
  Typography,
  CardMedia,
  Box,
} from "@mui/material";
import FallbackImage from "~/assets/banner.jpg";
import { useAppStateContext } from "~/context/app-state.context";

type CourseDetailModalProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  description: string;
  imageUrl: string;
};

export const CourseDetailModal: React.FC<CourseDetailModalProps> = ({
  open,
  onClose,
  title,
  description,
  imageUrl,
}) => {
  const { setModalOpen } = useAppStateContext();

  useEffect(() => {
    setModalOpen(open);
    return () => setModalOpen(false);
  }, [open, setModalOpen]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="md"
      PaperProps={{
        className:
          "relative mx-auto mt-20 max-w-lg max-h-[90vh] overflow-y-auto",
      }}
      disableEscapeKeyDown
    >
      <DialogContent>
        <Typography
          variant="h6"
          component="h2"
          className="line-clamp-2 overflow-hidden text-ellipsis whitespace-normal"
        >
          {title}
        </Typography>
        <Box className="flex flex-col items-center">
          <CardMedia
            component="img"
            image={imageUrl || FallbackImage}
            alt={title}
            className="max-h-[400px] object-cover mb-4"
          />
          {description && (
            <Box
              className="mt-4 text-base leading-relaxed"
              dangerouslySetInnerHTML={{ __html: description }}
            />
          )}
        </Box>
      </DialogContent>
      <DialogActions className="flex justify-end pr-4">
        <Button onClick={onClose} color="primary">
          Close
        </Button>
      </DialogActions>
    </Dialog>
  );
};
