import { KeyboardBackspace } from "@mui/icons-material";
import { CircularProgress, Box, Button } from "@mui/material";
import { json, LoaderFunctionArgs } from "@remix-run/node";
import { useNavigate, useLoaderData } from "@remix-run/react";
import { useEffect, useRef } from "react";
import { getLessonPlayerPayload } from "~/.server/infuse-api";
import { infuseJwtCookie } from "~/constants/infuse-cookie.server";

/**
 * Legacy "open in a new tab" course player.
 *
 * Now produces a proper Absorb Lesson Player URL (picks the next incomplete
 * lesson, fresh codeVerifier + single-use refreshToken every time, correct
 * /learn/lessonPlayer path). For the in-app modal experience, see the
 * `lesson-player.$courseId.tsx` resource route + LessonPlayerModal component.
 */
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  if (!params.courseId) {
    return new Response(null, { status: 404 });
  }

  const cookieHeader = request.headers.get("Cookie");
  const tokenValue = await infuseJwtCookie.parse(cookieHeader);
  if (!tokenValue) {
    throw new Response("Not authenticated", { status: 401 });
  }

  const url = new URL(request.url);
  const returnUrl = `${url.origin}/my-courses`;

  const payload = await getLessonPlayerPayload(params.courseId, tokenValue, {
    returnUrl,
  });

  return json({ playerUrl: payload.playerUrl });
};

export default function CoursePlayer() {
  const data = useLoaderData<typeof loader>();
  const openerRef = useRef<HTMLAnchorElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (openerRef.current) {
      openerRef.current.click();
    }
  }, []);

  if (!data?.playerUrl) {
    return (
      <div className="flex justify-center p-12">
        <div>
          <CircularProgress />
        </div>
      </div>
    );
  }

  const handleGoBack = () => {
    navigate("/my-courses");
  };

  return (
    <div className="p-12 mt-[75px]">
      <a
        ref={openerRef}
        href={data.playerUrl}
        target="_blank"
        rel="noreferrer"
        className="hidden"
      >
        Open course
      </a>
      <Box mt={4} display="flex" justifyContent="center">
        <Button
          variant="contained"
          color="primary"
          onClick={handleGoBack}
          startIcon={<KeyboardBackspace />}
        >
          Go back to My Courses
        </Button>
      </Box>
    </div>
  );
}
